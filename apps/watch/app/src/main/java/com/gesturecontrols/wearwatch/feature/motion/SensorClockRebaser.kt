package com.gesturecontrols.wearwatch.feature.motion

/**
 * Puts orientation timestamps on the `SystemClock.elapsedRealtimeNanos()` base
 * that every other watch message already uses.
 *
 * Orientation is the only message whose envelope timestamp is the sensor's own
 * `SensorEvent.timestamp`. Android requires that clock to share
 * `elapsedRealtimeNanos()`'s base, so on a compliant device it is passed
 * through untouched. The desktop merges orientation and PPG rows by timestamp
 * (and a PPG batch's translation is anchored on the same domain), so a device
 * whose sensor clock differs would displace every orientation row against the
 * PPG rows by a constant offset. This verifies the assumption on each event and
 * rebases when it does not hold, instead of trusting it.
 *
 * Pure: the caller supplies both clocks, so it never reads one itself.
 */
class SensorClockRebaser(private val maxPlausibleDeliveryLagNs: Long = MAX_PLAUSIBLE_DELIVERY_LAG_NS) {

    private var offsetNs: Long? = null
    private var lastRebasedNs = Long.MIN_VALUE

    /** True once a sensor timestamp was found off the `elapsedRealtimeNanos` base and is being rebased. */
    var isRebasing = false
        private set

    /**
     * [sensorTimestampNs] is `SensorEvent.timestamp`; [nowElapsedRealtimeNs] is
     * `SystemClock.elapsedRealtimeNanos()` read as the event is delivered.
     * Returns the timestamp to put on the wire.
     */
    fun toElapsedRealtime(sensorTimestampNs: Long, nowElapsedRealtimeNs: Long): Long {
        val lag = nowElapsedRealtimeNs - sensorTimestampNs
        if (lag in 0..maxPlausibleDeliveryLagNs) {
            // A sensor event cannot be delivered before it happened, and is not
            // delivered long after: the bases agree.
            offsetNs = null
            isRebasing = false
            lastRebasedNs = sensorTimestampNs
            return sensorTimestampNs
        }
        // Different base: shift by the smallest delivery lag seen, which is the
        // best available estimate of the base difference (plus one minimal
        // delivery latency), so sensor-side timing between events is preserved
        // and the result never lies in the future.
        val offset = minOf(offsetNs ?: lag, lag)
        offsetNs = offset
        isRebasing = true
        val rebased = sensorTimestampNs + offset
        // The offset only ever shrinks, which could step back by more than one
        // sample period; the desktop rejects non-increasing orientation timestamps.
        val monotonic = if (rebased > lastRebasedNs) rebased else lastRebasedNs + 1
        lastRebasedNs = monotonic
        return monotonic
    }

    fun reset() {
        offsetNs = null
        lastRebasedNs = Long.MIN_VALUE
        isRebasing = false
    }

    companion object {
        /** A sensor event delivered more than this long after it happened is not on the same clock. */
        const val MAX_PLAUSIBLE_DELIVERY_LAG_NS = 1_000_000_000L
    }
}
