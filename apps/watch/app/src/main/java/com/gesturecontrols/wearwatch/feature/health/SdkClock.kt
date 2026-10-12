package com.gesturecontrols.wearwatch.feature.health

private const val NANOS_PER_MILLI = 1_000_000L

/**
 * A Samsung Health Sensor SDK `DataPoint.getTimestamp()` in nanoseconds, the unit of every `timestampsNs` field on the
 * wire. The SDK reports milliseconds. Sending them unchanged put 25 Hz pulse samples 40 ns apart instead of 40 ms, so
 * the desktop squeezed each batch onto a single instant.
 */
fun sdkTimestampToNs(timestampMs: Long): Long = timestampMs * NANOS_PER_MILLI
