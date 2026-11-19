package com.gesturecontrols.wearwatch.data.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundQueueTest {
    private fun message(tag: Int, fragments: Int) = List(fragments) { byteArrayOf(tag.toByte(), it.toByte()) }

    private fun drain(queue: OutboundQueue): List<Pair<Int, Int>> =
        generateSequence { queue.poll() }.map { it[0].toInt() to it[1].toInt() }.toList()

    @Test
    fun sendsMessagesInOrderFragmentByFragment() {
        val queue = OutboundQueue(10)
        queue.add(message(1, 2))
        queue.add(message(2, 1))
        assertEquals(listOf(1 to 0, 1 to 1, 2 to 0), drain(queue))
        assertTrue(queue.isEmpty())
        assertNull(queue.poll())
    }

    @Test
    fun dropsTheOldestWholeMessagesToStayFreshAndKeepsTheNewest() {
        val queue = OutboundQueue(4)
        repeat(5) { queue.add(message(it, 2)) }
        // Only the newest two whole messages fit; nothing is cut in half.
        assertEquals(4, queue.size)
        assertEquals(listOf(3 to 0, 3 to 1, 4 to 0, 4 to 1), drain(queue))
    }

    @Test
    fun neverDropsAMessageThatHasStartedSending() {
        val queue = OutboundQueue(3)
        queue.add(message(1, 3))
        assertEquals(1 to 0, queue.poll()!!.let { it[0].toInt() to it[1].toInt() })
        // The rest of message 1 must still go, even though the queue is over its limit now.
        assertEquals(1, queue.add(message(2, 2)) + queue.add(message(3, 2)))
        assertEquals(listOf(1 to 1, 1 to 2, 3 to 0, 3 to 1), drain(queue))
    }

    @Test
    fun keepsAMessageBiggerThanTheLimitWhenItIsTheOnlyOne() {
        val queue = OutboundQueue(2)
        assertEquals(0, queue.add(message(1, 5)))
        assertEquals(5, queue.size)
    }

    @Test
    fun `a message cut off in flight is dropped and the next one goes whole`() {
        val queue = OutboundQueue(maxQueuedFragments = 12)
        val first = listOf(byteArrayOf(1), byteArrayOf(2), byteArrayOf(3))
        val second = listOf(byteArrayOf(4), byteArrayOf(5))
        queue.add(first)
        queue.add(second)
        queue.poll()
        org.junit.Assert.assertEquals(2, queue.dropStarted())
        org.junit.Assert.assertArrayEquals(byteArrayOf(4), queue.poll())
        org.junit.Assert.assertEquals(0, OutboundQueue(4).dropStarted())
    }

    @Test
    fun `a control message keeps its place in line and is never dropped`() {
        val queue = OutboundQueue(4)
        queue.add(message(1, 2))
        assertEquals(1 to 0, queue.poll()!!.let { it[0].toInt() to it[1].toInt() })
        queue.add(message(2, 2))
        queue.add(message(9, 1), control = true)
        queue.add(message(8, 1), control = true)
        // A flood of telemetry: the old batches give way, the control messages and the one being sent stay.
        repeat(5) { queue.add(message(3 + it, 2)) }
        assertEquals(listOf(1 to 1, 9 to 0, 8 to 0, 7 to 0, 7 to 1), drain(queue))
    }

    @Test
    fun `messages leave in the order they were made, so their sequence numbers only rise`() {
        // The desktop refuses a message numbered below one it has; a control message must not overtake older telemetry.
        val queue = OutboundQueue(10)
        queue.add(message(1, 1))
        queue.add(message(2, 1))
        queue.add(message(3, 1), control = true)
        queue.add(message(4, 1))
        val sent = drain(queue).map { it.first }
        assertEquals(listOf(1, 2, 3, 4), sent)
    }

    @Test
    fun `control messages alone over the limit are all kept`() {
        val queue = OutboundQueue(1)
        repeat(3) { assertEquals(0, queue.add(message(it, 1), control = true)) }
        assertEquals(listOf(0 to 0, 1 to 0, 2 to 0), drain(queue))
    }
}
