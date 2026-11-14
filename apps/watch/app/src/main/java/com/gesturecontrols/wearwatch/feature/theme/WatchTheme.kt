package com.gesturecontrols.wearwatch.feature.theme

/**
 * The desktop's three looks, which the watch app wears to match (`desktop.set_theme`). The names are the desktop's
 * (`AppTheme` in apps/desktop/src/shared/theme/theme.ts, `WATCH_THEMES` in spatial_protocol).
 */
enum class WatchTheme(val wire: String) {
    /** Deep blue, flat and square: the watch's look before the desktop had themes, and its default. */
    ELECTRIC("electric"),

    /** Neo-brutalism: cream paper, black ink, thick outlines. */
    NEO("neo"),

    /** A NERV command terminal: black, orange frames, green state. */
    NERV("nerv");

    companion object {
        /** The theme a name stands for, or null for a name this app does not know (a newer desktop's theme). */
        fun fromWire(name: String?): WatchTheme? = entries.firstOrNull { it.wire == name }
    }
}
