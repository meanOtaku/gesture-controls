package com.gesturecontrols.wearwatch

import android.content.Context
import android.os.BatteryManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
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

    private val watchLink = WatchLinkManager()
    private lateinit var sensorCollector: SensorCollector

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = ConnectionPrefs(this)
        endpointInput = findViewById(R.id.endpointInput)
        connectButton = findViewById(R.id.connectButton)
        connectionStatusText = findViewById(R.id.connectionStatusText)
        sensorStatusText = findViewById(R.id.sensorStatusText)
        detailText = findViewById(R.id.detailText)

        endpointInput.setText(prefs.endpoint.orEmpty())

        watchLink.batteryPercentProvider = { readBatteryPercent() }

        sensorCollector = SensorCollector(this) { quaternion, accelerometer, gyroscope, timestampNs ->
            watchLink.sendOrientation(quaternion, accelerometer, gyroscope, timestampNs)
        }

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
            }
        }
    }

    override fun onPause() {
        super.onPause()
        sensorCollector.stop()
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
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        sensorCollector.stop()
        watchLink.shutdown()
    }

    private fun onConnectButtonClicked() {
        val currentState = watchLink.state.value
        if (currentState == ConnectionState.CONNECTED ||
            currentState == ConnectionState.CONNECTING ||
            currentState == ConnectionState.RECONNECTING
        ) {
            sensorCollector.stop()
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
            sensorStatusText.setText(R.string.sensors_idle)
        }
    }

    private fun readBatteryPercent(): Int? {
        val batteryManager = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val level = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) level else null
    }
}
