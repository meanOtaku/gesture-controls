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
import org.json.JSONObject

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,

    /** BLE only: a central is connected and bonded but not yet approved on the watch. */
    AWAITING_TRUST,
    FAILED,
}

/**
 * Owns the single link to the desktop — Wi-Fi WebSocket or Bluetooth LE,
 * whichever [WatchTransportLink] the user selected — and everything layered on
 * top of it: envelope construction, sequencing, the heartbeat, and the batched
 * PPG/medical flush timers (docs/protocols/watch-websocket-protocol.md,
 * docs/protocols/watch-ble-transport.md).
 *
 * The transport itself owns connection establishment and its own retry policy;
 * this class never reaches past [WatchTransportLink], and never substitutes one
 * transport for another.
 */
class WatchLinkManager(deviceId: String = WatchProtocol.DEVICE_ID) {

    /**
     * The id stamped on every outgoing envelope. Set to the install's persisted
     * id (`ConnectionPrefs.deviceId`) as soon as preferences exist; the
     * constructor default is only the pre-initialisation fallback. Over
     * Bluetooth the desktop ignores it in favour of the peripheral's identity.
     */
    @Volatile
    var deviceId: String = deviceId

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var link: WatchTransportLink? = null
    private var heartbeatJob: Job? = null
    private var ppgFlushJob: Job? = null
    private val ppgBuffer = mutableListOf<PpgSample>()
    @Volatile private var lastPpgStatus: String? = null
    private var medicalFlushJob: Job? = null
    private val heartRateBuffer = mutableListOf<HeartRateSample>()
    private val skinTemperatureBuffer = mutableListOf<SkinTemperatureSample>()
    private val edaBuffer = mutableListOf<EdaSample>()
    private val sequence = AtomicLong(0)

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
    // which could echo internal detail beyond the endpoint already shown in
    // the UI) describing the most recent link failure/retry.
    private val _lastFailureReason = MutableStateFlow<String?>(null)
    val lastFailureReason: StateFlow<String?> = _lastFailureReason.asStateFlow()

    /** Which transport is currently installed, or null when disconnected. */
    val activeTransport: WatchTransportKind?
        get() = link?.kind

    /**
     * Installs [transport] as the one active link and starts it, replacing and
     * fully releasing whatever was installed before. Switching transports
     * therefore cannot leave the previous one holding a socket, an mDNS
     * registration, or an advertising GATT server in the background.
     */
    fun connect(transport: WatchTransportLink) {
        val previous = link
        if (previous !== transport) {
            previous?.onState = null
            previous?.onMessage = null
            previous?.shutdown()
        }
        resetStreamingState()
        link = transport
        transport.onState = { state, reason -> scope.launch { handleState(state, reason) } }
        transport.onMessage = { text -> scope.launch { handleInbound(text) } }
        _lastFailureReason.value = null
        transport.start()
    }

    /** User-initiated stop: the transport releases everything and does not retry. */
    fun disconnect() {
        resetStreamingState()
        link?.stop()
        _state.value = ConnectionState.DISCONNECTED
        _lastFailureReason.value = null
    }

    /** Call from Activity#onDestroy to release the coroutine scope and transport resources. */
    fun shutdown() {
        resetStreamingState()
        link?.onState = null
        link?.onMessage = null
        link?.shutdown()
        link = null
        _state.value = ConnectionState.DISCONNECTED
        scope.cancel()
    }

    /**
     * Releases the link when the activity leaves the foreground without
     * forgetting that the user wants a connection, so [resumeForLifecycle] can
     * re-establish it.
     */
    fun pauseForLifecycle() {
        link?.pause()
    }

    /** Re-establishes the connection if the user had requested one before the activity paused. */
    fun resumeForLifecycle() {
        link?.resume()
    }

    fun sendOrientation(
        quaternion: FloatArray,
        accelerometer: FloatArray?,
        gyroscope: FloatArray?,
        timestampNs: Long,
    ) {
        val link = streamingLink() ?: return
        val seq = sequence.incrementAndGet()
        val message = WatchProtocol.orientationMessage(
            deviceId,
            seq,
            timestampNs,
            quaternion,
            accelerometer,
            gyroscope,
        )
        link.send(message)
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
        val link = streamingLink() ?: return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        link.send(WatchProtocol.ppgStatusMessage(deviceId, seq, timestampNs, state))
    }

    /** Sends a STEM button press/release, grabbing or releasing the desktop's volume overlay. */
    fun sendButtonEvent(pressed: Boolean) {
        val link = streamingLink() ?: return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        val buttonState = if (pressed) WatchProtocol.BUTTON_STATE_DOWN else WatchProtocol.BUTTON_STATE_UP
        link.send(WatchProtocol.buttonMessage(deviceId, seq, timestampNs, buttonState))
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
        val link = streamingLink() ?: return
        for (chunk in samples.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            link.send(WatchProtocol.spo2BatchMessage(deviceId, seq, timestampNs, chunk))
        }
    }

    /** Sends a bounded ECG_ON_DEMAND session's samples immediately; see [sendSpo2Samples]. */
    fun sendEcgSamples(samples: List<EcgSample>) {
        if (samples.isEmpty()) return
        val link = streamingLink() ?: return
        for (chunk in samples.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            link.send(WatchProtocol.ecgBatchMessage(deviceId, seq, timestampNs, chunk))
        }
    }

