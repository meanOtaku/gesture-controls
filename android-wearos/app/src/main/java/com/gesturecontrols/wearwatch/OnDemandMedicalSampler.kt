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
import com.samsung.android.service.health.tracking.data.PpgType
import com.samsung.android.service.health.tracking.data.ValueKey
import java.util.EnumSet
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One SPO2_ON_DEMAND reading from a bounded measurement session. Wellness data, not a diagnostic pulse oximeter reading. */
data class Spo2Sample(
    val timestampNs: Long,
    val spo2: Int,
    val heartRate: Int,
    val accuracyFlag: Int,
    val status: Int,
)

/** One ECG_ON_DEMAND reading from a bounded measurement session. Not a diagnostic-grade ECG. */
data class EcgSample(
    val timestampNs: Long,
    val ecgMillivolts: Double,
    val leadOff: Int,
    val sequenceNumber: Int,
    val maxThresholdMillivolts: Double,
    val minThresholdMillivolts: Double,
)

/**
 * BIA_ON_DEMAND progress/result from a single bounded session (~tens of
 * seconds): `progressPercent` climbs to 100 as the session runs, and the
 * body-composition fields are only meaningful once the SDK has finished
 * computing them (absent readings surface as `null`, since the AAR's own
 * docs are unavailable to confirm exactly when each field first populates).
 */
data class BiaResult(
    val progressPercent: Double,
    val status: Int,
    val bodyFatRatio: Double?,
    val bodyFatMassKg: Double?,
    val totalBodyWaterKg: Double?,
    val skeletalMuscleRatio: Double?,
    val skeletalMuscleMassKg: Double?,
    val basalMetabolicRateKcal: Double?,
    val fatFreeRatio: Double?,
    val fatFreeMassKg: Double?,
    val bodyImpedanceMagnitudeOhm: Double?,
    val bodyImpedanceDegreeDeg: Double?,
)

/** One SWEAT_LOSS reading from a bounded, exercise-session-scoped measurement. */
data class SweatLossSample(
    val timestampNs: Long,
    val sweatLossMilliliters: Double,
    val status: Int,
)

/** Returns `getValue(key)`, or `null` if the SDK hasn't populated that key on this [DataPoint] yet. */
private fun <T> DataPoint.valueOrNull(key: ValueKey<T>): T? =
    try {
        getValue(key)
    } catch (error: Exception) {
        null
    }

/**
 * Wraps Samsung Health Sensor SDK 1.4.1's bounded, on-demand medical
 * trackers: `SPO2_ON_DEMAND`, `ECG_ON_DEMAND`, `BIA_ON_DEMAND`, `PPG_ON_DEMAND`,
 * and `SWEAT_LOSS` (session-scoped despite lacking an `_ON_DEMAND` suffix in the
 * SDK's own [HealthTrackerType] enum — see [ON_DEMAND_TRACKER_TYPES]). None
 * of these run continuously or bypass Samsung Health's consent flow:
 * [start] opens a session for exactly the tracker id the caller names
 * (`desktop.start_measurement`/an on-watch trigger), never all four, and
 * [stop] gracefully ends it via `HealthTracker.flush()` before tearing the
 * connection down. `flush()` is confirmed (via the AAR's own bytecode, since
 * its HTML docs are an empty JS shell) to reject the continuous tracker
 * types this app also uses, which is exactly why [MedicalContinuousCollector]
 * and [PpgCollector] never call it — it is the on-demand-only stop primitive.
 *
 * Each tracker gets its own [HealthTrackingService] connection, opened only
 * while that tracker has an active session, so no on-demand tracker is ever
 * connected to Samsung Health without an explicit request.
 */
