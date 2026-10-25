package com.gesturecontrols.wearwatch.data.connection

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class WatchProtocolHeartbeatTest {
    @Test
    fun aHeartbeatWithoutStatsIsAsBefore() {
        val payload = JSONObject(WatchProtocol.heartbeatMessage("watch", 1, 2, 80)).getJSONObject("payload")
        assertEquals(80, payload.getInt("batteryPercent"))
        assertFalse(payload.has("stats"))
    }

    @Test
    fun theStatsRideInTheHeartbeatsPayload() {
        val stats = JSONObject().put("elapsedMs", 5_000).put("messages", 42)
        val payload = JSONObject(WatchProtocol.heartbeatMessage("watch", 1, 2, null, stats)).getJSONObject("payload")
        assertEquals(42, payload.getJSONObject("stats").getInt("messages"))
        assert(payload.isNull("batteryPercent"))
    }
}
