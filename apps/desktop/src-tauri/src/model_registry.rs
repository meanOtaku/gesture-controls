//! Persisted desktop-owned pinch model lifecycle: Draft/Evaluated/Approved/
//! Active/Archived state per trained model, per-model inference thresholds
//! and sensor-quality gate, single-active-model selection with rollback, and
//! the global inference mode (Off/Monitor/Live). This is the registry that
//! [`crate::inference`] reads to decide which model (if any) to run and how
//! to gate/act on its output — see `apps/desktop/ARCHITECTURE.md` and the
//! project's non-negotiable rule that all pinch inference/lifecycle logic
//! lives on the desktop, never on the watch or headphones.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::inference::{GesturePolicyRuntime, PinchInferenceRuntime};
use crate::model_lab::{self, MODEL_LAB_DIR_NAME};
use interaction_engine::{ForceReleaseReason, GestureIntent};
#[cfg(test)]
use pinch_inference::FEATURE_COUNT;
use pinch_inference::{CLASS_COUNT, FEATURE_NAMES};

/// Filename of the validated TFLite bundle's metadata (see `bundle.py`'s
/// `METADATA_FILENAME`). Only a model directory containing this file (plus
/// `model.tflite`) satisfies the contract `DesktopPinchRuntime` requires, so
/// it is the only artifact shape [`activate_model`] will accept.
pub(crate) const TFLITE_METADATA_FILE_NAME: &str = "metadata.json";
const TFLITE_MODEL_FILE_NAME: &str = "model.tflite";
const REGISTRY_FILE_NAME: &str = "registry.json";

pub const MODEL_REGISTRY_EVENT: &str = "model-registry-updated";

pub const MIN_THRESHOLD: f64 = 0.0;
pub const MAX_THRESHOLD: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelLifecycleState {
    Draft,
    Evaluated,
    Approved,
    Active,
    Archived,
}

/// `true` iff a model may move directly from `from` to `to` via
/// [`transition_model_state`]. Activation/rollback are their own dedicated
/// operations ([`activate_model`]/[`rollback_active_model`]) rather than
/// generic transitions, since they also have to move the *other* model
/// that's currently Active.
fn legal_transition(from: ModelLifecycleState, to: ModelLifecycleState) -> bool {
    use ModelLifecycleState::*;
    matches!(
        (from, to),
        (Draft, Evaluated)
            | (Evaluated, Approved)
            | (Evaluated, Archived)
            | (Approved, Archived)
            | (Approved, Evaluated)
            | (Archived, Draft)
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelThresholds {
    pub start_threshold: f64,
    pub release_threshold: f64,
}

impl Default for ModelThresholds {
    fn default() -> Self {
        // Mirrors `DesktopPinchRuntime`'s own constructor defaults in
        // desktop_runtime.py, which also requires `(0, 1]`.
        Self {
            start_threshold: 0.80,
            release_threshold: 0.80,
        }
    }
}

impl ModelThresholds {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("startThreshold", self.start_threshold),
            ("releaseThreshold", self.release_threshold),
        ] {
            if !(value.is_finite() && value > MIN_THRESHOLD && value <= MAX_THRESHOLD) {
                return Err(format!("{name} must be in (0, 1], got {value}"));
            }
        }
        Ok(())
    }
}

/// Gates a fused feature window before it ever reaches the model. Samsung's
/// PPG status convention is 0 = valid, non-zero = degraded/invalid (see
/// `WatchPpgBatchPayload` in `spatial_protocol`), so `contact_quality` here
/// is a *defect* code: lower is better, and a window's mean must not exceed
/// `max_contact_quality`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityGateConfig {
    pub max_contact_quality: f64,
    pub min_sample_count: u32,
}

impl Default for QualityGateConfig {
    fn default() -> Self {
        Self {
            // Fail-closed by default: only Samsung's "valid" status code passes.
            max_contact_quality: 0.0,
            // Matches windowing.py's DEFAULT_MIN_SAMPLES_PER_WINDOW.
            min_sample_count: 3,
        }
    }
}

impl QualityGateConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !self.max_contact_quality.is_finite() {
            return Err("maxContactQuality must be finite".to_string());
        }
        if self.min_sample_count == 0 {
            return Err("minSampleCount must be at least 1".to_string());
        }
        Ok(())
    }
}

/// Why a fused window was rejected before inference ran.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum QualityGateRejection {
    LowSampleCount { actual: u32, required: u32 },
    DegradedContactQuality { actual: f64, max_allowed: f64 },
}

