package com.gesturecontrols.wearwatch.data.discovery

import com.gesturecontrols.wearwatch.data.connection.*
import com.gesturecontrols.wearwatch.data.preferences.*

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress

/**
 * Discovers the desktop bridge advertised through local DNS-SD/mDNS.
 *
 * Discovery is driven by Wi-Fi availability: [start] registers a
 * [ConnectivityManager.NetworkCallback] and only runs `NsdManager` discovery
 * while a Wi-Fi network is actually up, so a watch that walks out of range
 * doesn't spin retries against a dead radio, and reconnects as soon as Wi-Fi
 * comes back without the caller having to poll.
 */
class DesktopDiscovery(
    context: Context,
    private val onEndpoint: (String) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val nsdManager = appContext.getSystemService(NsdManager::class.java)
    private val wifiManager = appContext.getSystemService(WifiManager::class.java)
    private val connectivityManager = appContext.getSystemService(ConnectivityManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var resolving = false
    private var discoveredServiceName: String? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var retryScheduled = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val wifiNetworks = mutableSetOf<Network>()
    private val statusHistory = ArrayDeque<String>()

    /** Last few status transitions, oldest first; for a compact on-screen trail. */
    fun history(): List<String> = synchronized(statusHistory) { statusHistory.toList() }

    /** Begins watching Wi-Fi availability and starts discovery once a Wi-Fi network is up. */
    fun start() {
        if (networkCallback != null) return
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val wasEmpty = synchronized(wifiNetworks) { wifiNetworks.isEmpty().also { wifiNetworks.add(network) } }
                if (wasEmpty) beginDiscovery()
            }

            override fun onLost(network: Network) {
                val nowEmpty = synchronized(wifiNetworks) { wifiNetworks.remove(network); wifiNetworks.isEmpty() }
                if (nowEmpty) suspendDiscovery()
            }
        }
        networkCallback = callback
        emitStatus("Wi-Fi unavailable")
        connectivityManager.registerNetworkCallback(request, callback, mainHandler)
    }

    /** Full teardown: stops discovery and stops watching connectivity. Call from onDestroy. */
    fun stop(showWifiStatus: Boolean = true) {
        networkCallback?.let { callback ->
            try {
                connectivityManager.unregisterNetworkCallback(callback)
            } catch (_: IllegalArgumentException) {
                // Already unregistered (e.g. connectivity service torn down first).
            }
        }
        networkCallback = null
        synchronized(wifiNetworks) { wifiNetworks.clear() }
        suspendDiscovery(showWifiStatus)
    }

    /** Restarts the current scan when the user returns from a manual override. */
    fun refresh() {
        if (networkCallback == null) return
        val hasWifi = synchronized(wifiNetworks) { wifiNetworks.isNotEmpty() }
        if (!hasWifi) {
            emitStatus("Wi-Fi unavailable")
            return
        }
        mainHandler.removeCallbacksAndMessages(null)
        retryScheduled = false
        val listener = discoveryListener
        discoveryListener = null
        resolving = false
        discoveredServiceName = null
        if (listener != null) {
            try {
                nsdManager.stopServiceDiscovery(listener)
            } catch (_: IllegalArgumentException) {
                // The framework may already have stopped a failed scan.
            }
        }
        beginDiscovery()
    }

    private fun beginDiscovery() {
        if (discoveryListener != null) return
        acquireMulticastLock()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
                emitStatus("Searching for desktop…")
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                if (service.serviceType != SERVICE_TYPE || resolving || discoveredServiceName != null) return
                resolving = true
                emitStatus("Desktop service found; resolving…")
                nsdManager.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        resolving = false
                        emitStatus("Desktop resolve failed; retrying…")
                        scheduleRetry()
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        resolving = false
                        val address = selectAddress(serviceInfo)
                        val url = address?.let { buildWebSocketUrl(it, serviceInfo.port) }
                        if (address == null || serviceInfo.port !in 1..65535 || url == null) {
                            emitStatus("Desktop service had no usable address")
                            return
                        }
                        discoveredServiceName = serviceInfo.serviceName
                        emitStatus("Desktop resolved")
                        onEndpoint(url)
                    }
                })
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                if (service.serviceName == discoveredServiceName) {
                    discoveredServiceName = null
                    emitStatus("Desktop lost; searching…")
                }
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                discoveryListener = null
                emitStatus("Desktop discovery retrying…")
                scheduleRetry()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                discoveryListener = null
            }
        }
        discoveryListener = listener
        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    /** Stops the active NSD scan (if any) without forgetting connectivity watching. */
    private fun suspendDiscovery(showWifiStatus: Boolean = true) {
        mainHandler.removeCallbacksAndMessages(null)
        retryScheduled = false
        val listener = discoveryListener
        discoveryListener = null
        resolving = false
        discoveredServiceName = null
        if (listener != null) {
            try {
                nsdManager.stopServiceDiscovery(listener)
            } catch (_: IllegalArgumentException) {
                // Android may already have stopped discovery after a failure.
            }
        }
        multicastLock?.let { lock -> if (lock.isHeld) lock.release() }
        multicastLock = null
        if (showWifiStatus && networkCallback != null) {
            emitStatus("Wi-Fi unavailable")
        }
    }

    private fun acquireMulticastLock() {
        if (multicastLock == null) {
            multicastLock = wifiManager.createMulticastLock("gesture-controls-discovery").apply {
                setReferenceCounted(false)
            }
        }
        multicastLock?.let { lock -> if (!lock.isHeld) lock.acquire() }
    }

    private fun scheduleRetry() {
        if (retryScheduled) return
        retryScheduled = true
        mainHandler.postDelayed({
            retryScheduled = false
            // A resolve failure does not normally re-emit the already-found
            // service, so restart the DNS-SD scan before retrying.
            if (discoveryListener != null) {
                val listener = discoveryListener
                discoveryListener = null
                resolving = false
                discoveredServiceName = null
                listener?.let { try { nsdManager.stopServiceDiscovery(it) } catch (_: IllegalArgumentException) {} }
            }
            beginDiscovery()
        }, RETRY_DELAY_MS)
    }

    private fun emitStatus(status: String) {
        synchronized(statusHistory) {
            if (statusHistory.size >= HISTORY_LIMIT) statusHistory.removeFirst()
            statusHistory.addLast(status)
        }
        onStatus(status)
    }

    /**
     * Picks the best resolved address: an IPv4 literal when one is available
     * (works everywhere, no bracketing/zone-id concerns), else the first
     * IPv6 candidate as a fallback. `NsdServiceInfo.hostAddresses` (API 34+)
     * can carry both; below that only the single legacy `host` is available.
     */
    private fun selectAddress(serviceInfo: NsdServiceInfo): InetAddress? {
        val candidates: List<InetAddress> = if (Build.VERSION.SDK_INT >= 34) {
            serviceInfo.hostAddresses
        } else {
            listOfNotNull(serviceInfo.host)
        }
        if (candidates.isEmpty()) return null
        return candidates.firstOrNull { it is Inet4Address } ?: candidates.first()
    }

    /**
     * Builds a `ws://` endpoint from a resolved address, bracketing IPv6
     * literals per RFC 3986 and percent-encoding a zone/scope id (e.g. a
     * link-local `fe80::...%wlan0`) per RFC 6874 so the literal is a valid
     * authority component.
     */
    private fun buildWebSocketUrl(address: InetAddress, port: Int): String? {
        val raw = address.hostAddress ?: return null
        val host = if (address is Inet6Address) {
            val zoneIndex = raw.indexOf('%')
            if (zoneIndex >= 0) {
                "[${raw.substring(0, zoneIndex)}%25${raw.substring(zoneIndex + 1)}]"
            } else {
                "[$raw]"
            }
        } else {
            raw
        }
        return "ws://$host:$port$WEBSOCKET_PATH"
    }

    companion object {
        const val SERVICE_TYPE = "_gesture-controls._tcp."
        private const val WEBSOCKET_PATH = "/ws/watch"
        private const val RETRY_DELAY_MS = 2_000L
        private const val HISTORY_LIMIT = 6
    }
}
