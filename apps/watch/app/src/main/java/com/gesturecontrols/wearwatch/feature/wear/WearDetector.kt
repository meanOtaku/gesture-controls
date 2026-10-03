package com.gesturecontrols.wearwatch.feature.wear

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Whether the watch is on a wrist, from the standard low-latency off-body sensor.
 *
 * The sensor is a wake-up, on-change sensor: it costs next to nothing to hold and it wakes a
 * sleeping CPU when the watch is put back on, which is exactly what lets the rest of the app
 * go to sleep while the watch is off. It needs no permission.
 *
 * Taking the watch off is confirmed for [OFF_BODY_DEBOUNCE_MS] before it is believed (a strap
 * adjustment or a brief lift must not tear down and restart every sensor); putting it on is
 * believed at once. A watch with no such sensor reports "worn", so it keeps streaming as it
 * always did.
 */
class WearDetector(
    context: Context,
    private val scope: CoroutineScope,
) : SensorEventListener {
    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val sensor: Sensor? =
        sensorManager.getDefaultSensor(Sensor.TYPE_LOW_LATENCY_OFFBODY_DETECT, true)
            ?: sensorManager.getDefaultSensor(Sensor.TYPE_LOW_LATENCY_OFFBODY_DETECT)

    private val _worn = MutableStateFlow<Boolean?>(null)

    /** Null until known (or after [stop]); then true on a wrist, false off it. */
    val worn: StateFlow<Boolean?> = _worn.asStateFlow()

    private var registered = false
    private var offBodyJob: Job? = null
    private var startupJob: Job? = null

    /** Idempotent. Call when the wear state starts to matter, i.e. a desktop is connected. */
    fun start() {
        if (registered) return
        val offBody = sensor
        if (offBody == null) {
            Log.i(TAG, "no off-body sensor on this watch; treating it as worn")
            _worn.value = true
            registered = true
            return
        }
        registered = sensorManager.registerListener(this, offBody, SensorManager.SENSOR_DELAY_NORMAL)
        if (!registered) {
            Log.w(TAG, "could not register the off-body sensor; treating the watch as worn")
            _worn.value = true
            return
        }
        // An on-change sensor reports its current value on registration; this only covers a
        // sensor that never does, so a silent one cannot hold streaming back.
        startupJob = scope.launch {
            delay(STARTUP_ALLOWANCE_MS)
            if (_worn.value == null) {
                Log.w(TAG, "the off-body sensor sent no initial reading; assuming the watch is worn")
                _worn.value = true
            }
        }
    }

    fun stop() {
        if (!registered) return
        sensor?.let { sensorManager.unregisterListener(this, it) }
        registered = false
        offBodyJob?.cancel()
        startupJob?.cancel()
        _worn.value = null
    }

    override fun onSensorChanged(event: SensorEvent) {
        val onBody = event.values.firstOrNull()?.let { it != 0f } ?: return
        Log.i(TAG, "off-body sensor: ${if (onBody) "on body" else "off body"}")
        startupJob?.cancel()
        if (onBody) {
            offBodyJob?.cancel()
            _worn.value = true
        } else if (_worn.value != false && offBodyJob?.isActive != true) {
            offBodyJob = scope.launch {
                delay(OFF_BODY_DEBOUNCE_MS)
                _worn.value = false
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val TAG = "WearDetector"
        const val OFF_BODY_DEBOUNCE_MS = 3_000L
        const val STARTUP_ALLOWANCE_MS = 1_500L
    }
}
