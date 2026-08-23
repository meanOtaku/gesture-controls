package com.gesturecontrols.wearwatch

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper

/** Discovers the desktop bridge advertised through local DNS-SD/mDNS. */
class DesktopDiscovery(
    context: Context,
    private val onEndpoint: (String) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private val nsdManager = context.applicationContext.getSystemService(NsdManager::class.java)
    private val wifiManager = context.applicationContext.getSystemService(WifiManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var resolving = false
    private var discoveredServiceName: String? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var retryScheduled = false

    fun start() {
        if (discoveryListener != null) return
        acquireMulticastLock()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
                onStatus("Searching for desktop…")
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                if (service.serviceType != SERVICE_TYPE || resolving || discoveredServiceName != null) return
                resolving = true
                onStatus("Desktop found; connecting…")
                nsdManager.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        resolving = false
                        onStatus("Desktop discovery retrying…")
                        scheduleRetry()
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        resolving = false
                        val host = serviceInfo.host?.hostAddress
                        if (host == null || serviceInfo.port !in 1..65535) {
                            onStatus("Desktop service had no usable address")
                            return
                        }
                        discoveredServiceName = serviceInfo.serviceName
                        onStatus("Desktop discovered")
                        onEndpoint("ws://$host:${serviceInfo.port}$WEBSOCKET_PATH")
                    }
                })
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                if (service.serviceName == discoveredServiceName) {
                    discoveredServiceName = null
                    onStatus("Desktop changed; searching…")
                }
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                discoveryListener = null
                onStatus("Desktop discovery retrying…")
                scheduleRetry()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                discoveryListener = null
            }
        }
        discoveryListener = listener
        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    fun stop() {
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
            if (discoveryListener != null) stop()
            start()
        }, RETRY_DELAY_MS)
    }

    companion object {
        const val SERVICE_TYPE = "_gesture-controls._tcp."
        private const val WEBSOCKET_PATH = "/ws/watch"
        private const val RETRY_DELAY_MS = 2_000L
    }
}
