package com.gesturecontrols.wearwatch.data.preferences

import android.content.Context

/** Persists the desktop WebSocket endpoint locally so it survives app restarts. */
class ConnectionPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("watch_link_prefs", Context.MODE_PRIVATE)

    var endpoint: String?
        get() = prefs.getString(KEY_ENDPOINT, null)
        set(value) = prefs.edit().putString(KEY_ENDPOINT, value).apply()

    companion object {
        private const val KEY_ENDPOINT = "endpoint"
    }
}
