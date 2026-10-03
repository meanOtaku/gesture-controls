package com.gesturecontrols.wearwatch.data.connection

import com.gesturecontrols.wearwatch.data.preferences.ConnectionPrefs

import android.Manifest
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.IntentFilter
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import java.util.ArrayDeque
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Bluetooth LE transport: the watch is the GATT **peripheral**, advertising
 * [SERVICE_UUID], notifying protocol envelopes on [TELEMETRY_UUID] and
 * accepting desktop commands as write-with-response on [COMMAND_UUID]. The
 * desktop is the central, because that is the role its cross-platform BLE
 * library supports on macOS, Windows and Linux alike.
 *
 * The bytes on the wire are the same envelopes the WebSocket transport carries
 * (docs/protocols/watch-ble-transport.md), fragmented by [BleFraming].
 *
 * ## Trust model
 *
 * Two gates, both required before a single telemetry byte leaves the watch:
 *
 * 1. **OS bonding.** Both characteristics and the telemetry CCCD are declared
 *    with `PERMISSION_*_ENCRYPTED`, so Android's stack refuses subscription and
 *    command writes until the two devices are bonded and the link is encrypted.
 * 2. **Explicit app-level trust.** BLE "Just Works" bonding authenticates
 *    nothing, so bonding alone would let any nearby machine drive this watch.
 *    The first central to connect is therefore held in
 *    [pendingTrustedCentral] until the user approves it on the watch;
 *    [approvePendingCentral] persists that address in [ConnectionPrefs] so
 *    later reconnects are silent. Until then this transport sends nothing and
 *    answers command writes with `GATT_INSUFFICIENT_AUTHORIZATION`.
 */