/// Pure sensor-quality gate: evaluated once per fused window, before the
/// window is ever submitted to a model. Kept pure/standalone so it is
/// trivially unit-testable and has no dependency on a running inference
/// pipeline.
pub fn evaluate_quality_gate(
    config: &QualityGateConfig,
    contact_quality_mean: f64,
    sample_count: u32,
) -> Result<(), QualityGateRejection> {
    if sample_count < config.min_sample_count {
        return Err(QualityGateRejection::LowSampleCount {
            actual: sample_count,
            required: config.min_sample_count,
        });
    }
    if contact_quality_mean > config.max_contact_quality {
        return Err(QualityGateRejection::DegradedContactQuality {
            actual: contact_quality_mean,
            max_allowed: config.max_contact_quality,
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateTransitionRecord {
    pub from: Option<ModelLifecycleState>,
    pub to: ModelLifecycleState,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRecord {
    pub id: String,
    pub state: ModelLifecycleState,
    pub thresholds: ModelThresholds,
    pub quality_gate: QualityGateConfig,
    pub created_at: String,
    pub history: Vec<StateTransitionRecord>,
    /// Bindings belong to this immutable trained-model id, never to a label
    /// globally. A later model must opt in again, preventing a changed class
    /// meaning from silently inheriting a desktop action.
    #[serde(default)]
    pub intent_bindings: Vec<ModelIntentBinding>,
    /// Set only after this app has copied and revalidated an externally
    /// supplied TFLite bundle. Existing trained records retain their
    /// backend-derived deployability behavior.
    #[serde(default)]
    pub imported_tflite_bundle: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIntentBinding {
    pub class_label: String,
    pub intent: GestureIntent,
}

impl ModelRecord {
    fn new(id: String) -> Self {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        Self {
            id,
            state: ModelLifecycleState::Draft,
            thresholds: ModelThresholds::default(),
            quality_gate: QualityGateConfig::default(),
            created_at: now.clone(),
            history: vec![StateTransitionRecord {
                from: None,
                to: ModelLifecycleState::Draft,
                at: now,
            }],
            intent_bindings: Vec::new(),
            imported_tflite_bundle: false,
        }
    }

    fn push_transition(&mut self, to: ModelLifecycleState) {
        self.history.push(StateTransitionRecord {
            from: Some(self.state),
            to,
            at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        });
        self.state = to;
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InferenceMode {
    // A fresh install never drives desktop actions until the user opts in.
    #[default]
    Off,
    Monitor,
    Live,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryIndex {
    models: Vec<ModelRecord>,
    active_model_id: Option<String>,
    previous_active_model_id: Option<String>,
    inference_mode: InferenceMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryView {
    pub models: Vec<ModelRecord>,
    pub active_model_id: Option<String>,
    pub previous_active_model_id: Option<String>,
    pub inference_mode: InferenceMode,
}

impl From<RegistryIndex> for RegistryView {
    fn from(index: RegistryIndex) -> Self {
        Self {
            models: index.models,
            active_model_id: index.active_model_id,
            previous_active_model_id: index.previous_active_model_id,
            inference_mode: index.inference_mode,
        }
    }
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    Ok(base.join(MODEL_LAB_DIR_NAME).join(REGISTRY_FILE_NAME))
}

/// Loads the registry. A registry file that does not exist yet is a fresh
/// install (empty index); one that exists but cannot be read or parsed is an
/// error, never an empty index -- otherwise the next mutating command would
/// persist that empty index over the corrupt file and destroy every model's
/// lifecycle state, thresholds, intent bindings and approval history while
/// the bundle directories stay on disk.
fn load_registry(app: &AppHandle) -> Result<RegistryIndex, String> {
    read_registry_file(&registry_path(app)?)
}

fn read_registry_file(path: &Path) -> Result<RegistryIndex, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RegistryIndex::default());
        }
        Err(error) => {
            return Err(format!(
                "failed to read model registry {}: {error}",
                path.display()
            ));
        }
    };
    serde_json::from_str(&contents).map_err(|error| {
        format!(
            "model registry {} is corrupt ({error}); it was left untouched. \
             Restore it from a backup or move it aside to start with an empty registry",
            path.display()
        )
    })
}

/// Atomic write, matching `settings::write_atomic` / `model_lab`'s index writes.
fn write_registry_atomic(app: &AppHandle, index: &RegistryIndex) -> Result<(), String> {
    let path = registry_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "registry path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(&tmp_path, json).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|error| error.to_string())?;
    Ok(())
}

/// Serializes all registry reads/writes so concurrent commands never race.
#[derive(Default)]
pub struct ModelRegistryRuntime {
    lock: Mutex<()>,
}

const DEPLOYABLE_CLASS_LABELS: [&str; 3] = ["negative", "pinch_start", "pinch_release"];

/// The `Ok`/`Err` here also defines what "safe" means for a binding:
/// `pinch_start` may only ever initiate the volume grab or nothing;
/// `pinch_release` may only ever end it or do nothing; `negative` must never
/// bind to an actuating intent at all. This is what keeps an arbitrary
/// class-to-intent mapping from ever letting a model wire itself to a
/// mismatched or dangling actuation (e.g. `pinch_start` -> `Mute` with no
/// corresponding release), independent of whatever a training pipeline
/// happened to label its classes.
fn allowed_intents_for_class(class_label: &str) -> &'static [GestureIntent] {
    match class_label {
        "pinch_start" => &[GestureIntent::VolumeGrab, GestureIntent::NoAction],
        "pinch_release" => &[GestureIntent::VolumeRelease, GestureIntent::NoAction],
        "negative" => &[GestureIntent::NoAction],
        _ => &[],
    }
}

fn validate_intent_bindings(bindings: &[ModelIntentBinding]) -> Result<(), String> {
    if bindings.is_empty() {
        return Err("explicit intent bindings are required before activating a model".to_string());
    }
    if bindings.len() != DEPLOYABLE_CLASS_LABELS.len()
        || !DEPLOYABLE_CLASS_LABELS.iter().all(|class_label| {
            bindings
                .iter()
                .any(|binding| binding.class_label == *class_label)
        })
        || bindings
            .iter()
            .any(|binding| !DEPLOYABLE_CLASS_LABELS.contains(&binding.class_label.as_str()))
    {
        return Err("bindings must specify exactly negative, pinch_start, and pinch_release for this LiteRT model version".to_string());
    }
    for binding in bindings {
        if !allowed_intents_for_class(&binding.class_label).contains(&binding.intent) {
            return Err(format!(
                "class '{}' cannot bind to {:?}; only a safe intent for this class is allowed",
                binding.class_label, binding.intent
            ));
        }
    }
    Ok(())
}

const BUNDLE_SCHEMA_VERSION: u64 = 1;
const BUNDLE_MODEL_FORMAT: &str = "TFLite";

/// Parsed, contract-checked subset of a TFLite bundle's `metadata.json` (see
/// `tools/pinch-classifier/src/pinch_classifier/bundle.py::build_metadata`).
/// Only the fields the desktop actually depends on for safe activation are
/// modeled; training provenance fields are opaque and never interpreted here.
#[derive(Debug, Deserialize)]
struct BundleModelField {
    file: String,
    format: String,
    sha256: String,
    input_shape: Vec<u64>,
    output_shape: Vec<u64>,
}

#[derive(Debug, Deserialize)]
struct BundleClassEntry {
    index: usize,
    label: String,
}

/// The window settings the model was trained under (`bundle.py`'s
/// `window_config`); the other keys of that object are validated by
/// [`validate_inference_contract`] and not otherwise read.
#[derive(Debug, Deserialize)]
struct BundleWindowConfig {
    window_ms: f64,
    min_samples_per_window: u32,
}

#[derive(Debug, Deserialize)]
struct BundleFeatureContract {
    // Accepted for forward-compatible parsing of the bundle schema but not
    // yet read by any validation.
    #[allow(dead_code)]
    #[serde(default)]
    version: Option<u64>,
    count: usize,
    ordered_names: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BundleMetadata {
    schema_version: u64,
    model: BundleModelField,
    classes: Vec<BundleClassEntry>,
    feature_contract: BundleFeatureContract,
    window_config: BundleWindowConfig,
    // The remaining inference-critical sections (preprocessing, window_config,
    // conversion_parity, training, dtypes) are checked against the raw JSON
    // by `validate_inference_contract`.
}

/// Validates a bundle's declared `feature_contract.ordered_names` against
/// the desktop's canonical [`FEATURE_NAMES`] registry, returning each name's
/// resolved canonical index in the given (validated) order. A bundle may
/// declare a strict subset of the canonical registry -- provided every name
/// is known, none repeats, and the declared order matches each name's
/// canonical position. Reordering is rejected: live inference always
/// extracts the full canonical vector and then selects by canonical index
/// (see `pinch_inference::select_features`), so a declared order that didn't
/// match canonical position would silently select a different feature than
/// the one intended. Nothing is ever inferred, padded, or fabricated for a
/// name that isn't listed.
fn validate_feature_subset(ordered_names: &[String]) -> Result<Vec<usize>, String> {
    if ordered_names.is_empty() {
        return Err("bundle feature_contract.ordered_names must not be empty".to_string());
    }
    if ordered_names.len() > FEATURE_NAMES.len() {
        return Err(format!(
            "bundle feature_contract declares {} features, more than the desktop's canonical {}-feature registry",
            ordered_names.len(),
            FEATURE_NAMES.len()
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut indices = Vec::with_capacity(ordered_names.len());
    for name in ordered_names {
        if !seen.insert(name.as_str()) {
            return Err(format!(
                "bundle feature_contract declares duplicate feature '{name}'"
            ));
        }
        let index = FEATURE_NAMES
            .iter()
            .position(|canonical| canonical == name)
            .ok_or_else(|| {
                format!(
                    "bundle feature_contract declares unknown feature '{name}'; every feature \
                     must be one of the desktop's canonical FEATURE_NAMES"
                )
            })?;
        indices.push(index);
    }
    if !indices.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(
            "bundle feature_contract.ordered_names must preserve the canonical FEATURE_NAMES \
             order; reordering is not supported"
                .to_string(),
        );
    }
    Ok(indices)
}

fn sha256_hex(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read '{}': {error}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// The preprocessing policy the trainer (`bundle.py::PREPROCESSING_POLICY`)
/// bakes into every bundle it writes. A bundle declaring anything else was
/// not normalized the way this runtime feeds it, so it is rejected. Kept
/// identical to the Python constant; the shared fixture under
/// `tools/pinch-classifier/tests/fixtures/valid_bundle` is validated by both
/// languages' test suites so the two cannot drift silently.
fn supported_preprocessing_policy() -> serde_json::Value {
    serde_json::json!({
        "input": "the named engineered window features listed in feature_contract.ordered_names, in that order",
        "missing_sensor_values": "carry-forward within each recording; leading missing values become 0.0",
        "normalization": "per-feature standard score fitted on training sessions only and embedded in model.tflite",
        "zero_variance_scale": 1.0,
        "input_dtype": "float32",
    })
}

fn json_object_with_exact_keys<'a>(
    value: Option<&'a serde_json::Value>,
    name: &str,
    keys: &[&str],
) -> Result<&'a serde_json::Map<String, serde_json::Value>, String> {
    let object = value
        .and_then(serde_json::Value::as_object)
        .filter(|object| {
            object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
        })
        .ok_or_else(|| format!("bundle {name} must be an object containing exactly {keys:?}"))?;
    Ok(object)
}

fn positive_number(value: &serde_json::Value) -> bool {
    value.as_f64().is_some_and(|number| number > 0.0)
}

fn positive_integer(value: &serde_json::Value) -> bool {
    value.as_u64().is_some_and(|number| number > 0)
}

fn non_negative_finite(value: &serde_json::Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number >= 0.0)
}

fn non_empty_string_array(value: &serde_json::Value) -> Option<Vec<&str>> {
    let items = value.as_array().filter(|items| !items.is_empty())?;
    items
        .iter()
        .map(|item| item.as_str().filter(|text| !text.is_empty()))
        .collect()
}

/// Mirrors the inference-critical checks of the trainer's
/// `bundle.py::validate_metadata` that the typed [`BundleMetadata`] fields
/// do not cover: dtypes, preprocessing policy, window configuration, the
/// recorded source-vs-TFLite conversion parity, and training provenance. The
/// desktop activation gate must not be weaker than the writer-side gate,
/// because an imported bundle never passed the latter.
fn validate_inference_contract(root: &serde_json::Value) -> Result<(), String> {
    let model = root.get("model");
    for field in ["input_dtype", "output_dtype"] {
        if model.and_then(|model| model.get(field)) != Some(&serde_json::json!("float32")) {
            return Err(format!("bundle model.{field} must be \"float32\""));
        }
    }

    if root.get("preprocessing") != Some(&supported_preprocessing_policy()) {
        return Err("bundle preprocessing does not match the supported deployment policy".into());
    }

    let window = json_object_with_exact_keys(
        root.get("window_config"),
        "window_config",
        &[
            "window_ms",
            "stride_ms",
            "max_gap_ms",
            "min_samples_per_window",
            "boundary_policy",
        ],
    )?;
    for field in ["window_ms", "stride_ms", "max_gap_ms"] {
        if !positive_number(&window[field]) {
            return Err(format!("bundle window_config.{field} must be positive"));
        }
    }
    // At least 2, like the trainer's `WindowConfig`: a window of one sample has
    // no duration and none of the slope/std features mean anything.
    if window["min_samples_per_window"]
        .as_u64()
        .is_none_or(|samples| samples < 2)
    {
        return Err(
            "bundle window_config.min_samples_per_window must be an integer of at least 2".into(),
        );
    }

    let parity = json_object_with_exact_keys(
        root.get("conversion_parity"),
        "conversion_parity",
        &[
            "passed",
            "sample_count",
            "absolute_tolerance",
            "max_absolute_error",
            "argmax_agreement",
        ],
    )?;
    if parity["passed"] != serde_json::json!(true) {
        return Err("bundle conversion_parity must record a passed source-vs-TFLite check".into());
    }
    if !positive_integer(&parity["sample_count"]) {
        return Err("bundle conversion_parity.sample_count must be a positive integer".into());
    }
    for field in ["absolute_tolerance", "max_absolute_error"] {
        if !non_negative_finite(&parity[field]) {
            return Err(format!(
                "bundle conversion_parity.{field} must be finite and non-negative"
            ));
        }
    }
    let tolerance = parity["absolute_tolerance"].as_f64().unwrap_or(f64::NAN);
    let max_error = parity["max_absolute_error"].as_f64().unwrap_or(f64::NAN);
    if max_error > tolerance {
        return Err("bundle conversion parity error exceeds its absolute tolerance".into());
    }
    if parity["argmax_agreement"].as_f64() != Some(1.0) {
        return Err("bundle conversion_parity.argmax_agreement must be 1.0".into());
    }

    let training = json_object_with_exact_keys(
        root.get("training"),
        "training",
        &[
            "random_seed",
            "tensorflow_version",
            "model_type",
            "epochs",
            "batch_size",
            "learning_rate",
            "final_training_loss",
            "n_windows_train",
            "n_windows_test",
            "groups_train",
            "groups_test",
            "input_files",
            "metrics",
        ],
    )?;
    if !training["random_seed"].is_i64() && !training["random_seed"].is_u64() {
        return Err("bundle training.random_seed must be an integer".into());
    }
    for field in ["tensorflow_version", "model_type"] {
        if training[field].as_str().is_none_or(str::is_empty) {
            return Err(format!(
                "bundle training.{field} must be a non-empty string"
            ));
        }
    }
    for field in ["epochs", "batch_size", "n_windows_train", "n_windows_test"] {
        if !positive_integer(&training[field]) {
            return Err(format!(
                "bundle training.{field} must be a positive integer"
            ));
        }
    }
    for field in ["learning_rate", "final_training_loss"] {
        if !non_negative_finite(&training[field]) {
            return Err(format!(
                "bundle training.{field} must be a finite non-negative number"
            ));
        }
    }
    let mut string_arrays = Vec::new();
    for field in ["groups_train", "groups_test", "input_files"] {
        string_arrays.push(
            non_empty_string_array(&training[field]).ok_or_else(|| {
                format!("bundle training.{field} must be a non-empty string array")
            })?,
        );
    }
    if string_arrays[0]
        .iter()
        .any(|group| string_arrays[1].contains(group))
    {
        return Err("bundle training group split leaks a session between train and test".into());
    }
    if !training["metrics"].is_object() {
        return Err("bundle training.metrics must be an object".into());
    }
    Ok(())
}

/// Fully revalidates a model directory's bundle contract against the desktop's
/// fixed class contract and canonical feature registry (accepting any
/// strict, canonically-ordered subset -- see [`validate_feature_subset`]) and
/// recomputes `model.tflite`'s digest -- never trusts that a file named
/// `metadata.json` still matches the bytes on disk, since either could have
/// been replaced or corrupted after the model was approved. Returns the
/// parsed metadata, the freshly recomputed (verified-matching) digest, and
/// the bundle's declared features' resolved canonical indices. This is the
/// single choke point [`ActiveModelSnapshot::verified`] runs through at
/// activation, rollback, and every runtime (re)load.
fn load_and_verify_bundle(dir: &Path) -> Result<(BundleMetadata, String, Vec<usize>), String> {
    let metadata_path = dir.join(TFLITE_METADATA_FILE_NAME);
    let contents = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("failed to read {TFLITE_METADATA_FILE_NAME}: {error}"))?;
    let metadata: BundleMetadata = serde_json::from_str(&contents).map_err(|error| {
        format!("{TFLITE_METADATA_FILE_NAME} is not a valid bundle contract: {error}")
    })?;
    let raw: serde_json::Value = serde_json::from_str(&contents).map_err(|error| {
        format!("{TFLITE_METADATA_FILE_NAME} is not a valid bundle contract: {error}")
    })?;

    if metadata.schema_version != BUNDLE_SCHEMA_VERSION {
        return Err(format!(
            "unsupported bundle schema_version {} (expected {BUNDLE_SCHEMA_VERSION})",
            metadata.schema_version
        ));
    }

    let classes_match = metadata.classes.len() == DEPLOYABLE_CLASS_LABELS.len()
        && metadata
            .classes
            .iter()
            .zip(DEPLOYABLE_CLASS_LABELS.iter())
            .enumerate()
            .all(|(expected_index, (entry, expected_label))| {
                entry.index == expected_index && entry.label == *expected_label
            });
    if !classes_match {
        return Err(format!(
            "bundle classes must be exactly {DEPLOYABLE_CLASS_LABELS:?} in index order"
        ));
    }

    if metadata.feature_contract.count != metadata.feature_contract.ordered_names.len() {
        return Err("bundle feature_contract.count must match ordered_names length".to_string());
    }
    let feature_indices = validate_feature_subset(&metadata.feature_contract.ordered_names)?;

    if metadata.model.file != TFLITE_MODEL_FILE_NAME || metadata.model.format != BUNDLE_MODEL_FORMAT
    {
        return Err(format!(
            "bundle model must be '{TFLITE_MODEL_FILE_NAME}' in {BUNDLE_MODEL_FORMAT} format"
        ));
    }
    if metadata.model.input_shape != vec![1, feature_indices.len() as u64] {
        return Err(
            "bundle model input_shape does not match its own declared feature_contract length"
                .to_string(),
        );
    }
    if metadata.model.output_shape != vec![1, CLASS_COUNT as u64] {
        return Err(
            "bundle model output_shape does not match the desktop's class contract".to_string(),
        );
    }

    validate_inference_contract(&raw)?;

    let digest = metadata.model.sha256.clone();
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("bundle model.sha256 must be a lowercase SHA-256 hex digest".to_string());
    }
    let actual_digest = sha256_hex(&dir.join(TFLITE_MODEL_FILE_NAME))?;
    if actual_digest != digest {
        return Err(format!(
            "model.tflite digest mismatch: metadata records {digest}, actual file hashes to {actual_digest}"
        ));
    }

    Ok((metadata, actual_digest, feature_indices))
}

/// How far a live PPG window's duration may stray from the window the bundle
/// was trained on before the two are considered different inputs.
const WINDOW_DURATION_TOLERANCE: f64 = 0.25;

/// The window settings a bundle declares, which the live runtime must hold
/// each window to (R-M3-1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeclaredWindow {
    pub window_ms: f64,
    pub min_samples_per_window: u32,
}

/// One live window's duration measured against the bundle's declared window.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCheck {
    pub declared_ms: f64,
    /// `None` when the window has fewer than two timestamps.
    pub observed_ms: Option<f64>,
    pub compatible: bool,
}

impl WindowCheck {
    pub fn describe(&self) -> String {
        match self.observed_ms {
            Some(observed) => format!(
                "live PPG windows span {observed:.0} ms but this model was trained on {:.0} ms windows (±{:.0}%)",
                self.declared_ms,
                WINDOW_DURATION_TOLERANCE * 100.0
            ),
            None => format!(
                "live PPG window has no measurable duration but this model was trained on {:.0} ms windows",
                self.declared_ms
            ),
        }
    }
}

/// A window is compatible when its duration is within
/// [`WINDOW_DURATION_TOLERANCE`] of the declared `window_ms` (a trained window
/// spans up to one sample period less than `window_ms`, hence a tolerance
/// rather than equality).
pub fn check_window(declared: DeclaredWindow, observed_ms: Option<f64>) -> WindowCheck {
    let compatible = observed_ms.is_some_and(|observed| {
        observed.is_finite()
            && (observed - declared.window_ms).abs()
                <= declared.window_ms * WINDOW_DURATION_TOLERANCE
    });
    WindowCheck {
        declared_ms: declared.window_ms,
        observed_ms,
        compatible,
    }
}

/// Duration of a raw PPG batch from its own per-sample timestamps -- the same
/// quantity the `duration_ms` feature measures.
pub fn observed_window_ms(timestamps_ns: &[u64]) -> Option<f64> {
    match (timestamps_ns.first(), timestamps_ns.last()) {
        (Some(&first), Some(&last)) if last > first => Some((last - first) as f64 / 1_000_000.0),
        _ => None,
    }
}

/// Immutable, contract-verified snapshot of one model: the only shape
/// [`crate::inference::PinchInferenceRuntime`] is allowed to classify
/// against or resolve class outcomes with. Building one is the sole path
/// that combines a model id with executable bindings, so a corrupted
/// bundle, a stale/incomplete binding set, or a contract mismatch can never
/// reach classification or actuation.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveModelSnapshot {
    pub model_id: String,
    pub thresholds: ModelThresholds,
    pub quality_gate: QualityGateConfig,
    pub class_order: Vec<String>,
    pub digest: String,
    /// Resolved canonical `FEATURE_NAMES` indices for this bundle's declared
    /// `feature_contract.ordered_names`, in that same order -- what
    /// `pinch_inference::select_features` uses to pick this model's input
    /// values out of the full extracted canonical feature vector. A full
    /// legacy/app-trained bundle resolves to `0..FEATURE_COUNT`.
    pub feature_indices: Vec<usize>,
    /// The window settings the bundle was trained under; see [`check_window`].
    pub declared_window: DeclaredWindow,
    bindings: HashMap<String, GestureIntent>,
}

impl ActiveModelSnapshot {
    /// Loads `model_id`'s registry record and on-disk bundle and fully
    /// revalidates the contract end-to-end (schema, class order, feature
    /// order, tensor shapes, and a freshly recomputed digest), then confirms
    /// every deployable class has a complete, safe binding whose labels
    /// agree with the bundle's own authoritative class order. Never trusts a
    /// previous validation (e.g. at a prior activation) to still hold.
    pub(crate) fn verified(app: &AppHandle, model_id: &str) -> Result<Self, String> {
        let index = load_registry(app)?;
        let model = index
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| format!("no registered model with id '{model_id}'"))?;
        validate_intent_bindings(&model.intent_bindings)?;
        model.thresholds.validate()?;
        model.quality_gate.validate()?;

        let dir = model_lab::models_dir(app)?.join(model_id);
        let (metadata, digest, feature_indices) = load_and_verify_bundle(&dir)?;
        let class_order: Vec<String> = metadata
            .classes
            .iter()
            .map(|entry| entry.label.clone())
            .collect();
        let class_order_matches = class_order.len() == DEPLOYABLE_CLASS_LABELS.len()
            && class_order
                .iter()
                .zip(DEPLOYABLE_CLASS_LABELS.iter())
                .all(|(actual, expected)| actual.as_str() == *expected);
        if !class_order_matches {
            return Err(
                "bundle class order does not match the bindings' expected class labels".to_string(),
            );
        }

        let bindings = model
            .intent_bindings
            .iter()
            .map(|binding| (binding.class_label.clone(), binding.intent))
            .collect();

        Ok(Self {
            model_id: model_id.to_string(),
            thresholds: model.thresholds,
            quality_gate: model.quality_gate,
            class_order,
            digest,
            feature_indices,
            declared_window: DeclaredWindow {
                window_ms: metadata.window_config.window_ms,
                min_samples_per_window: metadata.window_config.min_samples_per_window,
            },
            bindings,
        })
    }

    /// The safe [`GestureIntent`] bound to `class_label`, or `NoAction` if
    /// somehow absent -- defensive only, since [`Self::verified`] already
    /// guarantees a complete binding set for every deployable class.
    pub fn intent_for_class(&self, class_label: &str) -> GestureIntent {
        self.bindings
            .get(class_label)
            .copied()
            .unwrap_or(GestureIntent::NoAction)
    }

    /// Test-only constructor bypassing [`Self::verified`]'s `AppHandle`
    /// requirement, so callers outside this module can exercise binding
    /// resolution without a real Tauri app.
    #[cfg(test)]
    pub(crate) fn for_test(model_id: &str, bindings: &[(&str, GestureIntent)]) -> Self {
        Self {
            model_id: model_id.to_string(),
            thresholds: ModelThresholds::default(),
            quality_gate: QualityGateConfig::default(),
            class_order: DEPLOYABLE_CLASS_LABELS
                .iter()
                .map(|label| label.to_string())
                .collect(),
            digest: "test-digest".to_string(),
            feature_indices: (0..FEATURE_COUNT).collect(),
            declared_window: DeclaredWindow {
                window_ms: 500.0,
                min_samples_per_window: 3,
            },
            bindings: bindings
                .iter()
                .map(|(label, intent)| (label.to_string(), *intent))
                .collect(),
        }
    }
}

