package com.gesturecontrols.wearwatch.data.preferences

import com.gesturecontrols.wearwatch.data.connection.WatchTransportKind

import android.content.Context
import java.util.UUID

/** Persists the desktop link's configuration locally so it survives app restarts. */
class ConnectionPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("watch_link_prefs", Context.MODE_PRIVATE)

    /** Desktop WebSocket endpoint used by the Wi-Fi transport. */
    var endpoint: String?
        get() = prefs.getString(KEY_ENDPOINT, null)
        set(value) = prefs.edit().putString(KEY_ENDPOINT, value).apply()

    /**
     * Which transport the user selected. Installs that predate the key — every
     * Wi-Fi-only build — read as [WatchTransportKind.DEFAULT], i.e. they
     * migrate to Bluetooth, which is also what a fresh install starts on. The
     * saved [endpoint] is left untouched by that migration, so switching back
     * to Wi-Fi reconnects without rediscovery.
     */
    var transport: WatchTransportKind
        get() = WatchTransportKind.fromWireValue(prefs.getString(KEY_TRANSPORT, null))
        set(value) = prefs.edit().putString(KEY_TRANSPORT, value.wireValue).apply()

    /**
     * BLE address of the desktop the user has explicitly approved. Null means
     * no central is trusted yet and the BLE transport streams nothing; see
     * `BleGattTransport`'s trust model.
     */
    var trustedCentral: String?
        get() = prefs.getString(KEY_TRUSTED_CENTRAL, null)
        set(value) = prefs.edit().putString(KEY_TRUSTED_CENTRAL, value).apply()

    /**
     * Keep streaming while the watch is off the wrist. Off by default: nothing useful is
     * measured off-body and the sensors are the battery's biggest cost. Turn it on to
     * test or record with the watch on a desk.
     */
    var streamWhenNotWorn: Boolean
        get() = prefs.getBoolean(KEY_STREAM_WHEN_NOT_WORN, false)
        set(value) = prefs.edit().putBoolean(KEY_STREAM_WHEN_NOT_WORN, value).apply()

    /**
     * This install's identity on the Wi-Fi transport, where the desktop has no
     * Bluetooth peripheral to identify the watch by and can only go by what the
     * watch claims. Generated once and kept, so two watches never share an id
     * and one watch keeps its id across restarts. (Over Bluetooth the desktop
     * assigns the id from the discovered peripheral and ignores this.)
     */
    val deviceId: String
        get() {
            prefs.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() }?.let { return it }
            val created = newDeviceId()
            prefs.edit().putString(KEY_DEVICE_ID, created).apply()
            return created
        }

    companion object {
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_TRANSPORT = "transport"
        private const val KEY_TRUSTED_CENTRAL = "trusted_central"
        private const val KEY_STREAM_WHEN_NOT_WORN = "stream_when_not_worn"

        /** A fresh, unique, protocol-safe device id. */
        fun newDeviceId(): String = "watch-" + UUID.randomUUID().toString()
    }
}
