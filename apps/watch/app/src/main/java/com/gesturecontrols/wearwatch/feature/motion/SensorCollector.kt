package com.gesturecontrols.wearwatch.feature.motion

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.util.Log
import com.gesturecontrols.wearwatch.feature.power.WatchStats

/**
 * Wraps SensorManager for the three IMU inputs the protocol cares about.
 * Readings are sent unfiltered: [ImuRowAssembler] makes one row per event of
 * the fastest sensor that is on, with the latest fresh reading of the others.
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

    private val rows = ImuRowAssembler()
    private val quaternionBuffer = FloatArray(4)
    // Orientation is the only message stamped with the sensor's own clock;
    // put it on the elapsedRealtimeNanos base every other message uses.
    private val orientationClock = SensorClockRebaser()
    private var loggedClockRebase = false

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

    // Desktop-controlled per-sensor rate (`desktop.set_sensor_rate`), in
    // microseconds for SensorManager#registerListener. Null until the
    // desktop sends a rate for that sensor, at which point [start] falls
    // back to SENSOR_DELAY_GAME. `startMonitoring`'s reduced-rate listener
    // is intentionally unaffected, since it exists for background power
    // savings rather than configured live capture.
    private var orientationRateUs: Int? = null
    private var accelerationRateUs: Int? = null
    private var gyroscopeRateUs: Int? = null

    // The rate each sensor was last registered at (a SENSOR_DELAY_* constant or µs), for the stats report.
    private var orientationActiveRate: Int? = null
    private var accelerationActiveRate: Int? = null
    private var gyroscopeActiveRate: Int? = null

    /** Counts each sensor event as it arrives, when set; see [WatchStats]. */
    @Volatile var stats: WatchStats? = null

    var isRegistered = false
        private set

    /** True when only [startMonitoring]'s reduced-rate listener is active, not full active capture. */
    var isMonitoring = false
        private set

    /** Full-rate active capture: all three IMU inputs at SENSOR_DELAY_GAME, each gated by [setSensorEnabled]. Never reduced. */
    fun start() {
        if (isRegistered && !isMonitoring) return
        if (isRegistered) unregisterAll()
        applyOrientationRegistration(orientationRateUs ?: SensorManager.SENSOR_DELAY_GAME)
        applyAccelerationRegistration(accelerationRateUs ?: SensorManager.SENSOR_DELAY_GAME)
        applyGyroscopeRegistration(gyroscopeRateUs ?: SensorManager.SENSOR_DELAY_GAME)
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
        rows.reset()
        orientationClock.reset()
        isRegistered = false
        isMonitoring = false
    }

    /**
     * Desktop-controlled enable/disable for a single IMU input
     * ([SENSOR_ORIENTATION], [SENSOR_ACCELERATION], [SENSOR_GYROSCOPE]),
     * applied immediately if a capture/monitoring session is active, and
     * remembered for the next [start]/[startMonitoring] otherwise. Disabling
     * [SENSOR_ORIENTATION] stops every IMU sample, since every row the watch
     * sends carries an orientation.
     */
    fun setSensorEnabled(sensorId: String, enabled: Boolean) {
        when (sensorId) {
            SENSOR_ORIENTATION -> {
                orientationEnabled = enabled
                if (isRegistered) {
                    applyOrientationRegistration(
                        if (isMonitoring) SensorManager.SENSOR_DELAY_UI else orientationRateUs ?: SensorManager.SENSOR_DELAY_GAME,
                    )
                }
            }
            SENSOR_ACCELERATION -> {
                accelerationEnabled = enabled
                if (isRegistered && !isMonitoring) {
                    applyAccelerationRegistration(accelerationRateUs ?: SensorManager.SENSOR_DELAY_GAME)
                }
            }
            SENSOR_GYROSCOPE -> {
                gyroscopeEnabled = enabled
                if (isRegistered && !isMonitoring) {
                    applyGyroscopeRegistration(gyroscopeRateUs ?: SensorManager.SENSOR_DELAY_GAME)
                }
            }
        }
    }

    /**
     * Desktop-controlled live sampling-rate update for a single IMU input
     * (`desktop.set_sensor_rate`). Re-registers only the changed physical
     * sensor, at the new [SensorManager.registerListener] `samplingPeriodUs`
     * derived from [hz], without touching the other two sensors or
     * restarting the overall stream. Ignored while in [startMonitoring]'s
     * reduced-rate mode; the requested rate is still remembered for the
     * next [start].
     */
    fun setSensorRateHz(sensorId: String, hz: Double) {
        if (hz < MIN_SENSOR_RATE_HZ || hz > MAX_SENSOR_RATE_HZ || hz.isNaN()) return
        val periodUs = (1_000_000.0 / hz).toInt().coerceAtLeast(1)
        when (sensorId) {
            SENSOR_ORIENTATION -> {
                orientationRateUs = periodUs
                if (isRegistered && !isMonitoring) applyOrientationRegistration(periodUs)
            }
            SENSOR_ACCELERATION -> {
                accelerationRateUs = periodUs
                if (isRegistered && !isMonitoring) applyAccelerationRegistration(periodUs)
            }
            SENSOR_GYROSCOPE -> {
                gyroscopeRateUs = periodUs
                if (isRegistered && !isMonitoring) applyGyroscopeRegistration(periodUs)
            }
        }
    }

    /** How each motion sensor is set up right now, for the stats report. */
    fun sensorInfo(): List<WatchStats.SensorInfo> = listOfNotNull(
        rotationVectorSensor?.let { info(SENSOR_ORIENTATION, it, orientationRegistered, orientationActiveRate) },
        accelerometerSensor?.let { info(SENSOR_ACCELERATION, it, accelerationRegistered, accelerationActiveRate) },
        gyroscopeSensor?.let { info(SENSOR_GYROSCOPE, it, gyroscopeRegistered, gyroscopeActiveRate) },
    )

    private fun info(id: String, sensor: Sensor, registered: Boolean, rate: Int?) = WatchStats.SensorInfo(
        id = id,
        name = sensor.name,
        registered = registered,
        requestedPeriodUs = rate?.let(WatchStats::nominalPeriodUs),
        fifoMaxEvents = sensor.fifoMaxEventCount,
        fifoReservedEvents = sensor.fifoReservedEventCount,
    )

    private fun unregisterAll() {
        sensorManager.unregisterListener(this)
        orientationRegistered = false
        accelerationRegistered = false
        gyroscopeRegistered = false
        updateDriver()
    }

    /** Rows follow the fastest-changing sensor that is registered; see [ImuRowAssembler]. */
    private fun updateDriver() {
        rows.driver = when {
            accelerationRegistered -> ImuRowAssembler.Driver.ACCELEROMETER
            gyroscopeRegistered -> ImuRowAssembler.Driver.GYROSCOPE
            else -> ImuRowAssembler.Driver.ROTATION_VECTOR
        }
    }

    // Always unregisters before re-registering when enabled (rather than
    // skipping when already registered) so a rate-only change while the
    // sensor is already active still takes effect immediately.
    private fun applyOrientationRegistration(rate: Int) {
        val sensor = rotationVectorSensor ?: return
        if (orientationEnabled) {
            sensorManager.unregisterListener(this, sensor)
            sensorManager.registerListener(this, sensor, rate)
            orientationRegistered = true
            orientationActiveRate = rate
        } else if (orientationRegistered) {
            sensorManager.unregisterListener(this, sensor)
            orientationRegistered = false
        }
        updateDriver()
    }

    private fun applyAccelerationRegistration(rate: Int) {
        val sensor = accelerometerSensor ?: return
        if (accelerationEnabled) {
            sensorManager.unregisterListener(this, sensor)
            sensorManager.registerListener(this, sensor, rate)
            accelerationRegistered = true
            accelerationActiveRate = rate
        } else if (accelerationRegistered) {
            sensorManager.unregisterListener(this, sensor)
            accelerationRegistered = false
            rows.forgetAccelerometer()
        }
        updateDriver()
    }

    private fun applyGyroscopeRegistration(rate: Int) {
        val sensor = gyroscopeSensor ?: return
        if (gyroscopeEnabled) {
            sensorManager.unregisterListener(this, sensor)
            sensorManager.registerListener(this, sensor, rate)
            gyroscopeRegistered = true
            gyroscopeActiveRate = rate
        } else if (gyroscopeRegistered) {
            sensorManager.unregisterListener(this, sensor)
            gyroscopeRegistered = false
            rows.forgetGyroscope()
        }
        updateDriver()
    }

    override fun onSensorChanged(event: SensorEvent) {
        stats?.let { counter ->
            val id = when (event.sensor.type) {
                Sensor.TYPE_LINEAR_ACCELERATION, Sensor.TYPE_ACCELEROMETER -> SENSOR_ACCELERATION
                Sensor.TYPE_GYROSCOPE -> SENSOR_GYROSCOPE
                Sensor.TYPE_ROTATION_VECTOR -> SENSOR_ORIENTATION
                else -> null
            }
            if (id != null) counter.onSensorEvent(id, SystemClock.elapsedRealtimeNanos())
        }
        val row = when (event.sensor.type) {
            Sensor.TYPE_LINEAR_ACCELERATION, Sensor.TYPE_ACCELEROMETER -> rows.onAccelerometer(event.values, event.timestamp)
            Sensor.TYPE_GYROSCOPE -> rows.onGyroscope(event.values, event.timestamp)
            Sensor.TYPE_ROTATION_VECTOR -> {
                SensorManager.getQuaternionFromVector(quaternionBuffer, event.values)
                rows.onRotation(quaternionBuffer, event.timestamp)
            }
            else -> null
        } ?: return
        // Companion freshness above stays on the sensor clock (both sides are raw SensorEvent timestamps); only the
        // timestamp put on the wire is moved onto the elapsedRealtimeNanos base every other message uses.
        val envelopeTimestampNs = orientationClock.toElapsedRealtime(row.sensorTimestampNs, SystemClock.elapsedRealtimeNanos())
        if (orientationClock.isRebasing && !loggedClockRebase) {
            loggedClockRebase = true
            Log.w(
                TAG,
                "SensorEvent.timestamp is not on the elapsedRealtimeNanos base on this device; " +
                    "rebasing orientation timestamps so they match every other watch message",
            )
        }
        onOrientation(row.quaternion, row.accelerometer, row.gyroscope, envelopeTimestampNs)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val TAG = "SensorCollector"
    }
}