    /** Sends a bounded SWEAT_LOSS session's samples immediately; see [sendSpo2Samples]. */
    fun sendSweatLossSamples(samples: List<SweatLossSample>) {
        if (samples.isEmpty()) return
        val link = streamingLink() ?: return
        for (chunk in samples.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            link.send(WatchProtocol.sweatLossBatchMessage(deviceId, seq, timestampNs, chunk))
        }
    }

    /** Sends a BIA_ON_DEMAND progress/result update from the current bounded session. */
    fun sendBiaResult(result: BiaResult) {
        val link = streamingLink() ?: return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        link.send(WatchProtocol.biaResultMessage(deviceId, seq, timestampNs, result))
    }

    /** Reports a medical tracker's [MedicalTrackerState.wireValue], continuous or on-demand, supported or not. */
    fun sendMedicalStatus(tracker: String, state: String) {
        val link = streamingLink() ?: return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        link.send(WatchProtocol.medicalStatusMessage(deviceId, seq, timestampNs, tracker, state))
    }

    /** Reports an IMU sensor's current enabled state ([SENSOR_ORIENTATION] etc.). */
    fun sendSensorStatus(sensor: String, enabled: Boolean) {
        val link = streamingLink() ?: return
        val timestampNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        link.send(WatchProtocol.sensorStatusMessage(deviceId, seq, timestampNs, sensor, enabled))
    }

    /** The active link, but only while it is actually carrying traffic. */
    private fun streamingLink(): WatchTransportLink? =
        if (_state.value == ConnectionState.CONNECTED) link else null

    /**
     * Applies a transport-reported state change: a fresh CONNECTED restarts the
     * sequence and the periodic senders; anything else tears them down so no
     * timer keeps firing against a dead link.
     */
    private fun handleState(state: ConnectionState, reason: String?) {
        val wasConnected = _state.value == ConnectionState.CONNECTED
        _state.value = state
        _lastFailureReason.value = reason
        if (state == ConnectionState.CONNECTED) {
            if (!wasConnected) {
                sequence.set(0)
                startHeartbeat()
                startPpgFlushTimer()
                startMedicalFlushTimer()
                sendStoredPpgStatus()
            }
        } else {
            resetStreamingState()
        }
    }

    /** Stops the periodic senders and drops every buffered batch. */
    private fun resetStreamingState() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        ppgFlushJob?.cancel()
        ppgFlushJob = null
        medicalFlushJob?.cancel()
        medicalFlushJob = null
        synchronized(ppgBuffer) { ppgBuffer.clear() }
        synchronized(heartRateBuffer) { heartRateBuffer.clear() }
        synchronized(skinTemperatureBuffer) { skinTemperatureBuffer.clear() }
        synchronized(edaBuffer) { edaBuffer.clear() }
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
        val link = streamingLink() ?: return
        val watchTimeNs = SystemClock.elapsedRealtimeNanos()
        val seq = sequence.incrementAndGet()
        link.send(WatchProtocol.timeSyncMessage(deviceId, seq, watchTimeNs, desktopTimeNs, watchTimeNs))
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
                val link = streamingLink()
                if (link != null) {
                    val timestampNs = SystemClock.elapsedRealtimeNanos()
                    val seq = sequence.incrementAndGet()
                    link.send(
                        WatchProtocol.heartbeatMessage(
                            deviceId,
                            seq,
                            timestampNs,
                            batteryPercentProvider?.invoke(),
                        )
                    )
                }
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
        val link = streamingLink() ?: return
        for (chunk in batch.chunked(PPG_BATCH_MAX_SAMPLES)) {
            val timestampNs = SystemClock.elapsedRealtimeNanos()
            val seq = sequence.incrementAndGet()
            link.send(WatchProtocol.ppgBatchMessage(deviceId, seq, timestampNs, chunk))
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
        val link = streamingLink() ?: return
        val heartRateBatch = synchronized(heartRateBuffer) {
            if (heartRateBuffer.isEmpty()) null else heartRateBuffer.toList().also { heartRateBuffer.clear() }
        }
        heartRateBatch?.let { batch ->
            for (chunk in batch.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
                val timestampNs = SystemClock.elapsedRealtimeNanos()
                val seq = sequence.incrementAndGet()
                link.send(WatchProtocol.heartRateBatchMessage(deviceId, seq, timestampNs, chunk))
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
                link.send(WatchProtocol.skinTemperatureBatchMessage(deviceId, seq, timestampNs, chunk))
            }
        }

        val edaBatch = synchronized(edaBuffer) {
            if (edaBuffer.isEmpty()) null else edaBuffer.toList().also { edaBuffer.clear() }
        }
        edaBatch?.let { batch ->
            for (chunk in batch.chunked(MEDICAL_BATCH_MAX_SAMPLES)) {
                val timestampNs = SystemClock.elapsedRealtimeNanos()
                val seq = sequence.incrementAndGet()
                link.send(WatchProtocol.edaBatchMessage(deviceId, seq, timestampNs, chunk))
            }
        }
    }

    companion object {
        private const val HEARTBEAT_INTERVAL_MS = 1000L
        private const val PPG_DELIVERY_INTERVAL_MS = 40L
        private const val PPG_BATCH_INTERVAL_MS = 100L
        private const val PPG_BATCH_MAX_SAMPLES = 32
        private const val MEDICAL_BATCH_MAX_SAMPLES = 32
    }
}
