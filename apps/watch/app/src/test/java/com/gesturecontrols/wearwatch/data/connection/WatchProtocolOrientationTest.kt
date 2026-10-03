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
        WatchProtocol.orientationMessage(deviceId, 1L, 123456789012345L, quaternion, accelerometer, gyroscope)!!

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

    private fun sameJson(a: JSONObject, b: JSONObject) {
        assertEquals(a.getString("type"), b.getString("type"))
        assertEquals(a.getInt("version"), b.getInt("version"))
        assertEquals(a.getString("deviceId"), b.getString("deviceId"))
        assertEquals(a.getLong("sequence"), b.getLong("sequence"))
        assertEquals(a.getLong("timestampNs"), b.getLong("timestampNs"))
        val pa = a.getJSONObject("payload")
        val pb = b.getJSONObject("payload")
        for (key in listOf("quaternion", "accelerometer", "gyroscope")) {
            assertEquals(key, pa.isNull(key), pb.isNull(key))
            if (pa.isNull(key)) continue
            val va = pa.getJSONArray(key)
            val vb = pb.getJSONArray(key)
            assertEquals(va.length(), vb.length())
            for (i in 0 until va.length()) assertEquals("$key[$i]", va.getDouble(i), vb.getDouble(i), 0.0)
        }
    }

    @Test
    fun theFastEncoderMatchesTheJsonObjectReferenceOnRandomReadings() {
        val random = java.util.Random(42)
        fun vec(n: Int) = FloatArray(n) {
            when (random.nextInt(6)) {
                0 -> 0.0f
                1 -> -0.0f
                2 -> random.nextFloat() * 1.0e-6f
                3 -> (random.nextFloat() - 0.5f) * 40f
                4 -> Float.MIN_VALUE * random.nextInt(1000)
                else -> random.nextFloat() * 2f - 1f
            }
        }
        repeat(2000) { index ->
            val q = vec(4)
            val a = if (random.nextInt(4) == 0) null else vec(3)
            val g = if (random.nextInt(4) == 0) null else vec(3)
            val id = if (index % 2 == 0) "w" else "watch-123e4567-e89b-12d3-a456-426614174000"
            val seq = random.nextLong() and 0x7fffffffffffL
            val ts = random.nextLong() and 0x7fffffffffffffL
            val fast = WatchProtocol.orientationMessage(id, seq, ts, q, a, g)!!
            val reference = WatchProtocol.orientationMessageViaJsonObject(id, seq, ts, q, a, g)
            sameJson(JSONObject(reference), JSONObject(fast))
        }
    }

    @Test
    fun aReadingWithANonFiniteComponentIsNotSent() {
        for (bad in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertEquals(null, WatchProtocol.orientationMessage("w", 1, 2, floatArrayOf(bad, 0f, 0f, 1f), null, null))
            assertEquals(null, WatchProtocol.orientationMessage("w", 1, 2, quaternion, floatArrayOf(0f, bad, 0f), null))
            assertEquals(null, WatchProtocol.orientationMessage("w", 1, 2, quaternion, null, floatArrayOf(0f, 0f, bad)))
        }
    }

    @Test
    fun theDeviceIdIsEscapedLikeAnyOtherJsonString() {
        val id = "a\"b\\c\u0001d"
        assertEquals(id, JSONObject(WatchProtocol.orientationMessage(id, 1, 2, quaternion, null, null)!!).getString("deviceId"))
    }

    @Test
    fun printEncoderTiming() {
        val q = floatArrayOf(0.1234567f, -0.7071068f, 0.0f, 0.6954321f)
        val a = floatArrayOf(0.01f, 9.80665f, -0.3f)
        val g = floatArrayOf(-0.002f, 0.5f, 1.0e-5f)
        fun time(block: () -> Unit): Double {
            repeat(20000) { block() }
            val start = System.nanoTime()
            repeat(200000) { block() }
            return (System.nanoTime() - start) / 200000.0 / 1000.0
        }
        val reference = time { WatchProtocol.orientationMessageViaJsonObject("w", 1, 2, q, a, g) }
        val fast = time { WatchProtocol.orientationMessage("w", 1, 2, q, a, g) }
        println("orientation encode (JVM, org.json from Maven): reference %.2f us, fast %.2f us".format(reference, fast))
    }

    @Test
    fun theWearStateMessageCarriesAPlainBoolean() {
        for (worn in listOf(true, false)) {
            val root = JSONObject(WatchProtocol.wearStateMessage("w", 7, 99, worn))
            assertEquals("watch.wear_state", root.getString("type"))
            assertEquals(7L, root.getLong("sequence"))
            assertEquals(worn, root.getJSONObject("payload").getBoolean("worn"))
        }
    }
}
