package com.gesturecontrols.wearwatch.data.connection

import java.security.MessageDigest

/**
 * A short, stable label for this watch that goes in its Bluetooth advertisement, so a desktop
 * can name the watch it found ("watch a1b2c3d4") without connecting to it first. Derived from the
 * install's device id by a one-way hash, so the id itself is never broadcast. It is an identifier
 * for display and logs only: nothing is trusted because of it.
 */
object WatchTag {
    const val LENGTH_BYTES = 4

    fun bytesFor(deviceId: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(deviceId.toByteArray(Charsets.UTF_8)).copyOf(LENGTH_BYTES)

    /** The same label the desktop prints: lowercase hex. */
    fun labelFor(deviceId: String): String = bytesFor(deviceId).joinToString("") { "%02x".format(it) }
}
