//! The model bundle: a directory with `manifest.json` and one tree-ensemble model file.
//!
//! ```text
//! model-bundle/
//! |-- manifest.json
//! `-- model.trees
//! ```
//!
//! A bundle is data, never code: the model is a plain list of trees (see [`crate::trees`]), not a pickle, joblib, torch or
//! other serialisation that could run arbitrary code. The models this app runs are the pinch-start models of
//! [`crate::inputs::ModelKind`]: the PPG + IMU model Model Lab trains, and the earlier PPG-only one. Validation reads the
//! manifest, checks it declares exactly its kind's contract, hashes the model file, parses every tree, and runs the model
//! on a few bounded inputs to prove it produces probabilities. Only a bundle that passes all of it can be loaded.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use model_lab_core::{InputContract, LabelId, QualityRules, StreamSource, Thresholds, Trigger};
use pinch_inference::ppg_onset::{GRID_TICKS, MAX_GAP_MS, TICK_NS};

use crate::inputs::{ModelKind, PPG_IMU_PREPROCESSING, PPG_ONLY_PREPROCESSING};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::trees::{TreeEnsemble, TreesError};

pub const MANIFEST_FILE: &str = "manifest.json";
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
pub(crate) const MAX_MODEL_BYTES: u64 = 64 * 1024 * 1024;
/// The only model format this app runs.
pub const MODEL_FORMAT: &str = "trees";
/// The pulse history a decision reads (its grid of ticks), and how often a model decides.
pub const WINDOW_MS: u32 = (GRID_TICKS as u64 * TICK_NS / 1_000_000) as u32;
pub const STRIDE_MS: u32 = (TICK_NS / 1_000_000) as u32;

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
    #[error(
        "only the PPG pinch-start model (a '{MODEL_FORMAT}' file) can run in this app, not a '{0}' model: train a new one in Model Lab"
    )]
    UnsupportedFormat(String),
    #[error(
        "unsupported preprocessing '{0}': this app's models read '{PPG_IMU_PREPROCESSING}' (the pulse and motion) or '{PPG_ONLY_PREPROCESSING}' (the pulse alone)"
    )]
    UnsupportedPreprocessing(String),
    #[error(
        "the model file hash is {actual} but the manifest says {declared}: the file was changed"
    )]
    HashMismatch { declared: String, actual: String },
    #[error("the bundle is for label '{found}', expected '{expected}'")]
    WrongLabel { expected: LabelId, found: LabelId },
    #[error("the model contract does not match the manifest: {0}")]
    ContractMismatch(String),
    #[error(transparent)]
    Trees(#[from] TreesError),
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
    /// Unused by tree models (0); kept so the manifest's shape does not change.
    #[serde(default)]
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
    /// Ordered: position n is input n of the model. Always its kind's [`ModelKind::feature_names`].
    pub features: Vec<String>,
    /// The values each input usually takes in the decisions the model was trained on: one low and one high per input. Lets
    /// the app tell when live data is unlike anything the model trained on.
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
pub struct OutputSpec {
    pub name: String,
    pub shape: Vec<Option<u32>>,
    pub dtype: String,
    /// Which output column is the positive class.
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
    /// After a detection ends, the next one waits this long.
    #[serde(default)]
    pub cooldown_ms: u32,
    /// Which score starts a detection; bundles from before triggers existed start on the edge.
    #[serde(default)]
    pub trigger: Trigger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preprocessing {
    /// One of [`ModelKind::preprocessing`].
    pub kind: String,
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
            cooldown_ms: self.thresholds.cooldown_ms,
            trigger: self.thresholds.trigger,
            ..Thresholds::default()
        }
    }
}

