package com.gesturecontrols.wearwatch.feature.pinch

import com.gesturecontrols.wearwatch.data.connection.WatchProtocol
import com.gesturecontrols.wearwatch.feature.health.PpgSample
import org.json.JSONObject
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import java.io.File
import java.security.MessageDigest
import java.util.PriorityQueue
import kotlin.math.acos
import kotlin.math.max
import kotlin.math.roundToLong
import kotlin.math.sqrt

/** Selects the watch's grab input. The production default remains the hardware button. */
enum class WatchInputMode(val wireValue: String) {
    BUTTON("button"),
    PINCH_INFERENCE("pinch");

    companion object {
        fun parse(value: String): WatchInputMode = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("watch input mode must be 'button' or 'pinch', got '$value'")
    }
}

data class PinchTransition(
    val phase: WatchProtocol.PinchPhase,
    val confidence: Double,
    val modelId: String,
    val timestampNs: Long,
)

/** Runtime prediction seam: tests exercise preprocessing/state behavior without a native TFLite binary. */
fun interface PinchPredictor {
    fun predict(features: FloatArray): FloatArray
}

/**
 * Validated, fixed-window on-watch inference for the exported pinch-classifier bundle.
 *
 * The deployment bundle is read only from [bundleDirectory] (normally
 * `Context.filesDir/pinch-inference`). Raw PPG and motion events are merged in
 * monotonic timestamp order at each PPG watermark, reproducing the recorder's
 * carry-forward rows before applying the exact ordered 55-feature contract.
 * Any validation, ordering, tensor, or inference failure disables inference and
 * emits exactly one fail-closed RELEASED transition.
 */
