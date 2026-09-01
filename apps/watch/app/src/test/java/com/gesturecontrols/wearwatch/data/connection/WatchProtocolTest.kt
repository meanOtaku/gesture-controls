package com.gesturecontrols.wearwatch.data.connection

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WatchProtocolTest {
    @Test
    fun `pinch message encodes typed transition and monotonic timestamp`() {
        val message = WatchProtocol.pinchMessage(
            deviceId = "watch-test",
            sequence = 7,
            timestampNs = 123456,
            phase = WatchProtocol.PinchPhase.HELD,
            confidence = 0.75,
            modelId = "pinch-v1",
        )

        val root = JSONObject(message)
        assertEquals(WatchProtocol.TYPE_PINCH, root.getString("type"))
        assertEquals(123456L, root.getLong("timestampNs"))
        assertEquals("held", root.getJSONObject("payload").getString("phase"))
        assertEquals(0.75, root.getJSONObject("payload").getDouble("confidence"), 0.0)
        assertEquals("pinch-v1", root.getJSONObject("payload").getString("modelId"))
    }

    @Test
    fun `pinch message rejects malformed metadata`() {
        for (confidence in listOf(Double.NaN, Double.POSITIVE_INFINITY, -0.01, 1.01)) {
            assertThrows(IllegalArgumentException::class.java) {
                WatchProtocol.pinchMessage("watch-test", 1, 1, WatchProtocol.PinchPhase.STARTED, confidence, "model")
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            WatchProtocol.pinchMessage("watch-test", 1, 1, WatchProtocol.PinchPhase.RELEASED, 1.0, "   ")
        }
    }
}