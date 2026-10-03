package com.gesturecontrols.wearwatch.feature.wear

import com.gesturecontrols.wearwatch.data.connection.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingPolicyTest {
    private fun plan(state: ConnectionState, worn: Boolean?, override: Boolean = false) =
        StreamingPolicy.plan(state, worn, override)

    @Test
    fun aWornWatchWithAConnectedDesktopStreams() {
        assertEquals(StreamingPlan.STREAM, plan(ConnectionState.CONNECTED, true))
    }

    @Test
    fun anUnwornWatchWithAConnectedDesktopPausesItsSensors() {
        assertEquals(StreamingPlan.PAUSED_OFF_BODY, plan(ConnectionState.CONNECTED, false))
    }

    @Test
    fun theOffWristOverrideKeepsStreamingWhateverTheSensorSays() {
        for (worn in listOf(true, false, null)) {
            assertEquals(StreamingPlan.STREAM, plan(ConnectionState.CONNECTED, worn, override = true))
        }
    }

    @Test
    fun beforeTheOffBodySensorHasReportedNothingChanges() {
        assertEquals(StreamingPlan.PENDING, plan(ConnectionState.CONNECTED, null))
    }

    @Test
    fun withoutAConnectedDesktopNothingStreamsRegardlessOfWearOrOverride() {
        for (worn in listOf(true, false, null)) {
            for (override in listOf(true, false)) {
                for (state in listOf(ConnectionState.CONNECTING, ConnectionState.RECONNECTING, ConnectionState.AWAITING_TRUST)) {
                    assertEquals("$state worn=$worn override=$override", StreamingPlan.WAITING, plan(state, worn, override))
                }
                for (state in listOf(ConnectionState.DISCONNECTED, ConnectionState.FAILED)) {
                    assertEquals("$state worn=$worn override=$override", StreamingPlan.STOPPED, plan(state, worn, override))
                }
            }
        }
    }

    @Test
    fun everyConnectionStateIsCovered() {
        for (state in ConnectionState.values()) {
            // Throws if a state were ever added without a decision for it.
            plan(state, true)
        }
    }
}