class PinchInferenceEngine private constructor(
    private val metadata: BundleMetadata?,
    private val predictor: PinchPredictor?,
    private val onTransition: (PinchTransition) -> Unit,
    initiallyFailed: Boolean,
    failureTimestampNs: Long,
) : AutoCloseable {
    private data class Motion(
        val quaternion: FloatArray,
        val acceleration: FloatArray?,
        val gyroscope: FloatArray?,
        val timestampNs: Long,
    )

    private sealed interface SensorInput {
        val timestampNs: Long
        val order: Long

        data class MotionInput(val value: Motion, override val order: Long) : SensorInput {
            override val timestampNs: Long = value.timestampNs
        }

        data class PpgInput(val value: PpgSample, override val order: Long) : SensorInput {
            override val timestampNs: Long = value.timestampNs
        }
    }

    private data class Row(
        val timestampNs: Long,
        val ppg: DoubleArray,
        val acceleration: DoubleArray,
        val gyroscope: DoubleArray,
        val quaternion: DoubleArray,
        val contactQuality: Double,
    )

    private val pending = PriorityQueue<SensorInput>(compareBy<SensorInput> { it.timestampNs }.thenBy { it.order })
    private val segmentRows = ArrayDeque<Row>()
    private var order = 0L
    private var lastProcessedTimestampNs = Long.MIN_VALUE
    private var lastPpg = DoubleArray(3)
    private var lastAcceleration = DoubleArray(3)
    private var lastGyroscope = DoubleArray(3)
    private var lastQuaternion = DoubleArray(4)
    private var lastContactQuality = 0.0
    private var nextWindowStartNs: Long? = null
    private var active = false
    private var startVotes = 0
    private var releaseVotes = 0
    private var failed = initiallyFailed
    private var failClosedReleaseSent = false

    init {
        if (initiallyFailed) failClosed(failureTimestampNs)
    }

    @Synchronized
    fun onMotion(
        quaternion: FloatArray,
        acceleration: FloatArray?,
        gyroscope: FloatArray?,
        timestampNs: Long,
    ) {
        if (failed) return
        try {
            require(timestampNs >= 0) { "motion timestamp must be non-negative" }
            require(quaternion.size == 4 && quaternion.all(Float::isFinite)) { "quaternion must have four finite values" }
            require(acceleration == null || acceleration.size == 3 && acceleration.all(Float::isFinite))
            require(gyroscope == null || gyroscope.size == 3 && gyroscope.all(Float::isFinite))
            pending += SensorInput.MotionInput(
                Motion(quaternion.copyOf(), acceleration?.copyOf(), gyroscope?.copyOf(), timestampNs),
                order++,
            )
        } catch (_: Throwable) {
            failClosed(timestampNs.coerceAtLeast(0))
        }
    }

    @Synchronized
    fun onPpgSamples(samples: List<PpgSample>) {
        if (failed || samples.isEmpty()) return
        val failureTime = samples.maxOfOrNull { it.timestampNs }?.coerceAtLeast(0) ?: 0
        try {
            require(samples.zipWithNext().all { (a, b) -> a.timestampNs <= b.timestampNs }) {
                "PPG batch timestamps must be non-decreasing"
            }
            samples.forEach { sample ->
                require(sample.timestampNs >= 0) { "PPG timestamp must be non-negative" }
                pending += SensorInput.PpgInput(sample, order++)
            }
            drainThrough(samples.last().timestampNs)
        } catch (_: Throwable) {
            failClosed(failureTime)
        }
    }

    /** Clears temporal state. If a pinch was active, closes it with one release. */
    @Synchronized
    fun reset(timestampNs: Long) {
        if (active && !failed) emit(WatchProtocol.PinchPhase.RELEASED, 1.0, timestampNs.coerceAtLeast(0))
        clearState()
    }

    @Synchronized
    override fun close() {
        reset(lastProcessedTimestampNs.coerceAtLeast(0))
        (predictor as? AutoCloseable)?.close()
    }

    private fun drainThrough(watermarkNs: Long) {
        while (pending.peek()?.timestampNs?.let { it <= watermarkNs } == true) {
            val input = pending.remove()
            if (input.timestampNs < lastProcessedTimestampNs) {
                error("late sensor event crossed the processed watermark")
            }
            val row = when (input) {
                is SensorInput.MotionInput -> {
                    val value = input.value
                    lastQuaternion = value.quaternion.toDoubleArray()
                    value.acceleration?.let { lastAcceleration = it.toDoubleArray() }
                    value.gyroscope?.let { lastGyroscope = it.toDoubleArray() }
                    snapshotRow(value.timestampNs)
                }
                is SensorInput.PpgInput -> {
                    val value = input.value
                    lastPpg = doubleArrayOf(value.green.toDouble(), value.red.toDouble(), value.ir.toDouble())
                    lastContactQuality = max(value.greenStatus, max(value.redStatus, value.irStatus)).toDouble()
                    snapshotRow(value.timestampNs)
                }
            }
            acceptRow(row)
            lastProcessedTimestampNs = input.timestampNs
        }
    }

    private fun snapshotRow(timestampNs: Long) = Row(
        timestampNs,
        lastPpg.copyOf(),
        lastAcceleration.copyOf(),
        lastGyroscope.copyOf(),
        lastQuaternion.copyOf(),
        lastContactQuality,
    )

    private fun acceptRow(row: Row) {
        val config = requireNotNull(metadata).window
        val previous = segmentRows.lastOrNull()
        if (previous != null && row.timestampNs - previous.timestampNs > config.maxGapNs) {
            if (active) emit(WatchProtocol.PinchPhase.RELEASED, 1.0, previous.timestampNs)
            segmentRows.clear()
            nextWindowStartNs = null
            active = false
            startVotes = 0
            releaseVotes = 0
        }
        segmentRows += row
        if (nextWindowStartNs == null) nextWindowStartNs = row.timestampNs

        var start = requireNotNull(nextWindowStartNs)
        while (start <= Long.MAX_VALUE - config.windowNs && start + config.windowNs <= row.timestampNs) {
            val end = start + config.windowNs
            val windowRows = segmentRows.filter { it.timestampNs in start..end }
            if (windowRows.size >= config.minSamples) classify(windowRows, end)
            start += config.strideNs
            nextWindowStartNs = start
            while (segmentRows.firstOrNull()?.timestampNs?.let { it < start } == true) segmentRows.removeFirst()
        }
    }

    private fun classify(rows: List<Row>, timestampNs: Long) {
        val probabilities = requireNotNull(predictor).predict(extractFeatures(rows))
        require(probabilities.size == CLASS_COUNT && probabilities.all(Float::isFinite)) {
            "model must return three finite probabilities"
        }
        require(probabilities.all { it in 0f..1f }) { "model probabilities must be in [0, 1]" }
        val startConfidence = probabilities[START_CLASS].toDouble()
        val releaseConfidence = probabilities[RELEASE_CLASS].toDouble()

        if (!active) {
            startVotes = if (startConfidence >= ACTIVATION_THRESHOLD) startVotes + 1 else 0
            if (startVotes >= DEBOUNCE_WINDOWS) {
                active = true
                startVotes = 0
                releaseVotes = 0
                emit(WatchProtocol.PinchPhase.STARTED, startConfidence, timestampNs)
            }
            return
        }

        releaseVotes = if (releaseConfidence >= ACTIVATION_THRESHOLD) releaseVotes + 1 else 0
        if (releaseVotes >= DEBOUNCE_WINDOWS) {
            active = false
            releaseVotes = 0
            emit(WatchProtocol.PinchPhase.RELEASED, releaseConfidence, timestampNs)
        } else {
            emit(WatchProtocol.PinchPhase.HELD, (1.0 - releaseConfidence).coerceIn(0.0, 1.0), timestampNs)
        }
    }

    private fun emit(phase: WatchProtocol.PinchPhase, confidence: Double, timestampNs: Long) {
        onTransition(PinchTransition(phase, confidence, metadata?.modelId ?: FAILED_MODEL_ID, timestampNs))
    }

    private fun failClosed(timestampNs: Long) {
        if (!failClosedReleaseSent) {
            failClosedReleaseSent = true
            emit(WatchProtocol.PinchPhase.RELEASED, 1.0, timestampNs)
        }
        failed = true
        active = false
        clearState()
        runCatching { (predictor as? AutoCloseable)?.close() }
    }

    private fun clearState() {
        pending.clear()
        segmentRows.clear()
        nextWindowStartNs = null
        lastProcessedTimestampNs = Long.MIN_VALUE
        lastPpg = DoubleArray(3)
        lastAcceleration = DoubleArray(3)
        lastGyroscope = DoubleArray(3)
        lastQuaternion = DoubleArray(4)
        lastContactQuality = 0.0
        startVotes = 0
        releaseVotes = 0
        active = false
    }

    companion object {
        const val BUNDLE_DIRECTORY = "pinch-inference"
        private const val MODEL_FILENAME = "model.tflite"
        private const val METADATA_FILENAME = "metadata.json"
        private const val FEATURE_COUNT = 55
        private const val CLASS_COUNT = 3
        private const val START_CLASS = 1
        private const val RELEASE_CLASS = 2
        private const val ACTIVATION_THRESHOLD = 0.80
        private const val DEBOUNCE_WINDOWS = 2
        private const val FAILED_MODEL_ID = "pinch-inference-failed"

        val FEATURE_NAMES = listOf(
            "ppg_green_mean", "ppg_red_mean", "ppg_ir_mean",
            "ppg_green_std", "ppg_red_std", "ppg_ir_std",
            "ppg_green_min", "ppg_red_min", "ppg_ir_min",
            "ppg_green_max", "ppg_red_max", "ppg_ir_max",
            "ppg_green_slope", "ppg_red_slope", "ppg_ir_slope",
            "accel_x_mean", "accel_y_mean", "accel_z_mean",
            "accel_x_std", "accel_y_std", "accel_z_std",
            "accel_x_min", "accel_y_min", "accel_z_min",
            "accel_x_max", "accel_y_max", "accel_z_max",
            "accel_magnitude_mean", "accel_magnitude_std",
            "gyro_x_mean", "gyro_y_mean", "gyro_z_mean",
            "gyro_x_std", "gyro_y_std", "gyro_z_std",
            "gyro_x_min", "gyro_y_min", "gyro_z_min",
            "gyro_x_max", "gyro_y_max", "gyro_z_max",
            "gyro_magnitude_mean", "gyro_magnitude_std",
            "quat_w_mean", "quat_x_mean", "quat_y_mean", "quat_z_mean",
            "quat_w_std", "quat_x_std", "quat_y_std", "quat_z_std",
            "quat_delta_angle_deg", "contact_quality_mean", "sample_count", "duration_ms",
        )

        /** Never throws: invalid/missing bundles return a permanently failed engine after one release. */
        fun create(
            bundleDirectory: File,
            failureTimestampNs: Long,
            onTransition: (PinchTransition) -> Unit,
            predictorFactory: (File) -> PinchPredictor = ::TflitePredictor,
        ): PinchInferenceEngine = try {
            val metadata = BundleMetadata.loadAndValidate(bundleDirectory)
            val predictor = predictorFactory(File(bundleDirectory, MODEL_FILENAME))
            PinchInferenceEngine(metadata, predictor, onTransition, false, failureTimestampNs)
        } catch (_: Throwable) {
            PinchInferenceEngine(null, null, onTransition, true, failureTimestampNs)
        }

        private fun extractFeatures(rows: List<Row>): FloatArray {
            val timestamps = rows.map { it.timestampNs }
            val out = ArrayList<Double>(FEATURE_COUNT)
            fun channel(selector: (Row) -> Double): DoubleArray = DoubleArray(rows.size) { selector(rows[it]) }
            fun appendStats(channels: List<DoubleArray>, slopes: Boolean = false) {
                channels.forEach { out += mean(it) }
                channels.forEach { out += std(it) }
                channels.forEach { out += it.min() }
                channels.forEach { out += it.max() }
                if (slopes) channels.forEach { values ->
                    val durationMs = (timestamps.last() - timestamps.first()) / 1_000_000.0
                    out += if (durationMs <= 0.0) 0.0 else (values.last() - values.first()) / durationMs
                }
            }

            appendStats((0..2).map { axis -> channel { it.ppg[axis] } }, slopes = true)
            val acceleration = (0..2).map { axis -> channel { it.acceleration[axis] } }
            appendStats(acceleration)
            val accelerationMagnitude = DoubleArray(rows.size) { i ->
                sqrt(acceleration.sumOf { axis -> axis[i] * axis[i] })
            }
            out += mean(accelerationMagnitude)
            out += std(accelerationMagnitude)

            val gyroscope = (0..2).map { axis -> channel { it.gyroscope[axis] } }
            appendStats(gyroscope)
            val gyroscopeMagnitude = DoubleArray(rows.size) { i -> sqrt(gyroscope.sumOf { axis -> axis[i] * axis[i] }) }
            out += mean(gyroscopeMagnitude)
            out += std(gyroscopeMagnitude)

            val quaternion = (0..3).map { axis -> channel { it.quaternion[axis] } }
            quaternion.forEach { out += mean(it) }
            quaternion.forEach { out += std(it) }
            val first = DoubleArray(4) { rows.first().quaternion[it] }
            val last = DoubleArray(4) { rows.last().quaternion[it] }
            val firstNorm = max(sqrt(first.sumOf { it * it }), 1e-9)
            val lastNorm = max(sqrt(last.sumOf { it * it }), 1e-9)
            val dot = kotlin.math.abs((0..3).sumOf { first[it] / firstNorm * (last[it] / lastNorm) }).coerceIn(-1.0, 1.0)
            out += Math.toDegrees(2.0 * acos(dot))
            out += mean(channel { it.contactQuality })
            out += rows.size.toDouble()
            out += (timestamps.last() - timestamps.first()) / 1_000_000.0
            check(out.size == FEATURE_COUNT)
            return FloatArray(FEATURE_COUNT) { out[it].toFloat() }
        }

        private fun mean(values: DoubleArray) = values.sum() / values.size
        private fun std(values: DoubleArray): Double {
            val mean = mean(values)
            return sqrt(values.sumOf { (it - mean) * (it - mean) } / values.size)
        }
    }
}

