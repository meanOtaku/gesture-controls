package com.gesturecontrols.wearwatch.data.connection

/**
 * The one notification BLE allows outstanding per connection, and when it was sent.
 *
 * The stack says a notification is done through `onNotificationSent`. When that never comes (the desktop process died with
 * the frame in flight while macOS kept the link up, so no disconnect is reported either), waiting for it would stop the
 * stream for good: the watch shows a desktop connected and the desktop receives nothing until the app restarts. So a
 * notification unanswered for [stallMs] is given up.
 */
class NotificationInFlight(private val stallMs: Long) {
    private var sentAtMs: Long? = null

    val busy: Boolean get() = sentAtMs != null

    fun sent(nowMs: Long) {
        sentAtMs = nowMs
    }

    fun done() {
        sentAtMs = null
    }

    /** True (and no longer busy) when the outstanding notification has gone unanswered too long. */
    fun giveUpIfStalled(nowMs: Long): Boolean {
        val at = sentAtMs ?: return false
        if (nowMs - at < stallMs) return false
        sentAtMs = null
        return true
    }
}
