package com.gesturecontrols.wearwatch.data.connection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationInFlightTest {
    @Test
    fun `a notification answered in time is never given up`() {
        val inFlight = NotificationInFlight(stallMs = 2_000)
        inFlight.sent(1_000)
        assertTrue(inFlight.busy)
        assertFalse(inFlight.giveUpIfStalled(2_500))
        inFlight.done()
        assertFalse(inFlight.busy)
        assertFalse(inFlight.giveUpIfStalled(10_000))
    }

    @Test
    fun `a notification never answered is given up once, so the stream goes on`() {
        val inFlight = NotificationInFlight(stallMs = 2_000)
        inFlight.sent(1_000)
        assertTrue(inFlight.giveUpIfStalled(3_000))
        assertFalse(inFlight.busy)
        assertFalse(inFlight.giveUpIfStalled(9_000))
    }
}
