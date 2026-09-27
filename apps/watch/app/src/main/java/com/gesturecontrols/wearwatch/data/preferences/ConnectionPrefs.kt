package com.gesturecontrols.wearwatch.data.preferences

import com.gesturecontrols.wearwatch.data.connection.WatchTransportKind

import android.content.Context

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

    companion object {
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_TRANSPORT = "transport"
        private const val KEY_TRUSTED_CENTRAL = "trusted_central"
    }
}