class BleGattTransport(
    private val context: Context,
    private val prefs: ConnectionPrefs,
) : WatchTransportLink {

    override val kind = WatchTransportKind.BLUETOOTH
    override var onState: ((ConnectionState, String?) -> Unit)? = null
    override var onMessage: ((String) -> Unit)? = null

    private val bluetoothManager: BluetoothManager? =
        context.applicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var telemetryCharacteristic: BluetoothGattCharacteristic? = null

    /** The one central we talk to. BLE allows several; this protocol is one desktop per watch. */
    // Written on binder threads by the GATT callbacks, read on the sensor
    // threads that call `send`.
    @Volatile private var central: BluetoothDevice? = null
    @Volatile private var subscribed = false
    @Volatile private var mtu = DEFAULT_MTU

    /** Fragments waiting on [BluetoothGattServerCallback.onNotificationSent]. */
    private val outbound = ArrayDeque<ByteArray>()
    private var notificationInFlight = false
    private var droppedBacklogs = 0

    /**
     * A GATT *client* connection back to the central, held only so the Bluetooth
     * stack has something to confirm the central's Service Changed indication
     * with. macOS sends that indication the moment a bonded peer connects and
     * disconnects the link 30 s later if it is not confirmed; with no client on
     * the connection the watch never confirmed it, so every session ended after
     * exactly 30 s. See docs/protocols/watch-ble-transport.md.
     */
    private var confirmationClient: BluetoothGatt? = null

    private val confirmationCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            Log.i(TAG, "confirmation client state=$newState status=$status")
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                runCatching { gatt.discoverServices() }
            }
        }

        override fun onServiceChanged(gatt: BluetoothGatt) {
            LinkLog.add("desktop reported Service Changed; confirming")
            runCatching { gatt.discoverServices() }
        }
    }

    /** A short, stable handle for a central in the log: enough to tell two apart without printing the whole address. */
    private fun short(device: BluetoothDevice): String = "…" + device.address.takeLast(5)

    private fun openConfirmationClient(device: BluetoothDevice) {
        closeConfirmationClient()
        confirmationClient = runCatching {
            device.connectGatt(context.applicationContext, false, confirmationCallback, BluetoothDevice.TRANSPORT_LE)
        }.onFailure { LinkLog.add("could not open the Service Changed confirmation client: ${it.javaClass.simpleName}") }.getOrNull()
    }

    private fun closeConfirmationClient() {
        val client = confirmationClient ?: return
        confirmationClient = null
        runCatching { client.disconnect() }
        runCatching { client.close() }
    }
    private val reassembler = BleFraming.Reassembler()
    private var started = false

    private val _pendingTrustedCentral = MutableStateFlow<String?>(null)

    /** Address of a central awaiting the user's approval, or null. */
    val pendingTrustedCentral: StateFlow<String?> = _pendingTrustedCentral.asStateFlow()

    private val _trustedCentral = MutableStateFlow(prefs.trustedCentral)

    /** Address the user has already approved, surviving restarts. */
    val trustedCentral: StateFlow<String?> = _trustedCentral.asStateFlow()

    override fun start() {
        if (started) return
        val failure = unavailableReason()
        if (failure != null) {
            // Never quietly fall back to Wi-Fi: Bluetooth stays selected and
            // the UI shows exactly what has to be fixed.
            report(ConnectionState.FAILED, failure)
            return
        }
        started = true
        LinkLog.add("bluetooth: starting (GATT server and advertising)")
        registerAdapterStateReceiver()
        desktopSilence.heard(SystemClock.elapsedRealtime())
        watchdogHandler.removeCallbacks(watchdog)
        watchdogHandler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)
        report(ConnectionState.CONNECTING, null)
        if (!openGattServer()) {
            started = false
            report(ConnectionState.FAILED, "Could not open the Bluetooth GATT server")
            return
        }
        startAdvertising()
    }

    override fun stop() {
        if (!started && gattServer == null) {
            report(ConnectionState.DISCONNECTED, null)
            return
        }
        started = false
        unregisterAdapterStateReceiver()
        watchdogHandler.removeCallbacks(watchdog)
        LinkLog.add("bluetooth: stopped")
        teardown()
        report(ConnectionState.DISCONNECTED, null)
    }

    /**
     * The watch keeps advertising while backgrounded: the streaming foreground
     * service holds the session, and dropping the GATT server here would make
     * every screen-off moment a disconnect for the desktop. Unlike the Wi-Fi
     * transport there is no socket or wake source to release.
     */
    override fun pause() = Unit

    override fun resume() = Unit

    override fun shutdown() {
        stop()
    }

    override fun send(message: String): Boolean {
        val ok = sendMessage(message)
        LinkLog.noteSend(ok)
        return ok
    }

    private fun sendMessage(message: String): Boolean {
        if (!isTrusted(central) || !subscribed) return false
        val fragments = BleFraming.fragment(message.toByteArray(Charsets.UTF_8), BleFraming.attPayloadFor(mtu))
        if (fragments == null) return false
        synchronized(outbound) {
            // Bounded queue: telemetry is time-sensitive, so a stalled link
            // drops a backlog rather than growing without limit. The whole
            // backlog goes at once — dropping the *oldest* fragments would
            // leave a half-sent envelope at the head and desync the desktop's
            // reassembler, which is worse than losing the backlog outright.
            if (outbound.size + fragments.size > MAX_QUEUED_FRAGMENTS) {
                droppedBacklogs++
                LinkLog.add("dropped ${outbound.size} queued fragments (#$droppedBacklogs, MTU $mtu): the desktop is not keeping up")
                outbound.clear()
            }
            fragments.forEach { outbound.addLast(it) }
        }
        pumpOutbound()
        return true
    }

    /** Approves the central currently awaiting trust and starts streaming to it. */
    fun approvePendingCentral() {
        val address = _pendingTrustedCentral.value ?: return
        LinkLog.add("trusted the desktop …${address.takeLast(5)}")
        prefs.trustedCentral = address
        _trustedCentral.value = address
        _pendingTrustedCentral.value = null
        updateConnectedState()
    }

    /** Revokes the stored trust and drops the current central. */
    fun forgetTrustedCentral() {
        LinkLog.add("forgot the trusted desktop")
        prefs.trustedCentral = null
        _trustedCentral.value = null
        val device = central
        _pendingTrustedCentral.value = device?.address
        synchronized(outbound) { outbound.clear() }
        if (device != null) {
            runCatching { gattServer?.cancelConnection(device) }
        }
        updateConnectedState()
    }

    /**
     * Why BLE cannot start right now, or null if it can. Checked before any
     * GATT/advertising call so a missing permission surfaces as a UI state
     * rather than a SecurityException.
     */
    fun unavailableReason(): String? {
        val adapter = bluetoothManager?.adapter ?: return "This watch has no Bluetooth adapter"
        if (!adapter.isEnabled) return "Turn Bluetooth on to use the Bluetooth transport"
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            return "This watch does not support Bluetooth LE"
        }
        if (!adapter.isMultipleAdvertisementSupported) {
            return "This watch cannot advertise as a Bluetooth LE peripheral"
        }
        val missing = missingPermissions()
        if (missing.isNotEmpty()) {
            return "Grant Bluetooth permission (${missing.joinToString { it.substringAfterLast('.') }})"
        }
        return null
    }

    /**
     * Runtime permissions this transport needs. Empty below API 31, where
     * `BLUETOOTH`/`BLUETOOTH_ADMIN` are install-time permissions instead.
     * `BLUETOOTH_SCAN` is deliberately absent: the watch only advertises.
     */
    fun missingPermissions(): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        return REQUIRED_RUNTIME_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
        }
    }

    private fun openGattServer() = runCatching {
        val server = bluetoothManager?.openGattServer(context, serverCallback) ?: return@runCatching false
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val telemetry = BluetoothGattCharacteristic(
            TELEMETRY_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ_ENCRYPTED,
        )
        telemetry.addDescriptor(
            BluetoothGattDescriptor(
                CLIENT_CHARACTERISTIC_CONFIG_UUID,
                BluetoothGattDescriptor.PERMISSION_READ_ENCRYPTED or
                    BluetoothGattDescriptor.PERMISSION_WRITE_ENCRYPTED,
            )
        )
        val command = BluetoothGattCharacteristic(
            COMMAND_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE,
            BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED,
        )
        service.addCharacteristic(telemetry)
        service.addCharacteristic(command)
        server.addService(service)
        gattServer = server
        telemetryCharacteristic = telemetry
        true
    }.getOrDefault(false)

    private fun startAdvertising() {
        val leAdvertiser = bluetoothManager?.adapter?.bluetoothLeAdvertiser
        if (leAdvertiser == null) {
            report(ConnectionState.FAILED, "This watch cannot advertise as a Bluetooth LE peripheral")
            return
        }
        advertiser = leAdvertiser
        // A restart must not race the advertisement the stack may have resumed on
        // its own after the last disconnect.
        runCatching { leAdvertiser.stopAdvertising(advertiseCallback) }
        // Balanced (about 250 ms) instead of low-latency (about 100 ms): the desktop
        // only needs to see the watch within a fraction of a second of scanning, and
        // the radio spends this whole period waiting for it.
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        // The desktop filters scans on the service UUID alone, so it must be in
        // the advertisement itself, not the scan response. The device name is
        // left out: it would not fit alongside a 128-bit UUID in 31 bytes.
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()
        // The scan response carries a short, stable label so a desktop can say which watch it
        // found without connecting first (it fits: a 128-bit UUID plus 4 bytes is 22 of 31).
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceData(ParcelUuid(SERVICE_UUID), WatchTag.bytesFor(prefs.deviceId))
            .build()
        runCatching { leAdvertiser.startAdvertising(settings, data, scanResponse, advertiseCallback) }
            .onFailure { report(ConnectionState.FAILED, "Bluetooth advertising was refused") }
    }

    private var adapterReceiverRegistered = false

    /**
     * Whether a desktop is expected to be writing to the watch right now; set by the activity
     * (true while streaming on the wrist). Silence outside that is not a fault.
     */
    @Volatile var expectDesktopTraffic: () -> Boolean = { false }

    private val desktopSilence = DesktopSilence(DESKTOP_SILENCE_MS)
    private val watchdogHandler = Handler(Looper.getMainLooper())
    private val watchdog = object : Runnable {
        override fun run() {
            val device = central
            val now = SystemClock.elapsedRealtime()
            val connected = device != null && subscribed && isTrusted(device)
            if (device != null && desktopSilence.shouldDrop(now, connected, expectDesktopTraffic())) {
                LinkLog.add("no message from the desktop for ${DESKTOP_SILENCE_MS / 1000} s while streaming; dropping the connection so a desktop can find this watch again")
                runCatching { gattServer?.cancelConnection(device) }
            } else if (device == null) {
                desktopSilence.heard(now)
            }
            watchdogHandler.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }

    /**
     * Bluetooth being switched off tears the GATT server down underneath this class; without
     * this the watch would sit "advertising" a server that no longer exists. Off is reported
     * as a failure with the way out; on rebuilds the server and advertisement.
     */
    private val adapterStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context, intent: Intent) {
            if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_OFF -> {
                    LinkLog.add("Bluetooth was turned off")
                    if (started) {
                        teardown()
                        report(ConnectionState.FAILED, "Bluetooth is off — turn it on to reconnect")
                    }
                }
                BluetoothAdapter.STATE_ON -> {
                    LinkLog.add("Bluetooth was turned on")
                    if (started && gattServer == null) {
                        if (openGattServer()) {
                            startAdvertising()
                            report(ConnectionState.CONNECTING, null)
                        } else {
                            report(ConnectionState.FAILED, "Could not reopen the Bluetooth GATT server")
                        }
                    }
                }
            }
        }
    }

    private fun registerAdapterStateReceiver() {
        if (adapterReceiverRegistered) return
        runCatching {
            context.applicationContext.registerReceiver(adapterStateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
            adapterReceiverRegistered = true
        }
    }

    private fun unregisterAdapterStateReceiver() {
        if (!adapterReceiverRegistered) return
        adapterReceiverRegistered = false
        runCatching { context.applicationContext.unregisterReceiver(adapterStateReceiver) }
    }

    private fun teardown() {
        runCatching { advertiser?.stopAdvertising(advertiseCallback) }
        advertiser = null
        val device = central
        central = null
        closeConfirmationClient()
        subscribed = false
        mtu = DEFAULT_MTU
        _pendingTrustedCentral.value = null
        synchronized(outbound) { outbound.clear() }
        notificationInFlight = false
        reassembler.clear()
        val server = gattServer
        gattServer = null
        telemetryCharacteristic = null
        runCatching {
            if (device != null) server?.cancelConnection(device)
            server?.clearServices()
            server?.close()
        }
    }

    private fun isTrusted(device: BluetoothDevice?): Boolean =
        device != null && device.address == _trustedCentral.value

    private fun updateConnectedState() {
        val state = when {
            !started -> ConnectionState.DISCONNECTED
            central == null -> ConnectionState.CONNECTING
            !isTrusted(central) -> ConnectionState.AWAITING_TRUST
            subscribed -> ConnectionState.CONNECTED
            else -> ConnectionState.CONNECTING
        }
        val reason = if (state == ConnectionState.AWAITING_TRUST) {
            "Approve ${central?.address ?: "this computer"} on the watch to start streaming"
        } else {
            null
        }
        report(state, reason)
    }

    private fun report(state: ConnectionState, reason: String?) {
        onState?.invoke(state, reason)
    }

    /**
     * Drains the outbound queue one notification at a time: BLE only allows a
     * single outstanding notification per connection, and the stack signals
     * readiness through `onNotificationSent`.
     */
    private fun pumpOutbound() {
        val server = gattServer ?: return
        val characteristic = telemetryCharacteristic ?: return
        val device = central ?: return
        if (!subscribed || !isTrusted(device)) return
        val frame = synchronized(outbound) {
            if (notificationInFlight || outbound.isEmpty()) return
            notificationInFlight = true
            outbound.pollFirst()
        } ?: return
        val sent = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                server.notifyCharacteristicChanged(device, characteristic, false, frame) ==
                    BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    characteristic.value = frame
                    server.notifyCharacteristicChanged(device, characteristic, false)
                }
            }
        }.getOrDefault(false)
        if (!sent) {
            // The stack refused the frame outright; the rest of this envelope
            // would reach the desktop as a truncated message, so drop the whole
            // queue and let the next envelope resynchronize it at index 0.
            synchronized(outbound) {
                outbound.clear()
                notificationInFlight = false
            }
        }
    }

    /** Only one desktop is served at a time, so nothing needs to find the watch while one is connected. */
    private fun stopAdvertising() {
        runCatching { advertiser?.stopAdvertising(advertiseCallback) }
        LinkLog.add("advertising paused (a desktop is connected)")
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            LinkLog.add("advertising as watch ${WatchTag.labelFor(prefs.deviceId)}: waiting for a desktop to find it")
        }

        override fun onStartFailure(errorCode: Int) {
            if (errorCode == ADVERTISE_FAILED_ALREADY_STARTED) {
                LinkLog.add("advertising was already running")
                return
            }
            LinkLog.add("advertising failed: ${advertiseFailureReason(errorCode)}")
            report(ConnectionState.FAILED, advertiseFailureReason(errorCode))
        }
    }

    private fun advertiseFailureReason(errorCode: Int): String = when (errorCode) {
        AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE -> "Bluetooth advertisement payload too large"
        AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "Too many Bluetooth advertisers active"
        AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "Bluetooth advertising already running"
        AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "Bluetooth advertising failed inside the system"
        AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "This watch cannot advertise as a Bluetooth LE peripheral"
        else -> "Bluetooth advertising failed"
    }

    private val serverCallback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                // One desktop at a time. A second central is refused rather
                // than allowed to race the first one's session.
                if (central != null && central?.address != device.address) {
                    LinkLog.add("refused a second desktop ${short(device)} (one is already attached)")
                    runCatching { gattServer?.cancelConnection(device) }
                    return
                }
                LinkLog.add("desktop ${short(device)} connected")
                desktopSilence.heard(SystemClock.elapsedRealtime())
                central = device
                subscribed = false
                mtu = DEFAULT_MTU
                stopAdvertising()
                openConfirmationClient(device)
                reassembler.clear()
                synchronized(outbound) {
                    outbound.clear()
                    notificationInFlight = false
                }
                _pendingTrustedCentral.value = if (isTrusted(device)) null else device.address
                updateConnectedState()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                if (central?.address != device.address) return
                // Status 0 is a clean close; 8 a supervision timeout (out of range / radio);
                // 19 the desktop hung up; 22 this watch did.
                LinkLog.add("desktop ${short(device)} disconnected (status $status)")
                central = null
                closeConfirmationClient()
                if (started && gattServer != null) startAdvertising()
                subscribed = false
                mtu = DEFAULT_MTU
                _pendingTrustedCentral.value = null
                reassembler.clear()
                synchronized(outbound) {
                    outbound.clear()
                    notificationInFlight = false
                }
                updateConnectedState()
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, newMtu: Int) {
            if (central?.address != device.address) return
            mtu = newMtu.coerceAtLeast(DEFAULT_MTU)
            LinkLog.add("MTU $newMtu (${BleFraming.attPayloadFor(mtu)} bytes per notification)")
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.uuid != CLIENT_CHARACTERISTIC_CONFIG_UUID) {
                respond(device, requestId, BluetoothGatt.GATT_FAILURE, offset, responseNeeded)
                return
            }
            // The subscription itself is allowed before approval: refusing it
            // would only surface on the desktop as a bonding error, hiding the
            // real reason. Nothing is ever notified to an unapproved central —
            // `pumpOutbound` and `send` both check `isTrusted` — so the gate
            // still holds, and the desktop can report "awaiting approval"
            // instead of a misleading failure.
            if (!isTrusted(device)) {
                _pendingTrustedCentral.value = device.address
            }
            subscribed = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            LinkLog.add(
                "desktop ${short(device)} turned notifications " + (if (subscribed) "on" else "off") +
                    (if (isTrusted(device)) "" else " (not trusted yet: waiting for approval)"),
            )
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, responseNeeded)
            updateConnectedState()
            if (subscribed) pumpOutbound()
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor,
        ) {
            val value = if (subscribed) {
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            } else {
                BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            }
            runCatching {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid != COMMAND_UUID) {
                respond(device, requestId, BluetoothGatt.GATT_FAILURE, offset, responseNeeded)
                return
            }
            if (!isTrusted(device)) {
                // Unauthenticated desktop control is the thing this gate
                // exists to prevent; the command is never parsed.
                _pendingTrustedCentral.value = device.address
                respond(device, requestId, INSUFFICIENT_AUTHORIZATION, offset, responseNeeded)
                updateConnectedState()
                return
            }
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, responseNeeded)
            desktopSilence.heard(SystemClock.elapsedRealtime())
            val envelope = reassembler.push(value) ?: return
            onMessage?.invoke(String(envelope, Charsets.UTF_8))
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            if (central?.address != device.address) return
            synchronized(outbound) { notificationInFlight = false }
            if (status != BluetoothGatt.GATT_SUCCESS) {
                // Same reasoning as a refused notify: the desktop would see a
                // hole in this envelope, so abandon it rather than truncate.
                synchronized(outbound) { outbound.clear() }
                return
            }
            pumpOutbound()
        }
    }

    private fun respond(
        device: BluetoothDevice,
        requestId: Int,
        status: Int,
        offset: Int,
        responseNeeded: Boolean,
    ) {
        if (!responseNeeded) return
        runCatching { gattServer?.sendResponse(device, requestId, status, offset, null) }
    }

    companion object {
        /** Stable custom service; mirrors `WATCH_BLE_SERVICE_UUID` in crates/watch-bridge/src/ble.rs. */
        val SERVICE_UUID: UUID = UUID.fromString("6b1d0001-9f2a-4c7e-9a1b-2f5a7c3e8d41")

        /** Watch → desktop envelopes, as GATT notifications. */
        val TELEMETRY_UUID: UUID = UUID.fromString("6b1d0002-9f2a-4c7e-9a1b-2f5a7c3e8d41")

        /** Desktop → watch commands, as write-with-response. */
        val COMMAND_UUID: UUID = UUID.fromString("6b1d0003-9f2a-4c7e-9a1b-2f5a7c3e8d41")

        private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID =
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /** ATT error 0x08; not exposed as a constant by the framework. */
        private const val INSUFFICIENT_AUTHORIZATION = 0x08

        private const val TAG = "BleGattTransport"
        private const val DEFAULT_MTU = 23

        /** The desktop writes a time sync every 5 s while the watch is worn and streaming; five missed ones is a dead desktop. */
        private const val DESKTOP_SILENCE_MS = 25_000L
        private const val WATCHDOG_INTERVAL_MS = 5_000L

        /**
         * Roughly two seconds of orientation frames at 50Hz and the default
         * MTU. Past this the desktop is not keeping up and stale motion is
         * worthless anyway.
         */
        private const val MAX_QUEUED_FRAGMENTS = 512

        /** Requested at runtime on API 31+; see [missingPermissions]. */
        val REQUIRED_RUNTIME_PERMISSIONS = listOf(
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
        )
    }
}
