package com.gesturecontrols.wearwatch

import android.Manifest
import android.content.Context
import android.os.BatteryManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: ConnectionPrefs
    private lateinit var endpointInput: EditText
    private lateinit var connectButton: Button
    private lateinit var connectionStatusText: TextView
    private lateinit var sensorStatusText: TextView
    private lateinit var detailText: TextView
    private lateinit var ppgStatusText: TextView

    private val watchLink = WatchLinkManager()
    private lateinit var sensorCollector: SensorCollector
    private lateinit var ppgCollector: PpgCollector

    // Samsung Health Sensor SDK's own consent flow is separate from this; see
    // PpgCollector's kdoc. Must be registered before onStart, so it's a field.
    private val requestBodySensorsPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) ppgCollector.start()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = ConnectionPrefs(this)
        endpointInput = findViewById(R.id.endpointInput)
        connectButton = findViewById(R.id.connectButton)
        connectionStatusText = findViewById(R.id.connectionStatusText)
        sensorStatusText = findViewById(R.id.sensorStatusText)
        detailText = findViewById(R.id.detailText)
        ppgStatusText = findViewById(R.id.ppgStatusText)

        endpointInput.setText(prefs.endpoint.orEmpty())

        watchLink.batteryPercentProvider = { readBatteryPercent() }

        sensorCollector = SensorCollector(this) { quaternion, accelerometer, gyroscope, timestampNs ->
            watchLink.sendOrientation(quaternion, accelerometer, gyroscope, timestampNs)
        }
        ppgCollector = PpgCollector(this) { samples -> watchLink.enqueuePpgSamples(samples) }

        connectButton.setOnClickListener { onConnectButtonClicked() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { watchLink.state.collect { renderState(it) } }
                launch {
                    watchLink.lastOrientationSequence.collect { sequence ->
                        detailText.text = if (sequence == 0L) {
                            ""
                        } else {
                            getString(R.string.sensors_streaming) + " · seq=$sequence"
                        }
                    }
                }
                launch { ppgCollector.state.collect { renderPpgState(it) } }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        sensorCollector.stop()
        ppgCollector.stop()
        watchLink.pauseForLifecycle()
        sensorStatusText.setText(R.string.sensors_idle)
    }

    override fun onResume() {
        super.onResume()
        watchLink.resumeForLifecycle()
        if (watchLink.state.value == ConnectionState.CONNECTED ||
            watchLink.state.value == ConnectionState.CONNECTING ||
            watchLink.state.value == ConnectionState.RECONNECTING
        ) {
            sensorCollector.start()
            sensorStatusText.setText(R.string.sensors_streaming)
            startPpgCollection()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        sensorCollector.stop()
        ppgCollector.stop()
        watchLink.shutdown()
    }

    private fun onConnectButtonClicked() {
        val currentState = watchLink.state.value
        if (currentState == ConnectionState.CONNECTED ||
            currentState == ConnectionState.CONNECTING ||
            currentState == ConnectionState.RECONNECTING
        ) {
            sensorCollector.stop()
            ppgCollector.stop()
            watchLink.disconnect()
            sensorStatusText.setText(R.string.sensors_idle)
            return
        }

        val url = endpointInput.text.toString().trim()
        if (url.isEmpty() || !url.startsWith("ws://")) {
            connectionStatusText.text = "Enter a ws:// endpoint"
            return
        }
        prefs.endpoint = url
        sensorCollector.start()
        sensorStatusText.setText(R.string.sensors_streaming)
        watchLink.connect(url)
        startPpgCollection()
    }

    /** Starts PPG_CONTINUOUS if BODY_SENSORS is already granted, else requests it first. */
    private fun startPpgCollection() {
        if (ppgCollector.hasBodySensorsPermission()) {
            ppgCollector.start()
        } else {
            requestBodySensorsPermission.launch(Manifest.permission.BODY_SENSORS)
        }
    }

    private fun renderState(state: ConnectionState) {
        connectionStatusText.text = when (state) {
            ConnectionState.DISCONNECTED -> getString(R.string.status_disconnected)
            ConnectionState.CONNECTING -> getString(R.string.status_connecting)
            ConnectionState.CONNECTED -> getString(R.string.status_connected)
            ConnectionState.RECONNECTING -> getString(R.string.status_reconnecting)
            ConnectionState.FAILED -> getString(R.string.status_failed)
        }
        connectButton.text = when (state) {
            ConnectionState.CONNECTED, ConnectionState.CONNECTING, ConnectionState.RECONNECTING ->
                getString(R.string.action_disconnect)
            ConnectionState.DISCONNECTED, ConnectionState.FAILED ->
                getString(R.string.action_connect)
        }
        if (state == ConnectionState.DISCONNECTED || state == ConnectionState.FAILED) {
            sensorCollector.stop()
            ppgCollector.stop()
            sensorStatusText.setText(R.string.sensors_idle)
        }
    }

    private fun renderPpgState(state: PpgState) {
        ppgStatusText.text = when (state) {
            PpgState.IDLE -> getString(R.string.ppg_idle)
            PpgState.PERMISSION_REQUIRED -> getString(R.string.ppg_permission_required)
            PpgState.CONNECTING -> getString(R.string.ppg_connecting)
            PpgState.STREAMING -> getString(R.string.ppg_streaming)
            PpgState.UNAVAILABLE -> getString(R.string.ppg_unavailable)
            PpgState.ERROR -> getString(R.string.ppg_error)
        }
        watchLink.sendPpgStatus(state.wireValue())
    }

    private fun readBatteryPercent(): Int? {
        val batteryManager = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val level = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) level else null
    }
}
