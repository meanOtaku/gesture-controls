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
    const val TYPE_BUTTON = "watch.button"
    const val TYPE_DESKTOP_CONNECTED = "desktop.connected"
    const val TYPE_DESKTOP_TIME_SYNC = "desktop.time_sync"

    // Medical tracker types (Samsung Health Sensor SDK 1.4.1); see
    // docs/watch-websocket-protocol.md's "Medical trackers" section.
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

    /** Identifies this app to the desktop; matches the sample deviceId in the protocol doc. */
    const val DEVICE_ID = "galaxy-watch-4"

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
