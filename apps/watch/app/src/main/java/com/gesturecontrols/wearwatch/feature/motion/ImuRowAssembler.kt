package com.gesturecontrols.wearwatch.feature.motion

import kotlin.math.abs

/**
 * Turns the three motion sensors' separate events into the rows the watch sends: one row for each event of the
 * driving sensor, carrying the latest reading of the other two.
 *
 * The driver is the fastest-changing signal that is switched on: the accelerometer, else the gyroscope, else the
 * rotation vector (the only one on in low-power monitoring). Rows used to be made only on rotation-vector events, from
 * accelerometer and gyroscope values smoothed by a running average. That averaging kept little above about 2 Hz, which
 * removed the quick movements of a pinch or a tap, and any sensor running faster than the rotation vector lost samples.
 * Values are now sent exactly as the sensors report them, each row stamped with the driving sample's own time; any
 * filtering belongs on the desktop, where training and live inference share it.
 *
 * Pure (no Android types), so it is tested on the JVM.
 */
class ImuRowAssembler {
    enum class Driver { ACCELEROMETER, GYROSCOPE, ROTATION_VECTOR }

    class Row(
        val quaternion: FloatArray,
        val accelerometer: FloatArray?,
        val gyroscope: FloatArray?,
        /** The driving sample's `SensorEvent.timestamp`. */
        val sensorTimestampNs: Long,
    )

    /** Which sensor's events make rows. Set by the collector whenever the registered sensors change. */
    var driver = Driver.ROTATION_VECTOR

    private var quaternion: FloatArray? = null
    private var quaternionTimestampNs = 0L
    private var accelerometer: FloatArray? = null
    private var accelerometerTimestampNs = 0L
    private var gyroscope: FloatArray? = null
    private var gyroscopeTimestampNs = 0L

    fun onAccelerometer(values: FloatArray, timestampNs: Long): Row? {
        accelerometer = values.copyOf(3)
        accelerometerTimestampNs = timestampNs
        return if (driver == Driver.ACCELEROMETER) row(timestampNs) else null
    }

    fun onGyroscope(values: FloatArray, timestampNs: Long): Row? {
        gyroscope = values.copyOf(3)
        gyroscopeTimestampNs = timestampNs
        return if (driver == Driver.GYROSCOPE) row(timestampNs) else null
    }

    fun onRotation(quaternion: FloatArray, timestampNs: Long): Row? {
        this.quaternion = quaternion.copyOf(4)
        quaternionTimestampNs = timestampNs
        return if (driver == Driver.ROTATION_VECTOR) row(timestampNs) else null
    }

    /** Forgets every reading, so nothing from before a stop is attached to a row after it. */
    fun reset() {
        quaternion = null
        accelerometer = null
        gyroscope = null
    }

    fun forgetAccelerometer() {
        accelerometer = null
    }

    fun forgetGyroscope() {
        gyroscope = null
    }

    /** A row needs an orientation no older than [MAX_COMPANION_AGE_NS]; a stale accelerometer or gyroscope is left out. */
    private fun row(timestampNs: Long): Row? {
        val orientation = fresh(quaternion, quaternionTimestampNs, timestampNs) ?: return null
        return Row(
            quaternion = orientation,
            accelerometer = fresh(accelerometer, accelerometerTimestampNs, timestampNs),
            gyroscope = fresh(gyroscope, gyroscopeTimestampNs, timestampNs),
            sensorTimestampNs = timestampNs,
        )
    }

    private fun fresh(sample: FloatArray?, sampleTimestampNs: Long, rowTimestampNs: Long): FloatArray? {
        if (sample == null || abs(rowTimestampNs - sampleTimestampNs) > MAX_COMPANION_AGE_NS) return null
        return sample.copyOf()
    }

    companion object {
        const val MAX_COMPANION_AGE_NS = 100_000_000L
    }
}
