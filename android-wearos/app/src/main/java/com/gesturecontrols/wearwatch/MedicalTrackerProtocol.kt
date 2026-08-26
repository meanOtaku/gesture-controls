package com.gesturecontrols.wearwatch

import com.samsung.android.service.health.tracking.data.HealthTrackerType

/**
 * Tracker ids used in `watch.medical_status`, matching
 * `spatial_protocol::MEDICAL_TRACKER_IDS` exactly (docs/watch-websocket-protocol.md).
 */
const val TRACKER_HEART_RATE_CONTINUOUS = "heart_rate_continuous"
const val TRACKER_SKIN_TEMPERATURE_CONTINUOUS = "skin_temperature_continuous"
const val TRACKER_EDA_CONTINUOUS = "eda_continuous"
const val TRACKER_SPO2_ON_DEMAND = "spo2_on_demand"
const val TRACKER_ECG_ON_DEMAND = "ecg_on_demand"
const val TRACKER_BIA_ON_DEMAND = "bia_on_demand"
const val TRACKER_SWEAT_LOSS_ON_DEMAND = "sweat_loss_on_demand"

/**
 * IMU sensor ids individually controllable via `desktop.set_sensor`/
 * `watch.sensor_status`, matching `spatial_protocol::IMU_SENSOR_IDS` exactly.
 * See [SensorCollector].
 */
const val SENSOR_ORIENTATION = "orientation"
const val SENSOR_ACCELERATION = "acceleration"
const val SENSOR_GYROSCOPE = "gyroscope"

/** Every on-demand tracker id mapped to its Samsung Health Sensor SDK type; see [OnDemandMedicalSampler]. */
val ON_DEMAND_TRACKER_TYPES: Map<String, HealthTrackerType> = mapOf(
    TRACKER_SPO2_ON_DEMAND to HealthTrackerType.SPO2_ON_DEMAND,
    TRACKER_ECG_ON_DEMAND to HealthTrackerType.ECG_ON_DEMAND,
    TRACKER_BIA_ON_DEMAND to HealthTrackerType.BIA_ON_DEMAND,
    TRACKER_SWEAT_LOSS_ON_DEMAND to HealthTrackerType.SWEAT_LOSS,
)

/**
 * Shared availability states for every medical tracker, continuous and
 * on-demand, mirroring `spatial_protocol::MEDICAL_TRACKER_STATES` /
 * `watch.medical_status`. Continuous trackers never report [MEASURING];
 * on-demand trackers use it in place of [STREAMING] while a bounded session
 * is active.
 */
enum class MedicalTrackerState { IDLE, PERMISSION_REQUIRED, CONNECTING, STREAMING, MEASURING, UNAVAILABLE, ERROR }

fun MedicalTrackerState.wireValue(): String = when (this) {
    MedicalTrackerState.IDLE -> "idle"
    MedicalTrackerState.PERMISSION_REQUIRED -> "permission_required"
    MedicalTrackerState.CONNECTING -> "connecting"
    MedicalTrackerState.STREAMING -> "streaming"
    MedicalTrackerState.MEASURING -> "measuring"
    MedicalTrackerState.UNAVAILABLE -> "unavailable"
    MedicalTrackerState.ERROR -> "error"
}