/// A bundle that passed every check. Holds the verified model, ready to run.
pub struct ValidatedBundle {
    pub manifest: Manifest,
    /// Which pinch-start model it is, from its preprocessing.
    pub kind: ModelKind,
    pub(crate) trees: Arc<TreeEnsemble>,
    /// The model's SHA-256, as hashed from the very bytes that were parsed.
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

/// The model file name must be a plain file name inside the bundle: no path separators, no '..', no hidden tricks.
pub(crate) fn safe_model_name(name: &str) -> bool {
    !(name.is_empty()
        || name.contains(['/', '\\', '\0'])
        || name == "."
        || name == ".."
        || name.starts_with('.'))
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
    let name = &manifest.model.file;
    if !safe_model_name(name) {
        return Err(BundleError::UnsafePath(name.clone()));
    }
    if manifest.model.format != MODEL_FORMAT {
        return Err(BundleError::UnsupportedFormat(manifest.model.format.clone()));
    }
    let Some(kind) = ModelKind::from_preprocessing(&manifest.preprocessing.kind) else {
        return Err(BundleError::UnsupportedPreprocessing(
            manifest.preprocessing.kind.clone(),
        ));
    };
    let mismatch = |what: String| Err(BundleError::ContractMismatch(what));
    if manifest.sources != kind.sources() {
        return mismatch(format!(
            "a '{}' model must read {:?}, not {:?}",
            kind.preprocessing(),
            kind.sources(),
            manifest.sources
        ));
    }
    let feature_count = kind.feature_count();
    if manifest.input.features != kind.feature_names() {
        return mismatch(format!(
            "the model must read the {feature_count} features of a '{}' model in this app's order",
            kind.preprocessing()
        ));
    }
    if manifest.input.shape != [None, Some(feature_count as u32)] {
        return mismatch(format!("the input shape must be [batch, {feature_count}]"));
    }
    if manifest.input.dtype != "float32" || manifest.output.dtype != "float32" {
        return mismatch("inputs and outputs must be float32".into());
    }
    if manifest.output.positive_index != 1 {
        return mismatch("the positive class must be output 1".into());
    }
    if manifest.window.duration_ms != WINDOW_MS
        || manifest.window.stride_ms != STRIDE_MS
        || u64::from(manifest.window.max_gap_ms) != MAX_GAP_MS
    {
        return mismatch(format!(
            "the window must be {WINDOW_MS} ms long, every {STRIDE_MS} ms, with gaps of at most {MAX_GAP_MS} ms"
        ));
    }
    if let Some(usual) = &manifest.input.training_range {
        let sound = usual.low.len() == feature_count
            && usual.high.len() == feature_count
            && usual
                .low
                .iter()
                .zip(&usual.high)
                .all(|(low, high)| low.is_finite() && high.is_finite() && low <= high);
        if !sound {
            return mismatch(format!(
                "the training range must give a finite low and high, low not above high, for each of the {feature_count} inputs"
            ));
        }
    }
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

    // Hash and parse the very same bytes, so the file cannot change between the check and the use.
    let model_bytes = read_limited(&dir.join(name), "the model", MAX_MODEL_BYTES)?;
    let actual = sha256_hex(&model_bytes);
    if actual != manifest.model.sha256.to_ascii_lowercase() {
        return Err(BundleError::HashMismatch {
            declared: manifest.model.sha256.clone(),
            actual,
        });
    }
    let trees = TreeEnsemble::parse(&model_bytes)?;
    if trees.features() != feature_count {
        return mismatch(format!(
            "the model file reads {} features, the manifest lists {feature_count}",
            trees.features()
        ));
    }
    // A model that answers anything but a probability on ordinary inputs cannot be trusted on live ones.
    for value in [0.0, 1.0, -1.0, 1e6] {
        let p = trees.predict(&vec![value; feature_count]);
        if !(0.0..=1.0).contains(&p) {
            return Err(BundleError::BadTestOutput(format!(
                "{p} for every input at {value}"
            )));
        }
    }
    Ok(ValidatedBundle {
        manifest,
        kind,
        trees: Arc::new(trees),
        model_sha256: actual,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The bundle the trainer made for the runtime's tests (see `tools/label-trainer/tests/make_runtime_bundle.py`).
    pub fn fixture_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ppg_onset_bundle")
    }

    /// The PPG + IMU bundle the trainer made for the runtime's tests.
    pub fn motion_fixture_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ppg_imu_onset_bundle")
    }

    #[test]
    fn the_trainers_motion_bundle_is_valid_and_peaks() {
        let bundle = validate_bundle(&motion_fixture_dir(), None).unwrap();
        assert_eq!(bundle.kind, ModelKind::PpgImu);
        assert_eq!(
            bundle.manifest.sources,
            [StreamSource::WatchPpg, StreamSource::WatchOrientation]
        );
        assert_eq!(bundle.manifest.input.features.len(), 2733);
        assert_eq!(bundle.manifest.threshold_config().trigger, Trigger::Peak);
        assert_eq!(
            bundle.manifest.input_contract(),
            ModelKind::PpgImu.contract()
        );
    }

    #[test]
    fn a_bundle_from_before_triggers_starts_on_the_edge() {
        let bundle = validate_bundle(&fixture_dir(), None).unwrap();
        assert_eq!(bundle.manifest.threshold_config().trigger, Trigger::Edge);
    }

    /// A copy of the fixture, unchanged.
    pub fn copy_fixture() -> tempfile::TempDir {
        edited(|_| {})
    }

    /// A copy of the fixture, with its manifest changed by `edit`.
    pub fn edited(edit: impl FnOnce(&mut serde_json::Value)) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for file in ["manifest.json", "model.trees"] {
            fs::copy(fixture_dir().join(file), dir.path().join(file)).unwrap();
        }
        let path = dir.path().join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        edit(&mut manifest);
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        dir
    }

