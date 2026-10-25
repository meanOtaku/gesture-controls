package com.gesturecontrols.wearwatch.data.connection

import com.gesturecontrols.wearwatch.feature.health.*
import com.gesturecontrols.wearwatch.feature.motion.*

import org.json.JSONArray
import org.json.JSONObject

/**
 * Wire format for docs/protocols/watch-websocket-protocol.md (v1). Kept dependency-free
 * (org.json ships with Android) so the desktop protocol crate has no Kotlin
 * counterpart to drift out of sync with.
 */
/** One motion reading waiting for the next flush; the arrays are copies the sensor callback will not touch again. */
class ImuSample(
    val timestampNs: Long,
    val quaternion: FloatArray,
    val accelerometer: FloatArray?,
    val gyroscope: FloatArray?,
)

object WatchProtocol {
    const val VERSION = 1

    const val TYPE_ORIENTATION = "watch.orientation"
    const val TYPE_HEARTBEAT = "watch.heartbeat"
    const val TYPE_TIME_SYNC = "watch.time_sync"
    const val TYPE_PPG_BATCH = "watch.ppg_batch"
    /** A batch of motion samples (the watch's motion stream; pulse goes separately as [TYPE_PPG_BATCH]). The format can also
     *  carry pulse samples, which builds before 2026-10-13 did; see docs/protocols/watch-websocket-protocol.md. */
    const val TYPE_SENSOR_BATCH = "watch.sensor_batch"
    const val TYPE_PPG_STATUS = "watch.ppg_status"
    const val TYPE_BUTTON = "watch.button"
    /** Whether the watch is on a wrist; while it is not, the watch stops its sensors. */
    const val TYPE_WEAR_STATE = "watch.wear_state"
    const val TYPE_DESKTOP_CONNECTED = "desktop.connected"
    const val TYPE_DESKTOP_TIME_SYNC = "desktop.time_sync"

    // Medical tracker types (Samsung Health Sensor SDK 1.4.1); see
    // docs/protocols/watch-websocket-protocol.md's "Medical trackers" section.
    const val TYPE_HEART_RATE_BATCH = "watch.heart_rate_batch"
    const val TYPE_SKIN_TEMPERATURE_BATCH = "watch.skin_temperature_batch"
    const val TYPE_EDA_BATCH = "watch.eda_batch"
    const val TYPE_SPO2_BATCH = "watch.spo2_batch"
    const val TYPE_ECG_BATCH = "watch.ecg_batch"
    const val TYPE_BIA_RESULT = "watch.bia_result"
    const val TYPE_SWEAT_LOSS_BATCH = "watch.sweat_loss_batch"
    const val TYPE_MEDICAL_STATUS = "watch.medical_status"
    const val TYPE_DESKTOP_START_MEASUREMENT = "desktop.start_measurement"
    const val TYPE_DESKTOP_STOP_MEASUREMENT = "desktop.stop_measurement"

    /** Generic enable/disable command for an IMU input or continuous tracker; see [SensorCollector], [MedicalContinuousCollector]. */
    const val TYPE_DESKTOP_SET_SENSOR = "desktop.set_sensor"
    /** Reports an IMU sensor's current enabled state ([SENSOR_ORIENTATION] etc.); continuous trackers report via [TYPE_MEDICAL_STATUS] instead. */
    const val TYPE_SENSOR_STATUS = "watch.sensor_status"
    /** Sets an IMU sensor's requested sampling rate ([SENSOR_ORIENTATION] etc.); see [SensorCollector.setSensorRateHz]. */
    const val TYPE_DESKTOP_SET_SENSOR_RATE = "desktop.set_sensor_rate"

    /** A short, bounded haptic pulse (e.g. wrist-rotation volume feedback); see [WatchLinkManager.onHapticCommand]. */
    const val TYPE_DESKTOP_HAPTIC = "desktop.haptic"
    /** Inclusive bounds for `desktop.haptic`'s `durationMs`; mirrors `MIN_HAPTIC_DURATION_MS`/`MAX_HAPTIC_DURATION_MS` in spatial_protocol. */
    const val MIN_HAPTIC_DURATION_MS = 10
    const val MAX_HAPTIC_DURATION_MS = 200

    /**
     * Fallback only: the id used before the install's own persisted id is known
     * (see `ConnectionPrefs.deviceId`). Shared by every watch, so it must never
     * be what distinguishes one device from another.
     */
    const val DEVICE_ID = "galaxy-watch-4"

