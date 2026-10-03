package com.gesturecontrols.wearwatch.data.connection

import android.util.Log
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The newest [maxEntries] events, oldest dropped first. Plain and Android-free so it can be unit-tested. */
class LinkLogBuffer(private val maxEntries: Int, private val clock: () -> Long = System::currentTimeMillis) {
    data class Entry(val atMillis: Long, val text: String)

    private val entries = ArrayDeque<Entry>()

    @Synchronized
    fun add(text: String) {
        if (entries.size == maxEntries) entries.removeFirst()
        entries.addLast(Entry(clock(), text))
    }

    /** Newest first. */
    @Synchronized
    fun recent(count: Int): List<Entry> = entries.takeLast(count).asReversed()

    @Synchronized
    fun size(): Int = entries.size

    companion object {
        private val CLOCK_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")

        fun format(entry: Entry, zone: ZoneId = ZoneId.systemDefault()): String =
            CLOCK_FORMAT.format(Instant.ofEpochMilli(entry.atMillis).atZone(zone)) + " " + entry.text
    }
}

/**
 * What the watch's link has been doing, in words: connects, disconnects and the status code
 * that ended them, MTU, advertising, trust, retries, and dropped data. Written by the
 * transports, shown in the app's Details panel, and mirrored to logcat under `LinkLog`.
 * Counters are cumulative since the app started.
 */
object LinkLog {
    private const val TAG = "LinkLog"
    private val buffer = LinkLogBuffer(maxEntries = 60)
    private val _revision = MutableStateFlow(0)

    /** Changes whenever an entry is added or a counter moves; the UI redraws from it. */
    val revision: StateFlow<Int> = _revision.asStateFlow()

    private val sent = AtomicLong()
    private val sendFailures = AtomicLong()

    fun add(text: String) {
        buffer.add(text)
        runCatching { Log.i(TAG, text) }
        _revision.value += 1
    }

    /**
     * Counts one outgoing message. Failures are logged on the first one and then on every
     * hundredth, so a stalled link leaves a trail without flooding the log.
     */
    fun noteSend(ok: Boolean) {
        sent.incrementAndGet()
        if (!ok) {
            val failures = sendFailures.incrementAndGet()
            if (failures == 1L || failures % 100 == 0L) add("send failed ($failures so far): the link refused the message")
        }
    }

    fun counters(): String = "sent ${sent.get()} · failed ${sendFailures.get()}"

    /** The newest [count] events, newest first, one `HH:mm:ss text` line each. */
    fun lines(count: Int): List<String> = buffer.recent(count).map { LinkLogBuffer.format(it) }
}
