package com.gesturecontrols.wearwatch.data.connection

import com.gesturecontrols.wearwatch.data.preferences.*
import com.gesturecontrols.wearwatch.feature.health.*
import com.gesturecontrols.wearwatch.feature.motion.*
import com.gesturecontrols.wearwatch.platform.service.*

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
import org.json.JSONObject

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING, FAILED }

/**
 * Owns the single WebSocket connection to the desktop watch bridge
 * (docs/protocols/watch-websocket-protocol.md). Reconnects with a capped exponential
 * backoff for as long as the user has asked to stay connected, and gives up
 * after [MAX_RECONNECT_ATTEMPTS] so a dead endpoint doesn't retry forever.
 */
class WatchLinkManager(private val deviceId: String = WatchProtocol.DEVICE_ID) {

    private val client = OkHttpClient.Builder().build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var webSocket: WebSocket? = null
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private var ppgFlushJob: Job? = null
    private val ppgBuffer = mutableListOf<PpgSample>()
    @Volatile private var lastPpgStatus: String? = null
    private var medicalFlushJob: Job? = null
    private val heartRateBuffer = mutableListOf<HeartRateSample>()
    private val skinTemperatureBuffer = mutableListOf<SkinTemperatureSample>()
    private val edaBuffer = mutableListOf<EdaSample>()
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

    /** Forwards a `desktop.start_measurement`/`desktop.stop_measurement` command; wired by MainActivity to [OnDemandMedicalSampler]. */
    var onMeasurementCommand: ((tracker: String, start: Boolean) -> Unit)? = null

    /** Forwards a `desktop.set_sensor` command; wired by MainActivity to [SensorCollector]/[MedicalContinuousCollector]. */
    var onSensorControlCommand: ((sensor: String, enabled: Boolean) -> Unit)? = null

    /** Forwards a `desktop.set_sensor_rate` command; wired by MainActivity to [SensorCollector]. */
    var onSensorRateCommand: ((sensor: String, rateHz: Double) -> Unit)? = null

    /** Forwards a validated `desktop.haptic` command; wired by MainActivity to a context-owned Vibrator. */
    var onHapticCommand: ((durationMs: Int) -> Unit)? = null

    private val _state = MutableStateFlow(ConnectionState.DISCONNECTED)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _lastOrientationSequence = MutableStateFlow(0L)
    val lastOrientationSequence: StateFlow<Long> = _lastOrientationSequence.asStateFlow()

    // Short, sanitized category (never a raw exception message/stack trace,
    // which could echo internal detail beyond the LAN endpoint already shown
    // in the UI) describing the most recent socket failure/retry.
    private val _lastFailureReason = MutableStateFlow<String?>(null)
    val lastFailureReason: StateFlow<String?> = _lastFailureReason.asStateFlow()
    private var pendingFailureCategory: String = "Connection closed"

