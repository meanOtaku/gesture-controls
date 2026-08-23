package com.gesturecontrols.wearwatch

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager


/**
 * Wraps SensorManager for the three IMU inputs the protocol cares about.
 * Linear acceleration and gyroscope readings are filtered, freshness-checked,
 * and attached to the next rotation-vector sample. This keeps gravity and stale
 * sensor samples from appearing as erratic watch motion on the desktop.
 */
class SensorCollector(
    context: Context,
    private val onOrientation: (quaternion: FloatArray, accelerometer: FloatArray?, gyroscope: FloatArray?, timestampNs: Long) -> Unit,
) : SensorEventListener {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotationVectorSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    // `TYPE_ACCELEROMETER` includes gravity, which changes markedly as the wrist
    // rotates. Prefer the fused gravity-compensated sensor and retain the raw
    // accelerometer only as a hardware fallback.
    private val accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
        ?: sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyroscopeSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

    private var lastAccelerometer: FloatArray? = null
    private var lastGyroscope: FloatArray? = null
    private var lastAccelerometerTimestampNs = Long.MIN_VALUE
    private var lastGyroscopeTimestampNs = Long.MIN_VALUE
    private val quaternionBuffer = FloatArray(4)

    var isRegistered = false
        private set

    fun start() {
        if (isRegistered) return
        rotationVectorSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        accelerometerSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        gyroscopeSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        isRegistered = true
    }

    fun stop() {
        if (!isRegistered) return
        sensorManager.unregisterListener(this)
        lastAccelerometer = null
        lastGyroscope = null
        isRegistered = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_LINEAR_ACCELERATION, Sensor.TYPE_ACCELEROMETER -> {
                lastAccelerometer = smooth(lastAccelerometer, event.values, ACCELERATION_ALPHA)
                lastAccelerometerTimestampNs = event.timestamp
            }
            Sensor.TYPE_GYROSCOPE -> {
                lastGyroscope = smooth(lastGyroscope, event.values, GYROSCOPE_ALPHA)
                lastGyroscopeTimestampNs = event.timestamp
            }
            Sensor.TYPE_ROTATION_VECTOR -> {
                SensorManager.getQuaternionFromVector(quaternionBuffer, event.values)
                onOrientation(
                    quaternionBuffer.copyOf(4),
                    freshSample(lastAccelerometer, lastAccelerometerTimestampNs, event.timestamp),
                    freshSample(lastGyroscope, lastGyroscopeTimestampNs, event.timestamp),
                    event.timestamp,
                )
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun smooth(previous: FloatArray?, current: FloatArray, alpha: Float): FloatArray {
        val currentThreeAxis = current.copyOf(3)
        if (previous == null) return currentThreeAxis
        return FloatArray(3) { index ->
            previous[index] + alpha * (currentThreeAxis[index] - previous[index])
        }
    }

    private fun freshSample(sample: FloatArray?, sampleTimestampNs: Long, orientationTimestampNs: Long): FloatArray? {
        if (sample == null || orientationTimestampNs - sampleTimestampNs > MAX_COMPANION_SENSOR_AGE_NS) return null
        return sample.copyOf()
    }

    private companion object {
        const val ACCELERATION_ALPHA = 0.2f
        const val GYROSCOPE_ALPHA = 0.15f
        const val MAX_COMPANION_SENSOR_AGE_NS = 100_000_000L
    }
}
