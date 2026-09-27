package com.gesturecontrols.wearwatch.data.connection

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Wi-Fi transport: a single WebSocket to the desktop watch bridge
 * (docs/protocols/watch-websocket-protocol.md). Reconnects with a capped
 * exponential backoff for as long as the user has asked to stay connected, and
 * gives up after [MAX_RECONNECT_ATTEMPTS] so a dead endpoint doesn't retry
 * forever.
 *
 * Extracted from `WatchLinkManager` in GC-037 so the BLE transport could exist
 * alongside it behind [WatchTransportLink]; the socket lifecycle is unchanged.
 */
class WebSocketTransport(private val url: String) : WatchTransportLink {

    override val kind = WatchTransportKind.WIFI
    override var onState: ((ConnectionState, String?) -> Unit)? = null
    override var onMessage: ((String) -> Unit)? = null

    private val client = OkHttpClient.Builder().build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var attempt = 0
    private var userRequestedConnection = false

    // Set right before we close a socket ourselves, so the async onClosed/onFailure
    // callback OkHttp delivers afterwards is recognized as expected and doesn't
    // trigger a reconnect (e.g. right after pause() or a fresh start()).
    private var closeExpected = false
    private var pendingFailureCategory: String = "Connection closed"

    override fun start() {
        userRequestedConnection = true
        attempt = 0
        reconnectJob?.cancel()
        openSocket()
    }

    override fun stop() {
        userRequestedConnection = false
        reconnectJob?.cancel()
        reconnectJob = null
        closeSocket()
        onState?.invoke(ConnectionState.DISCONNECTED, null)
    }

    override fun pause() {
        reconnectJob?.cancel()
        reconnectJob = null
        closeSocket()
        if (userRequestedConnection) {
            onState?.invoke(ConnectionState.DISCONNECTED, null)
        }
    }

    override fun resume() {
        if (userRequestedConnection && webSocket == null) {
            attempt = 0
            openSocket()
        }
    }

    override fun shutdown() {
        stop()
        scope.cancel()
    }

    override fun send(message: String): Boolean = webSocket?.send(message) ?: false

    private fun openSocket() {
        closeSocket()
        onState?.invoke(
            if (attempt == 0) ConnectionState.CONNECTING else ConnectionState.RECONNECTING,
            null,
        )
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, listener)
    }

    private fun closeSocket() {
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
                onState?.invoke(ConnectionState.CONNECTED, null)
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            scope.launch { onMessage?.invoke(text) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            pendingFailureCategory = if (code == 1000) "Connection closed" else "Server closed connection"
            scope.launch { handleDisconnect() }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            pendingFailureCategory = classifyFailure(t)
            scope.launch { handleDisconnect() }
        }
    }

    /** Maps a socket exception to a short, sanitized category — no message/stack trace. */
    private fun classifyFailure(t: Throwable): String = when (t) {
        is java.net.ConnectException -> "Connection refused"
        is java.net.UnknownHostException -> "Host not found"
        is java.net.SocketTimeoutException -> "Timed out"
        is java.io.EOFException -> "Connection closed unexpectedly"
        else -> "Connection error"
    }

    private fun handleDisconnect() {
        webSocket = null
        if (closeExpected) {
            closeExpected = false
            return
        }
        if (!userRequestedConnection) {
            onState?.invoke(ConnectionState.DISCONNECTED, null)
            return
        }
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            onState?.invoke(
                ConnectionState.FAILED,
                "$pendingFailureCategory — gave up after $MAX_RECONNECT_ATTEMPTS attempts",
            )
            return
        }
        val delayMs = backoffDelayMs(attempt)
        attempt += 1
        onState?.invoke(
            ConnectionState.RECONNECTING,
            "$pendingFailureCategory — retrying ($attempt/$MAX_RECONNECT_ATTEMPTS)",
        )
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            if (userRequestedConnection) {
                openSocket()
            }
        }
    }

    private fun backoffDelayMs(attempt: Int): Long {
        val scaled = INITIAL_BACKOFF_MS shl attempt.coerceAtMost(8)
        return scaled.coerceAtMost(MAX_BACKOFF_MS)
    }

    companion object {
        private const val INITIAL_BACKOFF_MS = 1000L
        private const val MAX_BACKOFF_MS = 30_000L
        private const val MAX_RECONNECT_ATTEMPTS = 8
    }
}
