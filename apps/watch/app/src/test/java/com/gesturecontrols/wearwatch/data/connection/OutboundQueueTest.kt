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
}
