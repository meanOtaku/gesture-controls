package com.gesturecontrols.wearwatch.feature.motion

/**
 * IMU sensor ids used by `desktop.set_sensor` and `watch.sensor_status`.
 * These values must match `spatial_protocol::IMU_SENSOR_IDS`.
 */
const val SENSOR_ORIENTATION = "orientation"
const val SENSOR_ACCELERATION = "acceleration"
const val SENSOR_GYROSCOPE = "gyroscope"

/**
 * Valid `desktop.set_sensor_rate` range. Must match
 * `spatial_protocol::MIN_SENSOR_RATE_HZ`/`MAX_SENSOR_RATE_HZ`.
 */
const val MIN_SENSOR_RATE_HZ = 1.0
const val MAX_SENSOR_RATE_HZ = 200.0