class OnDemandMedicalSampler(
    private val context: Context,
    private val onSpo2: (List<Spo2Sample>) -> Unit,
    private val onEcg: (List<EcgSample>) -> Unit,
    private val onBiaResult: (BiaResult) -> Unit,
    private val onSweatLoss: (List<SweatLossSample>) -> Unit,
    private val onPpg: (List<PpgSample>) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val sessions = mutableMapOf<String, Session>()

    private val _state = MutableStateFlow(
        ON_DEMAND_TRACKER_TYPES.keys.associateWith { MedicalTrackerState.IDLE },
    )
    val state: StateFlow<Map<String, MedicalTrackerState>> = _state.asStateFlow()

    fun hasBodySensorsPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.BODY_SENSORS) ==
            PackageManager.PERMISSION_GRANTED

    /** Starts a bounded session for [trackerId] (a key of [ON_DEMAND_TRACKER_TYPES]). No-op for an unknown id or an already-active session. */
    fun start(trackerId: String) {
        val type = ON_DEMAND_TRACKER_TYPES[trackerId] ?: return
        if (sessions.containsKey(trackerId)) return
        // Samsung's on-demand trackers are foreground, mutually exclusive
        // measurements. Do not overlap sessions even if the desktop sends
        // multiple commands before it receives the first status update.
        if (sessions.isNotEmpty()) {
            setState(trackerId, MedicalTrackerState.ERROR)
            return
        }
        if (!hasBodySensorsPermission()) {
            setState(trackerId, MedicalTrackerState.PERMISSION_REQUIRED)
            return
        }
        setState(trackerId, MedicalTrackerState.CONNECTING)
        val session = Session(trackerId, type)
        sessions[trackerId] = session
        val svc = HealthTrackingService(session.connectionListener, context)
        session.service = svc
        svc.connectService()
    }

    /** Gracefully ends [trackerId]'s session via `flush()` if one is active; no-op otherwise. */
    fun stop(trackerId: String) {
        val session = sessions.remove(trackerId) ?: return
        session.tracker?.let { tracker ->
            try {
                tracker.flush()
            } catch (error: Exception) {
                // Best-effort: the SDK connection may already be gone.
            }
            tracker.unsetEventListener()
        }
        session.service?.disconnectService()
        setState(trackerId, MedicalTrackerState.IDLE)
    }

    /** Ends every active session; call from Activity#onPause/onDestroy. */
    fun stopAll() {
        for (trackerId in sessions.keys.toList()) stop(trackerId)
    }

    private fun setState(trackerId: String, state: MedicalTrackerState) {
        _state.value = _state.value.toMutableMap().apply { put(trackerId, state) }
    }

    private inner class Session(val trackerId: String, val type: HealthTrackerType) {
        var service: HealthTrackingService? = null
        var tracker: HealthTracker? = null

        val connectionListener = object : ConnectionListener {
            override fun onConnectionSuccess() {
                val svc = service
                if (svc == null || !sessions.containsKey(trackerId)) {
                    svc?.disconnectService()
                    return
                }
                val supported = try {
                    svc.trackingCapability.supportHealthTrackerTypes.contains(type)
                } catch (error: Exception) {
                    false
                }
                if (!supported) {
                    sessions.remove(trackerId)
                    svc.disconnectService()
                    setState(trackerId, MedicalTrackerState.UNAVAILABLE)
                    return
                }
                val newTracker = if (type == HealthTrackerType.PPG_ON_DEMAND) {
                    svc.getHealthTracker(type, EnumSet.of(PpgType.GREEN, PpgType.RED, PpgType.IR))
                } else {
                    svc.getHealthTracker(type)
                }
                tracker = newTracker
                newTracker.setEventListener(eventListener(trackerId))
                setState(trackerId, MedicalTrackerState.MEASURING)
            }

            override fun onConnectionEnded() {
                tracker = null
                if (sessions.containsKey(trackerId)) {
                    sessions.remove(trackerId)
                    setState(trackerId, MedicalTrackerState.IDLE)
                }
            }

            override fun onConnectionFailed(exception: HealthTrackerException) {
                sessions.remove(trackerId)
                service = null
                setState(trackerId, MedicalTrackerState.UNAVAILABLE)
            }
        }
    }

    private fun eventListener(trackerId: String): HealthTracker.TrackerEventListener =
        object : HealthTracker.TrackerEventListener {
            override fun onDataReceived(dataPoints: MutableList<DataPoint>) {
                if (dataPoints.isEmpty()) return
                mainHandler.post { dispatchSamples(trackerId, dataPoints) }
            }

            override fun onFlushCompleted() {
                // The session already ended on the SDK side; drop our side too.
                mainHandler.post { stop(trackerId) }
            }

            override fun onError(error: HealthTracker.TrackerError) {
                mainHandler.post {
                    setState(
                        trackerId,
                        when (error) {
                            HealthTracker.TrackerError.PERMISSION_ERROR -> MedicalTrackerState.PERMISSION_REQUIRED
                            HealthTracker.TrackerError.SDK_POLICY_ERROR -> MedicalTrackerState.UNAVAILABLE
                            else -> MedicalTrackerState.ERROR
                        },
                    )
                }
            }
        }

    private fun dispatchSamples(trackerId: String, dataPoints: List<DataPoint>) {
        when (trackerId) {
            TRACKER_SPO2_ON_DEMAND -> onSpo2(
                dataPoints.map { point ->
                    Spo2Sample(
                        timestampNs = point.timestamp,
                        spo2 = point.getValue(ValueKey.SpO2Set.SPO2),
                        heartRate = point.getValue(ValueKey.SpO2Set.HEART_RATE),
                        accuracyFlag = point.getValue(ValueKey.SpO2Set.ACCURACY_FLAG),
                        status = point.getValue(ValueKey.SpO2Set.STATUS),
                    )
                },
            )
            TRACKER_ECG_ON_DEMAND -> onEcg(
                dataPoints.map { point ->
                    EcgSample(
                        timestampNs = point.timestamp,
                        ecgMillivolts = point.getValue(ValueKey.EcgSet.ECG_MV).toDouble(),
                        leadOff = point.getValue(ValueKey.EcgSet.LEAD_OFF),
                        sequenceNumber = point.getValue(ValueKey.EcgSet.SEQUENCE),
                        maxThresholdMillivolts = point.getValue(ValueKey.EcgSet.MAX_THRESHOLD_MV).toDouble(),
                        minThresholdMillivolts = point.getValue(ValueKey.EcgSet.MIN_THRESHOLD_MV).toDouble(),
                    )
                },
            )
            TRACKER_BIA_ON_DEMAND -> dataPoints.lastOrNull()?.let { point ->
                onBiaResult(
                    BiaResult(
                        progressPercent = point.getValue(ValueKey.BiaSet.PROGRESS).toDouble(),
                        status = point.getValue(ValueKey.BiaSet.STATUS),
                        bodyFatRatio = point.valueOrNull(ValueKey.BiaSet.BODY_FAT_RATIO)?.toDouble(),
                        bodyFatMassKg = point.valueOrNull(ValueKey.BiaSet.BODY_FAT_MASS)?.toDouble(),
                        totalBodyWaterKg = point.valueOrNull(ValueKey.BiaSet.TOTAL_BODY_WATER)?.toDouble(),
                        skeletalMuscleRatio = point.valueOrNull(ValueKey.BiaSet.SKELETAL_MUSCLE_RATIO)?.toDouble(),
                        skeletalMuscleMassKg = point.valueOrNull(ValueKey.BiaSet.SKELETAL_MUSCLE_MASS)?.toDouble(),
                        basalMetabolicRateKcal =
                            point.valueOrNull(ValueKey.BiaSet.BASAL_METABOLIC_RATE)?.toDouble(),
                        fatFreeRatio = point.valueOrNull(ValueKey.BiaSet.FAT_FREE_RATIO)?.toDouble(),
                        fatFreeMassKg = point.valueOrNull(ValueKey.BiaSet.FAT_FREE_MASS)?.toDouble(),
                        bodyImpedanceMagnitudeOhm =
                            point.valueOrNull(ValueKey.BiaSet.BODY_IMPEDANCE_MAGNITUDE)?.toDouble(),
                        bodyImpedanceDegreeDeg =
                            point.valueOrNull(ValueKey.BiaSet.BODY_IMPEDANCE_DEGREE)?.toDouble(),
                    ),
                )
            }
            TRACKER_SWEAT_LOSS_ON_DEMAND -> onSweatLoss(
                dataPoints.map { point ->
                    SweatLossSample(
                        timestampNs = point.timestamp,
                        sweatLossMilliliters = point.getValue(ValueKey.SweatLossSet.SWEAT_LOSS).toDouble(),
                        status = point.getValue(ValueKey.SweatLossSet.STATUS),
                    )
                },
            )
            TRACKER_PPG_ON_DEMAND -> onPpg(
                dataPoints.map { point ->
                    PpgSample(
                        timestampNs = point.timestamp,
                        green = point.getValue(ValueKey.PpgSet.PPG_GREEN),
                        greenStatus = point.getValue(ValueKey.PpgSet.GREEN_STATUS),
                        red = point.getValue(ValueKey.PpgSet.PPG_RED),
                        redStatus = point.getValue(ValueKey.PpgSet.RED_STATUS),
                        ir = point.getValue(ValueKey.PpgSet.PPG_IR),
                        irStatus = point.getValue(ValueKey.PpgSet.IR_STATUS),
                    )
                },
            )
        }
    }
}
