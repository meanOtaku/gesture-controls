package com.gesturecontrols.wearwatch.data.connection

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The watch half of the BLE framing contract. The desktop half lives in
 * `crates/watch-bridge/src/ble.rs`'s tests; both must agree byte-for-byte or a
 * PPG batch arrives truncated.
 */
class BleFramingTest {

    private fun roundTrip(message: ByteArray, attPayload: Int): ByteArray? {
        val reassembler = BleFraming.Reassembler()
        var out: ByteArray? = null
        val fragments = BleFraming.fragment(message, attPayload)!!
        for (frame in fragments) {
            assertTrue("fragment must fit one ATT payload", frame.size <= attPayload)
            val complete = reassembler.push(frame)
            if (complete != null) {
                assertNull("only the final fragment completes a message", out)
                out = complete
            }
        }
        return out
    }

    @Test
    fun singleFragmentMessageRoundTrips() {
        val message = """{"type":"watch.heartbeat"}""".toByteArray()
        assertArrayEquals(message, roundTrip(message, 200))
    }

    @Test
    fun multiFragmentMessageRoundTripsAtTheMinimumMtu() {
        // 20 bytes is the usable payload at the default 23-byte MTU, so a real
        // telemetry batch always spans many fragments.
        val message = ByteArray(1000) { (it % 251).toByte() }
        assertArrayEquals(message, roundTrip(message, BleFraming.MIN_ATT_PAYLOAD))
    }

    @Test
    fun emptyMessageRoundTrips() {
        assertArrayEquals(ByteArray(0), roundTrip(ByteArray(0), 20))
    }

    @Test
    fun oversizedMessageIsRefusedRatherThanFragmented() {
        assertNull(BleFraming.fragment(ByteArray(BleFraming.MAX_MESSAGE_BYTES + 1), 200))
    }

    @Test
    fun droppedMiddleFragmentNeverYieldsAPartialMessage() {
        val message = ByteArray(200) { it.toByte() }
        val fragments = BleFraming.fragment(message, 20)!!
        assertTrue(fragments.size > 3)
        val reassembler = BleFraming.Reassembler()
        assertNull(reassembler.push(fragments[0]))
        // fragments[1] is lost.
        assertNull(reassembler.push(fragments[2]))
        for (index in 3 until fragments.size) {
            assertNull(
                "a gap must never complete a truncated envelope",
                reassembler.push(fragments[index]),
            )
        }
    }

    @Test
    fun reassemblerRecoversOnTheNextMessageAfterADesync() {
        val reassembler = BleFraming.Reassembler()
        assertNull(reassembler.push(BleFraming.fragment(ByteArray(100), 20)!![0]))
        val fresh = """{"type":"watch.button"}""".toByteArray()
        val fragments = BleFraming.fragment(fresh, 200)!!
        assertArrayEquals(fresh, reassembler.push(fragments[0]))
    }

    @Test
    fun runtFragmentShorterThanTheHeaderIsRefused() {
        assertNull(BleFraming.Reassembler().push(byteArrayOf(0x01, 0x00)))
    }

    @Test
    fun attPayloadFollowsTheNegotiatedMtuButNeverDropsBelowTheDefault() {
        assertEquals(BleFraming.MIN_ATT_PAYLOAD, BleFraming.attPayloadFor(23))
        assertEquals(BleFraming.MIN_ATT_PAYLOAD, BleFraming.attPayloadFor(5))
        assertEquals(514, BleFraming.attPayloadFor(517))
    }
}
