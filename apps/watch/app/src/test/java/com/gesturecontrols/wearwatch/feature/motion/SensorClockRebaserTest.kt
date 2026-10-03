package com.gesturecontrols.wearwatch.feature.motion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D-4: orientation's envelope timestamp must be on the same clock as every
 * other watch message (`SystemClock.elapsedRealtimeNanos()`), on any device.
 */
class SensorClockRebaserTest {

    private val ms = 1_000_000L

    @Test
    fun aSensorClockOnTheElapsedRealtimeBaseIsPassedThroughUntouched() {
        val rebaser = SensorClockRebaser()
        val now = 10_000 * ms
        // Delivered 3 ms after it happened.
        assertEquals(now - 3 * ms, rebaser.toElapsedRealtime(now - 3 * ms, now))
        assertFalse(rebaser.isRebasing)
    }

    @Test
    fun aSensorClockOnAnotherBaseIsRebasedOntoElapsedRealtime() {
        val rebaser = SensorClockRebaser()
        // Sensor clock is a wall-clock-like epoch value; elapsedRealtime is boot-relative.
        val epochOffset = 1_700_000_000_000L * ms
        val boot = 50_000 * ms
        var rebased = 0L
        for (tick in 0 until 5) {
            val nowElapsed = boot + tick * 20 * ms
            // Each event happened 2 ms before it is delivered, on the other clock.
            val sensorTs = epochOffset + nowElapsed - 2 * ms
            rebased = rebaser.toElapsedRealtime(sensorTs, nowElapsed)
        }
        assertTrue(rebaser.isRebasing)
        // Lands on the elapsedRealtime base, and never in the future.
        assertEquals(boot + 4 * 20 * ms, rebased)
    }

    @Test
    fun aRebasedStreamKeepsTheSensorsOwnSpacingBetweenEvents() {
        val rebaser = SensorClockRebaser()
        val epochOffset = 9_000_000_000_000_000L
        val boot = 1_000_000 * ms
        val first = rebaser.toElapsedRealtime(epochOffset + 100 * ms, boot + 105 * ms)
        // 20 ms later on the sensor clock, delivered with the same lag.
        val second = rebaser.toElapsedRealtime(epochOffset + 120 * ms, boot + 125 * ms)
        assertEquals(20 * ms, second - first)
    }

    @Test
    fun aRebasedStreamIsStrictlyIncreasingEvenWhenTheLagEstimateShrinks() {
        val rebaser = SensorClockRebaser()
        val epochOffset = 9_000_000_000_000_000L
        val boot = 1_000_000 * ms
        // First event looks 30 ms late; the next, 1 sample period later, only 1 ms late,
        // so the offset estimate shrinks by far more than the sample period.
        val a = rebaser.toElapsedRealtime(epochOffset, boot + 30 * ms)
        val b = rebaser.toElapsedRealtime(epochOffset + 2 * ms, boot + 3 * ms)
        assertTrue("$b must follow $a", b > a)
    }

    @Test
    fun aSensorTimestampFromTheFutureIsTreatedAsAnotherBase() {
        val rebaser = SensorClockRebaser()
        val now = 10_000 * ms
        val rebased = rebaser.toElapsedRealtime(now + 5_000 * ms, now)
        assertTrue(rebaser.isRebasing)
        assertTrue("never in the future", rebased <= now)
    }

    @Test
    fun resetForgetsTheOffsetAndTheMonotonicFloor() {
        val rebaser = SensorClockRebaser()
        rebaser.toElapsedRealtime(9_000_000_000_000_000L, 1_000 * ms)
        assertTrue(rebaser.isRebasing)
        rebaser.reset()
        assertFalse(rebaser.isRebasing)
        val now = 2_000 * ms
        assertEquals(now - ms, rebaser.toElapsedRealtime(now - ms, now))
    }
}