    fn refused(edit: impl FnOnce(&mut serde_json::Value)) -> String {
        let dir = edited(edit);
        match validate_bundle(dir.path(), None) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("the edited bundle was accepted"),
        }
    }

    #[test]
    fn the_trainers_bundle_is_valid_and_reads_the_ppg_features() {
        let bundle = validate_bundle(&fixture_dir(), None).unwrap();
        assert_eq!(bundle.kind, ModelKind::PpgOnly);
        assert_eq!(
            bundle.manifest.input.features.len(),
            pinch_inference::ppg_onset::FEATURE_COUNT
        );
        assert_eq!(bundle.manifest.sources, [StreamSource::WatchPpg]);
        assert_eq!(bundle.manifest.input_contract().window_ms, WINDOW_MS);
        assert_eq!(bundle.manifest.threshold_config().cooldown_ms, 1500);
        assert_eq!(bundle.model_sha256.len(), 64);
    }

    #[test]
    fn an_old_kind_of_model_is_refused_with_what_to_do() {
        let onnx = refused(|m| m["model"]["format"] = "onnx".into());
        assert!(onnx.contains("train a new one in Model Lab"), "{onnx}");
        assert!(
            refused(|m| m["preprocessing"] = serde_json::json!({"kind": "spike_extraction", "method": "first_derivative"}))
                .contains("not valid")
        );
        assert!(refused(|m| m["preprocessing"]["kind"] = "none".into()).contains("unsupported preprocessing"));
    }

    #[test]
    fn a_bundle_that_does_not_read_exactly_the_ppg_features_is_refused() {
        assert!(refused(|m| m["sources"] = serde_json::json!(["watchPpg", "watchAcceleration"])).contains("must read [WatchPpg]"));
        // A PPG-only model's features under the PPG + IMU kind's name are not that model.
        assert!(refused(|m| m["preprocessing"]["kind"] = "ppg_imu_onset".into()).contains("must read [WatchPpg, WatchOrientation]"));
        assert!(refused(|m| {
            m["input"]["features"].as_array_mut().unwrap().swap(0, 1);
        })
        .contains("in this app's order"));
        assert!(refused(|m| m["window"]["durationMs"] = 500.into()).contains("5640 ms"));
        assert!(refused(|m| m["input"]["trainingRange"]["low"][0] = 1e30.into()).contains("training range"));
    }

    #[test]
    fn a_changed_model_file_or_an_unsafe_name_is_refused() {
        let dir = edited(|_| {});
        let path = dir.path().join("model.trees");
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            validate_bundle(dir.path(), None),
            Err(BundleError::HashMismatch { .. })
        ));
        assert!(refused(|m| m["model"]["file"] = "../model.trees".into()).contains("plain file name"));
    }

    #[test]
    fn the_label_must_be_the_one_expected() {
        let other = LabelId::new("fist").unwrap();
        assert!(matches!(
            validate_bundle(&fixture_dir(), Some(&other)),
            Err(BundleError::WrongLabel { .. })
        ));
    }
}