/// Forces any in-progress grab to release and clears the loaded model
/// backend's internal pinch state before ever swapping which model is
/// active. Without this, a grab classified under the outgoing model's
/// bindings could survive into the incoming model's lifetime, which has no
/// reason to share its meaning -- see the acceptance criterion that
/// switching model state can never preserve a grab.
fn force_release_before_swap(
    app: &AppHandle,
    gesture_policy: &GesturePolicyRuntime,
    pinch_inference: &PinchInferenceRuntime,
) {
    pinch_inference.reset();
    match gesture_policy.force_release(ForceReleaseReason::ModelSwapped) {
        Ok(decision) => crate::inference::apply_decision(app, decision),
        Err(error) => {
            tracing::warn!(%error, "failed to force-release gesture policy before model swap")
        }
    }
}

/// Everything the live inference path needs to decide what to do with one
/// raw sensor window: which model is active, what mode the registry is in,
/// and that model's own thresholds and sensor-quality gate.
pub(crate) struct ActiveModelRuntimeConfig {
    pub model_id: String,
    pub inference_mode: InferenceMode,
    pub thresholds: ModelThresholds,
    pub quality_gate: QualityGateConfig,
}

/// The [`ActiveModelRuntimeConfig`] for the currently active model, or
/// `None` if no model is active at all -- in which case there is nothing
/// running that a stale/degraded window could corrupt, so callers should
/// skip quality gating and classification entirely.
///
/// The Off/Monitor/Live gate itself is deliberately *not* applied here: it
/// belongs to the single live-path choke point in
/// [`crate::inference::ingest_ppg_window`] (see `inference::mode_classifies`),
/// so the rule that `Off` never reaches a model is stated and unit-tested in
/// one obvious place rather than hidden behind this lookup's `None`.
pub(crate) fn active_model_runtime_config(app: &AppHandle) -> Option<ActiveModelRuntimeConfig> {
    let index = match load_registry(app) {
        Ok(index) => index,
        Err(error) => {
            // Fail closed: with no readable registry nothing is classified
            // and nothing can actuate.
            tracing::warn!(%error, "model registry unavailable; treating as no active model");
            return None;
        }
    };
    let active_id = index.active_model_id.clone()?;
    index
        .models
        .iter()
        .find(|model| model.id == active_id)
        .map(|model| ActiveModelRuntimeConfig {
            model_id: active_id,
            inference_mode: index.inference_mode,
            thresholds: model.thresholds,
            quality_gate: model.quality_gate,
        })
}

