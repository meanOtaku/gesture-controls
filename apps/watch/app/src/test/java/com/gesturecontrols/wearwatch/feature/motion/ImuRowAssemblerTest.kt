package com.gesturecontrols.wearwatch.feature.motion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ImuRowAssemblerTest {
    private val identity = floatArrayOf(1f, 0f, 0f, 0f)
    private val ms = 1_000_000L

    private fun accelDriven() = ImuRowAssembler().apply {
        driver = ImuRowAssembler.Driver.ACCELEROMETER
        onRotation(identity, 0L)
    }

    @Test
    fun everyAccelerometerSampleMakesARowWithItsOwnValueAndTime() {
        val rows = accelDriven()
        val values = listOf(0.1f, 3.0f, -2.5f, 0.2f)
        val sent = values.mapIndexed { i, x -> rows.onAccelerometer(floatArrayOf(x, 0f, 0f), i * 10 * ms) }
        assertEquals(values, sent.map { it!!.accelerometer!![0] })
        assertEquals(listOf(0L, 10 * ms, 20 * ms, 30 * ms), sent.map { it!!.sensorTimestampNs })
    }

    @Test
    fun aSuddenSpikeIsSentAsMeasuredNotSmoothedAway() {
        val rows = accelDriven()
        rows.onAccelerometer(floatArrayOf(0f, 0f, 0f), 0L)
        val spike = rows.onAccelerometer(floatArrayOf(9f, -4f, 2f), 10 * ms)
        assertArrayEquals(floatArrayOf(9f, -4f, 2f), spike!!.accelerometer, 0f)
    }

    @Test
    fun theOtherSensorsRideAlongOnlyWhileFresh() {
        val rows = accelDriven()
        rows.onGyroscope(floatArrayOf(1f, 2f, 3f), 5 * ms)
        val withGyro = rows.onAccelerometer(floatArrayOf(0f, 0f, 1f), 10 * ms)
        assertArrayEquals(floatArrayOf(1f, 2f, 3f), withGyro!!.gyroscope, 0f)
        rows.onRotation(identity, 150 * ms)
        val stale = rows.onAccelerometer(floatArrayOf(0f, 0f, 1f), 200 * ms)
        assertNull("a gyroscope reading 195 ms old is left out", stale!!.gyroscope)
    }

    @Test
    fun noRowIsMadeWithoutARecentOrientation() {
        val rows = ImuRowAssembler().apply { driver = ImuRowAssembler.Driver.ACCELEROMETER }
        assertNull(rows.onAccelerometer(floatArrayOf(0f, 0f, 1f), 0L))
        rows.onRotation(identity, 0L)
        assertNotNull(rows.onAccelerometer(floatArrayOf(0f, 0f, 1f), 50 * ms))
        assertNull(rows.onAccelerometer(floatArrayOf(0f, 0f, 1f), 500 * ms))
    }

    @Test
    fun onlyTheDriverMakesRows() {
        val rows = accelDriven()
        assertNull(rows.onGyroscope(floatArrayOf(1f, 1f, 1f), 1 * ms))
        assertNull(rows.onRotation(identity, 2 * ms))
        rows.driver = ImuRowAssembler.Driver.ROTATION_VECTOR
        assertNull(rows.onAccelerometer(floatArrayOf(0f, 0f, 1f), 3 * ms))
        assertNotNull(rows.onRotation(identity, 4 * ms))
    }

    @Test
    fun resetForgetsEveryReading() {
        val rows = accelDriven()
        rows.onGyroscope(floatArrayOf(1f, 1f, 1f), 0L)
        rows.reset()
        assertNull(rows.onAccelerometer(floatArrayOf(0f, 0f, 1f), 1 * ms))
    }

    @Test
    fun rowsDoNotShareArraysWithTheAssembler() {
        val rows = accelDriven()
        val input = floatArrayOf(1f, 2f, 3f)
        val row = rows.onAccelerometer(input, 0L)!!
        input[0] = 99f
        assertEquals(1f, row.accelerometer!![0])
    }
}
