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

    /** True when only [startMonitoring]'s reduced-rate listener is active, not full active capture. */
    var isMonitoring = false
        private set

    /** Full-rate active capture: all three IMU inputs at SENSOR_DELAY_GAME. Never reduced. */
    fun start() {
        if (isRegistered && !isMonitoring) return
        if (isRegistered) sensorManager.unregisterListener(this)
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
        isMonitoring = false
    }

    /**
     * Low-power background mode: rotation vector only, at a slower sensor delay, and
     * without the streaming foreground service's wake lock. Never used in place of
     * [start] while a capture session is active-only when idle and backgrounded.
     */
    fun startMonitoring() {
        if (isRegistered) return
        rotationVectorSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }
        isRegistered = true
        isMonitoring = true
    }

    fun stop() {
        if (!isRegistered) return
        sensorManager.unregisterListener(this)
        lastAccelerometer = null
        lastGyroscope = null
        isRegistered = false
        isMonitoring = false
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
        val smoothed = previous ?: FloatArray(3)
        for (index in 0 until 3) {
            smoothed[index] += alpha * (current[index] - smoothed[index])
        }
        return smoothed
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
