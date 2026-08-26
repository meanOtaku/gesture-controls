package com.gesturecontrols.wearwatch

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.samsung.android.service.health.tracking.ConnectionListener
import com.samsung.android.service.health.tracking.HealthTracker
import com.samsung.android.service.health.tracking.HealthTrackerException
import com.samsung.android.service.health.tracking.HealthTrackingService
import com.samsung.android.service.health.tracking.data.DataPoint
import com.samsung.android.service.health.tracking.data.HealthTrackerType
import com.samsung.android.service.health.tracking.data.ValueKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One HEART_RATE_CONTINUOUS reading; `ibiMs`/`ibiStatus` may each list more than one inter-beat interval. */
data class HeartRateSample(
    val timestampNs: Long,
    val heartRate: Int,
    val heartRateStatus: Int,
    val ibiMs: List<Int>,
    val ibiStatus: List<Int>,
)

/** One SKIN_TEMPERATURE_CONTINUOUS reading. */
data class SkinTemperatureSample(
    val timestampNs: Long,
    val objectTemperatureCelsius: Double,
    val ambientTemperatureCelsius: Double,
    val status: Int,
)

/** One EDA_CONTINUOUS reading (skin conductance). Not available on every Galaxy Watch model. */
data class EdaSample(
    val timestampNs: Long,
    val skinConductanceMicrosiemens: Double,
    val status: Int,
)

/**
 * Wraps a single Samsung Health Sensor SDK 1.4.1 [HealthTrackingService]
 * connection to stream every continuously-accessible medical tracker this
 * SDK exposes: `HEART_RATE_CONTINUOUS`, `SKIN_TEMPERATURE_CONTINUOUS`, and
 * `EDA_CONTINUOUS`. Each is capability-gated independently — a watch can
 * support heart rate but not EDA, for example — so [state] is keyed by the
 * protocol's tracker ids ([TRACKER_HEART_RATE_CONTINUOUS] etc.) rather than
 * being a single aggregate state, mirroring [PpgCollector]'s state machine
 * but per-tracker.
 *
 * Same two-layer permission model as [PpgCollector]: Android's `BODY_SENSORS`
 * runtime permission (checked here) and the SDK's own consent, reported
 * asynchronously via [HealthTracker.TrackerError.PERMISSION_ERROR].
 */
