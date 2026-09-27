package com.gesturecontrols.wearwatch.data.connection

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The persisted transport preference's default and migration behaviour, which
 * `ConnectionPrefs.transport` reads straight through.
 */
class WatchTransportKindTest {

    @Test
    fun aFreshInstallWithNoStoredValueSelectsBluetooth() {
        assertEquals(WatchTransportKind.BLUETOOTH, WatchTransportKind.fromWireValue(null))
    }

    @Test
    fun anInstallUpgradingFromTheWifiOnlyBuildMigratesToBluetooth() {
        // Pre-GC-037 preference files have no transport key at all, which
        // reaches `fromWireValue` as null, and an unrecognized value (a
        // downgrade/upgrade mismatch) must not leave the watch without a
        // transport either.
        assertEquals(WatchTransportKind.BLUETOOTH, WatchTransportKind.fromWireValue(""))
        assertEquals(WatchTransportKind.BLUETOOTH, WatchTransportKind.fromWireValue("zigbee"))
    }

    @Test
    fun anExplicitChoiceSurvivesAPersistenceRoundTrip() {
        for (kind in WatchTransportKind.entries) {
            assertEquals(kind, WatchTransportKind.fromWireValue(kind.wireValue))
        }
    }
}
