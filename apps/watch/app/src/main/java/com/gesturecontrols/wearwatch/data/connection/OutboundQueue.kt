package com.gesturecontrols.wearwatch.data.connection

/**
 * The Bluetooth send queue: whole messages, each a run of fragments, sent one fragment at a time.
 *
 * Live data is only useful while it is fresh. When the link carries less than the watch produces (a sudden arm movement
 * can make the radio resend), a queue that only grows makes everything later and later. So once more than
 * [maxQueuedFragments] are waiting, the oldest messages that have not started sending are dropped, whole: the message
 * being sent is never cut short (the desktop would get half an envelope), and the newest is always kept.
 */
class OutboundQueue(private val maxQueuedFragments: Int) {
    private val messages = ArrayDeque<ArrayDeque<ByteArray>>()
    /** Whether the first message has begun sending, so it must be finished, not dropped. */
    private var firstStarted = false
    private var queued = 0

    /** Fragments waiting. */
    val size: Int get() = queued

    fun isEmpty(): Boolean = messages.isEmpty()

    /** Queues one message; returns how many older, unsent messages were dropped to make room. */
    fun add(fragments: List<ByteArray>): Int {
        if (fragments.isEmpty()) return 0
        messages.addLast(ArrayDeque(fragments))
        queued += fragments.size
        var dropped = 0
        val oldestDroppable = if (firstStarted) 1 else 0
        while (queued > maxQueuedFragments && messages.size - 1 > oldestDroppable) {
            queued -= messages.removeAt(oldestDroppable).size
            dropped++
        }
        return dropped
    }

    /** The next fragment to send, or null when nothing is waiting. */
    fun poll(): ByteArray? {
        val first = messages.firstOrNull() ?: return null
        val fragment = first.removeFirst()
        queued--
        firstStarted = true
        if (first.isEmpty()) {
            messages.removeFirst()
            firstStarted = false
        }
        return fragment
    }

    fun clear() {
        messages.clear()
        queued = 0
        firstStarted = false
    }
}
