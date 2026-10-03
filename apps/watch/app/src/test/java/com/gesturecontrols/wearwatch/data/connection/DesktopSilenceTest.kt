package com.gesturecontrols.wearwatch.data.connection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopSilenceTest {
    private val threshold = 25_000L

    @Test
    fun aDesktopThatKeepsWritingIsNeverDropped() {
        val silence = DesktopSilence(threshold)
        silence.heard(0)
        for (second in 1..120) {
            silence.heard(second * 5_000L - 1)
            assertFalse(silence.shouldDrop(second * 5_000L, connected = true, trafficExpected = true))
        }
    }

    @Test
    fun aDesktopSilentPastTheThresholdWhileStreamingIsDropped() {
        val silence = DesktopSilence(threshold)
        silence.heard(0)
        assertFalse(silence.shouldDrop(24_999, connected = true, trafficExpected = true))
        assertTrue(silence.shouldDrop(25_000, connected = true, trafficExpected = true))
    }

    @Test
    fun silenceOffTheWristIsNotSilence() {
        // The desktop stops writing, and the watch sleeps, on purpose.
        val silence = DesktopSilence(threshold)
        silence.heard(0)
        assertFalse(silence.shouldDrop(600_000, connected = true, trafficExpected = false))
    }

    @Test
    fun theFullThresholdAppliesFromTheMomentTrafficIsExpectedAgain() {
        val silence = DesktopSilence(threshold)
        silence.heard(0)
        assertFalse(silence.shouldDrop(600_000, connected = true, trafficExpected = false))
        // Back on the wrist: not dropped at once for silence that was legitimate.
        assertFalse(silence.shouldDrop(601_000, connected = true, trafficExpected = true))
        assertFalse(silence.shouldDrop(620_000, connected = true, trafficExpected = true))
        assertTrue(silence.shouldDrop(626_000, connected = true, trafficExpected = true))
    }

    @Test
    fun nothingIsDroppedWithoutAConnection() {
        val silence = DesktopSilence(threshold)
        assertFalse(silence.shouldDrop(1_000_000, connected = false, trafficExpected = true))
    }

    @Test
    fun afterADropTheNextOneWaitsAnotherFullThreshold() {
        val silence = DesktopSilence(threshold)
        silence.heard(0)
        assertTrue(silence.shouldDrop(25_000, connected = true, trafficExpected = true))
        assertFalse(silence.shouldDrop(30_000, connected = true, trafficExpected = true))
        assertTrue(silence.shouldDrop(50_000, connected = true, trafficExpected = true))
    }
}