class MedicalContinuousCollector(
    private val context: Context,
    private val onHeartRate: (List<HeartRateSample>) -> Unit,
    private val onSkinTemperature: (List<SkinTemperatureSample>) -> Unit,
    private val onEda: (List<EdaSample>) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    private var service: HealthTrackingService? = null
    private var heartRateTracker: HealthTracker? = null
    private var skinTemperatureTracker: HealthTracker? = null
    private var edaTracker: HealthTracker? = null
    private var started = false

    // Desktop-controlled per-tracker toggles (`desktop.set_sensor`); all on by
    // default so existing start()/stop() behavior is unchanged until the
    // desktop explicitly disables one. Persisted across stop()/start() like
    // SensorCollector's IMU enabled flags.
    private var heartRateEnabled = true
    private var skinTemperatureEnabled = true
    private var edaEnabled = true

    // Populated from the SDK's capability query on each connection, so a
    // later setTrackerEnabled() re-enable can re-acquire a tracker without
    // reconnecting the whole service.
    private var supportedTypes: Set<HealthTrackerType> = emptySet()

    private val _state = MutableStateFlow(
        mapOf(
            TRACKER_HEART_RATE_CONTINUOUS to MedicalTrackerState.IDLE,
            TRACKER_SKIN_TEMPERATURE_CONTINUOUS to MedicalTrackerState.IDLE,
            TRACKER_EDA_CONTINUOUS to MedicalTrackerState.IDLE,
        ),
    )
    val state: StateFlow<Map<String, MedicalTrackerState>> = _state.asStateFlow()

    fun hasBodySensorsPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.BODY_SENSORS) ==
            PackageManager.PERMISSION_GRANTED

    /** No-op if already started. Reports [MedicalTrackerState.PERMISSION_REQUIRED] on every tracker without connecting if BODY_SENSORS is missing. */
    fun start() {
        if (started) return
        if (!hasBodySensorsPermission()) {
            setAllStates(MedicalTrackerState.PERMISSION_REQUIRED)
            return
        }
        started = true
        setAllStates(MedicalTrackerState.CONNECTING)
        val svc = HealthTrackingService(connectionListener, context)
        service = svc
        svc.connectService()
    }

    fun stop() {
        started = false
        heartRateTracker?.unsetEventListener()
        heartRateTracker = null
        skinTemperatureTracker?.unsetEventListener()
        skinTemperatureTracker = null
        edaTracker?.unsetEventListener()
        edaTracker = null
        supportedTypes = emptySet()
        service?.disconnectService()
        service = null
        setAllStates(MedicalTrackerState.IDLE)
    }

    /**
     * Desktop-controlled enable/disable for a single continuous tracker
     * ([TRACKER_HEART_RATE_CONTINUOUS] etc.), applied immediately if a
     * connection is active, and remembered for the next [start] otherwise.
     * Disabling reports [MedicalTrackerState.IDLE], mirroring how the desktop
     * reads a continuous tracker's enabled state off `medical_status` rather
     * than a separate `watch.sensor_status` message.
     */
    fun setTrackerEnabled(trackerId: String, enabled: Boolean) {
        when (trackerId) {
            TRACKER_HEART_RATE_CONTINUOUS -> {
                heartRateEnabled = enabled
                applyHeartRateTracker()
            }
            TRACKER_SKIN_TEMPERATURE_CONTINUOUS -> {
                skinTemperatureEnabled = enabled
                applySkinTemperatureTracker()
            }
            TRACKER_EDA_CONTINUOUS -> {
                edaEnabled = enabled
                applyEdaTracker()
            }
        }
    }

    private fun applyHeartRateTracker() {
        val svc = service
        if (!started || svc == null) return
        if (heartRateEnabled) {
            if (heartRateTracker == null && supportedTypes.contains(HealthTrackerType.HEART_RATE_CONTINUOUS)) {
                val tracker = svc.getHealthTracker(HealthTrackerType.HEART_RATE_CONTINUOUS)
                heartRateTracker = tracker
                tracker.setEventListener(heartRateEventListener)
                setState(TRACKER_HEART_RATE_CONTINUOUS, MedicalTrackerState.STREAMING)
            }
        } else {
            heartRateTracker?.unsetEventListener()
            heartRateTracker = null
            setState(TRACKER_HEART_RATE_CONTINUOUS, MedicalTrackerState.IDLE)
        }
    }

    private fun applySkinTemperatureTracker() {
        val svc = service
        if (!started || svc == null) return
        if (skinTemperatureEnabled) {
            if (skinTemperatureTracker == null &&
                supportedTypes.contains(HealthTrackerType.SKIN_TEMPERATURE_CONTINUOUS)
            ) {
                val tracker = svc.getHealthTracker(HealthTrackerType.SKIN_TEMPERATURE_CONTINUOUS)
                skinTemperatureTracker = tracker
                tracker.setEventListener(skinTemperatureEventListener)
                setState(TRACKER_SKIN_TEMPERATURE_CONTINUOUS, MedicalTrackerState.STREAMING)
            }
        } else {
            skinTemperatureTracker?.unsetEventListener()
            skinTemperatureTracker = null
            setState(TRACKER_SKIN_TEMPERATURE_CONTINUOUS, MedicalTrackerState.IDLE)
        }
    }

    private fun applyEdaTracker() {
        val svc = service
        if (!started || svc == null) return
        if (edaEnabled) {
            if (edaTracker == null && supportedTypes.contains(HealthTrackerType.EDA_CONTINUOUS)) {
                val tracker = svc.getHealthTracker(HealthTrackerType.EDA_CONTINUOUS)
                edaTracker = tracker
                tracker.setEventListener(edaEventListener)
                setState(TRACKER_EDA_CONTINUOUS, MedicalTrackerState.STREAMING)
            }
        } else {
            edaTracker?.unsetEventListener()
            edaTracker = null
            setState(TRACKER_EDA_CONTINUOUS, MedicalTrackerState.IDLE)
        }
    }

    private fun setAllStates(state: MedicalTrackerState) {
        _state.value = _state.value.mapValues { state }
    }

    private fun setState(trackerId: String, state: MedicalTrackerState) {
        _state.value = _state.value.toMutableMap().apply { put(trackerId, state) }
    }

    private val connectionListener = object : ConnectionListener {
        override fun onConnectionSuccess() {
            val svc = service
            if (!started || svc == null) {
                svc?.disconnectService()
                return
            }
            supportedTypes = try {
                svc.trackingCapability.supportHealthTrackerTypes.toSet()
            } catch (error: Exception) {
                emptySet()
            }
            if (supportedTypes.contains(HealthTrackerType.HEART_RATE_CONTINUOUS)) {
                applyHeartRateTracker()
            } else {
                setState(TRACKER_HEART_RATE_CONTINUOUS, MedicalTrackerState.UNAVAILABLE)
            }
            if (supportedTypes.contains(HealthTrackerType.SKIN_TEMPERATURE_CONTINUOUS)) {
                applySkinTemperatureTracker()
            } else {
                setState(TRACKER_SKIN_TEMPERATURE_CONTINUOUS, MedicalTrackerState.UNAVAILABLE)
            }
            if (supportedTypes.contains(HealthTrackerType.EDA_CONTINUOUS)) {
                applyEdaTracker()
            } else {
                setState(TRACKER_EDA_CONTINUOUS, MedicalTrackerState.UNAVAILABLE)
            }
        }

        override fun onConnectionEnded() {
            heartRateTracker = null
            skinTemperatureTracker = null
            edaTracker = null
            if (started) {
                // The service ended the connection on its own; reflect that
                // without flipping `started`, so a future start() still works.
                started = false
                setAllStates(MedicalTrackerState.IDLE)
            }
        }

        override fun onConnectionFailed(exception: HealthTrackerException) {
            started = false
            service = null
            setAllStates(MedicalTrackerState.UNAVAILABLE)
        }
    }

    private val heartRateEventListener = object : HealthTracker.TrackerEventListener {
        override fun onDataReceived(dataPoints: MutableList<DataPoint>) {
            if (dataPoints.isEmpty()) return
            val samples = dataPoints.map { point ->
                HeartRateSample(
                    timestampNs = point.timestamp,
                    heartRate = point.getValue(ValueKey.HeartRateSet.HEART_RATE),
                    heartRateStatus = point.getValue(ValueKey.HeartRateSet.HEART_RATE_STATUS),
                    ibiMs = point.getValue(ValueKey.HeartRateSet.IBI_LIST),
                    ibiStatus = point.getValue(ValueKey.HeartRateSet.IBI_STATUS_LIST),
                )
            }
            mainHandler.post { onHeartRate(samples) }
        }

        override fun onFlushCompleted() = Unit

        override fun onError(error: HealthTracker.TrackerError) {
            mainHandler.post { setState(TRACKER_HEART_RATE_CONTINUOUS, trackerErrorState(error)) }
        }
    }

    private val skinTemperatureEventListener = object : HealthTracker.TrackerEventListener {
        override fun onDataReceived(dataPoints: MutableList<DataPoint>) {
            if (dataPoints.isEmpty()) return
            val samples = dataPoints.map { point ->
                SkinTemperatureSample(
                    timestampNs = point.timestamp,
                    objectTemperatureCelsius =
                        point.getValue(ValueKey.SkinTemperatureSet.OBJECT_TEMPERATURE).toDouble(),
                    ambientTemperatureCelsius =
                        point.getValue(ValueKey.SkinTemperatureSet.AMBIENT_TEMPERATURE).toDouble(),
                    status = point.getValue(ValueKey.SkinTemperatureSet.STATUS),
                )
            }
            mainHandler.post { onSkinTemperature(samples) }
        }

        override fun onFlushCompleted() = Unit

        override fun onError(error: HealthTracker.TrackerError) {
            mainHandler.post { setState(TRACKER_SKIN_TEMPERATURE_CONTINUOUS, trackerErrorState(error)) }
        }
    }

    private val edaEventListener = object : HealthTracker.TrackerEventListener {
        override fun onDataReceived(dataPoints: MutableList<DataPoint>) {
            if (dataPoints.isEmpty()) return
            val samples = dataPoints.map { point ->
                EdaSample(
                    timestampNs = point.timestamp,
                    skinConductanceMicrosiemens = point.getValue(ValueKey.EdaSet.SKIN_CONDUCTANCE).toDouble(),
                    status = point.getValue(ValueKey.EdaSet.STATUS),
                )
            }
            mainHandler.post { onEda(samples) }
        }

        override fun onFlushCompleted() = Unit

        override fun onError(error: HealthTracker.TrackerError) {
            mainHandler.post { setState(TRACKER_EDA_CONTINUOUS, trackerErrorState(error)) }
        }
    }

    private fun trackerErrorState(error: HealthTracker.TrackerError): MedicalTrackerState = when (error) {
        HealthTracker.TrackerError.PERMISSION_ERROR -> MedicalTrackerState.PERMISSION_REQUIRED
        HealthTracker.TrackerError.SDK_POLICY_ERROR -> MedicalTrackerState.UNAVAILABLE
        else -> MedicalTrackerState.ERROR
    }
}
