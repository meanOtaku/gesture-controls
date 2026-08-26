package com.gesturecontrols.wearwatch

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import java.util.EnumSet
import com.samsung.android.service.health.tracking.ConnectionListener
import com.samsung.android.service.health.tracking.HealthTracker
import com.samsung.android.service.health.tracking.HealthTrackerException
import com.samsung.android.service.health.tracking.HealthTrackingService
import com.samsung.android.service.health.tracking.data.DataPoint
import com.samsung.android.service.health.tracking.data.HealthTrackerType
import com.samsung.android.service.health.tracking.data.PpgType
import com.samsung.android.service.health.tracking.data.ValueKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * PPG availability, mirroring the wire states in
 * docs/watch-websocket-protocol.md's `watch.ppg_status`. Distinct from
 * [ConnectionState] — the watch can be connected to the desktop with PPG
 * unavailable or still waiting on the Samsung Health permission grant.
 */
enum class PpgState { IDLE, PERMISSION_REQUIRED, CONNECTING, STREAMING, UNAVAILABLE, ERROR }

fun PpgState.wireValue(): String = when (this) {
    PpgState.IDLE -> "idle"
    PpgState.PERMISSION_REQUIRED -> "permission_required"
    PpgState.CONNECTING -> "connecting"
    PpgState.STREAMING -> "streaming"
    PpgState.UNAVAILABLE -> "unavailable"
    PpgState.ERROR -> "error"
}

/** One PPG_CONTINUOUS reading: raw green/red/IR counts, per-channel status, and the SDK's own sample timestamp. */
data class PpgSample(
    val timestampNs: Long,
    val green: Int,
    val greenStatus: Int,
    val red: Int,
    val redStatus: Int,
    val ir: Int,
    val irStatus: Int,
)

/**
 * Wraps Samsung Health Sensor SDK 1.4.1's [HealthTrackingService] to stream raw
 * [HealthTrackerType.PPG_CONTINUOUS] samples (green/red/IR channels plus
 * per-channel status) from `ValueKey.PpgSet`.
 *
 * Galaxy Watch 4+ on Samsung Wear OS only — the tracker type is absent from
 * the SDK's `HealthTrackerCapability` on other hardware, surfaced here as
 * [PpgState.UNAVAILABLE]. This is wellness data, not a medical measurement.
 *
 * Two permission layers gate streaming: the Android runtime permission
 * `BODY_SENSORS` (checked here, requested by the caller since that needs an
 * Activity), and the SDK's own consent, reported asynchronously as
 * `HealthTracker.TrackerError.PERMISSION_ERROR` in [HealthTracker.TrackerEventListener.onError]
 * once a tracker is active.
 */
