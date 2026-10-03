package com.gesturecontrols.wearwatch.data.preferences

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** D-M2-3: a watch's id on the Wi-Fi transport must be unique to the install, not a build constant. */
class ConnectionPrefsDeviceIdTest {

    @Test
    fun everyGeneratedIdIsDifferent() {
        val ids = (1..200).map { ConnectionPrefs.newDeviceId() }.toSet()
        assertEquals(200, ids.size)
    }

    @Test
    fun aGeneratedIdIsNotTheSharedFallbackConstant() {
        assertNotEquals(
            com.gesturecontrols.wearwatch.data.connection.WatchProtocol.DEVICE_ID,
            ConnectionPrefs.newDeviceId(),
        )
    }

    @Test
    fun aGeneratedIdIsNonBlankAndSafeToPutInAnEnvelope() {
        val id = ConnectionPrefs.newDeviceId()
        assertTrue(id.startsWith("watch-"))
        assertTrue(id.all { it.isLetterOrDigit() || it == '-' })
    }
}
