package com.gesturecontrols.wearwatch

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING, FAILED }

/**
 * Owns the single WebSocket connection to the desktop watch bridge
 * (docs/watch-websocket-protocol.md). Reconnects with a capped exponential
 * backoff for as long as the user has asked to stay connected, and gives up
 * after [MAX_RECONNECT_ATTEMPTS] so a dead endpoint doesn't retry forever.
 */
class WatchLinkManager(private val deviceId: String = WatchProtocol.DEVICE_ID) {

    private val client = OkHttpClient.Builder().build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var webSocket: WebSocket? = null
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private val sequence = AtomicLong(0)
    private var attempt = 0
    private var userRequestedConnection = false
    private var currentUrl: String? = null
    // Set right before we close a socket ourselves, so the async onClosed/onFailure
    // callback OkHttp delivers afterwards is recognized as expected and doesn't
    // trigger a reconnect (e.g. right after pauseForLifecycle or a fresh connect()).
    private var closeExpected = false

    /** Supplies battery percent for outgoing heartbeats; wired by MainActivity. */
    var batteryPercentProvider: (() -> Int?)? = null

    private val _state = MutableStateFlow(ConnectionState.DISCONNECTED)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _lastOrientationSequence = MutableStateFlow(0L)
    val lastOrientationSequence: StateFlow<Long> = _lastOrientationSequence.asStateFlow()

    fun connect(url: String) {
        userRequestedConnection = true
        currentUrl = url
        attempt = 0
        reconnectJob?.cancel()
        openSocket(url)
    }

    /** User-initiated stop: no reconnect attempts follow this. */
    fun disconnect() {
        userRequestedConnection = false
        reconnectJob?.cancel()
        reconnectJob = null
        closeSocket()
        _state.value = ConnectionState.DISCONNECTED
    }

    /** Call from Activity#onDestroy to release the coroutine scope and client threads. */
    fun shutdown() {
        disconnect()
        scope.cancel()
    }

    /**
     * Closes the socket when the activity leaves the foreground without
     * forgetting that the user wants a connection, so [resumeForLifecycle]
     * can re-open it. Keeps a backgrounded app from holding a socket + wake
     * source it can't act on.
     */
    fun pauseForLifecycle() {
        reconnectJob?.cancel()
        reconnectJob = null
        closeSocket()
        if (userRequestedConnection) {
            _state.value = ConnectionState.DISCONNECTED
        }
    }

    /** Re-opens the connection if the user had requested one before the activity paused. */
    fun resumeForLifecycle() {
        val url = currentUrl
        if (userRequestedConnection && url != null && webSocket == null) {
            attempt = 0
            openSocket(url)
        }
    }

    fun sendOrientation(
        quaternion: FloatArray,
        accelerometer: FloatArray?,
        gyroscope: FloatArray?,
        timestampNs: Long,
    ) {
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        val seq = sequence.incrementAndGet()
        val message = WatchProtocol.orientationMessage(
            deviceId,
            seq,
            timestampNs,
            quaternion,
            accelerometer,
            gyroscope,
        )
        socket.send(message)
        _lastOrientationSequence.value = seq
    }

    private fun openSocket(url: String) {
        closeSocket()
        _state.value = if (attempt == 0) ConnectionState.CONNECTING else ConnectionState.RECONNECTING
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, listener)
    }

    private fun closeSocket() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        if (webSocket != null) {
            closeExpected = true
        }
        webSocket?.close(1000, "client closing")
        webSocket = null
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            scope.launch {
                attempt = 0
                sequence.set(0)
                _state.value = ConnectionState.CONNECTED
                startHeartbeat()
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            scope.launch { handleInbound(text) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scope.launch { handleDisconnect() }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            scope.launch { handleDisconnect() }
        }
    }

    private fun handleInbound(text: String) {
        val message = WatchProtocol.parseInbound(text) ?: return
        if (message.type != WatchProtocol.TYPE_DESKTOP_TIME_SYNC) return
        val desktopTimeNs = message.payload.optLong("desktopTimeNs", -1L)
        if (desktopTimeNs < 0) return
        val watchTimeNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        val reply = WatchProtocol.timeSyncMessage(deviceId, seq, watchTimeNs, desktopTimeNs, watchTimeNs)
        webSocket?.send(reply)
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                val timestampNs = SystemClock.elapsedRealtimeNanos()
                val seq = sequence.incrementAndGet()
                val message = WatchProtocol.heartbeatMessage(
                    deviceId,
                    seq,
                    timestampNs,
                    batteryPercentProvider?.invoke(),
                )
                webSocket?.send(message)
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun handleDisconnect() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        webSocket = null
        if (closeExpected) {
            closeExpected = false
            return
        }
        if (!userRequestedConnection) {
            _state.value = ConnectionState.DISCONNECTED
            return
        }
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            _state.value = ConnectionState.FAILED
            return
        }
        val delayMs = backoffDelayMs(attempt)
        attempt += 1
        _state.value = ConnectionState.RECONNECTING
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            val url = currentUrl
            if (userRequestedConnection && url != null) {
                openSocket(url)
            }
        }
    }

    private fun backoffDelayMs(attempt: Int): Long {
        val scaled = INITIAL_BACKOFF_MS shl attempt.coerceAtMost(8)
        return scaled.coerceAtMost(MAX_BACKOFF_MS)
    }

    companion object {
        private const val HEARTBEAT_INTERVAL_MS = 1000L
        private const val INITIAL_BACKOFF_MS = 1000L
        private const val MAX_BACKOFF_MS = 30_000L
        private const val MAX_RECONNECT_ATTEMPTS = 8
    }
}
