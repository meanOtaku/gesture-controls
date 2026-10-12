//! The model bundle: a directory with `manifest.json` and one ONNX model.
//!
//! ```text
//! model-bundle/
//! |-- manifest.json
//! `-- model.onnx
//! ```
//!
//! A bundle is data, never code: only the ONNX format is accepted (no pickle, joblib, torch or SavedModel
//! serialisations, which can run arbitrary code or depend on a framework version). Validation reads the manifest,
//! hashes the model file, checks every contract the manifest declares against the model itself, and runs the model on
//! a few bounded inputs to prove it produces finite probabilities. Only a bundle that passes all of it can be loaded.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use model_lab_core::{InputContract, LabelId, QualityRules, StreamSource, Thresholds};
use pinch_inference::{FEATURE_NAMES, GridChannel, MAX_GRID_STEPS, MIN_GRID_STEPS, SpikeMethod};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tract_onnx::prelude::*;
use tract_onnx::tract_core::framework::Framework as _;

pub const MANIFEST_FILE: &str = "manifest.json";
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
pub(crate) const MAX_MODEL_BYTES: u64 = 16 * 1024 * 1024;
/// The runtime is checked against this ONNX opset range; tract reports anything it cannot run.
const MIN_OPSET: u32 = 9;
const MAX_OPSET: u32 = 21;

