package com.gesturecontrols.wearwatch

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock

/**
 * Wraps SensorManager for the three IMU inputs the protocol cares about.
 * Accelerometer and gyroscope readings are cached and attached to the next
 * rotation-vector sample, since desktop consumes one orientation message per
 * quaternion update with optional accompanying vectors.
 */
class SensorCollector(
    context: Context,
    private val onOrientation: (quaternion: FloatArray, accelerometer: FloatArray?, gyroscope: FloatArray?, timestampNs: Long) -> Unit,
) : SensorEventListener {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotationVectorSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyroscopeSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

    private var lastAccelerometer: FloatArray? = null
    private var lastGyroscope: FloatArray? = null
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
            Sensor.TYPE_ACCELEROMETER -> {
                lastAccelerometer = event.values.copyOf(3)
            }
            Sensor.TYPE_GYROSCOPE -> {
                lastGyroscope = event.values.copyOf(3)
            }
            Sensor.TYPE_ROTATION_VECTOR -> {
                SensorManager.getQuaternionFromVector(quaternionBuffer, event.values)
                onOrientation(
                    quaternionBuffer.copyOf(4),
                    lastAccelerometer,
                    lastGyroscope,
                    SystemClock.elapsedRealtimeNanos(),
                )
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
