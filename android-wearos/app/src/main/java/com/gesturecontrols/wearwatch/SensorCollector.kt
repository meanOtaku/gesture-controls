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

    // Desktop-controlled per-sensor toggles (`desktop.set_sensor`); all on by
    // default so existing start()/startMonitoring()/stop() behavior is
    // unchanged until the desktop explicitly disables one.
    private var orientationEnabled = true
    private var accelerationEnabled = true
    private var gyroscopeEnabled = true

    // Tracks which physical sensors are actually registered right now, kept
    // separate from the enabled flags above so toggling one sensor never
    // double-registers or unregisters the other two.
    private var orientationRegistered = false
    private var accelerationRegistered = false
    private var gyroscopeRegistered = false

    var isRegistered = false
        private set

    /** True when only [startMonitoring]'s reduced-rate listener is active, not full active capture. */
    var isMonitoring = false
        private set

    /** Full-rate active capture: all three IMU inputs at SENSOR_DELAY_GAME, each gated by [setSensorEnabled]. Never reduced. */
    fun start() {
        if (isRegistered && !isMonitoring) return
        if (isRegistered) unregisterAll()
        applyOrientationRegistration(SensorManager.SENSOR_DELAY_GAME)
        applyAccelerationRegistration(SensorManager.SENSOR_DELAY_GAME)
        applyGyroscopeRegistration(SensorManager.SENSOR_DELAY_GAME)
        isRegistered = true
        isMonitoring = false
    }

    /**
     * Low-power background mode: rotation vector only (if [SENSOR_ORIENTATION] is
     * enabled), at a slower sensor delay, and without the streaming foreground
     * service's wake lock. Never used in place of [start] while a capture session
     * is active-only when idle and backgrounded.
     */
    fun startMonitoring() {
        if (isRegistered) return
        applyOrientationRegistration(SensorManager.SENSOR_DELAY_UI)
        isRegistered = true
        isMonitoring = true
    }

    fun stop() {
        if (!isRegistered) return
        unregisterAll()
        lastAccelerometer = null
        lastGyroscope = null
        isRegistered = false
        isMonitoring = false
    }

    /**
     * Desktop-controlled enable/disable for a single IMU input
     * ([SENSOR_ORIENTATION], [SENSOR_ACCELERATION], [SENSOR_GYROSCOPE]),
     * applied immediately if a capture/monitoring session is active, and
     * remembered for the next [start]/[startMonitoring] otherwise. Disabling
     * [SENSOR_ORIENTATION] stops every IMU sample, since acceleration/gyroscope
     * are only ever sent attached to a rotation-vector event.
     */
    fun setSensorEnabled(sensorId: String, enabled: Boolean) {
        when (sensorId) {
            SENSOR_ORIENTATION -> {
                orientationEnabled = enabled
                if (isRegistered) {
                    applyOrientationRegistration(
                        if (isMonitoring) SensorManager.SENSOR_DELAY_UI else SensorManager.SENSOR_DELAY_GAME,
                    )
                }
            }
            SENSOR_ACCELERATION -> {
                accelerationEnabled = enabled
                if (isRegistered && !isMonitoring) applyAccelerationRegistration(SensorManager.SENSOR_DELAY_GAME)
            }
            SENSOR_GYROSCOPE -> {
                gyroscopeEnabled = enabled
                if (isRegistered && !isMonitoring) applyGyroscopeRegistration(SensorManager.SENSOR_DELAY_GAME)
            }
        }
    }

    private fun unregisterAll() {
        sensorManager.unregisterListener(this)
        orientationRegistered = false
        accelerationRegistered = false
        gyroscopeRegistered = false
    }

    private fun applyOrientationRegistration(rate: Int) {
        val sensor = rotationVectorSensor ?: return
        if (orientationEnabled) {
            if (!orientationRegistered) {
                sensorManager.registerListener(this, sensor, rate)
                orientationRegistered = true
            }
        } else if (orientationRegistered) {
            sensorManager.unregisterListener(this, sensor)
            orientationRegistered = false
        }
    }

    private fun applyAccelerationRegistration(rate: Int) {
        val sensor = accelerometerSensor ?: return
        if (accelerationEnabled) {
            if (!accelerationRegistered) {
                sensorManager.registerListener(this, sensor, rate)
                accelerationRegistered = true
            }
        } else if (accelerationRegistered) {
            sensorManager.unregisterListener(this, sensor)
            accelerationRegistered = false
            lastAccelerometer = null
        }
    }

    private fun applyGyroscopeRegistration(rate: Int) {
        val sensor = gyroscopeSensor ?: return
        if (gyroscopeEnabled) {
            if (!gyroscopeRegistered) {
                sensorManager.registerListener(this, sensor, rate)
                gyroscopeRegistered = true
            }
        } else if (gyroscopeRegistered) {
            sensorManager.unregisterListener(this, sensor)
            gyroscopeRegistered = false
            lastGyroscope = null
        }
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
