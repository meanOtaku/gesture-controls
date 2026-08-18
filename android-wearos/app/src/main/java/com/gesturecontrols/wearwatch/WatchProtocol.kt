package com.gesturecontrols.wearwatch

import org.json.JSONArray
import org.json.JSONObject

/**
 * Wire format for docs/watch-websocket-protocol.md (v1). Kept dependency-free
 * (org.json ships with Android) so the desktop protocol crate has no Kotlin
 * counterpart to drift out of sync with.
 */
object WatchProtocol {
    const val VERSION = 1

    const val TYPE_ORIENTATION = "watch.orientation"
    const val TYPE_HEARTBEAT = "watch.heartbeat"
    const val TYPE_TIME_SYNC = "watch.time_sync"
    const val TYPE_PPG_BATCH = "watch.ppg_batch"
    const val TYPE_PPG_STATUS = "watch.ppg_status"
    const val TYPE_DESKTOP_CONNECTED = "desktop.connected"
    const val TYPE_DESKTOP_TIME_SYNC = "desktop.time_sync"

    /** Identifies this app to the desktop; matches the sample deviceId in the protocol doc. */
    const val DEVICE_ID = "galaxy-watch-4"

    private fun envelope(
        type: String,
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        payload: JSONObject,
    ): String {
        val root = JSONObject()
        root.put("type", type)
        root.put("version", VERSION)
        root.put("deviceId", deviceId)
        root.put("sequence", sequence)
        root.put("timestampNs", timestampNs)
        root.put("payload", payload)
        return root.toString()
    }

    private fun vectorOrNull(values: FloatArray?): JSONArray? {
        if (values == null) return null
        val array = JSONArray()
        for (component in values) array.put(component.toDouble())
        return array
    }

    fun orientationMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        quaternion: FloatArray,
        accelerometer: FloatArray?,
        gyroscope: FloatArray?,
    ): String {
        val payload = JSONObject()
        payload.put("quaternion", vectorOrNull(quaternion))
        payload.put("accelerometer", vectorOrNull(accelerometer) ?: JSONObject.NULL)
        payload.put("gyroscope", vectorOrNull(gyroscope) ?: JSONObject.NULL)
        return envelope(TYPE_ORIENTATION, deviceId, sequence, timestampNs, payload)
    }

    fun heartbeatMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        batteryPercent: Int?,
    ): String {
        val payload = JSONObject()
        payload.put("batteryPercent", batteryPercent ?: JSONObject.NULL)
        return envelope(TYPE_HEARTBEAT, deviceId, sequence, timestampNs, payload)
    }

    fun timeSyncMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        desktopTimeNs: Long,
        watchTimeNs: Long,
    ): String {
        val payload = JSONObject()
        payload.put("desktopTimeNs", desktopTimeNs)
        payload.put("watchTimeNs", watchTimeNs)
        return envelope(TYPE_TIME_SYNC, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a compact batch of raw PPG samples as parallel per-channel arrays (docs/watch-websocket-protocol.md). */
    fun ppgBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<PpgSample>,
    ): String {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("green", JSONArray(samples.map { it.green }))
        payload.put("greenStatus", JSONArray(samples.map { it.greenStatus }))
        payload.put("red", JSONArray(samples.map { it.red }))
        payload.put("redStatus", JSONArray(samples.map { it.redStatus }))
        payload.put("ir", JSONArray(samples.map { it.ir }))
        payload.put("irStatus", JSONArray(samples.map { it.irStatus }))
        return envelope(TYPE_PPG_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes the watch's PPG availability (permission/unavailable/streaming/etc.), independent of the WebSocket connection. */
    fun ppgStatusMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        state: String,
    ): String {
        val payload = JSONObject()
        payload.put("state", state)
        return envelope(TYPE_PPG_STATUS, deviceId, sequence, timestampNs, payload)
    }

    /** Parsed subset of an inbound desktop-to-watch envelope; null fields mean "not present". */
    data class InboundMessage(val type: String, val payload: JSONObject)

    fun parseInbound(text: String): InboundMessage? {
        return try {
            val root = JSONObject(text)
            val type = root.optString("type", "")
            if (type.isEmpty()) return null
            InboundMessage(type, root.optJSONObject("payload") ?: JSONObject())
        } catch (error: Exception) {
            null
        }
    }
}
