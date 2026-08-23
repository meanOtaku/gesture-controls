package com.gesturecontrols.wearwatch

import android.Manifest
import android.content.Context
import android.os.BatteryManager
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
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

    /** Where the currently active/last-attempted endpoint came from, for the UI label. */
    private enum class EndpointSource { DISCOVERED, PERSISTED_FALLBACK, MANUAL }

    private lateinit var prefs: ConnectionPrefs
    private lateinit var endpointInput: EditText
    private lateinit var connectButton: Button
    private lateinit var connectionStatusText: TextView
    private lateinit var discoveryStatusText: TextView
    private lateinit var discoveryHistoryText: TextView
    private lateinit var endpointSourceText: TextView
    private lateinit var useAutoDiscoveryLink: TextView
    private lateinit var linkDiagnosticsText: TextView
    private lateinit var sensorStatusText: TextView
    private lateinit var detailText: TextView
    private lateinit var ppgStatusText: TextView

    private val watchLink = WatchLinkManager()
    private lateinit var desktopDiscovery: DesktopDiscovery
    // True only for an explicit manual Connect (typed endpoint + tap); blocks
    // discovery from overriding it until the user asks to go back to
    // automatic via [useAutoDiscoveryLink]. A persisted-fallback reconnect on
    // startup does NOT set this, so discovery can still replace it.
    private var manualEndpointSelected = false
    private var endpointSource: EndpointSource = EndpointSource.DISCOVERED
    private lateinit var sensorCollector: SensorCollector
    private lateinit var ppgCollector: PpgCollector
    private lateinit var medicalCollector: MedicalContinuousCollector
    private lateinit var onDemandSampler: OnDemandMedicalSampler

    // Tracks whether we've sent a button-down without a matching button-up yet,
    // so backgrounding the activity mid-hold can't leave the desktop overlay grabbed.
    private var stemButtonPressed = false

    // Samsung Health Sensor SDK's own consent flow is separate from this; see
    // PpgCollector's kdoc. Must be registered before onStart, so it's a field.
    private val requestBodySensorsPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                ppgCollector.start()
                medicalCollector.start()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = ConnectionPrefs(this)
        endpointInput = findViewById(R.id.endpointInput)
        connectButton = findViewById(R.id.connectButton)
        connectionStatusText = findViewById(R.id.connectionStatusText)
        discoveryStatusText = findViewById(R.id.discoveryStatusText)
        discoveryHistoryText = findViewById(R.id.discoveryHistoryText)
        endpointSourceText = findViewById(R.id.endpointSourceText)
        useAutoDiscoveryLink = findViewById(R.id.useAutoDiscoveryLink)
        linkDiagnosticsText = findViewById(R.id.linkDiagnosticsText)
        sensorStatusText = findViewById(R.id.sensorStatusText)
        detailText = findViewById(R.id.detailText)
        ppgStatusText = findViewById(R.id.ppgStatusText)

        val persistedEndpoint = prefs.endpoint
        endpointInput.setText(persistedEndpoint.orEmpty())
        useAutoDiscoveryLink.setOnClickListener { switchToAutomaticDiscovery() }
        renderEndpointSource()

        watchLink.batteryPercentProvider = { readBatteryPercent() }
        desktopDiscovery = DesktopDiscovery(
            this,
            onEndpoint = { endpoint ->
                runOnUiThread {
                    if (!manualEndpointSelected) connectDiscoveredDesktop(endpoint)
                }
            },
            onStatus = { status ->
                runOnUiThread {
                    discoveryStatusText.text = status
                    discoveryHistoryText.text = desktopDiscovery.history().joinToString(" › ")
                }
            },
        )

        sensorCollector = SensorCollector(this) { quaternion, accelerometer, gyroscope, timestampNs ->
            watchLink.sendOrientation(quaternion, accelerometer, gyroscope, timestampNs)
        }
        ppgCollector = PpgCollector(this) { samples -> watchLink.enqueuePpgSamples(samples) }
        medicalCollector = MedicalContinuousCollector(
            this,
            onHeartRate = { samples -> watchLink.enqueueHeartRateSamples(samples) },
            onSkinTemperature = { samples -> watchLink.enqueueSkinTemperatureSamples(samples) },
            onEda = { samples -> watchLink.enqueueEdaSamples(samples) },
        )
        onDemandSampler = OnDemandMedicalSampler(
            this,
            onSpo2 = { samples -> watchLink.sendSpo2Samples(samples) },
            onEcg = { samples -> watchLink.sendEcgSamples(samples) },
            onBiaResult = { result -> watchLink.sendBiaResult(result) },
            onSweatLoss = { samples -> watchLink.sendSweatLossSamples(samples) },
        )
        watchLink.onMeasurementCommand = { tracker, start ->
            if (start) onDemandSampler.start(tracker) else onDemandSampler.stop(tracker)
        }

        connectButton.setOnClickListener { onConnectButtonClicked() }
        desktopDiscovery.start()

        // Durable pairing fallback: reconnect to whatever we last used, right
        // away, so the watch doesn't sit idle waiting on a fresh mDNS
        // resolve every cold start. Not "manual", so a subsequent discovery
        // result is still free to replace it.
        if (!persistedEndpoint.isNullOrBlank()) {
            endpointSource = EndpointSource.PERSISTED_FALLBACK
            renderEndpointSource()
            connectToDesktop(persistedEndpoint)
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { watchLink.state.collect { renderState(it) } }
                launch { watchLink.lastFailureReason.collect { reason -> linkDiagnosticsText.text = reason.orEmpty() } }
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
                launch {
                    medicalCollector.state.collect { statuses ->
                        statuses.forEach { (tracker, state) -> watchLink.sendMedicalStatus(tracker, state.wireValue()) }
                    }
                }
                launch {
                    onDemandSampler.state.collect { statuses ->
                        statuses.forEach { (tracker, state) -> watchLink.sendMedicalStatus(tracker, state.wireValue()) }
                    }
                }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        releaseStemButtonIfPressed()
        sensorCollector.stop()
        ppgCollector.stop()
        medicalCollector.stop()
        onDemandSampler.stopAll()
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
            startBodySensorCollection()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        releaseStemButtonIfPressed()
        sensorCollector.stop()
        ppgCollector.stop()
        medicalCollector.stop()
        onDemandSampler.stopAll()
        desktopDiscovery.stop()
        watchLink.shutdown()
    }

    /**
     * Only the STEM_1 hardware key grabs the volume overlay; Back/Home and every
     * other key fall through to the default behavior (e.g. Back still exits).
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_STEM_1) {
            if (event?.repeatCount == 0 && !stemButtonPressed) {
                stemButtonPressed = true
                watchLink.sendButtonEvent(pressed = true)
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_STEM_1) {
            releaseStemButtonIfPressed()
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun releaseStemButtonIfPressed() {
        if (stemButtonPressed) {
            stemButtonPressed = false
            watchLink.sendButtonEvent(pressed = false)
        }
    }

    private fun onConnectButtonClicked() {
        val currentState = watchLink.state.value
        if (currentState == ConnectionState.CONNECTED ||
            currentState == ConnectionState.CONNECTING ||
            currentState == ConnectionState.RECONNECTING
        ) {
            sensorCollector.stop()
            ppgCollector.stop()
            medicalCollector.stop()
            onDemandSampler.stopAll()
            watchLink.disconnect()
            sensorStatusText.setText(R.string.sensors_idle)
            return
        }

        val url = endpointInput.text.toString().trim()
        if (url.isEmpty() || !url.startsWith("ws://")) {
            connectionStatusText.text = "Enter a ws:// endpoint"
            return
        }
        manualEndpointSelected = true
        endpointSource = EndpointSource.MANUAL
        renderEndpointSource()
        prefs.endpoint = url
        connectToDesktop(url)
    }

    private fun connectDiscoveredDesktop(url: String) {
        endpointInput.setText(url)
        endpointSource = EndpointSource.DISCOVERED
        renderEndpointSource()
        prefs.endpoint = url
        connectToDesktop(url)
    }

    /** Drops the manual override so the next discovery result is used again. */
    private fun switchToAutomaticDiscovery() {
        manualEndpointSelected = false
        endpointSource = EndpointSource.DISCOVERED
        renderEndpointSource()
        watchLink.disconnect()
        sensorCollector.stop()
        ppgCollector.stop()
        medicalCollector.stop()
        onDemandSampler.stopAll()
        sensorStatusText.setText(R.string.sensors_idle)
        desktopDiscovery.refresh()
    }

    private fun renderEndpointSource() {
        endpointSourceText.text = when (endpointSource) {
            EndpointSource.DISCOVERED -> getString(R.string.endpoint_source_discovered)
            EndpointSource.PERSISTED_FALLBACK -> getString(R.string.endpoint_source_persisted)
            EndpointSource.MANUAL -> getString(R.string.endpoint_source_manual)
        }
        useAutoDiscoveryLink.visibility = if (endpointSource == EndpointSource.MANUAL) {
            View.VISIBLE
        } else {
            View.GONE
        }
    }

    private fun connectToDesktop(url: String) {
        sensorCollector.start()
        sensorStatusText.setText(R.string.sensors_streaming)
        watchLink.connect(url)
        startBodySensorCollection()
    }

    /** Starts PPG_CONTINUOUS and the continuous medical trackers if BODY_SENSORS is already granted, else requests it first. */
    private fun startBodySensorCollection() {
        if (ppgCollector.hasBodySensorsPermission()) {
            ppgCollector.start()
            medicalCollector.start()
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
            medicalCollector.stop()
            onDemandSampler.stopAll()
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