    fun connect(url: String) {
        userRequestedConnection = true
        currentUrl = url
        attempt = 0
        _lastFailureReason.value = null
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
        _lastFailureReason.value = null
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

    /** Buffers raw PPG samples for the next flush tick; dropped if not connected. */
    fun enqueuePpgSamples(samples: List<PpgSample>) {
        if (samples.isEmpty()) return
        if (_state.value != ConnectionState.CONNECTED) return
        synchronized(ppgBuffer) { ppgBuffer.addAll(samples) }
    }

    /** Reports [PpgState] to the desktop; independent of the PPG sample buffer. */
    fun sendPpgStatus(state: String) {
        lastPpgStatus = state
        sendStoredPpgStatus()
    }

    private fun sendStoredPpgStatus() {
        val state = lastPpgStatus ?: return
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        socket.send(WatchProtocol.ppgStatusMessage(deviceId, seq, timestampNs, state))
    }

    /** Sends a STEM button press/release, grabbing or releasing the desktop's volume overlay. */
    fun sendButtonEvent(pressed: Boolean) {
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        val buttonState = if (pressed) WatchProtocol.BUTTON_STATE_DOWN else WatchProtocol.BUTTON_STATE_UP
        socket.send(WatchProtocol.buttonMessage(deviceId, seq, timestampNs, buttonState))
    }

    /** Sends an already-classified pinch transition; no local or desktop control behavior is implied. */
    fun sendPinchEvent(
        phase: WatchProtocol.PinchPhase,
        confidence: Double,
        modelId: String,
        timestampNs: Long,
    ) {
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        val seq = sequence.incrementAndGet()
        socket.send(
            WatchProtocol.pinchMessage(
                deviceId,
                seq,
                timestampNs,
                phase,
                confidence,
                modelId,
            ),
        )
    }

    /** Buffers HEART_RATE_CONTINUOUS samples for the next medical flush tick; dropped if not connected. */
    fun enqueueHeartRateSamples(samples: List<HeartRateSample>) {
        if (samples.isEmpty()) return
        if (_state.value != ConnectionState.CONNECTED) return
        synchronized(heartRateBuffer) { heartRateBuffer.addAll(samples) }
    }

    /** Buffers SKIN_TEMPERATURE_CONTINUOUS samples for the next medical flush tick; dropped if not connected. */
    fun enqueueSkinTemperatureSamples(samples: List<SkinTemperatureSample>) {
        if (samples.isEmpty()) return
        if (_state.value != ConnectionState.CONNECTED) return
        synchronized(skinTemperatureBuffer) { skinTemperatureBuffer.addAll(samples) }
    }

    /** Buffers EDA_CONTINUOUS samples for the next medical flush tick; dropped if not connected. */
    fun enqueueEdaSamples(samples: List<EdaSample>) {
        if (samples.isEmpty()) return
        if (_state.value != ConnectionState.CONNECTED) return
        synchronized(edaBuffer) { edaBuffer.addAll(samples) }
    }

    /** Sends a bounded SPO2_ON_DEMAND session's samples immediately; on-demand data is low-volume, unlike the continuous trackers. */
    fun sendSpo2Samples(samples: List<Spo2Sample>) {
        if (samples.isEmpty()) return
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        for (chunk in samples.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            socket.send(WatchProtocol.spo2BatchMessage(deviceId, seq, timestampNs, chunk))
        }
    }

    /** Sends a bounded ECG_ON_DEMAND session's samples immediately; see [sendSpo2Samples]. */
    fun sendEcgSamples(samples: List<EcgSample>) {
        if (samples.isEmpty()) return
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        for (chunk in samples.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            socket.send(WatchProtocol.ecgBatchMessage(deviceId, seq, timestampNs, chunk))
        }
    }

    /** Sends a bounded SWEAT_LOSS session's samples immediately; see [sendSpo2Samples]. */
    fun sendSweatLossSamples(samples: List<SweatLossSample>) {
        if (samples.isEmpty()) return
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        for (chunk in samples.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            socket.send(WatchProtocol.sweatLossBatchMessage(deviceId, seq, timestampNs, chunk))
        }
    }

    /** Sends a BIA_ON_DEMAND progress/result update from the current bounded session. */
    fun sendBiaResult(result: BiaResult) {
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        socket.send(WatchProtocol.biaResultMessage(deviceId, seq, timestampNs, result))
    }

    /** Reports a medical tracker's [MedicalTrackerState.wireValue], continuous or on-demand, supported or not. */
    fun sendMedicalStatus(tracker: String, state: String) {
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        socket.send(WatchProtocol.medicalStatusMessage(deviceId, seq, timestampNs, tracker, state))
    }

    /** Reports an IMU sensor's current enabled state ([SENSOR_ORIENTATION] etc.). */
    fun sendSensorStatus(sensor: String, enabled: Boolean) {
        val socket = webSocket ?: return
        if (_state.value != ConnectionState.CONNECTED) return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        socket.send(WatchProtocol.sensorStatusMessage(deviceId, seq, timestampNs, sensor, enabled))
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
        ppgFlushJob?.cancel()
        ppgFlushJob = null
        synchronized(ppgBuffer) { ppgBuffer.clear() }
        medicalFlushJob?.cancel()
        medicalFlushJob = null
        synchronized(heartRateBuffer) { heartRateBuffer.clear() }
        synchronized(skinTemperatureBuffer) { skinTemperatureBuffer.clear() }
        synchronized(edaBuffer) { edaBuffer.clear() }
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
                _lastFailureReason.value = null
                sendStoredPpgStatus()
                startHeartbeat()
                startPpgFlushTimer()
                startMedicalFlushTimer()
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            scope.launch { handleInbound(text) }
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

    private fun handleInbound(text: String) {
        val message = WatchProtocol.parseInbound(text) ?: return
        when (message.type) {
            WatchProtocol.TYPE_DESKTOP_TIME_SYNC -> handleTimeSync(message.payload)
            WatchProtocol.TYPE_DESKTOP_START_MEASUREMENT -> dispatchMeasurementCommand(message.payload, start = true)
            WatchProtocol.TYPE_DESKTOP_STOP_MEASUREMENT -> dispatchMeasurementCommand(message.payload, start = false)
            WatchProtocol.TYPE_DESKTOP_SET_SENSOR -> dispatchSensorControlCommand(message.payload)
            WatchProtocol.TYPE_DESKTOP_SET_SENSOR_RATE -> dispatchSensorRateCommand(message.payload)
            WatchProtocol.TYPE_DESKTOP_HAPTIC -> dispatchHapticCommand(message.payload)
        }
    }

    private fun handleTimeSync(payload: JSONObject) {
        val desktopTimeNs = payload.optLong("desktopTimeNs", -1L)
        if (desktopTimeNs < 0) return
        val watchTimeNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        val reply = WatchProtocol.timeSyncMessage(deviceId, seq, watchTimeNs, desktopTimeNs, watchTimeNs)
        webSocket?.send(reply)
    }

    /** Forwards a `desktop.start_measurement`/`desktop.stop_measurement` command to [onMeasurementCommand]; ignored if `tracker` is missing. */
    private fun dispatchMeasurementCommand(payload: JSONObject, start: Boolean) {
        val tracker = payload.optString("tracker", "")
        if (tracker.isEmpty()) return
        onMeasurementCommand?.invoke(tracker, start)
    }

    /** Forwards a `desktop.set_sensor` command to [onSensorControlCommand]; ignored if `sensor` is missing. */
    private fun dispatchSensorControlCommand(payload: JSONObject) {
        val sensor = payload.optString("sensor", "")
        if (sensor.isEmpty()) return
        val enabled = payload.optBoolean("enabled", true)
        onSensorControlCommand?.invoke(sensor, enabled)
    }

    /** Forwards a `desktop.set_sensor_rate` command to [onSensorRateCommand]; ignored if `sensor`/`rateHz` are missing or non-positive. */
    private fun dispatchSensorRateCommand(payload: JSONObject) {
        val sensor = payload.optString("sensor", "")
        if (sensor.isEmpty()) return
        val rateHz = payload.optDouble("rateHz", -1.0)
        if (rateHz <= 0.0 || rateHz.isNaN()) return
        onSensorRateCommand?.invoke(sensor, rateHz)
    }

    /** Forwards a `desktop.haptic` command to [onHapticCommand]; ignored if `durationMs` is missing or outside the protocol's allowed bounds. */
    private fun dispatchHapticCommand(payload: JSONObject) {
        val durationMs = payload.optInt("durationMs", -1)
        if (durationMs < WatchProtocol.MIN_HAPTIC_DURATION_MS || durationMs > WatchProtocol.MAX_HAPTIC_DURATION_MS) return
        onHapticCommand?.invoke(durationMs)
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

    private fun startPpgFlushTimer() {
        ppgFlushJob?.cancel()
        ppgFlushJob = scope.launch {
            while (isActive) {
                delay(PPG_DELIVERY_INTERVAL_MS)
                flushPpgBuffer()
            }
        }
    }

    private fun flushPpgBuffer() {
        val batch = synchronized(ppgBuffer) {
            if (ppgBuffer.isEmpty()) return
            val copy = ppgBuffer.toList()
            ppgBuffer.clear()
            copy
        }
        val socket = webSocket ?: return
        for (chunk in batch.chunked(PPG_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            socket.send(WatchProtocol.ppgBatchMessage(deviceId, seq, timestampNs, chunk))
        }
    }

    private fun startMedicalFlushTimer() {
        medicalFlushJob?.cancel()
        medicalFlushJob = scope.launch {
            while (isActive) {
                delay(PPG_BATCH_INTERVAL_MS)
                flushMedicalBuffers()
            }
        }
    }

    private fun flushMedicalBuffers() {
        val socket = webSocket ?: return
        val heartRateBatch = synchronized(heartRateBuffer) {
            if (heartRateBuffer.isEmpty()) null else heartRateBuffer.toList().also { heartRateBuffer.clear() }
        }
        heartRateBatch?.let { batch ->
            for (chunk in batch.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
                val timestampNs = SystemClock.elapsedRealtimeNanos()
                val seq = sequence.incrementAndGet()
                socket.send(WatchProtocol.heartRateBatchMessage(deviceId, seq, timestampNs, chunk))
            }
        }

        val skinTemperatureBatch = synchronized(skinTemperatureBuffer) {
            if (skinTemperatureBuffer.isEmpty()) {
                null
            } else {
                skinTemperatureBuffer.toList().also { skinTemperatureBuffer.clear() }
            }
        }
        skinTemperatureBatch?.let { batch ->
            for (chunk in batch.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
                val timestampNs = SystemClock.elapsedRealtimeNanos()
                val seq = sequence.incrementAndGet()
                socket.send(WatchProtocol.skinTemperatureBatchMessage(deviceId, seq, timestampNs, chunk))
            }
        }

        val edaBatch = synchronized(edaBuffer) {
            if (edaBuffer.isEmpty()) null else edaBuffer.toList().also { edaBuffer.clear() }
        }
        edaBatch?.let { batch ->
            for (chunk in batch.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
                val timestampNs = SystemClock.elapsedRealtimeNanos()
                val seq = sequence.incrementAndGet()
                socket.send(WatchProtocol.edaBatchMessage(deviceId, seq, timestampNs, chunk))
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
            _lastFailureReason.value = null
            return
        }
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            _state.value = ConnectionState.FAILED
            _lastFailureReason.value = "$pendingFailureCategory — gave up after $MAX_RECONNECT_ATTEMPTS attempts"
            return
        }
        val delayMs = backoffDelayMs(attempt)
        attempt += 1
        _state.value = ConnectionState.RECONNECTING
        _lastFailureReason.value = "$pendingFailureCategory — retrying ($attempt/$MAX_RECONNECT_ATTEMPTS)"
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
        private const val PPG_DELIVERY_INTERVAL_MS = 40L
        private const val PPG_BATCH_INTERVAL_MS = 100L
        private const val PPG_BATCH_MAX_SAMPLES = 32
        private const val MEDICAL_BATCH_MAX_SAMPLES = 32
    }
}
