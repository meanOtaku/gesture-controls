package com.gesturecontrols.wearwatch.feature.health

import org.junit.Assert.assertEquals
import org.junit.Test

class SdkClockTest {
    @Test
    fun sdkMillisecondsBecomeNanoseconds() {
        assertEquals(1_700_000_000_123_000_000L, sdkTimestampToNs(1_700_000_000_123L))
    }

    @Test
    fun twentyFiveHertzPulseSamplesStayFortyMillisecondsApart() {
        val first = sdkTimestampToNs(1_000L)
        val second = sdkTimestampToNs(1_040L)
        assertEquals(40_000_000L, second - first)
    }
}
