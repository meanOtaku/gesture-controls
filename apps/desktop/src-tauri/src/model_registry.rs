//! Persisted desktop-owned pinch model lifecycle: Draft/Evaluated/Approved/
//! Active/Archived state per trained model, per-model inference thresholds
//! and sensor-quality gate, single-active-model selection with rollback, and
//! the global inference mode (Off/Monitor/Live). This is the registry that
//! [`crate::inference`] reads to decide which model (if any) to run and how
//! to gate/act on its output — see `apps/desktop/ARCHITECTURE.md` and the
//! project's non-negotiable rule that all pinch inference/lifecycle logic
//! lives on the desktop, never on the watch or headphones.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::model_lab::{self, MODEL_LAB_DIR_NAME};

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
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
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

/// The active model's sensor-quality gate, or `None` if inference is `Off`
/// or no model is active -- callers should skip quality gating entirely in
/// that case, since there is nothing running that a stale/degraded window
/// could corrupt.
pub(crate) fn active_quality_gate(app: &AppHandle) -> Option<QualityGateConfig> {
    let index = load_registry(app);
    if index.inference_mode == InferenceMode::Off {
        return None;
    }
    let active_id = index.active_model_id.as_ref()?;
    index
        .models
        .iter()
        .find(|model| &model.id == active_id)
        .map(|model| model.quality_gate)
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

/// Activates `id`: requires it be `Approved` and a validated TFLite bundle.
/// Any currently Active model is demoted back to `Approved` and remembered
/// as `previous_active_model_id` so [`rollback_active_model`] can restore it.
#[tauri::command]
pub fn activate_model(
    id: String,
    app: AppHandle,
    runtime: State<'_, ModelRegistryRuntime>,
) -> Result<RegistryView, String> {
    model_is_activatable(&app, &id)?;
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
) -> Result<RegistryView, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model registry lock was poisoned".to_string())?;
    let mut index = load_registry(&app);
    let Some(previous_id) = index.previous_active_model_id.clone() else {
        return Err("no previous active model to roll back to".to_string());
    };
    let current_active = index.active_model_id.clone();

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
}
