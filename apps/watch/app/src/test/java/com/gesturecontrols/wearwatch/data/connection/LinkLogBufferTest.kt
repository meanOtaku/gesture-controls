package com.gesturecontrols.wearwatch.data.connection

import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class LinkLogBufferTest {
    @Test
    fun keepsTheNewestEntriesAndReturnsThemNewestFirst() {
        var now = 1_000L
        val buffer = LinkLogBuffer(maxEntries = 3) { now++ }
        for (index in 1..5) buffer.add("event $index")
        assertEquals(3, buffer.size())
        assertEquals(listOf("event 5", "event 4", "event 3"), buffer.recent(10).map { it.text })
        assertEquals(listOf("event 5", "event 4"), buffer.recent(2).map { it.text })
    }

    @Test
    fun formatsAnEntryAsAClockTimeAndItsText() {
        val entry = LinkLogBuffer.Entry(atMillis = 1_800_000_000_000L, text = "central connected")
        val line = LinkLogBuffer.format(entry, ZoneId.of("UTC"))
        assertEquals("08:00:00 central connected", line)
    }

    @Test
    fun anEmptyBufferHasNothingToShow() {
        assertEquals(emptyList<LinkLogBuffer.Entry>(), LinkLogBuffer(5).recent(5))
    }
}