    /** Over Bluetooth the desktop overwrites the id with the peripheral's, so one byte is enough on the wire. */
    const val BLE_WIRE_DEVICE_ID = "w"

    /** The only hardware button this milestone dispatches; see `MainActivity#onKeyDown`. */
    const val BUTTON_ID_STEM_PRIMARY = "stem_primary"
    const val BUTTON_STATE_DOWN = "down"
    const val BUTTON_STATE_UP = "up"

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
        // Float.toString is the shortest text that reads back as the same float;
        // widening to Double first would print ~17 digits per component.
        for (component in values) array.put(component.toString().toDouble())
        return array
    }

    /**
     * Reference encoder for [orientationMessage]: the straightforward
     * JSONObject build the fast path must stay equivalent to (see
     * WatchProtocolOrientationTest). Not used on the sensor path.
     */
    internal fun orientationMessageViaJsonObject(
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

    /**
     * The sensor hot path (up to 50 messages a second): writes the envelope
     * straight into one StringBuilder instead of allocating a JSONObject, two
     * JSONArrays and a boxed Double per component. Returns null for a reading
     * with a non-finite component, which JSON cannot carry (the JSONObject path
     * threw on one, from inside the sensor callback).
     */
    fun orientationMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        quaternion: FloatArray,
        accelerometer: FloatArray?,
        gyroscope: FloatArray?,
    ): String? {
        if (!allFinite(quaternion) || !allFinite(accelerometer) || !allFinite(gyroscope)) return null
        val out = StringBuilder(ORIENTATION_ESTIMATED_CHARS)
        out.append("{\"type\":\"").append(TYPE_ORIENTATION)
            .append("\",\"version\":").append(VERSION)
            .append(",\"deviceId\":")
        appendJsonString(out, deviceId)
        out.append(",\"sequence\":").append(sequence)
            .append(",\"timestampNs\":").append(timestampNs)
            .append(",\"payload\":{\"quaternion\":")
        appendVector(out, quaternion)
        out.append(",\"accelerometer\":")
        appendVector(out, accelerometer)
        out.append(",\"gyroscope\":")
        appendVector(out, gyroscope)
        out.append("}}")
        return out.toString()
    }

    private const val ORIENTATION_ESTIMATED_CHARS = 224

    private fun allFinite(values: FloatArray?): Boolean {
        if (values == null) return true
        for (component in values) if (!component.isFinite()) return false
        return true
    }

    private fun appendVector(out: StringBuilder, values: FloatArray?) {
        if (values == null) {
            out.append("null")
            return
        }
        out.append('[')
        for (index in values.indices) {
            if (index > 0) out.append(',')
            out.append(values[index].toString())
        }
        out.append(']')
    }

    private fun appendJsonString(out: StringBuilder, value: String) {
        out.append('"')
        for (char in value) {
            when {
                char == '"' -> out.append("\\\"")
                char == '\\' -> out.append("\\\\")
                char < ' ' -> out.append(String.format("\\u%04x", char.code))
                else -> out.append(char)
            }
        }
        out.append('"')
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

    /** Encodes a compact batch of raw PPG samples as parallel per-channel arrays (docs/protocols/watch-websocket-protocol.md). */
    fun ppgBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<PpgSample>,
    ): String {
        val payload = ppgPayload(samples)
        return envelope(TYPE_PPG_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /**
     * One flush of both sensors in a single envelope: `imuPacked` carries the motion samples packed as
     * binary ([packImu]; the desktop's `decode_packed_imu` reads it), `ppg` the same arrays as
     * [ppgBatchMessage] or null. A batch spanning more time than a packed offset holds (over 4 s, after a
     * stall) goes as `imu`, per-sample arrays, instead. A motion reading with a non-finite component is
     * left out. Returns null when nothing is left to send.
     */
    fun sensorBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        imu: List<ImuSample>,
        ppg: List<PpgSample>,
    ): String? {
        val motion = imu.filter { allFinite(it.quaternion) && allFinite(it.accelerometer) && allFinite(it.gyroscope) }
        if (motion.isEmpty() && ppg.isEmpty()) return null
        val payload = JSONObject()
        val packed = packImu(motion)
        if (packed != null) {
            payload.put("imuPacked", packed)
        } else if (motion.isNotEmpty()) {
            val block = JSONObject()
            block.put("count", motion.size)
            block.put("timestampsNs", JSONArray(motion.map { it.timestampNs }))
            block.put("quaternion", JSONArray(motion.map { vectorOrNull(it.quaternion) }))
            block.put("accelerometer", JSONArray(motion.map { vectorOrNull(it.accelerometer) ?: JSONObject.NULL }))
            block.put("gyroscope", JSONArray(motion.map { vectorOrNull(it.gyroscope) ?: JSONObject.NULL }))
            payload.put("imu", block)
        }
        if (ppg.isNotEmpty()) payload.put("ppg", ppgPayload(ppg))
        return envelope(TYPE_SENSOR_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** The packed motion layout's version, as the desktop's `PACKED_IMU_VERSION`. */
    private const val PACKED_IMU_VERSION: Byte = 1

    /**
     * Motion samples packed as the desktop's `decode_packed_imu` reads them: standard base64 of, little-endian,
     * u8 version, u16 count, i64 first timestamp (ns); then per sample u32 ns after the first, u8 flags (bit 0
     * accelerometer, bit 1 gyroscope), and the quaternion, accelerometer and gyroscope as f32 (an absent sensor's
     * are 0). The sensors' own floats go as they are, so nothing is lost; it is about 60 bytes a sample against
     * about 140 as JSON numbers. Null with no sample, or when the samples span more than a u32 of nanoseconds.
     */
    fun packImu(samples: List<ImuSample>): String? {
        if (samples.isEmpty()) return null
        val first = samples.minOf { it.timestampNs }
        if (samples.any { it.timestampNs - first > 0xFFFF_FFFFL }) return null
        val buffer = java.nio.ByteBuffer.allocate(11 + samples.size * 45).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        buffer.put(PACKED_IMU_VERSION)
        buffer.putShort(samples.size.toShort())
        buffer.putLong(first)
        for (sample in samples) {
            buffer.putInt((sample.timestampNs - first).toInt())
            val flags = (if (sample.accelerometer != null) 1 else 0) or (if (sample.gyroscope != null) 2 else 0)
            buffer.put(flags.toByte())
            for (i in 0 until 4) buffer.putFloat(sample.quaternion.getOrElse(i) { 0f })
            for (values in listOf(sample.accelerometer, sample.gyroscope)) {
                for (i in 0 until 3) buffer.putFloat(values?.getOrElse(i) { 0f } ?: 0f)
            }
        }
        return java.util.Base64.getEncoder().encodeToString(buffer.array())
    }

    private fun ppgPayload(samples: List<PpgSample>): JSONObject {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("green", JSONArray(samples.map { it.green }))
        payload.put("greenStatus", JSONArray(samples.map { it.greenStatus }))
        payload.put("red", JSONArray(samples.map { it.red }))
        payload.put("redStatus", JSONArray(samples.map { it.redStatus }))
        payload.put("ir", JSONArray(samples.map { it.ir }))
        payload.put("irStatus", JSONArray(samples.map { it.irStatus }))
        return payload
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

    /** Encodes the off-body detector's verdict: `worn` is true on a wrist. */
    fun wearStateMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        worn: Boolean,
    ): String {
        val payload = JSONObject()
        payload.put("worn", worn)
        return envelope(TYPE_WEAR_STATE, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a STEM button press/release that grabs or releases the desktop's volume overlay. */
    fun buttonMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        state: String,
    ): String {
        val payload = JSONObject()
        payload.put("button", BUTTON_ID_STEM_PRIMARY)
        payload.put("state", state)
        return envelope(TYPE_BUTTON, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a batch of HEART_RATE_CONTINUOUS samples as parallel per-sample arrays. */
    fun heartRateBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<HeartRateSample>,
    ): String {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("heartRate", JSONArray(samples.map { it.heartRate }))
        payload.put("heartRateStatus", JSONArray(samples.map { it.heartRateStatus }))
        payload.put("ibiMs", JSONArray(samples.map { JSONArray(it.ibiMs) }))
        payload.put("ibiStatus", JSONArray(samples.map { JSONArray(it.ibiStatus) }))
        return envelope(TYPE_HEART_RATE_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a batch of SKIN_TEMPERATURE_CONTINUOUS samples as parallel per-sample arrays. */
    fun skinTemperatureBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<SkinTemperatureSample>,
    ): String {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("objectTemperatureCelsius", JSONArray(samples.map { it.objectTemperatureCelsius }))
        payload.put("ambientTemperatureCelsius", JSONArray(samples.map { it.ambientTemperatureCelsius }))
        payload.put("status", JSONArray(samples.map { it.status }))
        return envelope(TYPE_SKIN_TEMPERATURE_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a batch of EDA_CONTINUOUS samples as parallel per-sample arrays. */
    fun edaBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<EdaSample>,
    ): String {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("skinConductanceMicrosiemens", JSONArray(samples.map { it.skinConductanceMicrosiemens }))
        payload.put("status", JSONArray(samples.map { it.status }))
        return envelope(TYPE_EDA_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a batch of SPO2_ON_DEMAND samples from a bounded measurement session. */
    fun spo2BatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<Spo2Sample>,
    ): String {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("spo2", JSONArray(samples.map { it.spo2 }))
        payload.put("heartRate", JSONArray(samples.map { it.heartRate }))
        payload.put("accuracyFlag", JSONArray(samples.map { it.accuracyFlag }))
        payload.put("status", JSONArray(samples.map { it.status }))
        return envelope(TYPE_SPO2_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a batch of ECG_ON_DEMAND samples from a bounded measurement session. */
    fun ecgBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<EcgSample>,
    ): String {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("ecgMillivolts", JSONArray(samples.map { it.ecgMillivolts }))
        payload.put("leadOff", JSONArray(samples.map { it.leadOff }))
        payload.put("sequenceNumbers", JSONArray(samples.map { it.sequenceNumber }))
        payload.put("maxThresholdMillivolts", JSONArray(samples.map { it.maxThresholdMillivolts }))
        payload.put("minThresholdMillivolts", JSONArray(samples.map { it.minThresholdMillivolts }))
        return envelope(TYPE_ECG_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a BIA_ON_DEMAND progress/result update from a bounded measurement session. */
    fun biaResultMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        result: BiaResult,
    ): String {
        val payload = JSONObject()
        payload.put("progressPercent", result.progressPercent)
        payload.put("status", result.status)
        payload.put("bodyFatRatio", result.bodyFatRatio ?: JSONObject.NULL)
        payload.put("bodyFatMassKg", result.bodyFatMassKg ?: JSONObject.NULL)
        payload.put("totalBodyWaterKg", result.totalBodyWaterKg ?: JSONObject.NULL)
        payload.put("skeletalMuscleRatio", result.skeletalMuscleRatio ?: JSONObject.NULL)
        payload.put("skeletalMuscleMassKg", result.skeletalMuscleMassKg ?: JSONObject.NULL)
        payload.put("basalMetabolicRateKcal", result.basalMetabolicRateKcal ?: JSONObject.NULL)
        payload.put("fatFreeRatio", result.fatFreeRatio ?: JSONObject.NULL)
        payload.put("fatFreeMassKg", result.fatFreeMassKg ?: JSONObject.NULL)
        payload.put("bodyImpedanceMagnitudeOhm", result.bodyImpedanceMagnitudeOhm ?: JSONObject.NULL)
        payload.put("bodyImpedanceDegreeDeg", result.bodyImpedanceDegreeDeg ?: JSONObject.NULL)
        return envelope(TYPE_BIA_RESULT, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a batch of SWEAT_LOSS samples from a bounded, exercise-session-scoped measurement. */
    fun sweatLossBatchMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        samples: List<SweatLossSample>,
    ): String {
        val payload = JSONObject()
        payload.put("sampleCount", samples.size)
        payload.put("timestampsNs", JSONArray(samples.map { it.timestampNs }))
        payload.put("sweatLossMilliliters", JSONArray(samples.map { it.sweatLossMilliliters }))
        payload.put("status", JSONArray(samples.map { it.status }))
        return envelope(TYPE_SWEAT_LOSS_BATCH, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes a medical tracker's availability; sent for every supported *and* unsupported tracker id. */
    fun medicalStatusMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        tracker: String,
        state: String,
    ): String {
        val payload = JSONObject()
        payload.put("tracker", tracker)
        payload.put("state", state)
        return envelope(TYPE_MEDICAL_STATUS, deviceId, sequence, timestampNs, payload)
    }

    /** Encodes an IMU sensor's current enabled state ([SENSOR_ORIENTATION] etc.). */
    fun sensorStatusMessage(
        deviceId: String,
        sequence: Long,
        timestampNs: Long,
        sensor: String,
        enabled: Boolean,
    ): String {
        val payload = JSONObject()
        payload.put("sensor", sensor)
        payload.put("enabled", enabled)
        return envelope(TYPE_SENSOR_STATUS, deviceId, sequence, timestampNs, payload)
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