/// Absolute path to `model_id`'s `model.tflite` file, for loading into a real
/// inference backend. Does not check the file exists -- callers already know
/// the model is activatable (file presence was checked by
/// [`model_is_activatable`] before it could ever become active).
pub(crate) fn active_model_file_path(app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
    Ok(model_lab::models_dir(app)?
        .join(model_id)
        .join(TFLITE_MODEL_FILE_NAME))
}

/// Resolves an approved/active bundle for side-effect-free offline replay.
/// Draft and archived artifacts fail closed, as does any non-LiteRT bundle.
pub(crate) fn replayable_model_dir(app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
    let index = load_registry(app)?;
    let model = index
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| format!("no registered model with id '{model_id}'"))?;
    if !matches!(
        model.state,
        ModelLifecycleState::Approved | ModelLifecycleState::Active
    ) {
        return Err("offline replay requires an approved or active model".to_string());
    }
    model_is_activatable(app, model_id)?;
    Ok(model_lab::models_dir(app)?.join(model_id))
}

fn emit_registry(app: &AppHandle, index: &RegistryIndex) {
    if let Err(error) = app.emit(MODEL_REGISTRY_EVENT, RegistryView::from(index.clone())) {
        tracing::warn!(%error, "failed to emit model registry event");
    }
}

/// Single choke point for every registry-mutating command: acquires
/// `runtime`'s lock, loads the current index, runs `mutate` over it, and -- if
/// `mutate` succeeds -- atomically persists and emits the result. `mutate`
/// itself decides what "success" means for its operation (state checks,
/// bundle/binding revalidation, the actual field change), so this only
/// centralizes the lock/load/persist/emit/view steps every command repeated,
/// without changing what each command validates or when.
fn with_registry_mutation<F>(
    app: &AppHandle,
    runtime: &ModelRegistryRuntime,
    mutate: F,
) -> Result<RegistryView, String>
where
    F: FnOnce(&mut RegistryIndex) -> Result<(), String>,
{
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(app)?;
    mutate(&mut index)?;
    write_registry_atomic(app, &index)?;
    emit_registry(app, &index);
    Ok(RegistryView::from(index))
}

/// A model directory is a validated, activatable TFLite bundle iff it holds
/// both `metadata.json` and `model.tflite`. `metadata.json` is only ever
/// written by `write_and_validate_metadata` in bundle.py, which validates the
/// full contract (feature order, class order, conversion parity, sha256)
/// before writing — so file presence here is sufficient, no need to
/// re-parse/re-validate the contract on the Rust side.
fn model_is_activatable(app: &AppHandle, model_id: &str) -> Result<(), String> {
    let dir = model_lab::models_dir(app)?.join(model_id);
    if !dir.join(TFLITE_METADATA_FILE_NAME).is_file() || !dir.join(TFLITE_MODEL_FILE_NAME).is_file()
    {
        return Err(format!(
            "model '{model_id}' is not a validated TFLite bundle ({TFLITE_METADATA_FILE_NAME} + \
             {TFLITE_MODEL_FILE_NAME} required). Desktop inference only runs validated TFLite \
             bundles produced by the 'tflite' training backend; a sklearn baseline model cannot \
             be activated."
        ));
    }
    Ok(())
}

fn find_model_mut<'a>(
    index: &'a mut RegistryIndex,
    id: &str,
) -> Result<&'a mut ModelRecord, String> {
    index
        .models
        .iter_mut()
        .find(|model| model.id == id)
        .ok_or_else(|| format!("no registered model with id '{id}'"))
}