class PpgCollector(
    private val context: Context,
    private val onSamples: (List<PpgSample>) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    private var service: HealthTrackingService? = null
    private var tracker: HealthTracker? = null
    private var started: Boolean = false
    private val connectionTimeout = Runnable {
        if (started && _state.value == PpgState.CONNECTING) {
            service?.disconnectService()
            service = null
            started = false
            _diagnostic.value = "Samsung Health Sensor Service did not respond. Enable Health Sensor Service developer mode for this development build."
            _state.value = PpgState.UNAVAILABLE
        }
    }

    private val _state = MutableStateFlow(PpgState.IDLE)
    val state: StateFlow<PpgState> = _state.asStateFlow()
    private val _diagnostic = MutableStateFlow<String?>(null)
    val diagnostic: StateFlow<String?> = _diagnostic.asStateFlow()

    // Event counters, main-handler-only: flush requests/completions can drift
    // apart (a flush exception skips the completion callback), so both are
    // tracked separately rather than assumed to match.
    private var flushRequestedCount = 0
    private var flushCompletedCount = 0
    private var callbackCount = 0
    private var sampleCount = 0

    /** Must only run on [mainHandler]'s thread. Rebuilds the compact counter line and tags on the triggering event. */
    private fun updateDiagnostic(event: String) {
        _diagnostic.value =
            "flush=$flushRequestedCount/$flushCompletedCount cb=$callbackCount samples=$sampleCount · $event"
    }

    fun hasBodySensorsPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.BODY_SENSORS) ==
            PackageManager.PERMISSION_GRANTED

    /** No-op if already started. Reports [PpgState.PERMISSION_REQUIRED] without connecting if BODY_SENSORS is missing. */
    fun start() {
        if (started) return
        if (!hasBodySensorsPermission()) {
            _diagnostic.value = "Android BODY_SENSORS permission is required."
            _state.value = PpgState.PERMISSION_REQUIRED
            return
        }
        started = true
        flushRequestedCount = 0
        flushCompletedCount = 0
        callbackCount = 0
        sampleCount = 0
        _diagnostic.value = null
        _state.value = PpgState.CONNECTING
        val svc = HealthTrackingService(connectionListener, context)
        service = svc
        mainHandler.postDelayed(connectionTimeout, CONNECTION_TIMEOUT_MS)
        svc.connectService()
    }

    fun stop() {
        mainHandler.removeCallbacks(connectionTimeout)
        mainHandler.removeCallbacks(flushTick)
        started = false
        tracker?.unsetEventListener()
        tracker = null
        service?.disconnectService()
        service = null
        _state.value = PpgState.IDLE
    }

    /**
     * `PPG_CONTINUOUS` is in `HealthTracker.flush()`'s allowlist (verified via
     * the AAR's own bytecode, since its HTML docs are an empty JS shell — see
     * [OnDemandMedicalSampler]'s kdoc), unlike most continuous trackers.
     * Calling it forces the SDK to deliver its buffered samples immediately
     * instead of waiting for the screen to turn back on. Never runs faster
     * than [FLUSH_INTERVAL_MS] — the SDK doesn't need it more often, and nothing
     * here calls it off this one schedule.
     */
    private val flushTick = object : Runnable {
        override fun run() {
            flushRequestedCount++
            try {
                tracker?.flush()
                updateDiagnostic("flush requested")
            } catch (error: Exception) {
                // The SDK connection may already be gone; still surface it
                // instead of swallowing it, since a silent flush failure
                // looks identical to a healthy but quiet stream.
                updateDiagnostic("flush failed: ${error.javaClass.simpleName}: ${error.message}")
            }
            mainHandler.postDelayed(this, FLUSH_INTERVAL_MS)
        }
    }

    private val connectionListener = object : ConnectionListener {
        override fun onConnectionSuccess() {
            mainHandler.removeCallbacks(connectionTimeout)
            val svc = service
            if (!started || svc == null) {
                svc?.disconnectService()
                return
            }
            val supported = try {
                svc.trackingCapability.supportHealthTrackerTypes.contains(HealthTrackerType.PPG_CONTINUOUS)
            } catch (error: Exception) {
                false
            }
            if (!supported) {
                _diagnostic.value = "PPG_CONTINUOUS is not available. Enable Health Sensor Service developer mode, or register this app's package and signing certificate with Samsung."
                _state.value = PpgState.UNAVAILABLE
                started = false
                svc.disconnectService()
                service = null
                return
            }
            val newTracker = svc.getHealthTracker(
                HealthTrackerType.PPG_CONTINUOUS,
                EnumSet.of(PpgType.GREEN, PpgType.RED, PpgType.IR),
            )
            tracker = newTracker
            newTracker.setEventListener(trackerEventListener)
            _state.value = PpgState.STREAMING
            mainHandler.removeCallbacks(flushTick)
            mainHandler.postDelayed(flushTick, FLUSH_INTERVAL_MS)
        }

        override fun onConnectionEnded() {
            mainHandler.removeCallbacks(connectionTimeout)
            mainHandler.removeCallbacks(flushTick)
            tracker = null
            if (started) {
                // The service ended the connection on its own (e.g. Samsung Health
                // process died); reflect that PPG stopped without flipping
                // `started`, so a future start() attempt still works normally.
                started = false
                _state.value = PpgState.IDLE
            }
        }

        override fun onConnectionFailed(exception: HealthTrackerException) {
            mainHandler.removeCallbacks(connectionTimeout)
            mainHandler.removeCallbacks(flushTick)
            started = false
            service = null
            _diagnostic.value = "Samsung Health Sensor Service rejected the connection (${exception.javaClass.simpleName}). Enable developer mode for local testing."
            _state.value = PpgState.UNAVAILABLE
        }
    }

    private val trackerEventListener = object : HealthTracker.TrackerEventListener {
        override fun onDataReceived(dataPoints: MutableList<DataPoint>) {
            if (dataPoints.isEmpty()) return
            val samples = dataPoints.map { point ->
                PpgSample(
                    timestampNs = point.timestamp,
                    green = point.getValue(ValueKey.PpgSet.PPG_GREEN),
                    greenStatus = point.getValue(ValueKey.PpgSet.GREEN_STATUS),
                    red = point.getValue(ValueKey.PpgSet.PPG_RED),
                    redStatus = point.getValue(ValueKey.PpgSet.RED_STATUS),
                    ir = point.getValue(ValueKey.PpgSet.PPG_IR),
                    irStatus = point.getValue(ValueKey.PpgSet.IR_STATUS),
                )
            }
            // The SDK's callback thread isn't documented as the main looper;
            // hop explicitly so callers can treat onSamples like SensorCollector's
            // main-thread callback.
            mainHandler.post {
                callbackCount++
                sampleCount += samples.size
                updateDiagnostic("data callback")
                onSamples(samples)
            }
        }

        override fun onFlushCompleted() {
            mainHandler.post {
                flushCompletedCount++
                updateDiagnostic("flush completed")
            }
        }

        override fun onError(error: HealthTracker.TrackerError) {
            mainHandler.post {
                when (error) {
                    HealthTracker.TrackerError.PERMISSION_ERROR -> {
                        _state.value = PpgState.PERMISSION_REQUIRED
                        updateDiagnostic("tracker error: Samsung Health Sensor consent is required on the watch.")
                    }
                    HealthTracker.TrackerError.SDK_POLICY_ERROR -> {
                        _state.value = PpgState.UNAVAILABLE
                        updateDiagnostic("tracker error: Samsung SDK policy denied this build. Enable Health Sensor Service developer mode or register the app with Samsung.")
                    }
                    else -> {
                        _state.value = PpgState.ERROR
                        updateDiagnostic("tracker error: ${error.name}")
                    }
                }
            }
        }
    }

    private companion object {
        const val CONNECTION_TIMEOUT_MS = 12_000L
        const val FLUSH_INTERVAL_MS = 1_000L
    }
}
