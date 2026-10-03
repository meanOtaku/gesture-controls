package com.gesturecontrols.wearwatch.app

import com.gesturecontrols.wearwatch.R

import com.gesturecontrols.wearwatch.data.connection.*
import com.gesturecontrols.wearwatch.data.discovery.*
import com.gesturecontrols.wearwatch.data.preferences.*
import com.gesturecontrols.wearwatch.feature.health.*
import com.gesturecontrols.wearwatch.feature.motion.*
import com.gesturecontrols.wearwatch.platform.service.*

import android.Manifest
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.View
import android.widget.Button
import android.widget.RadioButton
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewConfigurationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    /** Where the currently active/last-attempted endpoint came from, for the UI label. */
    private enum class EndpointSource { DISCOVERED, PERSISTED_FALLBACK, DESKTOP_INITIATED }

    private companion object {
        /** Fast-changing status text is redrawn at most this often. */
        const val UI_REFRESH_INTERVAL_MS = 500L
        const val STATUS_MAX_SP = 34f
        const val STATUS_MIN_SP = 14f

        /** After the first tap on "forget", the second tap must land within this long. */
        const val FORGET_CONFIRM_WINDOW_MS = 3_000L
    }

    private lateinit var prefs: ConnectionPrefs
    private lateinit var transportBluetoothButton: RadioButton
    private lateinit var transportWifiButton: RadioButton
    private lateinit var trustButton: Button
    private lateinit var forgetTrustButton: Button
    private lateinit var detailsToggleButton: Button
    private lateinit var detailsPanel: View
    private lateinit var rootScroll: ScrollView
    private var forgetArmed = false
    private lateinit var connectButton: Button
    private lateinit var connectionStatusText: TextView
    private lateinit var discoveryStatusText: TextView
    private lateinit var discoveryHistoryText: TextView
    private lateinit var endpointSourceText: TextView

    private lateinit var linkDiagnosticsText: TextView
    private lateinit var sensorStatusText: TextView
    private lateinit var detailText: TextView
    private lateinit var ppgStatusText: TextView
    private lateinit var spo2Button: Button
    private lateinit var ecgButton: Button
    private lateinit var biaButton: Button
    private lateinit var sweatLossButton: Button

    private val watchLink = WatchLinkManager()

    // Obtained lazily (not in onCreate) so system-service lookup happens once, off
    // the Activity instance itself — resistant to leaking the Activity across
    // config changes since we never hold anything but applicationContext here.
    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (applicationContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            applicationContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }
    private lateinit var desktopDiscovery: DesktopDiscovery
    private lateinit var pairingServer: WatchPairingServer

    /** Live only while [WatchTransportKind.BLUETOOTH] is selected; see [applyTransport]. */
    private var bleTransport: BleGattTransport? = null
    private var bleObserverJob: Job? = null
    private var selectedTransport: WatchTransportKind = WatchTransportKind.DEFAULT
    private var endpointSource: EndpointSource = EndpointSource.DISCOVERED
    private lateinit var sensorCollector: SensorCollector
    private lateinit var ppgCollector: PpgCollector
    private lateinit var medicalCollector: MedicalContinuousCollector
    private lateinit var onDemandSampler: OnDemandMedicalSampler

    // Tracks whether we've sent a button-down without a matching button-up yet,
    // so backgrounding the activity mid-hold can't leave the desktop overlay grabbed.
    private var stemButtonPressed = false

    // BLUETOOTH_ADVERTISE/BLUETOOTH_CONNECT on API 31+. A denial leaves
    // Bluetooth selected and shows why it can't start; it never silently falls
    // back to Wi-Fi.
    private val requestBluetoothPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants.values.all { it }) {
                startBluetoothTransport()
            } else {
                connectionStatusText.setText(R.string.ble_permission_required)
                linkDiagnosticsText.text = getString(R.string.ble_permission_required)
            }
        }

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
        watchLink.deviceId = prefs.deviceId
        transportBluetoothButton = findViewById(R.id.transportBluetoothButton)
        transportWifiButton = findViewById(R.id.transportWifiButton)
        trustButton = findViewById(R.id.trustButton)
        forgetTrustButton = findViewById(R.id.forgetTrustButton)
        detailsToggleButton = findViewById(R.id.detailsToggleButton)
        detailsPanel = findViewById(R.id.detailsPanel)
        rootScroll = findViewById(R.id.rootScroll)
        connectButton = findViewById(R.id.connectButton)
        connectionStatusText = findViewById(R.id.connectionStatusText)
        discoveryStatusText = findViewById(R.id.discoveryStatusText)
        discoveryHistoryText = findViewById(R.id.discoveryHistoryText)
        endpointSourceText = findViewById(R.id.endpointSourceText)

        linkDiagnosticsText = findViewById(R.id.linkDiagnosticsText)
        sensorStatusText = findViewById(R.id.sensorStatusText)
        detailText = findViewById(R.id.detailText)
        ppgStatusText = findViewById(R.id.ppgStatusText)
        spo2Button = findViewById(R.id.spo2Button)
        ecgButton = findViewById(R.id.ecgButton)
        biaButton = findViewById(R.id.biaButton)
        sweatLossButton = findViewById(R.id.sweatLossButton)

        renderEndpointSource()

        watchLink.batteryPercentProvider = { readBatteryPercent() }
        desktopDiscovery = DesktopDiscovery(
            this,
            onEndpoint = { endpoint ->
                runOnUiThread { connectDesktop(endpoint, EndpointSource.DISCOVERED) }
            },
            onStatus = { status ->
                runOnUiThread {
                    discoveryStatusText.text = status
                    discoveryHistoryText.text = desktopDiscovery.history().joinToString(" › ")
                }
            },
        )
        pairingServer = WatchPairingServer(
            this,
            onPairRequest = { endpoint -> runOnUiThread { connectDesktop(endpoint, EndpointSource.DESKTOP_INITIATED) } },
            onStatus = { status -> runOnUiThread { discoveryStatusText.text = status } },
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
        watchLink.onSensorControlCommand = { sensor, enabled ->
            when (sensor) {
                SENSOR_ORIENTATION, SENSOR_ACCELERATION, SENSOR_GYROSCOPE -> {
                    sensorCollector.setSensorEnabled(sensor, enabled)
                    watchLink.sendSensorStatus(sensor, enabled)
                }
                TRACKER_HEART_RATE_CONTINUOUS, TRACKER_SKIN_TEMPERATURE_CONTINUOUS, TRACKER_EDA_CONTINUOUS ->
                    medicalCollector.setTrackerEnabled(sensor, enabled)
            }
        }
        watchLink.onSensorRateCommand = { sensor, rateHz ->
            if (sensor == TRACKER_PPG_CONTINUOUS) {
                ppgCollector.setFlushRateHz(rateHz)
            } else {
                sensorCollector.setSensorRateHz(sensor, rateHz)
            }
        }
        watchLink.onHapticCommand = { durationMs -> triggerHaptic(durationMs) }

        connectButton.setOnClickListener { onConnectButtonClicked() }
        trustButton.setOnClickListener { onTrustButtonClicked() }
        forgetTrustButton.setOnClickListener { onForgetButtonClicked() }
        detailsToggleButton.setOnClickListener { toggleDetails() }
        // The rotating bezel / crown scrolls the column, as on every other Wear screen.
        rootScroll.setOnGenericMotionListener { _, event ->
            if (event.action == MotionEvent.ACTION_SCROLL && event.isFromSource(InputDevice.SOURCE_ROTARY_ENCODER)) {
                val factor = ViewConfigurationCompat.getScaledVerticalScrollFactor(ViewConfiguration.get(this), this)
                rootScroll.scrollBy(0, Math.round(-event.getAxisValue(MotionEvent.AXIS_SCROLL) * factor))
                true
            } else {
                false
            }
        }
        transportBluetoothButton.setOnClickListener { onTransportSelected(WatchTransportKind.BLUETOOTH) }
        transportWifiButton.setOnClickListener { onTransportSelected(WatchTransportKind.WIFI) }
        spo2Button.setOnClickListener { onOnDemandButtonClicked(TRACKER_SPO2_ON_DEMAND) }
        ecgButton.setOnClickListener { onOnDemandButtonClicked(TRACKER_ECG_ON_DEMAND) }
        biaButton.setOnClickListener { onOnDemandButtonClicked(TRACKER_BIA_ON_DEMAND) }
        sweatLossButton.setOnClickListener { onOnDemandButtonClicked(TRACKER_SWEAT_LOSS_ON_DEMAND) }
        // Restores the persisted selection; a fresh install (and any install
        // upgrading from the Wi-Fi-only build) starts on Bluetooth.
        applyTransport(prefs.transport, persist = false)

        // Streaming control and status reporting must not depend on the screen being
        // on: a reconnect that lands while the display is off still has to start
        // (or stop) the sensors. Only rendering is tied to STARTED, below.
        lifecycleScope.launch { watchLink.state.collect { applyStreamingState(it) } }
        lifecycleScope.launch { ppgCollector.state.collect { watchLink.sendPpgStatus(it.wireValue()) } }
        lifecycleScope.launch {
            medicalCollector.state.collect { statuses ->
                statuses.forEach { (tracker, state) -> watchLink.sendMedicalStatus(tracker, state.wireValue()) }
            }
        }
        lifecycleScope.launch {
            onDemandSampler.state.collect { statuses ->
                statuses.forEach { (tracker, state) -> watchLink.sendMedicalStatus(tracker, state.wireValue()) }
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { watchLink.state.collect { renderState(it) } }
                launch { watchLink.lastFailureReason.collect { reason -> linkDiagnosticsText.text = reason.orEmpty() } }
                launch {
                    // Sequence changes at the sensor rate (up to 50 Hz); the screen needs two updates a second.
                    watchLink.lastOrientationSequence.collect { sequence ->
                        detailText.text = if (sequence == 0L) {
                            ""
                        } else {
                            getString(R.string.sensors_streaming) + " · seq=$sequence"
                        }
                        delay(UI_REFRESH_INTERVAL_MS)
                    }
                }
                launch {
                    ppgCollector.state.collect { state -> renderPpgState(state, ppgCollector.diagnostic.value) }
                }
                launch {
                    ppgCollector.diagnostic.collect { diagnostic ->
                        renderPpgState(ppgCollector.state.value, diagnostic)
                        delay(UI_REFRESH_INTERVAL_MS)
                    }
                }
                launch { onDemandSampler.state.collect { updateOnDemandButtons(it) } }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        releaseStemButtonIfPressed()
        // Nothing is registered while there is no desktop to send to: the former
        // "monitor mode" kept the rotation-vector sensor running while backgrounded
        // and disconnected, and every reading it produced was dropped unsent.
    }

    override fun onResume() {
        super.onResume()
        rootScroll.requestFocus()
        if (selectedTransport == WatchTransportKind.WIFI && !watchLink.state.value.isConnectionActive()) {
            sensorCollector.stop()
            desktopDiscovery.start()
            pairingServer.start()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        releaseStemButtonIfPressed()
        stopSensorCollection()
        desktopDiscovery.stop()
        pairingServer.stop()
        bleObserverJob?.cancel()
        bleObserverJob = null
        // `shutdown` releases whichever transport is installed, including the
        // GATT server and its advertisement.
        watchLink.shutdown()
        bleTransport = null
        StreamingForegroundService.stop(this)
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

    private fun onTransportSelected(kind: WatchTransportKind) {
        if (kind == selectedTransport) return
        applyTransport(kind, persist = true)
    }

    /**
     * Makes [kind] the one live transport. The other one is torn down first and
     * completely: Wi-Fi releases its WebSocket, mDNS browser and pairing
     * listener; Bluetooth releases its advertisement and GATT server. Neither
     * is ever left running in the background behind the other.
     */
    private fun applyTransport(kind: WatchTransportKind, persist: Boolean) {
        selectedTransport = kind
        if (persist) prefs.transport = kind

        stopSensorCollection()
        StreamingForegroundService.stop(this)
        sensorStatusText.setText(R.string.sensors_idle)
        watchLink.disconnect()

        desktopDiscovery.stop(showWifiStatus = false)
        pairingServer.stop()
        bleObserverJob?.cancel()
        bleObserverJob = null
        bleTransport?.shutdown()
        bleTransport = null

        renderTransportSelector()
        when (kind) {
            WatchTransportKind.BLUETOOTH -> startBluetoothTransport()
            WatchTransportKind.WIFI -> startWifiTransport()
        }
    }

    private fun startBluetoothTransport() {
        val transport = BleGattTransport(this, prefs)
        val missing = transport.missingPermissions()
        if (missing.isNotEmpty()) {
            connectionStatusText.setText(R.string.ble_permission_required)
            requestBluetoothPermissions.launch(missing.toTypedArray())
            return
        }
        bleTransport = transport
        bleObserverJob = lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                transport.pendingTrustedCentral.collect { renderTrustPrompt(it) }
            }
        }
        discoveryStatusText.setText(R.string.ble_advertising)
        discoveryHistoryText.text = ""
        watchLink.connect(transport)
    }

    private fun startWifiTransport() {
        desktopDiscovery.start()
        pairingServer.start()
        // Durable pairing fallback: reconnect to whatever we last used, right
        // away, so the watch doesn't sit idle waiting on a fresh mDNS
        // resolve. Not "manual", so a subsequent discovery result is still
        // free to replace it.
        val persistedEndpoint = prefs.endpoint
        if (!persistedEndpoint.isNullOrBlank()) {
            endpointSource = EndpointSource.PERSISTED_FALLBACK
            renderEndpointSource()
            connectToDesktop(persistedEndpoint)
        }
    }

    private fun renderTransportSelector() {
        transportBluetoothButton.isChecked = selectedTransport == WatchTransportKind.BLUETOOTH
        transportWifiButton.isChecked = selectedTransport == WatchTransportKind.WIFI
        val wifiOnly = if (selectedTransport == WatchTransportKind.WIFI) View.VISIBLE else View.GONE
        connectButton.visibility = wifiOnly
        endpointSourceText.visibility = wifiOnly
        discoveryHistoryText.visibility = wifiOnly
        if (selectedTransport != WatchTransportKind.BLUETOOTH) {
            trustButton.visibility = View.GONE
            forgetTrustButton.visibility = View.GONE
        }
    }

    /**
     * Shows the explicit per-desktop trust gate; see `BleGattTransport`'s trust model.
     * Approving is a prominent action under the status; forgetting a trusted desktop is
     * rare and destructive, so it lives in the Link section and needs a second tap.
     */
    private fun renderTrustPrompt(pendingCentral: String?) {
        val bluetooth = selectedTransport == WatchTransportKind.BLUETOOTH
        if (pendingCentral != null && bluetooth) {
            trustButton.visibility = View.VISIBLE
            trustButton.text = getString(R.string.action_trust) + "\n" + pendingCentral
        } else {
            trustButton.visibility = View.GONE
        }
        val trusted = bleTransport?.trustedCentral?.value
        forgetTrustButton.visibility = if (bluetooth && trusted != null && pendingCentral == null) View.VISIBLE else View.GONE
        disarmForget()
    }

    private fun onTrustButtonClicked() {
        val transport = bleTransport ?: return
        if (transport.pendingTrustedCentral.value != null) {
            transport.approvePendingCentral()
            renderTrustPrompt(transport.pendingTrustedCentral.value)
        }
    }

    private fun onForgetButtonClicked() {
        val transport = bleTransport ?: return
        if (!forgetArmed) {
            forgetArmed = true
            forgetTrustButton.setText(R.string.action_forget_confirm)
            forgetTrustButton.postDelayed({ disarmForget() }, FORGET_CONFIRM_WINDOW_MS)
            return
        }
        transport.forgetTrustedCentral()
        renderTrustPrompt(transport.pendingTrustedCentral.value)
    }

    private fun disarmForget() {
        forgetArmed = false
        forgetTrustButton.setText(R.string.action_forget_trust)
    }

    private fun toggleDetails() {
        val show = detailsPanel.visibility != View.VISIBLE
        detailsPanel.visibility = if (show) View.VISIBLE else View.GONE
        detailsToggleButton.setText(if (show) R.string.details_hide else R.string.details_show)
    }

    private fun onConnectButtonClicked() {
        if (watchLink.state.value.isConnectionActive()) {
            stopSensorCollection()
            watchLink.disconnect()
            StreamingForegroundService.stop(this)
            sensorStatusText.setText(R.string.sensors_idle)
            return
        }

        connectionStatusText.text = "Looking for desktop…"
        desktopDiscovery.start()
        desktopDiscovery.refresh()
        pairingServer.start()
    }

    private fun connectDesktop(url: String, source: EndpointSource) {
        if (selectedTransport != WatchTransportKind.WIFI) return
        if (watchLink.state.value.isConnectionActive()) return
        endpointSource = source
        renderEndpointSource()
        prefs.endpoint = url
        connectToDesktop(url)
    }

    private fun renderEndpointSource() {
        endpointSourceText.text = when (endpointSource) {
            EndpointSource.DISCOVERED -> getString(R.string.endpoint_source_discovered)
            EndpointSource.PERSISTED_FALLBACK -> getString(R.string.endpoint_source_persisted)
            EndpointSource.DESKTOP_INITIATED -> getString(R.string.endpoint_source_desktop)
        }
    }

    private fun connectToDesktop(url: String) {
        watchLink.connect(WebSocketTransport(url))
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

    private fun stopSensorCollection() {
        sensorCollector.stop()
        ppgCollector.stop()
        medicalCollector.stop()
        onDemandSampler.stopAll()
    }

    private fun ConnectionState.isConnectionActive(): Boolean =
        this == ConnectionState.CONNECTED ||
            this == ConnectionState.CONNECTING ||
            this == ConnectionState.RECONNECTING ||
            this == ConnectionState.AWAITING_TRUST

    /** Same foreground, single-session start/stop the desktop drives via `desktop.start_measurement`; see [OnDemandMedicalSampler]. */
    private fun onOnDemandButtonClicked(trackerId: String) {
        if (onDemandSampler.state.value[trackerId] == MedicalTrackerState.MEASURING) {
            onDemandSampler.stop(trackerId)
        } else {
            onDemandSampler.start(trackerId)
        }
    }

    /** Mirrors the desktop's on-demand button enablement (LiveTelemetry.tsx): only one tracker may measure at a time. */
    private fun updateOnDemandButtons(statuses: Map<String, MedicalTrackerState>) {
        fun apply(button: Button, trackerId: String, name: String) {
            val state = statuses[trackerId] ?: MedicalTrackerState.IDLE
            val measuring = state == MedicalTrackerState.MEASURING
            val anotherActive = statuses.any { (id, other) -> id != trackerId && other == MedicalTrackerState.MEASURING }
            // Two columns on a round screen leave room for a word, not a sentence.
            button.text = when {
                measuring -> "Stop\n$name"
                state == MedicalTrackerState.IDLE -> name
                else -> "$name\n${state.wireValue().replace('_', ' ')}"
            }
            button.isEnabled = !anotherActive && (state == MedicalTrackerState.IDLE || measuring)
        }
        apply(spo2Button, TRACKER_SPO2_ON_DEMAND, "SpO2")
        apply(ecgButton, TRACKER_ECG_ON_DEMAND, "ECG")
        apply(biaButton, TRACKER_BIA_ON_DEMAND, "BIA")
        apply(sweatLossButton, TRACKER_SWEAT_LOSS_ON_DEMAND, "Sweat")
    }

    private fun renderState(state: ConnectionState) {
        if (state == ConnectionState.CONNECTED) {
            desktopDiscovery.stop(showWifiStatus = false)
            pairingServer.stop()
            discoveryStatusText.text = "Connected to desktop"
            discoveryHistoryText.text = ""
            sensorStatusText.setText(R.string.sensors_streaming)
            // May need to ask for BODY_SENSORS, which only works while visible.
            startBodySensorCollection()
        }
        connectionStatusText.setTextColor(
            ContextCompat.getColor(
                this,
                when (state) {
                    ConnectionState.CONNECTED -> R.color.gc_green
                    ConnectionState.FAILED -> R.color.gc_red
                    ConnectionState.CONNECTING, ConnectionState.RECONNECTING, ConnectionState.AWAITING_TRUST -> R.color.gc_yellow
                    ConnectionState.DISCONNECTED -> R.color.gc_ink
                },
            ),
        )
        // Over Bluetooth the watch is the peripheral: "connecting" really means it is
        // advertising and waiting for the desktop to find it, which reads very differently.
        val bluetooth = selectedTransport == WatchTransportKind.BLUETOOTH
        if (bluetooth) {
            when (state) {
                ConnectionState.CONNECTED -> discoveryStatusText.setText(R.string.hint_connected)
                ConnectionState.CONNECTING -> discoveryStatusText.setText(R.string.hint_waiting_ble)
                ConnectionState.AWAITING_TRUST -> discoveryStatusText.setText(R.string.hint_approve)
                else -> Unit
            }
        }
        connectionStatusText.text = when (state) {
            ConnectionState.DISCONNECTED -> getString(R.string.status_disconnected)
            ConnectionState.CONNECTING ->
                getString(if (bluetooth) R.string.status_waiting else R.string.status_connecting)
            ConnectionState.CONNECTED -> getString(R.string.status_connected)
            ConnectionState.RECONNECTING -> getString(R.string.status_reconnecting)
            ConnectionState.AWAITING_TRUST -> getString(R.string.status_approve)
            ConnectionState.FAILED -> getString(R.string.status_failed)
        }
        fitStatusText()
        connectButton.text = when (state) {
            ConnectionState.CONNECTED, ConnectionState.CONNECTING, ConnectionState.RECONNECTING,
            ConnectionState.AWAITING_TRUST -> getString(R.string.action_disconnect)
            ConnectionState.DISCONNECTED, ConnectionState.FAILED ->
                getString(R.string.action_connect)
        }
        if (state != ConnectionState.CONNECTED) {
            sensorStatusText.setText(R.string.sensors_idle)
        }
    }

    /**
     * What runs follows the link, not the screen: sensors, PPG and the CPU wake lock
     * exist only while a desktop is actually receiving. While waiting to reconnect
     * (advertising, awaiting trust, retrying) the foreground service stays so the
     * process is not frozen, but the wake lock and every sensor are released.
     * Idempotent: each collector ignores a start it is already in.
     */
    private fun applyStreamingState(state: ConnectionState) {
        when (state) {
            ConnectionState.CONNECTED -> {
                StreamingForegroundService.start(this)
                sensorCollector.start()
                if (ppgCollector.hasBodySensorsPermission()) {
                    ppgCollector.start()
                    medicalCollector.start()
                }
            }
            ConnectionState.DISCONNECTED, ConnectionState.FAILED -> {
                stopSensorCollection()
                StreamingForegroundService.stop(this)
            }
            else -> {
                stopSensorCollection()
                StreamingForegroundService.releaseWakeLock(this)
            }
        }
    }

    /**
     * Picks the largest size, up to [STATUS_MAX_SP], at which the status word fits on one
     * line in the room the screen shape leaves it. Measured rather than auto-sized: the same
     * word has to fit a 198 dp round face and a larger square one without ever wrapping
     * mid-word.
     */
    private fun fitStatusText() {
        val view = connectionStatusText
        view.post {
            val room = view.width - view.paddingLeft - view.paddingRight
            if (room <= 0) return@post
            val scale = resources.displayMetrics.scaledDensity
            val text = view.text.toString().uppercase()
            var size = STATUS_MAX_SP
            while (size > STATUS_MIN_SP) {
                view.paint.textSize = size * scale
                if (view.paint.measureText(text) + view.paint.letterSpacing * view.paint.textSize * text.length <= room) break
                size -= 1f
            }
            view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, size)
        }
    }

    private fun renderPpgState(state: PpgState, diagnostic: String?) {
        val label = when (state) {
            PpgState.IDLE -> getString(R.string.ppg_idle)
            PpgState.PERMISSION_REQUIRED -> getString(R.string.ppg_permission_required)
            PpgState.CONNECTING -> getString(R.string.ppg_connecting)
            PpgState.STREAMING -> getString(R.string.ppg_streaming)
            PpgState.UNAVAILABLE -> getString(R.string.ppg_unavailable)
            PpgState.ERROR -> getString(R.string.ppg_error)
        }
        ppgStatusText.text = diagnostic?.let { "$label\n$it" } ?: label
    }

    /** Fires a single short vibration for a `desktop.haptic` command; [durationMs] is already bounds-checked by WatchLinkManager. */
    private fun triggerHaptic(durationMs: Int) {
        val device = vibrator ?: return
        if (!device.hasVibrator()) return
        device.vibrate(VibrationEffect.createOneShot(durationMs.toLong(), VibrationEffect.DEFAULT_AMPLITUDE))
    }

    private fun readBatteryPercent(): Int? {
        val batteryManager = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val level = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) level else null
    }
}
