package com.gesturecontrols.wearwatch.feature.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchThemeTest {
    @Test
    fun `the desktop's theme names are understood and others are not`() {
        assertEquals(WatchTheme.ELECTRIC, WatchTheme.fromWire("electric"))
        assertEquals(WatchTheme.NEO, WatchTheme.fromWire("neo"))
        assertEquals(WatchTheme.NERV, WatchTheme.fromWire("nerv"))
        assertNull(WatchTheme.fromWire("halftone"))
        assertNull(WatchTheme.fromWire(null))
    }
}
