package com.gesturecontrols.wearwatch.data.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchTagTest {
    @Test
    fun theTagIsFourBytesAndStableForOneId() {
        val id = "watch-123e4567-e89b-12d3-a456-426614174000"
        assertEquals(WatchTag.LENGTH_BYTES, WatchTag.bytesFor(id).size)
        assertEquals(WatchTag.labelFor(id), WatchTag.labelFor(id))
    }

    @Test
    fun differentWatchesGetDifferentTags() {
        assertNotEquals(WatchTag.labelFor("watch-a"), WatchTag.labelFor("watch-b"))
    }

    @Test
    fun theLabelIsEightLowercaseHexCharactersMatchingWhatTheDesktopPrints() {
        val label = WatchTag.labelFor("watch-123e4567-e89b-12d3-a456-426614174000")
        assertEquals(8, label.length)
        assertTrue(label.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun theTagDoesNotContainTheDeviceId() {
        val id = "watch-123e4567-e89b-12d3-a456-426614174000"
        assertTrue(!WatchTag.labelFor(id).contains("123e4567"))
    }
}
