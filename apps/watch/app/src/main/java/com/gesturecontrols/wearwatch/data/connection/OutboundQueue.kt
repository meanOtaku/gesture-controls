package com.gesturecontrols.wearwatch.data.connection

/**
 * The Bluetooth send queue: whole messages, each a run of fragments, sent one fragment at a time.
 *
 * Live data is only useful while it is fresh. When the link carries less than the watch produces (a sudden arm movement
 * can make the radio resend), a queue that only grows makes everything later and later. So once more than
 * [maxQueuedFragments] are waiting, the oldest messages that have not started sending are dropped, whole: the message
 * being sent is never cut short (the desktop would get half an envelope), and the newest is always kept.
 *
 * A control message (the watch put on or taken off, a button press, a sensor turned on or off) is small and rare but its
 * loss is not: the desktop would keep the old state until the next change. So a message added with `control` is never
 * dropped. It still waits its turn: every message carries a sequence number from one counter, and the desktop refuses
 * one numbered below a message it already has, so a control message sent ahead of older telemetry would get that
 * telemetry refused (and the desktop's model runtime reset). Dropping older telemetry keeps its wait short.
 */
class OutboundQueue(private val maxQueuedFragments: Int) {
    private class Message(val fragments: ArrayDeque<ByteArray>, val control: Boolean)

    private val messages = ArrayDeque<Message>()
    /** Whether the first message has begun sending, so it must be finished, not dropped. */
    private var firstStarted = false
    private var queued = 0

    /** Fragments waiting. */
    val size: Int get() = queued

    fun isEmpty(): Boolean = messages.isEmpty()

    /**
     * Queues one message, last, in the order it was made; returns how many older, unsent messages were dropped to make
     * room. A `control` message is never dropped.
     */
    fun add(fragments: List<ByteArray>, control: Boolean = false): Int {
        if (fragments.isEmpty()) return 0
        messages.addLast(Message(ArrayDeque(fragments), control))
        queued += fragments.size
        var dropped = 0
        while (queued > maxQueuedFragments) {
            val victim = oldestDroppable() ?: break
            queued -= messages.removeAt(victim).fragments.size
            dropped++
        }
        return dropped
    }

    /** The oldest message that may give way: not started, not a control message, and not the newest telemetry. */
    private fun oldestDroppable(): Int? {
        val newest = messages.indexOfLast { !it.control }
        val from = if (firstStarted) 1 else 0
        return (from until messages.size).firstOrNull { it != newest && !messages[it].control }
    }

    /** The next fragment to send, or null when nothing is waiting. */
    fun poll(): ByteArray? {
        val first = messages.firstOrNull()?.fragments ?: return null
        val fragment = first.removeFirst()
        queued--
        firstStarted = true
        if (first.isEmpty()) {
            messages.removeFirst()
            firstStarted = false
        }
        return fragment
    }

    /**
     * Drops the rest of the message whose sending began (its fragment in flight was lost, so the desktop can never
     * complete it); the messages after it still go. Returns how many fragments were dropped.
     */
    fun dropStarted(): Int {
        if (!firstStarted) return 0
        val rest = messages.removeFirst().fragments.size
        queued -= rest
        firstStarted = false
        return rest
    }

    fun clear() {
        messages.clear()
        queued = 0
        firstStarted = false
    }
}
