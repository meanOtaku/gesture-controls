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

use crate::inference::{GesturePolicyRuntime, PinchInferenceRuntime};
use crate::model_lab::{self, MODEL_LAB_DIR_NAME};
use interaction_engine::{ForceReleaseReason, GestureIntent};
use pinch_inference::{CLASS_COUNT, FEATURE_COUNT, FEATURE_NAMES};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InferenceMode {
    Off,
    Monitor,
    Live,
}

impl Default for InferenceMode {
    fn default() -> Self {
        // Fail-closed default: a fresh install never drives desktop actions
        // from inference until a user explicitly opts in.
        InferenceMode::Off
    }
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

fn load_registry(app: &AppHandle) -> RegistryIndex {
    let Ok(path) = registry_path(app) else {
        return RegistryIndex::default();
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return RegistryIndex::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
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

#[derive(Debug, Deserialize)]
struct BundleFeatureContract {
    count: usize,
    ordered_names: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BundleMetadata {
    schema_version: u64,
    model: BundleModelField,
    classes: Vec<BundleClassEntry>,
    feature_contract: BundleFeatureContract,
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

/// Fully revalidates a model directory's bundle contract against the desktop's
/// fixed feature/class contract and recomputes `model.tflite`'s digest --
/// never trusts that a file named `metadata.json` still matches the bytes on
/// disk, since either could have been replaced or corrupted after the model
/// was approved. Returns the parsed metadata plus the freshly recomputed
/// (verified-matching) digest. This is the single choke point
/// [`ActiveModelSnapshot::verified`] runs through at activation, rollback,
/// and every runtime (re)load.
fn load_and_verify_bundle(dir: &Path) -> Result<(BundleMetadata, String), String> {
    let metadata_path = dir.join(TFLITE_METADATA_FILE_NAME);
    let contents = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("failed to read {TFLITE_METADATA_FILE_NAME}: {error}"))?;
    let metadata: BundleMetadata = serde_json::from_str(&contents).map_err(|error| {
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

    let features_match = metadata.feature_contract.count == FEATURE_COUNT
        && metadata.feature_contract.ordered_names.len() == FEATURE_NAMES.len()
        && metadata
            .feature_contract
            .ordered_names
            .iter()
            .zip(FEATURE_NAMES.iter())
            .all(|(actual, expected)| actual.as_str() == *expected);
    if !features_match {
        return Err(
            "bundle feature_contract does not match the desktop's 55-feature contract".to_string(),
        );
    }

    if metadata.model.file != TFLITE_MODEL_FILE_NAME || metadata.model.format != BUNDLE_MODEL_FORMAT
    {
        return Err(format!(
            "bundle model must be '{TFLITE_MODEL_FILE_NAME}' in {BUNDLE_MODEL_FORMAT} format"
        ));
    }
    if metadata.model.input_shape != vec![1, FEATURE_COUNT as u64] {
        return Err(
            "bundle model input_shape does not match the desktop's feature contract".to_string(),
        );
    }
    if metadata.model.output_shape != vec![1, CLASS_COUNT as u64] {
        return Err(
            "bundle model output_shape does not match the desktop's class contract".to_string(),
        );
    }

    let digest = metadata.model.sha256.to_lowercase();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("bundle model.sha256 is not a valid SHA-256 hex digest".to_string());
    }
    let actual_digest = sha256_hex(&dir.join(TFLITE_MODEL_FILE_NAME))?;
    if actual_digest != digest {
        return Err(format!(
            "model.tflite digest mismatch: metadata records {digest}, actual file hashes to {actual_digest}"
        ));
    }

    Ok((metadata, actual_digest))
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
        let index = load_registry(app);
        let model = index
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| format!("no registered model with id '{model_id}'"))?;
        validate_intent_bindings(&model.intent_bindings)?;
        model.thresholds.validate()?;
        model.quality_gate.validate()?;

        let dir = model_lab::models_dir(app)?.join(model_id);
        let (metadata, digest) = load_and_verify_bundle(&dir)?;
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

/// The active model's id, thresholds, and sensor-quality gate, or `None` if
/// inference is `Off` or no model is active -- callers should skip quality
/// gating and classification entirely in that case, since there is nothing
/// running that a stale/degraded window could corrupt.
pub(crate) fn active_model_runtime_config(
    app: &AppHandle,
) -> Option<(String, ModelThresholds, QualityGateConfig)> {
    let index = load_registry(app);
    if index.inference_mode == InferenceMode::Off {
        return None;
    }
    let active_id = index.active_model_id.clone()?;
    index
        .models
        .iter()
        .find(|model| model.id == active_id)
        .map(|model| (active_id, model.thresholds, model.quality_gate))
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
    let index = load_registry(app);
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
    let mut index = load_registry(app);
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

#[tauri::command]
pub fn get_model_registry(
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    Ok(RegistryView::from(load_registry(&app)))
}

#[tauri::command]
pub fn transition_model_state(
    id: String,
    to: ModelLifecycleState,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
    if index.active_model_id.as_deref() == Some(id.as_str()) {
        return Err("cannot transition the active model directly; use rollback_active_model or activate a different model first".to_string());
    }
    {
        let model = find_model_mut(&mut index, &id)?;
        if !legal_transition(model.state, to) {
            return Err(format!("illegal transition {:?} -> {:?}", model.state, to));
        }
        model.push_transition(to);
    }
    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    Ok(RegistryView::from(index))
}

#[tauri::command]
pub fn update_model_thresholds(
    id: String,
    thresholds: ModelThresholds,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    thresholds.validate()?;
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
    find_model_mut(&mut index, &id)?.thresholds = thresholds;
    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    Ok(RegistryView::from(index))
}

#[tauri::command]
pub fn update_model_quality_gate(
    id: String,
    quality_gate: QualityGateConfig,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    quality_gate.validate()?;
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
    find_model_mut(&mut index, &id)?.quality_gate = quality_gate;
    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    Ok(RegistryView::from(index))
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
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
    let model = find_model_mut(&mut index, &id)?;
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
    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    Ok(RegistryView::from(index))
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
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
    {
        let model = find_model_mut(&mut index, &id)?;
        if model.state != ModelLifecycleState::Approved {
            return Err(format!(
                "model '{id}' must be Approved before activation (currently {:?})",
                model.state
            ));
        }
    }
    // Revalidate the full bundle contract, digest, and bindings under the
    // same lock as the state check above -- a stale `Approved` state on disk
    // must never be trusted alone, and nothing may mutate the record between
    // this validation and the swap below (see `ActiveModelSnapshot::verified`).
    ActiveModelSnapshot::verified(&app, &id)?;

    force_release_before_swap(&app, &gesture_policy, &pinch_inference);

    let previous_active = index.active_model_id.clone();
    if let Some(previous_id) = &previous_active {
        if previous_id != &id {
            if let Ok(previous) = find_model_mut(&mut index, previous_id) {
                previous.push_transition(ModelLifecycleState::Approved);
            }
        }
    }
    find_model_mut(&mut index, &id)?.push_transition(ModelLifecycleState::Active);
    index.previous_active_model_id = previous_active.filter(|previous_id| previous_id != &id);
    index.active_model_id = Some(id);

    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    Ok(RegistryView::from(index))
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
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
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
        find_model_mut(&mut index, current_id)?.push_transition(ModelLifecycleState::Approved);
    }
    find_model_mut(&mut index, &previous_id)?.push_transition(ModelLifecycleState::Active);
    index.active_model_id = Some(previous_id);
    index.previous_active_model_id = current_active;

    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    Ok(RegistryView::from(index))
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
) -> Result<RegistryView, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
    index.inference_mode = mode;
    write_registry_atomic(&app, &index)?;
    emit_registry(&app, &index);
    if let Some(decision) = gesture_policy.set_mode(mode)? {
        crate::inference::apply_decision(&app, decision);
    }
    Ok(RegistryView::from(index))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut thresholds = ModelThresholds::default();
        thresholds.start_threshold = 0.0;
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
        fs::write(dir.join(TFLITE_MODEL_FILE_NAME), b"fake-tflite-bytes").unwrap();
        let digest = sha256_hex(&dir.join(TFLITE_MODEL_FILE_NAME)).unwrap();
        let feature_names: Vec<String> =
            FEATURE_NAMES.iter().map(|name| name.to_string()).collect();
        let metadata = serde_json::json!({
            "schema_version": BUNDLE_SCHEMA_VERSION,
            "model": {
                "file": TFLITE_MODEL_FILE_NAME,
                "format": BUNDLE_MODEL_FORMAT,
                "sha256": digest,
                "input_shape": [1, FEATURE_COUNT],
                "output_shape": [1, CLASS_COUNT],
            },
            "classes": [
                {"index": 0, "label": "negative"},
                {"index": 1, "label": "pinch_start"},
                {"index": 2, "label": "pinch_release"},
            ],
            "feature_contract": {
                "count": FEATURE_COUNT,
                "ordered_names": feature_names,
            },
        });
        fs::write(
            dir.join(TFLITE_METADATA_FILE_NAME),
            serde_json::to_string_pretty(&metadata).unwrap(),
        )
        .unwrap();
        metadata
    }

    fn write_metadata(dir: &Path, metadata: &serde_json::Value) {
        fs::write(
            dir.join(TFLITE_METADATA_FILE_NAME),
            serde_json::to_string_pretty(metadata).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn sha256_hex_matches_known_test_vector() {
        let dir = unique_bundle_dir("sha256-vector");
        fs::write(dir.join("empty"), b"").unwrap();
        assert_eq!(
            sha256_hex(&dir.join("empty")).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85"
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
    fn load_and_verify_bundle_rejects_wrong_output_shape() {
        let dir = unique_bundle_dir("output-shape");
        let mut metadata = write_valid_bundle(&dir);
        metadata["model"]["output_shape"] = serde_json::json!([1, 4]);
        write_metadata(&dir, &metadata);
        assert!(load_and_verify_bundle(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
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
}
