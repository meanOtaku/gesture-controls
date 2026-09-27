package com.gesturecontrols.wearwatch.data.connection

/** Which link the watch uses to reach the desktop; persisted by [ConnectionPrefs]. */
enum class WatchTransportKind {
    /** BLE GATT server + advertising. The default since GC-037. */
    BLUETOOTH,

    /** Wi-Fi LAN WebSocket with mDNS discovery and the desktop pairing callback. */
    WIFI,
    ;

    val wireValue: String get() = name.lowercase()

    companion object {
        /** Fresh installs — and installs upgrading from a Wi-Fi-only build — start on Bluetooth. */
        val DEFAULT = BLUETOOTH

        fun fromWireValue(value: String?): WatchTransportKind =
            entries.firstOrNull { it.wireValue == value } ?: DEFAULT
    }
}

/**
 * The single seam the two watch transports differ at. Everything above it —
 * message construction, sequencing, heartbeat and batch flush timers, inbound
 * command dispatch — lives in [WatchLinkManager] and is shared, so neither
 * transport re-implements the protocol
 * (docs/protocols/watch-websocket-protocol.md).
 *
 * Implementations own their own reconnect/retry policy and report every state
 * change through [onState]; they never silently hand over to the other
 * transport.
 */
interface WatchTransportLink {

    /** Which kind this is, for UI labelling and for asserting only one is live. */
    val kind: WatchTransportKind

    /**
     * Reports a state change plus a short, sanitized failure category (never a
     * raw exception message or stack trace, which could leak internal detail
     * into the UI). `null` clears any previous failure.
     */
    var onState: ((ConnectionState, String?) -> Unit)?

    /** Receives one complete inbound protocol envelope. */
    var onMessage: ((String) -> Unit)?

    /** Begins connecting/advertising. Idempotent. */
    fun start()

    /** User-initiated stop: releases every socket/GATT/advertising resource. */
    fun stop()

    /**
     * Releases resources while the activity is backgrounded, without forgetting
     * that the user wants a connection; [resume] re-establishes it.
     */
    fun pause()

    /** Re-establishes a connection paused by [pause]. */
    fun resume()

    /** Permanent teardown; the link is unusable afterwards. */
    fun shutdown()

    /** Sends one serialized envelope. `false` means it was dropped. */
    fun send(message: String): Boolean
}
