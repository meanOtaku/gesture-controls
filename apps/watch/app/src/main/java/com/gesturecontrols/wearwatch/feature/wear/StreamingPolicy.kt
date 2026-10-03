package com.gesturecontrols.wearwatch.feature.wear

import com.gesturecontrols.wearwatch.data.connection.ConnectionState

/** What the watch should be doing with its sensors right now. */
enum class StreamingPlan {
    /** A desktop is receiving and the watch is on a wrist: IMU, PPG and the wake lock run. */
    STREAM,

    /** A desktop is connected but the watch is off the wrist: nothing is collected. */
    PAUSED_OFF_BODY,

    /** Connected, and the off-body detector has not reported yet: change nothing. */
    PENDING,

    /** Not connected, but a link is being set up or retried: nothing is collected. */
    WAITING,

    /** No link at all. */
    STOPPED,
}

/**
 * The single rule for when the sensors may run. Kept pure so it can be tested exhaustively;
 * the activity only carries out the plan it returns.
 *
 * [worn] is null until the off-body detector first reports (or until its short start-up
 * allowance gives up and reports "worn"), so a watch that has no such sensor streams as it
 * always did.
 */
object StreamingPolicy {
    fun plan(state: ConnectionState, worn: Boolean?, streamWhenNotWorn: Boolean): StreamingPlan = when (state) {
        ConnectionState.CONNECTED -> when {
            streamWhenNotWorn || worn == true -> StreamingPlan.STREAM
            worn == false -> StreamingPlan.PAUSED_OFF_BODY
            else -> StreamingPlan.PENDING
        }
        ConnectionState.CONNECTING,
        ConnectionState.RECONNECTING,
        ConnectionState.AWAITING_TRUST -> StreamingPlan.WAITING
        ConnectionState.DISCONNECTED,
        ConnectionState.FAILED -> StreamingPlan.STOPPED
    }
}
