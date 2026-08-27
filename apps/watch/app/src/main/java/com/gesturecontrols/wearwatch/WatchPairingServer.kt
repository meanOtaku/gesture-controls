package com.gesturecontrols.wearwatch

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.Inet4Address
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Advertises a tiny LAN-only pairing endpoint. A desktop that discovers it
 * sends GET /pair; the watch derives the desktop's reachable IPv4 address from
 * that TCP connection and opens the normal outbound WebSocket to it.
 */
class WatchPairingServer(
    context: Context,
    private val onPairRequest: (String) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private val nsdManager = context.getSystemService(NsdManager::class.java)
    private var executor: ExecutorService? = null
    private var serverSocket: ServerSocket? = null
    private var registrationListener: NsdManager.RegistrationListener? = null

    fun start() {
        if (serverSocket != null) return
        try {
            val socket = ServerSocket(0).apply { reuseAddress = true }
            serverSocket = socket
            registerService(socket.localPort)
            Executors.newSingleThreadExecutor().also { executor = it }
                .execute { acceptConnections(socket) }
        } catch (error: Exception) {
            serverSocket = null
            onStatus("Desktop pairing unavailable: ${error.javaClass.simpleName}")
        }
    }

    fun stop() {
        serverSocket?.close()
        serverSocket = null
        registrationListener?.let { listener ->
            try {
                nsdManager.unregisterService(listener)
            } catch (_: IllegalArgumentException) {
                // The system may already have removed the advertisement.
            }
        }
        registrationListener = null
        executor?.shutdownNow()
        executor = null
    }

    private fun registerService(port: Int) {
        val service = NsdServiceInfo().apply {
            serviceName = "Gesture Watch"
            serviceType = SERVICE_TYPE
            this.port = port
            setAttribute("path", PAIRING_PATH)
            setAttribute("version", "1")
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                onStatus("Ready for desktop pairing")
            }

            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                onStatus("Desktop pairing advertisement failed ($errorCode)")
            }

            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit

            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
        }
        registrationListener = listener
        nsdManager.registerService(service, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    private fun acceptConnections(socket: ServerSocket) {
        while (!socket.isClosed) {
            try {
                socket.accept().use(::handleConnection)
            } catch (_: Exception) {
                if (!socket.isClosed) onStatus("Desktop pairing listener restarted")
            }
        }
    }

    private fun handleConnection(socket: Socket) {
        socket.soTimeout = REQUEST_TIMEOUT_MS
        val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.US_ASCII))
        val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.US_ASCII)
        val requestLine = reader.readLine().orEmpty()
        while (reader.readLine()?.isNotEmpty() == true) {
            // Consume request headers before responding.
        }
        val desktopAddress = socket.inetAddress as? Inet4Address
        if (!requestLine.startsWith("GET $PAIRING_PATH ") || desktopAddress == null) {
            writer.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            writer.flush()
            return
        }
        val endpoint = "ws://${desktopAddress.hostAddress}:$DESKTOP_PORT$WATCH_PATH"
        writer.write("HTTP/1.1 202 Accepted\r\nConnection: close\r\n\r\n")
        writer.flush()
        onPairRequest(endpoint)
    }

    companion object {
        const val SERVICE_TYPE = "_gesture-watch._tcp."
        private const val PAIRING_PATH = "/pair"
        private const val DESKTOP_PORT = 8766
        private const val WATCH_PATH = "/ws/watch"
        private const val REQUEST_TIMEOUT_MS = 2_000
    }
}
