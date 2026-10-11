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
        val motion = payload(text).getJSONObject("imu")
        assertEquals(2, motion.getInt("count"))
        assertEquals(20L, motion.getJSONArray("timestampsNs").getLong(1))
        assertEquals(4, motion.getJSONArray("quaternion").getJSONArray(0).length())
        val pulse = payload(text).getJSONObject("ppg")
        assertEquals(1, pulse.getInt("sampleCount"))
        assertEquals(15L, pulse.getJSONArray("timestampsNs").getLong(0))
        assertEquals(300, pulse.getJSONArray("ir").getInt(0))
    }

    @Test
    fun aSensorThatGaveNothingIsNullForThatSampleOnly() {
        val text = WatchProtocol.sensorBatchMessage("w", 1L, 1L, listOf(imu(10, accel = null), imu(20)), emptyList())!!
        val accel = payload(text).getJSONObject("imu").getJSONArray("accelerometer")
        assertTrue(accel.isNull(0))
        assertEquals(3, accel.getJSONArray(1).length())
        assertFalse(payload(text).has("ppg"))
    }

    @Test
    fun aNonFiniteReadingIsLeftOutAndAnEmptyBatchIsNotSent() {
        val bad = imu(10, accel = floatArrayOf(Float.NaN, 0f, 0f))
        val text = WatchProtocol.sensorBatchMessage("w", 1L, 1L, listOf(bad, imu(20)), emptyList())!!
        assertEquals(1, payload(text).getJSONObject("imu").getInt("count"))
        assertNull(WatchProtocol.sensorBatchMessage("w", 1L, 1L, listOf(bad), emptyList()))
    }

    @Test
    fun theSeparatePpgMessageIsUnchanged() {
        val p = payload(WatchProtocol.ppgBatchMessage("w", 1L, 1L, listOf(ppg(5), ppg(6))))
        assertEquals(2, p.getInt("sampleCount"))
        assertEquals(6L, p.getJSONArray("timestampsNs").getLong(1))
    }
}