private data class WindowMetadata(
    val windowNs: Long,
    val strideNs: Long,
    val maxGapNs: Long,
    val minSamples: Int,
)

private data class BundleMetadata(val modelId: String, val window: WindowMetadata) {
    companion object {
        fun loadAndValidate(directory: File): BundleMetadata {
            require(directory.isDirectory) { "bundle directory does not exist" }
            val model = File(directory, "model.tflite")
            val metadataFile = File(directory, "metadata.json")
            require(model.isFile && metadataFile.isFile) { "bundle must contain model.tflite and metadata.json" }
            val root = JSONObject(metadataFile.readText(Charsets.UTF_8))
            require(root.getInt("schema_version") == 1)
            val modelJson = root.getJSONObject("model")
            require(modelJson.getString("file") == "model.tflite")
            require(modelJson.getString("format") == "TFLite")
            require(modelJson.getJSONArray("input_shape").toList() == listOf(1, 55))
            require(modelJson.getString("input_dtype") == "float32")
            require(modelJson.getJSONArray("output_shape").toList() == listOf(1, 3))
            require(modelJson.getString("output_dtype") == "float32")
            val expectedDigest = modelJson.getString("sha256")
            require(expectedDigest.matches(Regex("[0-9a-f]{64}")))
            require(model.sha256() == expectedDigest) { "model SHA-256 mismatch" }

            val classes = root.getJSONArray("classes")
            require(classes.length() == 3)
            listOf("negative", "pinch_start", "pinch_release").forEachIndexed { index, label ->
                val item = classes.getJSONObject(index)
                require(item.getInt("index") == index && item.getString("label") == label)
            }
            val features = root.getJSONObject("feature_contract")
            require(features.getInt("count") == 55)
            require(features.getJSONArray("ordered_names").toList() == PinchInferenceEngine.FEATURE_NAMES)

            val preprocessing = root.getJSONObject("preprocessing")
            require(preprocessing.length() == 5)
            require(preprocessing.getString("input") == "the 55 engineered window features in feature_contract.ordered_names order")
            require(preprocessing.getString("missing_sensor_values") == "carry-forward within each recording; leading missing values become 0.0")
            require(preprocessing.getString("normalization") == "per-feature standard score fitted on training sessions only and embedded in model.tflite")
            require(preprocessing.getDouble("zero_variance_scale") == 1.0)
            require(preprocessing.getString("input_dtype") == "float32")

            val parity = root.getJSONObject("conversion_parity")
            require(parity.getBoolean("passed"))
            require(parity.getInt("sample_count") > 0)
            val tolerance = parity.finiteDouble("absolute_tolerance")
            val error = parity.finiteDouble("max_absolute_error")
            require(tolerance >= 0 && error >= 0 && error <= tolerance)
            require(parity.finiteDouble("argmax_agreement") == 1.0)

            val window = root.getJSONObject("window_config")
            require(window.length() == 5)
            require(window.getString("boundary_policy") == "windows never cross recording, label, or max_gap_ms boundaries")
            val minimum = window.getInt("min_samples_per_window")
            require(minimum >= 2)
            return BundleMetadata(
                modelId = "sha256:$expectedDigest",
                window = WindowMetadata(
                    window.positiveMillisecondsAsNs("window_ms"),
                    window.positiveMillisecondsAsNs("stride_ms"),
                    window.positiveMillisecondsAsNs("max_gap_ms"),
                    minimum,
                ),
            )
        }

        private fun JSONObject.finiteDouble(name: String): Double = getDouble(name).also { require(it.isFinite()) }
        private fun JSONObject.positiveMillisecondsAsNs(name: String): Long {
            val value = finiteDouble(name)
            require(value > 0 && value <= Long.MAX_VALUE / 1_000_000.0)
            return (value * 1_000_000.0).roundToLong().also { require(it > 0) }
        }

        private fun org.json.JSONArray.toList(): List<Any> = (0 until length()).map { get(it) }
        private fun File.sha256(): String {
            val digest = MessageDigest.getInstance("SHA-256")
            inputStream().use { stream ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = stream.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

private class TflitePredictor(modelFile: File) : PinchPredictor, AutoCloseable {
    private val interpreter = Interpreter(modelFile)

    init {
        interpreter.allocateTensors()
        require(interpreter.inputTensorCount == 1 && interpreter.outputTensorCount == 1)
        require(interpreter.getInputTensor(0).shape().contentEquals(intArrayOf(1, 55)))
        require(interpreter.getInputTensor(0).dataType() == DataType.FLOAT32)
        require(interpreter.getOutputTensor(0).shape().contentEquals(intArrayOf(1, 3)))
        require(interpreter.getOutputTensor(0).dataType() == DataType.FLOAT32)
    }

    override fun predict(features: FloatArray): FloatArray {
        require(features.size == 55)
        val output = Array(1) { FloatArray(3) }
        interpreter.run(arrayOf(features), output)
        return output[0]
    }

    override fun close() = interpreter.close()
}