#[derive(Debug, Error)]
pub enum BundleError {
    #[error("the bundle has no {0}")]
    MissingFile(String),
    #[error("{what} is {actual} bytes, over the {limit} byte limit")]
    TooLarge {
        what: &'static str,
        actual: u64,
        limit: u64,
    },
    #[error("the manifest is not valid: {0}")]
    BadManifest(String),
    #[error(
        "manifest schema version {0} is not supported (this app reads version {SUPPORTED_SCHEMA_VERSION})"
    )]
    UnsupportedSchema(u32),
    #[error("the model file name '{0}' must be a plain file name inside the bundle")]
    UnsafePath(String),
    #[error("only ONNX models are accepted, not '{0}'")]
    UnsupportedFormat(String),
    #[error("the ONNX opset {0} is outside the supported range {MIN_OPSET} to {MAX_OPSET}")]
    UnsupportedOpset(u32),
    #[error(
        "the model file hash is {actual} but the manifest says {declared}: the file was changed"
    )]
    HashMismatch { declared: String, actual: String },
    #[error("the bundle is for label '{found}', expected '{expected}'")]
    WrongLabel { expected: LabelId, found: LabelId },
    #[error("feature '{0}' is not a canonical feature this app can compute")]
    UnknownFeature(String),
    #[error("feature '{feature}' needs the {stream:?} stream, which the manifest does not list")]
    SourceNotDeclared {
        feature: String,
        stream: StreamSource,
    },
    #[error("the {0:?} stream has no canonical features yet, so no model can read it")]
    UnreadableSource(StreamSource),
    #[error(
        "unsupported preprocessing '{0}': only 'none' and 'spike_extraction' (with a known method) are supported"
    )]
    UnsupportedPreprocessing(String),
    #[error(
        "the model reads spike features but its manifest does not name a spike extraction method, so the runtime could not make them the way the model was trained"
    )]
    SpikeMethodMissing,
    #[error(
        "the model reads pulse-sensor level features against the recent past but its manifest does not say how far back (preprocessing.baselineMs), so the runtime could not make them the way the model was trained"
    )]
    BaselineMissing,
    #[error("the model contract does not match the manifest: {0}")]
    ContractMismatch(String),
    #[error(
        "the model could not be loaded by the runtime (an unsupported operator is the usual cause): {0}"
    )]
    CannotLoad(String),
    #[error("the model gave a bad answer on a test input: {0}")]
    BadTestOutput(String),
    #[error("{0}")]
    Settings(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFile {
    pub file: String,
    pub sha256: String,
    pub format: String,
    pub opset: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Framework {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputSpec {
    pub name: String,
    /// `[null, features]`: any batch size, then one value per feature.
    pub shape: Vec<Option<u32>>,
    pub dtype: String,
    /// Ordered: position n is input n of the model. For a convolutional model (`grid` present), the channel names.
    pub features: Vec<String>,
    /// Present for a convolutional model: the window is read as a grid of the listed channels over `steps` steps, laid
    /// out as one flat row (`channels x steps` numbers, channel after channel) that the model folds back into rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<GridSpec>,
    /// The values each input usually takes in the windows the model was trained on, when the trainer recorded them: one low
    /// and one high per listed input (per channel for a grid, over all its steps). Lets the app tell when live data is
    /// unlike anything the model trained on. Absent for a model trained before this was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub training_range: Option<TrainingRange>,
}

/// See [`InputSpec::training_range`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrainingRange {
    pub low: Vec<f64>,
    pub high: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridSpec {
    pub steps: u32,
    /// How samples are laid onto the steps; absent in manifests written before the trainer used timestamps.
    #[serde(default)]
    pub timing: GridTimingSpec,
    /// What the pulse channels carry: the counts ("raw", the default) or each channel in units of its recent past
    /// ("recentPast", which needs the manifest's `baselineMs`).
    #[serde(default)]
    pub pulse: GridPulseSpec,
}

/// `input.grid.pulse` in a manifest. See [`pinch_inference::GridPulse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GridPulseSpec {
    #[default]
    Raw,
    RecentPast,
}

impl From<GridPulseSpec> for pinch_inference::GridPulse {
    fn from(spec: GridPulseSpec) -> Self {
        match spec {
            GridPulseSpec::Raw => Self::Raw,
            GridPulseSpec::RecentPast => Self::RecentPast,
        }
    }
}

/// `input.grid.timing` in a manifest: "samples" (the default) or "time". See [`pinch_inference::GridTiming`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GridTimingSpec {
    #[default]
    Samples,
    Time,
}

impl From<GridTimingSpec> for pinch_inference::GridTiming {
    fn from(spec: GridTimingSpec) -> Self {
        match spec {
            GridTimingSpec::Samples => Self::Samples,
            GridTimingSpec::Time => Self::Time,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputSpec {
    pub name: String,
    pub shape: Vec<Option<u32>>,
    pub dtype: String,
    /// Which output value is the probability that the label is present.
    pub positive_index: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowSpec {
    pub duration_ms: u32,
    pub stride_ms: u32,
    pub max_gap_ms: u32,
    pub min_samples: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThresholdSpec {
    pub activation: f64,
    pub release: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preprocessing {
    /// `none`, or `spike_extraction` (the pulse sensor's spike features are made with `method`).
    pub kind: String,
    /// The spike extraction method, when `kind` is `spike_extraction`.
    #[serde(default)]
    pub method: Option<String>,
    /// How far back (in milliseconds) the pulse sensor's level features look for what the window is compared with; absent
    /// when the model reads none of them.
    #[serde(default)]
    pub baseline_ms: Option<u32>,
}

/// The lengths of past a model may be compared with, in milliseconds (the trainer's `BASELINE_CHOICES_MS`).
pub const BASELINE_CHOICES_MS: [u32; 3] = [2000, 4000, 8000];

impl Manifest {
    /// The channels a convolutional model reads, in order; `None` for a model that reads statistics.
    pub fn grid_channels(&self) -> Option<Vec<GridChannel>> {
        self.input.grid.as_ref()?;
        self.input
            .features
            .iter()
            .map(|name| GridChannel::from_name(name))
            .collect()
    }

    /// How far back this model's level-against-the-past features look, or `None` when it reads none.
    pub fn baseline_ms(&self) -> Option<u32> {
        self.preprocessing.baseline_ms
    }

    /// How this model's spike features are extracted, or `None` when it reads none.
    pub fn spike_method(&self) -> Option<SpikeMethod> {
        self.preprocessing
            .method
            .as_deref()
            .and_then(SpikeMethod::from_name)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub model_id: String,
    pub target_label: LabelId,
    pub model: ModelFile,
    pub framework: Framework,
    pub input: InputSpec,
    pub output: OutputSpec,
    pub sources: Vec<StreamSource>,
    pub window: WindowSpec,
    pub quality: QualityRules,
    pub thresholds: ThresholdSpec,
    pub preprocessing: Preprocessing,
    #[serde(default)]
    pub provenance: serde_json::Map<String, serde_json::Value>,
}

impl Manifest {
    /// The input contract this model needs, in the form the rest of Model Lab uses.
    pub fn input_contract(&self) -> InputContract {
        InputContract {
            sources: self.sources.clone(),
            features: self.input.features.clone(),
            window_ms: self.window.duration_ms,
            stride_ms: self.window.stride_ms,
            max_gap_ms: self.window.max_gap_ms,
            min_samples: self.window.min_samples,
        }
    }

    pub fn threshold_config(&self) -> Thresholds {
        Thresholds {
            activation: self.thresholds.activation,
            release: self.thresholds.release,
            ..Thresholds::default()
        }
    }
}

/// The stream a grid channel comes from.
pub fn source_of_channel(channel: GridChannel) -> StreamSource {
    match channel {
        GridChannel::PpgGreen | GridChannel::PpgRed | GridChannel::PpgIr => StreamSource::WatchPpg,
        GridChannel::AccelX | GridChannel::AccelY | GridChannel::AccelZ => {
            StreamSource::WatchAcceleration
        }
        GridChannel::GyroX | GridChannel::GyroY | GridChannel::GyroZ => {
            StreamSource::WatchGyroscope
        }
        _ => StreamSource::WatchOrientation,
    }
}

/// A pulse-sensor spike feature (the ones that depend on a spike extraction method).
fn is_spike_name(feature: &str) -> bool {
    feature.starts_with("ppg_") && (feature.contains("_spike_") || feature.contains("_deriv_"))
}

/// A pulse-sensor level feature against the recent past (the ones that depend on a baseline length).
fn is_baseline_name(feature: &str) -> bool {
    feature.starts_with("ppg_") && feature.contains("_rel_")
}

/// The stream a canonical feature is computed from.
pub fn source_of_feature(feature: &str) -> Option<StreamSource> {
    if !FEATURE_NAMES.contains(&feature) {
        return None;
    }
    Some(match feature.split('_').next()? {
        "accel" => StreamSource::WatchAcceleration,
        "gyro" => StreamSource::WatchGyroscope,
        "quat" => StreamSource::WatchOrientation,
        // The PPG statistics, and the window-level values (contact quality, sample count, duration) that come from them.
        _ => StreamSource::WatchPpg,
    })
}

/// A bundle that passed every check. Holds the verified model, ready to run.
pub struct ValidatedBundle {
    pub manifest: Manifest,
    pub(crate) plan: Arc<TypedRunnableModel<TypedModel>>,
    pub(crate) output_index: usize,
    /// The model's SHA-256, as hashed from the very bytes that were loaded.
    pub model_sha256: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn read_limited(path: &Path, what: &'static str, limit: u64) -> Result<Vec<u8>, BundleError> {
    let meta =
        fs::metadata(path).map_err(|_| BundleError::MissingFile(path.display().to_string()))?;
    if !meta.is_file() {
        return Err(BundleError::MissingFile(path.display().to_string()));
    }
    if meta.len() > limit {
        return Err(BundleError::TooLarge {
            what,
            actual: meta.len(),
            limit,
        });
    }
    fs::read(path)
        .map_err(|e| BundleError::BadManifest(format!("cannot read {}: {e}", path.display())))
}

/// Validates the bundle in `dir`. If `expected_label` is given, the bundle must be for that label.
pub fn validate_bundle(
    dir: &Path,
    expected_label: Option<&LabelId>,
) -> Result<ValidatedBundle, BundleError> {
    let manifest_bytes =
        read_limited(&dir.join(MANIFEST_FILE), "the manifest", MAX_MANIFEST_BYTES)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| BundleError::BadManifest(e.to_string()))?;

    if manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(BundleError::UnsupportedSchema(manifest.schema_version));
    }
    if let Some(expected) = expected_label
        && *expected != manifest.target_label
    {
        return Err(BundleError::WrongLabel {
            expected: expected.clone(),
            found: manifest.target_label.clone(),
        });
    }

    // The model must be a plain file name inside the bundle: no path separators, no '..', no hidden tricks.
    let name = &manifest.model.file;
    if name.is_empty()
        || name.contains(['/', '\\', '\0'])
        || name == "."
        || name == ".."
        || name.starts_with('.')
    {
        return Err(BundleError::UnsafePath(name.clone()));
    }
    if manifest.model.format != "onnx" {
        return Err(BundleError::UnsupportedFormat(
            manifest.model.format.clone(),
        ));
    }
    if !(MIN_OPSET..=MAX_OPSET).contains(&manifest.model.opset) {
        return Err(BundleError::UnsupportedOpset(manifest.model.opset));
    }
    match (
        manifest.preprocessing.kind.as_str(),
        manifest.preprocessing.method.as_deref(),
    ) {
        ("none", None) => {}
        ("spike_extraction", Some(method)) if SpikeMethod::from_name(method).is_some() => {}
        (kind, method) => {
            return Err(BundleError::UnsupportedPreprocessing(match method {
                Some(method) => format!("{kind} ({method})"),
                None => kind.to_string(),
            }));
        }
    }
    if let Some(ms) = manifest.baseline_ms()
        && !BASELINE_CHOICES_MS.contains(&ms)
    {
        return Err(BundleError::UnsupportedPreprocessing(format!(
            "a baseline of {ms} ms: choose from {BASELINE_CHOICES_MS:?}"
        )));
    }
    if manifest.input.grid.is_none()
        && manifest.baseline_ms().is_none()
        && manifest.input.features.iter().any(|f| is_baseline_name(f))
    {
        return Err(BundleError::BaselineMissing);
    }
    // Pulse channels in units of their recent past need that past kept, and a pulse channel to apply to.
    if manifest
        .input
        .grid
        .as_ref()
        .is_some_and(|g| g.pulse == GridPulseSpec::RecentPast)
    {
        if manifest.baseline_ms().is_none() {
            return Err(BundleError::BaselineMissing);
        }
        if !manifest
            .input
            .features
            .iter()
            .any(|f| f.starts_with("ppg_"))
        {
            return Err(BundleError::ContractMismatch(
                "the grid's pulse is measured against its recent past, but it reads no pulse channel".into(),
            ));
        }
    }
    if manifest.input.grid.is_none()
        && manifest.spike_method().is_none()
        && manifest.input.features.iter().any(|f| is_spike_name(f))
    {
        return Err(BundleError::SpikeMethodMissing);
    }
    if let Some(usual) = &manifest.input.training_range {
        let n = manifest.input.features.len();
        let sound = usual.low.len() == n
            && usual.high.len() == n
            && usual
                .low
                .iter()
                .zip(&usual.high)
                .all(|(low, high)| low.is_finite() && high.is_finite() && low <= high);
        if !sound {
            return Err(BundleError::ContractMismatch(format!(
                "the training range must give a finite low and high, low not above high, for each of the {n} inputs"
            )));
        }
    }
    if manifest.input.dtype != "float32" || manifest.output.dtype != "float32" {
        return Err(BundleError::ContractMismatch(
            "inputs and outputs must be float32".into(),
        ));
    }

    // The declared contract has to be a sound one before anything is loaded.
    manifest
        .input_contract()
        .validate()
        .map_err(|e| BundleError::Settings(e.to_string()))?;
    manifest
        .threshold_config()
        .validate()
        .map_err(|e| BundleError::Settings(e.to_string()))?;
    manifest
        .quality
        .validate()
        .map_err(|e| BundleError::Settings(e.to_string()))?;
    let declared: BTreeSet<StreamSource> = manifest.sources.iter().copied().collect();
    for source in &declared {
        if matches!(source, StreamSource::HeadPose) {
            return Err(BundleError::UnreadableSource(*source));
        }
    }
    let width = match &manifest.input.grid {
        None => {
            for feature in &manifest.input.features {
                let source = source_of_feature(feature)
                    .ok_or_else(|| BundleError::UnknownFeature(feature.clone()))?;
                if !declared.contains(&source) {
                    return Err(BundleError::SourceNotDeclared {
                        feature: feature.clone(),
                        stream: source,
                    });
                }
            }
            manifest.input.features.len()
        }
        Some(grid) => {
            if !(MIN_GRID_STEPS..=MAX_GRID_STEPS).contains(&grid.steps) {
                return Err(BundleError::ContractMismatch(format!(
                    "a convolutional model's grid must have from {MIN_GRID_STEPS} to {MAX_GRID_STEPS} steps, got {}",
                    grid.steps
                )));
            }
            for feature in &manifest.input.features {
                let channel = GridChannel::from_name(feature)
                    .ok_or_else(|| BundleError::UnknownFeature(feature.clone()))?;
                let source = source_of_channel(channel);
                if !declared.contains(&source) {
                    return Err(BundleError::SourceNotDeclared {
                        feature: feature.clone(),
                        stream: source,
                    });
                }
            }
            manifest.input.features.len() * grid.steps as usize
        }
    };
    if manifest.input.shape.len() != 2 || manifest.input.shape[1] != Some(width as u32) {
        return Err(BundleError::ContractMismatch(format!(
            "the input shape must be [batch, {width}] to match the {} listed {}",
            manifest.input.features.len(),
            if manifest.input.grid.is_some() {
                "channels over the grid's steps"
            } else {
                "features"
            }
        )));
    }

    // Hash and load the very same bytes, so the file cannot change between the check and the use.
    let model_bytes = read_limited(&dir.join(name), "the model", MAX_MODEL_BYTES)?;
    let actual = sha256_hex(&model_bytes);
    if actual != manifest.model.sha256.to_ascii_lowercase() {
        return Err(BundleError::HashMismatch {
            declared: manifest.model.sha256.clone(),
            actual,
        });
    }

    let mut onnx = tract_onnx::onnx()
        .model_for_read(&mut &model_bytes[..])
        .map_err(|e| BundleError::CannotLoad(e.to_string()))?;
    if onnx
        .input_outlets()
        .map_err(|e| BundleError::CannotLoad(e.to_string()))?
        .len()
        != 1
    {
        return Err(BundleError::ContractMismatch(
            "the model must have exactly one input".into(),
        ));
    }
    // tract names a node after the operation that makes it; the ONNX graph's own tensor names are the outlet labels.
    let input_outlet = onnx
        .input_outlets()
        .map_err(|e| BundleError::CannotLoad(e.to_string()))?[0];
    // An input is a source node named after the tensor.
    let input_name = onnx.node(input_outlet.node).name.clone();
    if input_name != manifest.input.name {
        return Err(BundleError::ContractMismatch(format!(
            "the model's input is named '{input_name}', the manifest says '{}'",
            manifest.input.name
        )));
    }
    let output_names: Vec<String> = onnx
        .output_outlets()
        .map_err(|e| BundleError::CannotLoad(e.to_string()))?
        .iter()
        .map(|outlet| {
            onnx.outlet_label(*outlet)
                .map(str::to_string)
                .unwrap_or_default()
        })
        .collect();
    let output_index = output_names
        .iter()
        .position(|n| *n == manifest.output.name)
        .ok_or_else(|| {
            BundleError::ContractMismatch(format!(
                "the model has no output named '{}' (it has {output_names:?})",
                manifest.output.name
            ))
        })?;
    onnx.set_input_fact(0, f32::fact([1, width]).into())
        .map_err(|e| BundleError::CannotLoad(e.to_string()))?;
    let plan = onnx
        .into_optimized()
        .and_then(|m| m.into_runnable())
        .map_err(|e| BundleError::CannotLoad(e.to_string()))?;

    let bundle = ValidatedBundle {
        manifest,
        plan: Arc::new(plan),
        output_index,
        model_sha256: actual,
    };
    bundle.check_test_inference(width)?;
    Ok(bundle)
}

impl ValidatedBundle {
    /// Runs the model on a few bounded inputs. It must give finite probabilities, with the positive index in range.
    fn check_test_inference(&self, width: usize) -> Result<(), BundleError> {
        let probes: [f32; 3] = [0.0, 1.0, -1.0];
        for probe in probes {
            let input = tract_ndarray::Array2::from_elem((1, width), probe);
            let outputs = self
                .plan
                .run(tvec!(input.into_tensor().into()))
                .map_err(|e| BundleError::BadTestOutput(e.to_string()))?;
            let tensor = outputs
                .get(self.output_index)
                .ok_or_else(|| BundleError::BadTestOutput("the output is missing".into()))?;
            let values = tensor.to_array_view::<f32>().map_err(|e| {
                BundleError::BadTestOutput(format!("the output is not float32: {e}"))
            })?;
            let flat: Vec<f32> = values.iter().copied().collect();
            if self.manifest.output.positive_index >= flat.len() {
                return Err(BundleError::ContractMismatch(format!(
                    "positiveIndex {} is outside the model's {} output values",
                    self.manifest.output.positive_index,
                    flat.len()
                )));
            }
            if flat
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
            {
                return Err(BundleError::BadTestOutput(format!(
                    "the output {flat:?} is not made of probabilities in [0, 1]"
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    pub fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/shake_bundle")
    }

    /// A copy of the fixture in a temp dir that the test can then damage.
    pub fn copy_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for file in ["manifest.json", "model.onnx"] {
            fs::copy(fixture_dir().join(file), dir.path().join(file)).unwrap();
        }
        dir
    }

    fn edit_manifest(dir: &Path, change: impl FnOnce(&mut serde_json::Value)) {
        let path = dir.join(MANIFEST_FILE);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        change(&mut value);
        fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }

    #[test]
    fn the_real_exporter_bundle_validates_and_matches_its_framework() {
        let bundle = validate_bundle(
            &fixture_dir(),
            Some(&LabelId::new("shake_fixture").unwrap()),
        )
        .unwrap();
        assert_eq!(bundle.manifest.target_label.as_str(), "shake_fixture");
        assert_eq!(bundle.model_sha256, bundle.manifest.model.sha256);
        // It reproduces what scikit-learn predicted for the same inputs.
        let expected: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture_dir().join("expected.json")).unwrap())
                .unwrap();
        for (input, want) in expected["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .zip(expected["positive_probability"].as_array().unwrap())
        {
            let features: Vec<f32> = input
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap() as f32)
                .collect();
            let tensor =
                tract_ndarray::Array2::from_shape_vec((1, features.len()), features).unwrap();
            let out = bundle.plan.run(tvec!(tensor.into_tensor().into())).unwrap();
            let got = out[bundle.output_index].to_array_view::<f32>().unwrap()[[0, 1]];
            assert!(
                (got as f64 - want.as_f64().unwrap()).abs() < 1e-5,
                "{got} vs {want}"
            );
        }
    }

    #[test]
    fn a_missing_or_oversized_or_malformed_manifest_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::MissingFile(_))
        ));
        fs::write(dir.path().join(MANIFEST_FILE), "{ nope").unwrap();
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::BadManifest(_))
        ));
        fs::write(
            dir.path().join(MANIFEST_FILE),
            vec![b' '; (MAX_MANIFEST_BYTES + 1) as usize],
        )
        .unwrap();
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::TooLarge { .. })
        ));
    }

    #[test]
    fn an_unknown_schema_an_unknown_field_and_a_wrong_label_are_refused() {
        let dir = copy_fixture();
        edit_manifest(dir.path(), |m| m["schemaVersion"] = 2.into());
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::UnsupportedSchema(2))
        ));
        let dir = copy_fixture();
        edit_manifest(dir.path(), |m| m["surprise"] = 1.into());
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::BadManifest(_))
        ));
        let dir = copy_fixture();
        let other = LabelId::new("swipe_left").unwrap();
        assert!(matches!(
            validate_bundle(dir.path(), Some(&other)),
            Err(BundleError::WrongLabel { .. })
        ));
    }

    #[test]
    fn path_traversal_and_executable_formats_are_refused() {
        for bad in [
            "../model.onnx",
            "sub/model.onnx",
            "/etc/passwd",
            "..",
            ".hidden",
            "a\\b.onnx",
            "",
        ] {
            let dir = copy_fixture();
            edit_manifest(dir.path(), |m| m["model"]["file"] = bad.into());
            assert!(
                matches!(
                    validate_bundle(dir.path(), None),
                    Err(BundleError::UnsafePath(_))
                ),
                "{bad}"
            );
        }
        for format in ["pickle", "joblib", "pt", "savedmodel", "tflite"] {
            let dir = copy_fixture();
            edit_manifest(dir.path(), |m| m["model"]["format"] = format.into());
            assert!(
                matches!(
                    validate_bundle(dir.path(), None),
                    Err(BundleError::UnsupportedFormat(_))
                ),
                "{format}"
            );
        }
        let dir = copy_fixture();
        edit_manifest(dir.path(), |m| m["model"]["opset"] = 3.into());
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::UnsupportedOpset(3))
        ));
        let dir = copy_fixture();
        edit_manifest(dir.path(), |m| {
            m["preprocessing"]["kind"] = "standardize".into()
        });
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::UnsupportedPreprocessing(_))
        ));
    }

    #[test]
    fn spike_features_need_a_named_spike_extraction_method_the_runtime_knows() {
        let reads_a_spike_feature = |m: &mut serde_json::Value| {
            m["sources"] = serde_json::json!(["watchAcceleration", "watchGyroscope", "watchPpg"]);
            let last = m["input"]["features"].as_array().unwrap().len() - 1;
            m["input"]["features"][last] = "ppg_green_spike_height".into();
        };
        // Reading a spike feature while declaring no preprocessing: the runtime could not make it the way it was trained.
        let dir = copy_fixture();
        edit_manifest(dir.path(), reads_a_spike_feature);
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::SpikeMethodMissing)
        ));
        // With a known method it is accepted, and the model knows which.
        for method in SpikeMethod::ALL {
            let dir = copy_fixture();
            edit_manifest(dir.path(), |m| {
                reads_a_spike_feature(m);
                m["preprocessing"] =
                    serde_json::json!({"kind": "spike_extraction", "method": method.name()});
            });
            let bundle = validate_bundle(dir.path(), None)
                .unwrap_or_else(|e| panic!("{}: {e}", method.name()));
            assert_eq!(bundle.manifest.spike_method(), Some(method));
        }
        // An unknown method, a method with no kind, and a kind with no method are all refused.
        for preprocessing in [
            serde_json::json!({"kind": "spike_extraction", "method": "soup"}),
            serde_json::json!({"kind": "none", "method": "first_derivative"}),
            serde_json::json!({"kind": "spike_extraction"}),
        ] {
            let dir = copy_fixture();
            edit_manifest(dir.path(), |m| m["preprocessing"] = preprocessing.clone());
            assert!(
                matches!(
                    validate_bundle(dir.path(), None),
                    Err(BundleError::UnsupportedPreprocessing(_))
                ),
                "{preprocessing}"
            );
        }
    }

    #[test]
    fn a_training_range_must_give_a_sound_low_and_high_for_every_input() {
        let n = {
            let dir = copy_fixture();
            validate_bundle(dir.path(), None)
                .unwrap()
                .manifest
                .input
                .features
                .len()
        };
        let dir = copy_fixture();
        edit_manifest(dir.path(), |m| {
            m["input"]["trainingRange"] =
                serde_json::json!({"low": vec![0.0; n], "high": vec![1.0; n]});
        });
        assert!(
            validate_bundle(dir.path(), None)
                .unwrap()
                .manifest
                .input
                .training_range
                .is_some()
        );
        for range in [
            serde_json::json!({"low": vec![0.0; n - 1], "high": vec![1.0; n - 1]}),
            serde_json::json!({"low": vec![2.0; n], "high": vec![1.0; n]}),
            serde_json::json!({"low": vec![0.0; n], "high": vec![1.0; n], "extra": 1}),
        ] {
            let dir = copy_fixture();
            edit_manifest(dir.path(), |m| m["input"]["trainingRange"] = range.clone());
            assert!(validate_bundle(dir.path(), None).is_err(), "{range}");
        }
    }

    #[test]
    fn level_features_against_the_past_need_a_known_baseline_length() {
        let reads_a_level_feature = |m: &mut serde_json::Value| {
            m["sources"] = serde_json::json!(["watchAcceleration", "watchGyroscope", "watchPpg"]);
            let last = m["input"]["features"].as_array().unwrap().len() - 1;
            m["input"]["features"][last] = "ppg_red_rel_low".into();
        };
        // Reading one while saying nothing about how far back to look: the runtime could not make it as it was trained.
        let dir = copy_fixture();
        edit_manifest(dir.path(), reads_a_level_feature);
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::BaselineMissing)
        ));
        for ms in BASELINE_CHOICES_MS {
            let dir = copy_fixture();
            edit_manifest(dir.path(), |m| {
                reads_a_level_feature(m);
                m["preprocessing"] = serde_json::json!({"kind": "none", "baselineMs": ms});
            });
            let bundle = validate_bundle(dir.path(), None).unwrap_or_else(|e| panic!("{ms}: {e}"));
            assert_eq!(bundle.manifest.baseline_ms(), Some(ms));
        }
        // A length the app does not offer is refused, even if no feature reads it.
        let dir = copy_fixture();
        edit_manifest(dir.path(), |m| {
            m["preprocessing"] = serde_json::json!({"kind": "none", "baselineMs": 3000});
        });
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::UnsupportedPreprocessing(_))
        ));
    }

    #[test]
    fn a_convolutional_manifest_is_checked_against_its_grid() {
        let cnn = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/trained_cnn_bundle");
        let copy = || {
            let dir = tempfile::tempdir().unwrap();
            for file in ["manifest.json", "model.onnx"] {
                fs::copy(cnn.join(file), dir.path().join(file)).unwrap();
            }
            dir
        };
        let samples = validate_bundle(copy().path(), None).unwrap();
        assert_eq!(
            samples.manifest.input.grid.as_ref().unwrap().timing,
            GridTimingSpec::Samples,
            "a manifest from before timing was written keeps the old layout"
        );
        let dir = copy();
        edit_manifest(dir.path(), |m| m["input"]["grid"]["timing"] = "time".into());
        let timed = validate_bundle(dir.path(), None).unwrap();
        assert_eq!(
            timed.manifest.input.grid.as_ref().unwrap().timing,
            GridTimingSpec::Time
        );
        let dir = copy();
        edit_manifest(dir.path(), |m| {
            m["input"]["grid"]["timing"] = "sideways".into()
        });
        assert!(validate_bundle(dir.path(), None).is_err());
        // The pulse in units of its recent past needs that past, and a pulse channel to apply to.
        let dir = copy();
        edit_manifest(dir.path(), |m| {
            m["input"]["grid"]["pulse"] = "recentPast".into()
        });
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::BaselineMissing)
        ));
        let dir = copy();
        edit_manifest(dir.path(), |m| {
            m["input"]["grid"]["pulse"] = "recentPast".into();
            m["preprocessing"]["baselineMs"] = 4000.into();
        });
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::ContractMismatch(_))
        ));
        // Steps outside the allowed range, and an input shape that is not channels x steps.
        let dir = copy();
        edit_manifest(dir.path(), |m| m["input"]["grid"]["steps"] = 0.into());
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::ContractMismatch(_))
        ));
        let dir = copy();
        edit_manifest(dir.path(), |m| {
            m["input"]["shape"] = serde_json::json!([null, 6])
        });
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::ContractMismatch(_))
        ));
        // A channel that does not exist, and a channel whose stream is not declared.
        let dir = copy();
        edit_manifest(dir.path(), |m| m["input"]["features"][0] = "accel_w".into());
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::UnknownFeature(_))
        ));
        let dir = copy();
        edit_manifest(dir.path(), |m| {
            m["input"]["features"][0] = "ppg_green".into()
        });
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::SourceNotDeclared { .. })
        ));
        // A statistics model cannot claim a grid it does not read.
        let dir = copy_fixture();
        edit_manifest(dir.path(), |m| {
            m["input"]["grid"] = serde_json::json!({"steps": 16})
        });
        assert!(validate_bundle(dir.path(), None).is_err());
    }

    #[test]
    fn a_changed_or_oversized_model_file_is_refused() {
        let dir = copy_fixture();
        let mut bytes = fs::read(dir.path().join("model.onnx")).unwrap();
        bytes[10] ^= 0xff;
        fs::write(dir.path().join("model.onnx"), &bytes).unwrap();
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::HashMismatch { .. })
        ));

        let dir = copy_fixture();
        fs::write(
            dir.path().join("model.onnx"),
            vec![0u8; (MAX_MODEL_BYTES + 1) as usize],
        )
        .unwrap();
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::TooLarge { .. })
        ));

        // A model file that hashes correctly but is not an ONNX model cannot be loaded.
        let dir = copy_fixture();
        let junk = b"this is not a model".to_vec();
        fs::write(dir.path().join("model.onnx"), &junk).unwrap();
        edit_manifest(dir.path(), |m| {
            m["model"]["sha256"] = sha256_hex(&junk).into()
        });
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::CannotLoad(_))
        ));
    }

    #[test]
    fn the_feature_and_tensor_contracts_are_checked_against_the_model() {
        type Change = Box<dyn Fn(&mut serde_json::Value)>;
        let cases: Vec<(&str, Change)> = vec![
            (
                "an unknown feature",
                Box::new(|m| m["input"]["features"][0] = "not_a_feature".into()),
            ),
            (
                "a feature from a stream that is not declared",
                Box::new(|m| m["input"]["features"][0] = "ppg_green_mean".into()),
            ),
            (
                "a wrong feature count",
                Box::new(|m| {
                    m["input"]["features"].as_array_mut().unwrap().pop();
                }),
            ),
            (
                "a wrong input name",
                Box::new(|m| m["input"]["name"] = "images".into()),
            ),
            (
                "a wrong output name",
                Box::new(|m| m["output"]["name"] = "scores".into()),
            ),
            (
                "a positive index past the output",
                Box::new(|m| m["output"]["positiveIndex"] = 5.into()),
            ),
            (
                "a duplicate feature",
                Box::new(|m| m["input"]["features"][1] = "accel_x_std".into()),
            ),
            (
                "a window shorter than its stride",
                Box::new(|m| m["window"]["durationMs"] = 100.into()),
            ),
            (
                "thresholds the wrong way round",
                Box::new(|m| {
                    m["thresholds"]["activation"] = 0.4.into();
                    m["thresholds"]["release"] = 0.9.into();
                }),
            ),
            (
                "a head-pose source",
                Box::new(|m| m["sources"] = serde_json::json!(["watchAcceleration", "headPose"])),
            ),
            (
                "a non-float input",
                Box::new(|m| m["input"]["dtype"] = "int64".into()),
            ),
        ];
        for (what, change) in cases {
            let dir = copy_fixture();
            edit_manifest(dir.path(), |m| change(m));
            assert!(
                validate_bundle(dir.path(), None).is_err(),
                "{what} must be refused"
            );
        }
    }

    #[test]
    fn features_map_to_the_streams_they_need() {
        assert_eq!(
            source_of_feature("accel_x_std"),
            Some(StreamSource::WatchAcceleration)
        );
        assert_eq!(
            source_of_feature("gyro_magnitude_mean"),
            Some(StreamSource::WatchGyroscope)
        );
        assert_eq!(
            source_of_feature("quat_delta_angle_deg"),
            Some(StreamSource::WatchOrientation)
        );
        assert_eq!(
            source_of_feature("ppg_ir_slope"),
            Some(StreamSource::WatchPpg)
        );
        assert_eq!(
            source_of_feature("contact_quality_mean"),
            Some(StreamSource::WatchPpg)
        );
        assert_eq!(source_of_feature("nonsense"), None);
    }
}
