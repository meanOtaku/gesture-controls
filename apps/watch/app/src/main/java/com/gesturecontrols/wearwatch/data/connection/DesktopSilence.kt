package com.gesturecontrols.wearwatch.data.connection

/**
 * Decides when the watch should give up on a desktop that has stopped talking.
 *
 * While the watch is worn and streaming the desktop writes to it every few seconds (a time sync).
 * A desktop that was killed without disconnecting leaves the link looking connected: the watch
 * keeps streaming into it, stops advertising (it does while a desktop is attached), and no new desktop
 * can find it. Dropping the connection lets the watch advertise again.
 *
 * Silence only counts while traffic is expected. Off the wrist the watch sleeps and the desktop
 * stops writing on purpose, so that is not silence.
 */
class DesktopSilence(private val thresholdMs: Long) {
    private var lastHeardAtMs = 0L

    /** The desktop did something: connected, subscribed, or wrote. */
    fun heard(nowMs: Long) {
        lastHeardAtMs = nowMs
    }

    /**
     * True when the connection should be dropped now. Otherwise the clock is held at "now" while no
     * traffic is expected, so the full threshold applies from the moment traffic is expected again.
     */
    fun shouldDrop(nowMs: Long, connected: Boolean, trafficExpected: Boolean): Boolean {
        if (!connected || !trafficExpected) {
            lastHeardAtMs = nowMs
            return false
        }
        if (nowMs - lastHeardAtMs < thresholdMs) return false
        lastHeardAtMs = nowMs
        return true
    }

    fun silentForMs(nowMs: Long): Long = nowMs - lastHeardAtMs
}
