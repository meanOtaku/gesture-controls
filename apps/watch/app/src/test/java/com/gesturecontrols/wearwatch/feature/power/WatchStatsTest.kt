package com.gesturecontrols.wearwatch.feature.power

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchStatsTest {
    private val sensors = listOf(
        WatchStats.SensorInfo("acceleration", "LSM6DSO Linear Acceleration", true, 20_000, 450, 0),
        WatchStats.SensorInfo("gyroscope", "LSM6DSO Gyroscope", false, null, 0, 0),
    )

    @Test
    fun eventsArrivingTogetherAreOneDelivery() {
        val stats = WatchStats()
        // Five events 20 ms apart (a wake for each), then a burst of five within a millisecond (one wake).
        for (i in 0 until 5) stats.onSensorEvent("acceleration", i * 20_000_000L)
        for (i in 0 until 5) stats.onSensorEvent("acceleration", 1_000_000_000L + i * 200_000L)
        val report = stats.toJson(10_000, 1_234, null, sensors, 0)
        assertEquals(6L, report.getLong("sensorDeliveries"))
        assertEquals(10L, report.getJSONArray("sensors").getJSONObject(0).getLong("events"))
        assertEquals(0L, report.getJSONArray("sensors").getJSONObject(1).getLong("events"))
    }

    @Test
    fun theReportCarriesEveryCounterAndTheSensorsSetUp() {
        val stats = WatchStats()
        stats.onPpgDelivery(4)
        stats.onPpgDelivery(6)
        stats.onSend(100, accepted = true)
        stats.onSend(50, accepted = false)
        val battery = WatchStats.Battery(87, false, 250_000, -120_000, 31.5)
        val report = stats.toJson(60_000, null, battery, sensors, 3)
        assertEquals(10L, report.getLong("ppgSamples"))
        assertEquals(2L, report.getLong("ppgDeliveries"))
        assertEquals(2L, report.getLong("messages"))
        assertEquals(150L, report.getLong("bytes"))
        assertEquals(1L, report.getLong("refusedSends"))
        assertEquals(3L, report.getLong("droppedMessages"))
        assertTrue(report.isNull("cpuMs"))
        val reportedBattery = report.getJSONObject("battery")
        assertEquals(250_000L, reportedBattery.getLong("chargeUah"))
        assertEquals(31.5, reportedBattery.getDouble("temperatureC"), 1e-9)
        val accel = report.getJSONArray("sensors").getJSONObject(0)
        assertEquals(450, accel.getInt("fifoMaxEvents"))
        assertEquals(20_000, accel.getInt("requestedPeriodUs"))
        assertTrue(report.getJSONArray("sensors").getJSONObject(1).isNull("requestedPeriodUs"))
    }

    @Test
    fun aSensorDelayConstantIsReportedAsItsNominalPeriod() {
        assertEquals(20_000, WatchStats.nominalPeriodUs(1)) // SENSOR_DELAY_GAME
        assertEquals(66_667, WatchStats.nominalPeriodUs(2)) // SENSOR_DELAY_UI
        assertEquals(10_000, WatchStats.nominalPeriodUs(10_000))
    }
}
