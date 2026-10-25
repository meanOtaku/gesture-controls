package com.gesturecontrols.wearwatch.data.connection

import com.gesturecontrols.wearwatch.feature.health.PpgSample
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchProtocolSensorBatchTest {
    private fun imu(ts: Long, accel: FloatArray? = floatArrayOf(0f, 0f, 9.8f), gyro: FloatArray? = floatArrayOf(0.1f, 0f, 0f)) =
        ImuSample(ts, floatArrayOf(1f, 0f, 0f, 0f), accel, gyro)

    private fun ppg(ts: Long) = PpgSample(ts, 100, 0, 200, 0, 300, 0)

    private fun payload(text: String) = JSONObject(text).getJSONObject("payload")

    @Test
    fun carriesBothSensorsOfOneFlushInOneEnvelope() {
        val text = WatchProtocol.sensorBatchMessage("w", 7L, 999L, listOf(imu(10), imu(20)), listOf(ppg(15)))!!
        val root = JSONObject(text)
        assertEquals("watch.sensor_batch", root.getString("type"))
        assertEquals(7L, root.getLong("sequence"))
        // Two samples packed: 11 header bytes and 45 per sample, as base64.
        val motion = java.util.Base64.getDecoder().decode(payload(text).getString("imuPacked"))
        assertEquals(11 + 2 * 45, motion.size)
        assertFalse(payload(text).has("imu"))
        val pulse = payload(text).getJSONObject("ppg")
        assertEquals(1, pulse.getInt("sampleCount"))
        assertEquals(15L, pulse.getJSONArray("timestampsNs").getLong(0))
        assertEquals(300, pulse.getJSONArray("ir").getInt(0))
    }

    @Test
    fun packedMotionIsExactlyWhatTheDesktopReads() {
        // The same two samples as the desktop's PACKED_IMU_EXAMPLE (crates/protocol): 20 ms apart, the second without a gyroscope.
        val base = 2026873695031040L
        val samples = listOf(
            ImuSample(base, floatArrayOf(0.83891f, -0.234956f, -0.038563f, -0.489426f), floatArrayOf(0.019153614f, 0.0047884034f, 0.02873042f), floatArrayOf(0.0012217305f, 0.009773844f, 0.004886922f)),
            ImuSample(base + 20_000_000L, floatArrayOf(1f, 0f, 0f, 0f), floatArrayOf(0.1f, 0.2f, 0.3f), null),
        )
        assertEquals(
            "AQIAAM+YTm4zBwAAAAAAA87CVj9OmHC+PPQdvQuW+r4K6Jw8CuicOw9c6zx5IqA6eSIgPHkioDsALTEBAQAAgD8AAAAAAAAAAAAAAADNzMw9zcxMPpqZmT4AAAAAAAAAAAAAAAA=",
            WatchProtocol.packImu(samples),
        )
    }

    @Test
    fun aBatchSpanningMoreThanAPackedOffsetGoesAsArrays() {
        val late = 5_000_000_000L // 5 s after the first sample: more than a u32 of nanoseconds
        val text = WatchProtocol.sensorBatchMessage("w", 1L, 1L, listOf(imu(10, accel = null), imu(10 + late)), emptyList())!!
        assertNull(WatchProtocol.packImu(listOf(imu(10), imu(10 + late))))
        val accel = payload(text).getJSONObject("imu").getJSONArray("accelerometer")
        assertTrue(accel.isNull(0))
        assertEquals(3, accel.getJSONArray(1).length())
        assertFalse(payload(text).has("ppg"))
    }

    @Test
    fun aNonFiniteReadingIsLeftOutAndAnEmptyBatchIsNotSent() {
        val bad = imu(10, accel = floatArrayOf(Float.NaN, 0f, 0f))
        val text = WatchProtocol.sensorBatchMessage("w", 1L, 1L, listOf(bad, imu(20)), emptyList())!!
        assertEquals(11 + 45, java.util.Base64.getDecoder().decode(payload(text).getString("imuPacked")).size)
        assertNull(WatchProtocol.sensorBatchMessage("w", 1L, 1L, listOf(bad), emptyList()))
    }

    @Test
    fun theSeparatePpgMessageIsUnchanged() {
        val p = payload(WatchProtocol.ppgBatchMessage("w", 1L, 1L, listOf(ppg(5), ppg(6))))
        assertEquals(2, p.getInt("sampleCount"))
        assertEquals(6L, p.getJSONArray("timestampsNs").getLong(1))
    }
}
