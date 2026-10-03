package com.gesturecontrols.wearwatch.data.connection

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchProtocolOrientationTest {
    private val quaternion = floatArrayOf(0.1234567f, -0.7071068f, 0.0f, 0.6954321f)
    private val accelerometer = floatArrayOf(0.01f, 9.80665f, -0.3f)
    private val gyroscope = floatArrayOf(-0.002f, 0.5f, 1.0e-5f)

    private fun message(deviceId: String) =
        WatchProtocol.orientationMessage(deviceId, 1L, 123456789012345L, quaternion, accelerometer, gyroscope)

    @Test
    fun floatsRoundTripExactlyThroughTheWireText() {
        val payload = JSONObject(message("w")).getJSONObject("payload")
        val read = payload.getJSONArray("quaternion")
        for (i in quaternion.indices) assertEquals(quaternion[i], read.getDouble(i).toFloat(), 0.0f)
        val gyro = payload.getJSONArray("gyroscope")
        for (i in gyroscope.indices) assertEquals(gyroscope[i], gyro.getDouble(i).toFloat(), 0.0f)
    }

    @Test
    fun componentsAreNotWidenedToSeventeenDigits() {
        val text = message("w")
        assertTrue(text, !text.contains("0.12345670"))
        assertTrue(text, text.contains("0.1234567"))
        assertTrue("envelope was ${text.length} bytes: $text", text.length < 230)
    }

    @Test
    fun theBleIdIsOneByteAndStillANonEmptyString() {
        assertEquals("w", WatchProtocol.BLE_WIRE_DEVICE_ID)
        assertEquals("w", JSONObject(message(WatchProtocol.BLE_WIRE_DEVICE_ID)).getString("deviceId"))
    }
}
