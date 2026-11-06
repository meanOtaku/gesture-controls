package com.gesturecontrols.wearwatch.data.connection

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test

class WebSocketTransportTest {
    private class QueuedDispatcher : CoroutineDispatcher() {
        private val pending = ArrayDeque<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) { pending.addLast(block) }
        fun drain() { while (pending.isNotEmpty()) pending.removeFirst().run() }
    }

    private class Socket(private val request: Request, val listener: WebSocketListener) : WebSocket {
        val sent = mutableListOf<String>()
        override fun request() = request
        override fun queueSize() = 0L
        override fun send(text: String): Boolean { sent.add(text); return true }
        override fun send(bytes: ByteString) = true
        override fun close(code: Int, reason: String?) = true
        override fun cancel() = Unit
        fun opened() = listener.onOpen(this, Response.Builder().request(request)
            .protocol(Protocol.HTTP_1_1).code(101).message("Switching Protocols").build())
        fun message(text: String) = listener.onMessage(this, text)
        fun closed() = listener.onClosed(this, 1000, "closed")
        fun failed() = listener.onFailure(this, java.net.ConnectException(), null)
    }

    private class Fixture {
        val dispatcher = QueuedDispatcher()
        val sockets = mutableListOf<Socket>()
        val states = mutableListOf<Pair<ConnectionState, String?>>()
        val messages = mutableListOf<String>()
        val transport = WebSocketTransport("ws://localhost/ws/watch", object : WebSocket.Factory {
            override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
                Socket(request, listener).also { sockets.add(it) }
        }, CoroutineScope(SupervisorJob() + dispatcher)).apply {
            onState = { state, detail -> states.add(state to detail) }
            onMessage = { messages.add(it) }
        }
        fun close() { transport.shutdown(); dispatcher.drain() }
    }

    @Test fun oldCallbacksCannotClearOrPublishIntoTheReplacement() {
        val f = Fixture()
        try {
            f.transport.start()
            val old = f.sockets.single()
            // Queue before replacement as well as after, testing the dispatch boundary.
            old.opened(); old.message("queued old")
            f.transport.pause(); f.transport.resume()
            val current = f.sockets.last()
            current.opened(); f.dispatcher.drain()
            val states = f.states.toList()
            old.opened(); old.message("late old"); old.closed(); old.failed()
            current.message("current"); f.dispatcher.drain()
            assertEquals(states, f.states)
            assertEquals(listOf("current"), f.messages)
            assertTrue(f.transport.send("sample"))
            assertEquals(listOf("sample"), current.sent)
            assertEquals(2, f.sockets.size)
        } finally { f.close() }
    }

    @Test fun stopDuringConnectRejectsQueuedOpenAndMessage() {
        val f = Fixture()
        try {
            f.transport.start()
            val socket = f.sockets.single()
            socket.opened(); socket.message("late")
            f.transport.stop(); socket.closed(); socket.failed(); f.dispatcher.drain()
            assertEquals(ConnectionState.DISCONNECTED, f.states.last().first)
            assertFalse(f.states.any { it.first == ConnectionState.CONNECTED })
            assertTrue(f.messages.isEmpty())
            assertFalse(f.transport.send("sample"))
            f.transport.resume()
            assertEquals(1, f.sockets.size)
        } finally { f.close() }
    }

    @Test fun replacementFailureIsNotSwallowedByTheOldExpectedClose() {
        val f = Fixture()
        try {
            f.transport.start()
            val old = f.sockets.single()
            f.transport.start()
            val current = f.sockets.last()
            current.failed(); f.dispatcher.drain()
            assertEquals(ConnectionState.RECONNECTING, f.states.last().first)
            assertTrue(f.states.last().second!!.startsWith("Connection refused"))
            val states = f.states.toList()
            old.closed(); old.failed(); current.closed(); current.opened()
            f.dispatcher.drain()
            assertEquals(states, f.states)
            assertFalse(f.transport.send("sample"))
        } finally { f.close() }
    }
}