/// Registers a freshly trained model as `Draft` if it isn't already
/// registered. Called from `model_lab::run_training_job` on completion, for
/// both backends (a Draft record is harmless bookkeeping even for a sklearn
/// model that can never be activated).
pub(crate) fn register_trained_model(
    app: &AppHandle,
    runtime: &ModelRegistryRuntime,
    model_id: &str,
) {
    let Ok(_guard) = runtime.lock.lock() else {
        return;
    };
    let mut index = match load_registry(app) {
        Ok(index) => index,
        Err(error) => {
            tracing::warn!(%error, model_id, "failed to register newly trained model");
            return;
        }
    };
    if index.models.iter().any(|model| model.id == model_id) {
        return;
    }
    index.models.push(ModelRecord::new(model_id.to_string()));
    if let Err(error) = write_registry_atomic(app, &index) {
        tracing::warn!(%error, model_id, "failed to persist newly registered model");
        return;
    }
    emit_registry(app, &index);
}

/// Imports a user-selected TFLite bundle into Model Lab. The selected path must
/// be `metadata.json`; its parent is treated as the bundle root. The source is
/// validated before copy and the private destination is validated again before
/// a Draft lifecycle record is persisted. Thus a copied/corrupt/swapped file can
/// never become registered, approved, or active merely because it has a familiar
/// filename.
#[tauri::command]
pub fn import_custom_tflite_bundle(
    metadata_path: String,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    let source_metadata = PathBuf::from(&metadata_path);
    if source_metadata.file_name().and_then(|name| name.to_str()) != Some(TFLITE_METADATA_FILE_NAME)
    {
        return Err(format!(
            "select the bundle's {TFLITE_METADATA_FILE_NAME}, not an arbitrary file"
        ));
    }
    let source_dir = source_metadata
        .parent()
        .ok_or_else(|| format!("{TFLITE_METADATA_FILE_NAME} has no containing bundle directory"))?;
    load_and_verify_bundle(source_dir)
        .map_err(|error| format!("custom bundle rejected before import: {error}"))?;

    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let id = format!("imported-{}", Uuid::new_v4());
    let destination = model_lab::models_dir(&app)?.join(&id);
    fs::create_dir_all(&destination)
        .map_err(|error| format!("failed to create private bundle storage: {error}"))?;
    let copy_result = (|| -> Result<(), String> {
        fs::copy(
            source_dir.join(TFLITE_METADATA_FILE_NAME),
            destination.join(TFLITE_METADATA_FILE_NAME),
        )
        .map_err(|error| format!("failed to copy {TFLITE_METADATA_FILE_NAME}: {error}"))?;
        fs::copy(
            source_dir.join(TFLITE_MODEL_FILE_NAME),
            destination.join(TFLITE_MODEL_FILE_NAME),
        )
        .map_err(|error| format!("failed to copy {TFLITE_MODEL_FILE_NAME}: {error}"))?;
        load_and_verify_bundle(&destination)
            .map_err(|error| format!("custom bundle rejected after copy: {error}"))?;
        Ok(())
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }

    let mut index = match load_registry(&app) {
        Ok(index) => index,
        Err(error) => {
            let _ = fs::remove_dir_all(&destination);
            return Err(error);
        }
    };
    let mut record = ModelRecord::new(id);
    record.imported_tflite_bundle = true;
    index.models.push(record);
    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    Ok(RegistryView::from(index))
}

#[tauri::command]
pub fn get_model_registry(
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    Ok(RegistryView::from(load_registry(&app)?))
}

#[tauri::command]
pub fn transition_model_state(
    id: String,
    to: ModelLifecycleState,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    with_registry_mutation(&app, &runtime, |index| {
        if index.active_model_id.as_deref() == Some(id.as_str()) {
            return Err("cannot transition the active model directly; use rollback_active_model or activate a different model first".to_string());
        }
        let model = find_model_mut(index, &id)?;
        if !legal_transition(model.state, to) {
            return Err(format!("illegal transition {:?} -> {:?}", model.state, to));
        }
        model.push_transition(to);
        Ok(())
    })
}

#[tauri::command]
pub fn update_model_thresholds(
    id: String,
    thresholds: ModelThresholds,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    thresholds.validate()?;
    with_registry_mutation(&app, &runtime, |index| {
        find_model_mut(index, &id)?.thresholds = thresholds;
        Ok(())
    })
}

#[tauri::command]
pub fn update_model_quality_gate(
    id: String,
    quality_gate: QualityGateConfig,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    quality_gate.validate()?;
    with_registry_mutation(&app, &runtime, |index| {
        find_model_mut(index, &id)?.quality_gate = quality_gate;
        Ok(())
    })
}

/// Replaces the complete, closed-set intent mapping for one trained model.
/// The caller cannot supply a shell command or executable path: intent is the
/// `GestureIntent` enum shared with the desktop policy. Activation additionally
/// requires a complete mapping, so an omitted class fails closed.
#[tauri::command]
pub fn set_model_intent_bindings(
    id: String,
    bindings: Vec<ModelIntentBinding>,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    validate_intent_bindings(&bindings)?;
    with_registry_mutation(&app, &runtime, |index| {
        let model = find_model_mut(index, &id)?;
        if matches!(
            model.state,
            ModelLifecycleState::Approved | ModelLifecycleState::Active
        ) {
            return Err(
                "cannot change bindings of an approved or active model; move it back to Evaluated first"
                    .to_string(),
            );
        }
        model.intent_bindings = bindings;
        Ok(())
    })
}

/// Activates `id`: requires it be `Approved` and a validated TFLite bundle.
/// Any currently Active model is demoted back to `Approved` and remembered
/// as `previous_active_model_id` so [`rollback_active_model`] can restore it.
#[tauri::command]
pub fn activate_model(
    id: String,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
    gesture_policy: State<'_, GesturePolicyRuntime>,
    pinch_inference: State<'_, PinchInferenceRuntime>,
) -> Result<RegistryView, String> {
    with_registry_mutation(&app, &runtime, |index| {
        {
            let model = find_model_mut(index, &id)?;
            if model.state != ModelLifecycleState::Approved {
                return Err(format!(
                    "model '{id}' must be Approved before activation (currently {:?})",
                    model.state
                ));
            }
        }
        // Reject a non-TFLite (e.g. sklearn baseline) bundle with a clear,
        // deployability-specific error before the generic contract revalidation
        // below, which would otherwise surface as an opaque "failed to read
        // metadata.json" I/O error.
        model_is_activatable(&app, &id)?;
        // Revalidate the full bundle contract, digest, and bindings under the
        // same lock as the state check above -- a stale `Approved` state on disk
        // must never be trusted alone, and nothing may mutate the record between
        // this validation and the swap below (see `ActiveModelSnapshot::verified`).
        ActiveModelSnapshot::verified(&app, &id)?;

        force_release_before_swap(&app, &gesture_policy, &pinch_inference);

        let previous_active = index.active_model_id.clone();
        if let Some(previous_id) = &previous_active
            && previous_id != &id
            && let Ok(previous) = find_model_mut(index, previous_id)
        {
            previous.push_transition(ModelLifecycleState::Approved);
        }
        find_model_mut(index, &id)?.push_transition(ModelLifecycleState::Active);
        index.previous_active_model_id = previous_active.filter(|previous_id| previous_id != &id);
        index.active_model_id = Some(id);
        Ok(())
    })
}

/// Swaps the active model back to whichever model was active immediately
/// before the last [`activate_model`] call.
#[tauri::command]
pub fn rollback_active_model(
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
    gesture_policy: State<'_, GesturePolicyRuntime>,
    pinch_inference: State<'_, PinchInferenceRuntime>,
) -> Result<RegistryView, String> {
    with_registry_mutation(&app, &runtime, |index| {
        let Some(previous_id) = index.previous_active_model_id.clone() else {
            return Err("no previous active model to roll back to".to_string());
        };
        // The model being restored may have been demoted since it was last
        // active; revalidate its bundle contract, digest, and bindings exactly
        // as activation would rather than trusting its earlier validation still
        // holds.
        ActiveModelSnapshot::verified(&app, &previous_id)?;
        let current_active = index.active_model_id.clone();

        force_release_before_swap(&app, &gesture_policy, &pinch_inference);

        if let Some(current_id) = &current_active {
            find_model_mut(index, current_id)?.push_transition(ModelLifecycleState::Approved);
        }
        find_model_mut(index, &previous_id)?.push_transition(ModelLifecycleState::Active);
        index.active_model_id = Some(previous_id);
        index.previous_active_model_id = current_active;
        Ok(())
    })
}

/// Also drives [`crate::inference::GesturePolicyRuntime`], which is the
/// component that actually gates whether pinch-transition decisions execute
/// against the overlay -- see the non-negotiable rule that all gesture
/// decisions run on the desktop, in `docs/architecture/project-brief.md`
/// Milestone 11.
/// The mode a freshly started app may run in. The persisted mode survives a
/// restart so the user's `Monitor` choice does, but `Live` is capped to
/// `Monitor`: real actions only start after an explicit `Live` selection in
/// this session, once the Monitor results are in front of the user (see the
/// release-readiness checklist). Without this the persisted mode said `Live`
/// while the freshly built policy was `Off`, so the UI showed `Live` and
/// nothing actuated.
fn startup_inference_mode(persisted: InferenceMode) -> InferenceMode {
    match persisted {
        InferenceMode::Live => InferenceMode::Monitor,
        other => other,
    }
}

/// Brings the policy and the persisted registry mode into agreement at
/// startup (see [`startup_inference_mode`]). Failing closed: if the registry
/// cannot be read the policy stays `Off`.
pub(crate) fn reconcile_inference_mode_at_startup(app: &AppHandle) {
    let runtime = app.state::<ModelRegistryRuntime>();
    let gesture_policy = app.state::<crate::inference::GesturePolicyRuntime>();
    let persisted = {
        let Ok(_guard) = runtime.lock.lock() else {
            return;
        };
        match load_registry(app) {
            Ok(index) => index.inference_mode,
            Err(error) => {
                tracing::warn!(%error, "model registry unavailable at startup; inference stays off");
                return;
            }
        }
    };
    let effective = startup_inference_mode(persisted);
    if effective != persisted
        && let Err(error) = with_registry_mutation(app, &runtime, |index| {
            index.inference_mode = effective;
            Ok(())
        })
    {
        tracing::warn!(%error, "failed to persist the startup inference mode cap");
        return;
    }
    if let Err(error) = gesture_policy.set_mode(effective) {
        tracing::warn!(%error, "failed to apply the startup inference mode");
    }
}

/// Why `Live` cannot be selected while the active model's training window and
/// the live PPG window disagree (R-M3-1). `Monitor` still runs, so the
/// mismatch can be inspected there.
fn live_refusal_message(check: &WindowCheck) -> String {
    format!(
        "Live is unavailable: {}. Align the Watch PPG flush rate with the model's window or \
         retrain with a matching --window-ms; Monitor still classifies so you can inspect it.",
        check.describe()
    )
}

/// Changes the inference mode with the policy and the persisted copy kept in
/// agreement: `apply` (the policy) runs first and `persist` second, so a
/// failure to apply leaves the persisted mode untouched, and a failure to
/// persist puts the policy back on `previous`. The reverse order let a
/// persisted `Off` sit beside a policy still running `Live`.
fn change_inference_mode<T>(
    previous: InferenceMode,
    next: InferenceMode,
    mut apply: impl FnMut(InferenceMode) -> Result<(), String>,
    persist: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    apply(next)?;
    match persist() {
        Ok(value) => Ok(value),
        Err(error) => {
            if let Err(revert_error) = apply(previous) {
                tracing::warn!(%revert_error, "failed to restore the previous inference mode after a persist failure");
            }
            Err(error)
        }
    }
}

/// Also drives [`crate::inference::GesturePolicyRuntime`], which is the
/// component that actually gates whether pinch-transition decisions execute
/// against the overlay -- see the non-negotiable rule that all gesture
/// decisions run on the desktop, in `docs/architecture/project-brief.md`
/// Milestone 11.
#[tauri::command]
pub fn set_inference_mode(
    mode: InferenceMode,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
    gesture_policy: State<'_, crate::inference::GesturePolicyRuntime>,
    ppg_ingest: State<'_, crate::inference::PpgIngestRuntime>,
) -> Result<RegistryView, String> {
    let (previous, active_model_id) = {
        let _guard = runtime
            .lock
            .lock()
            .map_err(|_| "model registry lock was poisoned".to_string())?;
        let index = load_registry(&app)?;
        (index.inference_mode, index.active_model_id)
    };
    if mode == InferenceMode::Live
        && let Some(model_id) = &active_model_id
        && let Some(check) = ppg_ingest.live_blocking_window_mismatch(model_id)
    {
        return Err(live_refusal_message(&check));
    }
    change_inference_mode(
        previous,
        mode,
        |target| {
            if let Some(decision) = gesture_policy.set_mode(target)? {
                crate::inference::apply_decision(&app, decision);
            }
            Ok(())
        },
        || {
            with_registry_mutation(&app, &runtime, |index| {
                index.inference_mode = mode;
                Ok(())
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R-M4-6: the policy and the persisted mode must not disagree.
    /// R-M3-1: a window is compatible when its duration is within tolerance
    /// of the window the bundle declares it was trained on.
    #[test]
    fn check_window_compares_the_live_duration_with_the_declared_window() {
        let declared = DeclaredWindow {
            window_ms: 500.0,
            min_samples_per_window: 3,
        };
        // A trained 500 ms window spans slightly less than 500 ms of samples.
        assert!(check_window(declared, Some(470.0)).compatible);
        assert!(check_window(declared, Some(500.0)).compatible);
        assert!(check_window(declared, Some(620.0)).compatible);
        // The default 1 Hz PPG flush is roughly 960 ms: not the trained window.
        assert!(!check_window(declared, Some(960.0)).compatible);
        assert!(!check_window(declared, Some(300.0)).compatible);
        // No measurable duration is never compatible, and never panics.
        assert!(!check_window(declared, None).compatible);
        assert!(!check_window(declared, Some(f64::NAN)).compatible);
    }

    #[test]
    fn observed_window_ms_measures_first_to_last_timestamp() {
        assert_eq!(observed_window_ms(&[0, 20_000_000, 40_000_000]), Some(40.0));
        assert_eq!(observed_window_ms(&[5]), None);
        assert_eq!(observed_window_ms(&[]), None);
        assert_eq!(observed_window_ms(&[10, 10]), None);
    }

    #[test]
    fn the_live_refusal_names_the_mismatch_and_how_to_fix_it() {
        let declared = DeclaredWindow {
            window_ms: 500.0,
            min_samples_per_window: 3,
        };
        let message = live_refusal_message(&check_window(declared, Some(960.0)));
        assert!(message.contains("960"), "{message}");
        assert!(message.contains("500"), "{message}");
        assert!(message.contains("flush rate"), "{message}");
        assert!(message.contains("Monitor"), "{message}");
    }

    #[test]
    fn load_and_verify_bundle_rejects_a_one_sample_minimum_window() {
        assert_mutation_is_rejected("min-samples-one", |m| {
            m["window_config"]["min_samples_per_window"] = serde_json::json!(1);
        });
    }

    #[test]
    fn load_and_verify_bundle_exposes_the_declared_window() {
        let dir = unique_bundle_dir("declared-window");
        write_valid_bundle(&dir);
        let (metadata, _, _) = load_and_verify_bundle(&dir).unwrap();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(metadata.window_config.window_ms, 500.0);
        assert_eq!(metadata.window_config.min_samples_per_window, 3);
    }

    #[test]
    fn startup_caps_a_persisted_live_mode_to_monitor() {
        assert_eq!(
            startup_inference_mode(InferenceMode::Live),
            InferenceMode::Monitor
        );
        assert_eq!(
            startup_inference_mode(InferenceMode::Monitor),
            InferenceMode::Monitor
        );
        assert_eq!(
            startup_inference_mode(InferenceMode::Off),
            InferenceMode::Off
        );
    }

    #[test]
    fn mode_change_applies_to_the_policy_before_persisting() {
        let mut order = Vec::new();
        let result = change_inference_mode(
            InferenceMode::Off,
            InferenceMode::Live,
            |mode| {
                order.push(format!("apply {mode:?}"));
                Ok(())
            },
            || {
                // persist runs after the first apply
                Ok::<_, String>("persisted")
            },
        );
        assert_eq!(result, Ok("persisted"));
        assert_eq!(order, vec!["apply Live".to_string()]);
    }

    #[test]
    fn a_failed_apply_never_reaches_persist() {
        let mut persisted = false;
        let result = change_inference_mode(
            InferenceMode::Off,
            InferenceMode::Live,
            |_| Err("policy lock poisoned".to_string()),
            || {
                persisted = true;
                Ok::<_, String>(())
            },
        );
        assert!(result.is_err());
        assert!(!persisted, "the persisted mode must stay untouched");
    }

    #[test]
    fn a_failed_persist_restores_the_previous_policy_mode() {
        let mut applied = Vec::new();
        let result: Result<(), String> = change_inference_mode(
            InferenceMode::Monitor,
            InferenceMode::Live,
            |mode| {
                applied.push(mode);
                Ok(())
            },
            || Err("disk full".to_string()),
        );
        assert_eq!(result, Err("disk full".to_string()));
        assert_eq!(applied, vec![InferenceMode::Live, InferenceMode::Monitor]);
    }

    #[test]
    fn quality_gate_rejects_low_sample_count() {
        let config = QualityGateConfig::default();
        let result = evaluate_quality_gate(&config, 0.0, 1);
        assert_eq!(
            result,
            Err(QualityGateRejection::LowSampleCount {
                actual: 1,
                required: 3
            })
        );
    }

    #[test]
    fn quality_gate_rejects_degraded_contact_quality() {
        let config = QualityGateConfig::default();
        let result = evaluate_quality_gate(&config, 1.0, 5);
        assert_eq!(
            result,
            Err(QualityGateRejection::DegradedContactQuality {
                actual: 1.0,
                max_allowed: 0.0
            })
        );
    }

    #[test]
    fn quality_gate_passes_clean_window() {
        let config = QualityGateConfig::default();
        assert_eq!(evaluate_quality_gate(&config, 0.0, 5), Ok(()));
    }

    #[test]
    fn quality_gate_honors_custom_max_contact_quality() {
        let config = QualityGateConfig {
            max_contact_quality: 2.0,
            min_sample_count: 1,
        };
        assert_eq!(evaluate_quality_gate(&config, 2.0, 1), Ok(()));
        assert!(evaluate_quality_gate(&config, 2.1, 1).is_err());
    }

    #[test]
    fn thresholds_validate_rejects_out_of_range() {
        let mut thresholds = ModelThresholds {
            start_threshold: 0.0,
            ..Default::default()
        };
        assert!(thresholds.validate().is_err());
        thresholds.start_threshold = 1.5;
        assert!(thresholds.validate().is_err());
    }

    #[test]
    fn thresholds_validate_accepts_boundary_one() {
        let thresholds = ModelThresholds {
            start_threshold: 1.0,
            release_threshold: 1.0,
        };
        assert!(thresholds.validate().is_ok());
    }

    #[test]
    fn quality_gate_config_validate_rejects_zero_sample_count() {
        let config = QualityGateConfig {
            max_contact_quality: 0.0,
            min_sample_count: 0,
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn legal_transition_allows_draft_evaluated_approved_and_denies_skips() {
        use ModelLifecycleState::*;
        assert!(legal_transition(Draft, Evaluated));
        assert!(legal_transition(Evaluated, Approved));
        assert!(!legal_transition(Draft, Approved));
        assert!(!legal_transition(Draft, Active));
        assert!(!legal_transition(Active, Draft));
    }

    #[test]
    fn legal_transition_allows_archive_and_restore() {
        use ModelLifecycleState::*;
        assert!(legal_transition(Evaluated, Archived));
        assert!(legal_transition(Approved, Archived));
        assert!(legal_transition(Archived, Draft));
        assert!(!legal_transition(Archived, Active));
    }

    #[test]
    fn model_record_new_starts_draft_with_one_history_entry() {
        let record = ModelRecord::new("model-1".to_string());
        assert_eq!(record.state, ModelLifecycleState::Draft);
        assert_eq!(record.history.len(), 1);
        assert_eq!(record.history[0].from, None);
        assert_eq!(record.history[0].to, ModelLifecycleState::Draft);
    }

    #[test]
    fn model_record_push_transition_appends_history_and_updates_state() {
        let mut record = ModelRecord::new("model-1".to_string());
        record.push_transition(ModelLifecycleState::Evaluated);
        assert_eq!(record.state, ModelLifecycleState::Evaluated);
        assert_eq!(record.history.len(), 2);
        assert_eq!(record.history[1].from, Some(ModelLifecycleState::Draft));
        assert_eq!(record.history[1].to, ModelLifecycleState::Evaluated);
    }

    #[test]
    fn inference_mode_defaults_off() {
        assert_eq!(InferenceMode::default(), InferenceMode::Off);
    }

    #[test]
    fn registry_index_round_trips_through_json() {
        let mut index = RegistryIndex::default();
        index.models.push(ModelRecord::new("model-1".to_string()));
        index.inference_mode = InferenceMode::Monitor;
        let json = serde_json::to_string(&index).expect("must serialize");
        let restored: RegistryIndex = serde_json::from_str(&json).expect("must deserialize");
        assert_eq!(restored.models.len(), 1);
        assert_eq!(restored.inference_mode, InferenceMode::Monitor);
    }

    #[test]
    fn allowed_intents_for_class_restricts_start_release_and_negative() {
        assert_eq!(
            allowed_intents_for_class("pinch_start"),
            &[GestureIntent::VolumeGrab, GestureIntent::NoAction]
        );
        assert_eq!(
            allowed_intents_for_class("pinch_release"),
            &[GestureIntent::VolumeRelease, GestureIntent::NoAction]
        );
        assert_eq!(
            allowed_intents_for_class("negative"),
            &[GestureIntent::NoAction]
        );
        assert!(!allowed_intents_for_class("pinch_start").contains(&GestureIntent::Mute));
        assert!(!allowed_intents_for_class("negative").contains(&GestureIntent::VolumeGrab));
    }

    fn safe_bindings() -> Vec<ModelIntentBinding> {
        vec![
            ModelIntentBinding {
                class_label: "negative".to_string(),
                intent: GestureIntent::NoAction,
            },
            ModelIntentBinding {
                class_label: "pinch_start".to_string(),
                intent: GestureIntent::VolumeGrab,
            },
            ModelIntentBinding {
                class_label: "pinch_release".to_string(),
                intent: GestureIntent::VolumeRelease,
            },
        ]
    }

    #[test]
    fn validate_intent_bindings_accepts_the_normal_safe_mapping() {
        assert!(validate_intent_bindings(&safe_bindings()).is_ok());
    }

    #[test]
    fn validate_intent_bindings_accepts_disabling_a_class_via_no_action() {
        let mut bindings = safe_bindings();
        bindings[1].intent = GestureIntent::NoAction;
        assert!(validate_intent_bindings(&bindings).is_ok());
    }

    #[test]
    fn validate_intent_bindings_rejects_unsafe_intent_for_pinch_start() {
        let mut bindings = safe_bindings();
        bindings[1].intent = GestureIntent::Mute;
        assert!(validate_intent_bindings(&bindings).is_err());
    }

    #[test]
    fn validate_intent_bindings_rejects_unsafe_intent_for_pinch_release() {
        let mut bindings = safe_bindings();
        bindings[2].intent = GestureIntent::PlayPause;
        assert!(validate_intent_bindings(&bindings).is_err());
    }

    #[test]
    fn validate_intent_bindings_rejects_actuating_intent_for_negative() {
        let mut bindings = safe_bindings();
        bindings[0].intent = GestureIntent::VolumeGrab;
        assert!(validate_intent_bindings(&bindings).is_err());
    }

    #[test]
    fn validate_intent_bindings_rejects_incomplete_set() {
        let bindings = vec![safe_bindings().remove(0)];
        assert!(validate_intent_bindings(&bindings).is_err());
    }

    /// D-M3-3: a corrupt registry.json must surface as an error and stay on
    /// disk untouched, not read as an empty index that a later write would
    /// persist over every model's lifecycle state.
    #[test]
    fn corrupt_registry_is_an_error_and_is_not_overwritten() {
        let dir = unique_bundle_dir("corrupt-registry");
        let path = dir.join(REGISTRY_FILE_NAME);
        fs::write(&path, "{ this is not json").unwrap();

        let error = read_registry_file(&path).unwrap_err();
        assert!(error.contains("corrupt"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ this is not json");
    }

    #[test]
    fn missing_registry_is_an_empty_index() {
        let dir = unique_bundle_dir("missing-registry");
        let index = read_registry_file(&dir.join(REGISTRY_FILE_NAME)).unwrap();
        assert!(index.models.is_empty());
        assert!(index.active_model_id.is_none());
    }

    #[test]
    fn valid_registry_round_trips() {
        let dir = unique_bundle_dir("valid-registry");
        let path = dir.join(REGISTRY_FILE_NAME);
        let mut index = RegistryIndex::default();
        index.models.push(ModelRecord::new("model-a".to_string()));
        fs::write(&path, serde_json::to_string(&index).unwrap()).unwrap();
        let loaded = read_registry_file(&path).unwrap();
        assert_eq!(loaded.models.len(), 1);
        assert_eq!(loaded.models[0].id, "model-a");
    }

    fn unique_bundle_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "model-registry-test-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("must create temp dir");
        dir
    }

    /// Writes a bundle that satisfies [`load_and_verify_bundle`]'s full
    /// contract, then hands back the metadata JSON as a mutable `Value` so
    /// individual tests can corrupt exactly one field before writing it.
    fn write_valid_bundle(dir: &Path) -> serde_json::Value {
        // The same fixture the trainer's own test suite validates with
        // `bundle.validate_metadata` (tools/pinch-classifier/tests/test_bundle.py),
        // so a bundle accepted here is one the writer-side contract accepts.
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tools/pinch-classifier/tests/fixtures/valid_bundle");
        fs::copy(
            fixture.join(TFLITE_MODEL_FILE_NAME),
            dir.join(TFLITE_MODEL_FILE_NAME),
        )
        .unwrap();
        fs::copy(
            fixture.join(TFLITE_METADATA_FILE_NAME),
            dir.join(TFLITE_METADATA_FILE_NAME),
        )
        .unwrap();
        serde_json::from_str(&fs::read_to_string(dir.join(TFLITE_METADATA_FILE_NAME)).unwrap())
            .unwrap()
    }

    fn write_metadata(dir: &Path, metadata: &serde_json::Value) {
        fs::write(
            dir.join(TFLITE_METADATA_FILE_NAME),
            serde_json::to_string_pretty(metadata).unwrap(),
        )
        .unwrap();
    }

    /// Like [`write_valid_bundle`], but with a custom (possibly reduced)
    /// declared feature list, for exercising [`validate_feature_subset`]
    /// through the full bundle contract.
    fn write_bundle_with_features(dir: &Path, feature_names: &[&str]) -> serde_json::Value {
        let mut metadata = write_valid_bundle(dir);
        metadata["feature_contract"] = serde_json::json!({
            "count": feature_names.len(),
            "ordered_names": feature_names,
        });
        metadata["model"]["input_shape"] = serde_json::json!([1, feature_names.len()]);
        write_metadata(dir, &metadata);
        metadata
    }

    #[test]
    fn sha256_hex_matches_known_test_vector() {
        let dir = unique_bundle_dir("sha256-vector");
        fs::write(dir.join("empty"), b"").unwrap();
        assert_eq!(
            sha256_hex(&dir.join("empty")).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_accepts_a_valid_bundle() {
        let dir = unique_bundle_dir("valid");
        write_valid_bundle(&dir);
        let result = load_and_verify_bundle(&dir);
        assert!(result.is_ok(), "{result:?}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_a_model_file_that_no_longer_matches_the_recorded_digest() {
        let dir = unique_bundle_dir("digest-mismatch");
        write_valid_bundle(&dir);
        // Simulate the model bytes changing (corruption or tampering) after
        // metadata.json was written and validated.
        fs::write(
            dir.join(TFLITE_MODEL_FILE_NAME),
            b"different-bytes-entirely",
        )
        .unwrap();
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_missing_metadata() {
        let dir = unique_bundle_dir("missing-metadata");
        fs::write(dir.join(TFLITE_MODEL_FILE_NAME), b"fake-tflite-bytes").unwrap();
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_wrong_schema_version() {
        let dir = unique_bundle_dir("schema-version");
        let mut metadata = write_valid_bundle(&dir);
        metadata["schema_version"] = serde_json::json!(2);
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_swapped_class_order() {
        let dir = unique_bundle_dir("class-order");
        let mut metadata = write_valid_bundle(&dir);
        metadata["classes"] = serde_json::json!([
            {"index": 0, "label": "negative"},
            {"index": 1, "label": "pinch_release"},
            {"index": 2, "label": "pinch_start"},
        ]);
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_truncated_feature_contract() {
        let dir = unique_bundle_dir("feature-contract");
        let mut metadata = write_valid_bundle(&dir);
        metadata["feature_contract"]["ordered_names"] = serde_json::json!(["ppg_green_mean"]);
        metadata["feature_contract"]["count"] = serde_json::json!(1);
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_accepts_versioned_custom_canonical_subset() {
        let dir = unique_bundle_dir("custom-contract");
        let mut metadata = write_valid_bundle(&dir);
        metadata["feature_contract"] = serde_json::json!({"count": 2, "ordered_names": ["ppg_green_mean", "gyro_magnitude_std"]});
        metadata["model"]["input_shape"] = serde_json::json!([1, 2]);
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_wrong_output_shape() {
        let dir = unique_bundle_dir("output-shape");
        let mut metadata = write_valid_bundle(&dir);
        metadata["model"]["output_shape"] = serde_json::json!([1, 4]);
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    /// D-M3-6: every case below passed the desktop's activation gate while the
    /// trainer's `validate_metadata` rejected it. An imported bundle never
    /// went through the trainer's writer-side check, so the desktop gate must
    /// reject each of these itself.
    fn assert_mutation_is_rejected(label: &str, mutate: impl FnOnce(&mut serde_json::Value)) {
        let dir = unique_bundle_dir(label);
        let mut metadata = write_valid_bundle(&dir);
        mutate(&mut metadata);
        write_metadata(&dir, &metadata);
        let result = load_and_verify_bundle(&dir);
        fs::remove_dir_all(&dir).ok();
        assert!(result.is_err(), "{label}: bundle must be rejected");
    }

    #[test]
    fn load_and_verify_bundle_rejects_a_missing_or_unsupported_preprocessing_policy() {
        assert_mutation_is_rejected("no-preprocessing", |m| {
            m.as_object_mut().unwrap().remove("preprocessing");
        });
        assert_mutation_is_rejected("raw-preprocessing", |m| {
            m["preprocessing"]["normalization"] =
                serde_json::json!("none; raw feature values fed directly");
        });
    }

    #[test]
    fn load_and_verify_bundle_rejects_missing_or_failed_conversion_parity() {
        assert_mutation_is_rejected("no-parity", |m| {
            m.as_object_mut().unwrap().remove("conversion_parity");
        });
        assert_mutation_is_rejected("failed-parity", |m| {
            m["conversion_parity"]["passed"] = serde_json::json!(false);
        });
        assert_mutation_is_rejected("parity-error-over-tolerance", |m| {
            m["conversion_parity"]["max_absolute_error"] = serde_json::json!(1.0);
        });
        assert_mutation_is_rejected("parity-argmax-disagrees", |m| {
            m["conversion_parity"]["argmax_agreement"] = serde_json::json!(0.9);
        });
    }

    #[test]
    fn load_and_verify_bundle_rejects_missing_or_leaky_training_provenance() {
        assert_mutation_is_rejected("no-training", |m| {
            m.as_object_mut().unwrap().remove("training");
        });
        assert_mutation_is_rejected("leaky-split", |m| {
            m["training"]["groups_test"] = m["training"]["groups_train"].clone();
        });
        assert_mutation_is_rejected("zero-epochs", |m| {
            m["training"]["epochs"] = serde_json::json!(0);
        });
    }

    #[test]
    fn load_and_verify_bundle_rejects_a_bad_window_config_or_dtype() {
        assert_mutation_is_rejected("no-window-config", |m| {
            m.as_object_mut().unwrap().remove("window_config");
        });
        assert_mutation_is_rejected("zero-window", |m| {
            m["window_config"]["window_ms"] = serde_json::json!(0);
        });
        assert_mutation_is_rejected("zero-min-samples", |m| {
            m["window_config"]["min_samples_per_window"] = serde_json::json!(0);
        });
        assert_mutation_is_rejected("int8-input", |m| {
            m["model"]["input_dtype"] = serde_json::json!("int8");
        });
    }

    #[test]
    fn load_and_verify_bundle_rejects_an_uppercase_digest() {
        let dir = unique_bundle_dir("uppercase-digest");
        let mut metadata = write_valid_bundle(&dir);
        let upper = metadata["model"]["sha256"].as_str().unwrap().to_uppercase();
        metadata["model"]["sha256"] = serde_json::json!(upper);
        write_metadata(&dir, &metadata);
        let result = load_and_verify_bundle(&dir);
        fs::remove_dir_all(&dir).ok();
        assert!(result.is_err());
    }

    #[test]
    fn load_and_verify_bundle_rejects_malformed_sha256() {
        let dir = unique_bundle_dir("malformed-digest");
        let mut metadata = write_valid_bundle(&dir);
        metadata["model"]["sha256"] = serde_json::json!("not-a-hex-digest");
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_feature_subset_accepts_full_canonical_registry() {
        let names: Vec<String> = FEATURE_NAMES.iter().map(|name| name.to_string()).collect();
        let indices = validate_feature_subset(&names).expect("must accept full registry");
        assert_eq!(indices, (0..FEATURE_COUNT).collect::<Vec<_>>());
    }

    #[test]
    fn validate_feature_subset_accepts_canonical_order_subset() {
        let names = vec![
            FEATURE_NAMES[0].to_string(),
            FEATURE_NAMES[2].to_string(),
            FEATURE_NAMES[5].to_string(),
        ];
        assert_eq!(validate_feature_subset(&names).unwrap(), vec![0, 2, 5]);
    }

    #[test]
    fn validate_feature_subset_rejects_empty() {
        assert!(validate_feature_subset(&[]).is_err());
    }

    #[test]
    fn validate_feature_subset_rejects_duplicate() {
        let names = vec![FEATURE_NAMES[0].to_string(), FEATURE_NAMES[0].to_string()];
        assert!(validate_feature_subset(&names).is_err());
    }

    #[test]
    fn validate_feature_subset_rejects_unknown_name() {
        let names = vec!["not_a_real_feature".to_string()];
        assert!(validate_feature_subset(&names).is_err());
    }

    #[test]
    fn validate_feature_subset_rejects_reordering() {
        let names = vec![FEATURE_NAMES[5].to_string(), FEATURE_NAMES[0].to_string()];
        assert!(validate_feature_subset(&names).is_err());
    }

    #[test]
    fn load_and_verify_bundle_accepts_a_strict_canonical_order_subset() {
        let dir = unique_bundle_dir("feature-subset-valid");
        let subset = [FEATURE_NAMES[0], FEATURE_NAMES[2], FEATURE_NAMES[10]];
        write_bundle_with_features(&dir, &subset);
        let (_, _, feature_indices) = load_and_verify_bundle(&dir).expect("must accept subset");
        assert_eq!(feature_indices, vec![0, 2, 10]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_reordered_subset() {
        let dir = unique_bundle_dir("feature-subset-reordered");
        let subset = [FEATURE_NAMES[10], FEATURE_NAMES[0]];
        write_bundle_with_features(&dir, &subset);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_unknown_feature_name() {
        let dir = unique_bundle_dir("feature-subset-unknown");
        let subset = ["not_a_real_feature"];
        write_bundle_with_features(&dir, &subset);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_duplicate_feature_name() {
        let dir = unique_bundle_dir("feature-subset-duplicate");
        let subset = [FEATURE_NAMES[0], FEATURE_NAMES[0]];
        write_bundle_with_features(&dir, &subset);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_and_verify_bundle_rejects_input_shape_mismatched_with_declared_feature_count() {
        let dir = unique_bundle_dir("feature-subset-shape-mismatch");
        let subset = [FEATURE_NAMES[0], FEATURE_NAMES[2]];
        let mut metadata = write_bundle_with_features(&dir, &subset);
        metadata["model"]["input_shape"] = serde_json::json!([1, FEATURE_COUNT]);
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
