//! Runs the per-label models in this process (see `crates/label-inference`), fed by the same watch events as the rest
//! of the app.
//!
//! This is the host: it opens the per-label registry, loads whichever models are active, feeds telemetry in, ticks a
//! timer so a stalled stream is noticed, and reports what the runtime decides. It decides nothing itself. Detections
//! are held here for the recipe engine to read; nothing in this module performs an action.
//!
//! The runtime stays **Off** until the registry says otherwise, and any failure to open or load leaves it Off or leaves
//! that label without a model: it fails closed.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use label_inference::{
    ClearReason, Conflict, DetectionEvent, LabelRuntime, ModelLoadFailure, RuntimeMode,
    RuntimeOutput, clean_staging, load_active_models, publish_staged, stage_bundle,
};
use model_lab_core::{
    FileStore, LabelId, LifecycleState, ModelVersionId, RegistryStore, open_registry,
};
use serde::Serialize;
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{info, warn};

use crate::automation::AutomationRuntime;
use crate::model_lab::MODEL_LAB_DIR_NAME;

pub const LABEL_DETECTIONS_EVENT: &str = "label-detections";
/// Sent when the set of registered models changes (an import).
pub const LABEL_MODELS_EVENT: &str = "label-models-changed";
const TICK_INTERVAL: Duration = Duration::from_millis(100);

/// What the UI and the recipe engine are told when detections change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionReport {
    pub events: Vec<DetectionEventView>,
    pub conflicts: Vec<Vec<String>>,
    pub rejections: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DetectionEventView {
    Rising {
        label: String,
        confidence: f64,
        timestamp_ns: u64,
    },
    Active {
        label: String,
        confidence: f64,
        timestamp_ns: u64,
    },
    Falling {
        label: String,
        timestamp_ns: u64,
        reason: String,
    },
}

impl From<&DetectionEvent> for DetectionEventView {
    fn from(event: &DetectionEvent) -> Self {
        match event {
            DetectionEvent::Rising {
                label,
                confidence,
                timestamp_ns,
            } => Self::Rising {
                label: label.to_string(),
                confidence: *confidence,
                timestamp_ns: *timestamp_ns,
            },
            DetectionEvent::Active {
                label,
                confidence,
                timestamp_ns,
            } => Self::Active {
                label: label.to_string(),
                confidence: *confidence,
                timestamp_ns: *timestamp_ns,
            },
            DetectionEvent::Falling {
                label,
                timestamp_ns,
                reason,
            } => Self::Falling {
                label: label.to_string(),
                timestamp_ns: *timestamp_ns,
                reason: match reason {
                    ClearReason::ScoreBelowRelease => "scoreBelowRelease".to_string(),
                    ClearReason::Conflict => "conflict".to_string(),
                    ClearReason::Rejected(why) => format!("rejected: {why}"),
                    ClearReason::ModelChanged => "modelChanged".to_string(),
                    ClearReason::Runtime(why) => format!("runtime: {why}"),
                },
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedView {
    pub id: String,
    pub diagnostic: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadFailureView {
    pub label: String,
    pub version: String,
    pub detail: String,
}

impl From<&ModelLoadFailure> for LoadFailureView {
    fn from(failure: &ModelLoadFailure) -> Self {
        Self {
            label: failure.label.to_string(),
            version: failure.version.to_string(),
            detail: failure.detail.clone(),
        }
    }
}

/// One registered model, for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelModelView {
    pub id: String,
    pub label: String,
    pub state: LifecycleState,
    pub deployable: bool,
    pub imported: bool,
    pub model_sha256: Option<String>,
    pub created_at: String,
    /// This model is the label's active one.
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedModelView {
    pub id: String,
    pub label: String,
    pub model_sha256: String,
    pub project_created: bool,
}

/// A snapshot of the runtime for the UI.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRuntimeStatus {
    pub mode: String,
    pub loaded_labels: Vec<String>,
    pub load_failures: Vec<LoadFailureView>,
    pub quarantined: Vec<QuarantinedView>,
    /// Set when the registry could not be opened; the runtime is then Off.
    pub registry_error: Option<String>,
    /// Labels detected right now that are cleared to act (Live only).
    pub active_detections: Vec<String>,
    pub last_scores: BTreeMap<String, f64>,
}

/// Decides when the recipe engine needs to hear from the label runtime. The runtime reports on every watch sample (tens of
/// times a second), but recipes only care when what they can see changes: what is loaded, what is detected, a one-shot
/// starting or being cut short, and a one-shot's moment ending. Telling the engine about every sample made every sample
/// cost an extra engine step.
#[derive(Default)]
struct PushGate {
    last: Option<(BTreeSet<String>, BTreeSet<String>)>,
    /// When a one-shot that started recently stops counting, so the engine is told once more to forget it.
    pulse_expires_ns: Option<u64>,
}

impl PushGate {
    fn needed(
        &mut self,
        loaded: &BTreeSet<String>,
        held: &BTreeSet<String>,
        edges: bool,
        now_ns: u64,
    ) -> bool {
        let changed = self
            .last
            .as_ref()
            .is_none_or(|(l, h)| l != loaded || h != held);
        if changed {
            self.last = Some((loaded.clone(), held.clone()));
        }
        let expired = self.pulse_expires_ns.is_some_and(|at| now_ns >= at);
        if expired {
            self.pulse_expires_ns = None;
        }
        if edges {
            // A little past the engine's own window, so the push that clears it lands after the pulse is over.
            self.pulse_expires_ns = Some(now_ns + crate::automation::MODEL_PULSE_NS + 1_000_000);
        }
        changed || edges || expired
    }
}

#[derive(Default)]
struct HostState {
    status: LabelRuntimeStatus,
    /// Labels whose detection is currently active and allowed to be acted on.
    actionable_active: BTreeSet<LabelId>,
    store: Option<RegistryStore<FileStore>>,
}

pub struct LabelRuntimeHost {
    push_gate: Mutex<PushGate>,
    runtime: Mutex<LabelRuntime>,
    state: Mutex<HostState>,
    started_at: Instant,
}

impl Default for LabelRuntimeHost {
    fn default() -> Self {
        Self {
            push_gate: Mutex::new(PushGate::default()),
            runtime: Mutex::new(LabelRuntime::default()),
            state: Mutex::new(HostState::default()),
            started_at: Instant::now(),
        }
    }
}

fn mode_name(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Off => "off",
        RuntimeMode::Monitor => "monitor",
        RuntimeMode::Live => "live",
    }
}

impl LabelRuntimeHost {
    fn now_ns(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64
    }

    /// The labels with a detection that is active and cleared to be acted on.
    #[allow(dead_code)]
    pub fn active_detections(&self) -> BTreeSet<LabelId> {
        self.state
            .lock()
            .map(|s| s.actionable_active.clone())
            .unwrap_or_default()
    }

    /// Every label a project, mapping or model in the registry refers to; `None` when there is no registry to ask.
    pub fn labels_in_registry(&self) -> Option<BTreeSet<String>> {
        let state = self.state.lock().ok()?;
        let registry = state.store.as_ref()?.registry();
        let mut labels = BTreeSet::new();
        for project in registry.projects.values() {
            labels.insert(project.target.to_string());
            labels.extend(project.mapping.entries.keys().map(ToString::to_string));
        }
        labels.extend(registry.versions.values().map(|v| v.label.to_string()));
        Some(labels)
    }

    pub fn status(&self) -> LabelRuntimeStatus {
        self.state
            .lock()
            .map(|s| s.status.clone())
            .unwrap_or_default()
    }

    /// Opens the registry (migrating the old one if needed), loads the active models and sets the mode. Anything that
    /// fails leaves the runtime Off and says why.
    pub fn load(&self, app: &AppHandle) {
        let Ok(base) = app.path().app_data_dir() else {
            self.set_registry_error("could not resolve the app data directory".into());
            return;
        };
        let dir: PathBuf = base.join(MODEL_LAB_DIR_NAME);
        // Whatever an interrupted import left behind is not trusted.
        clean_staging(&dir);
        let legacy = dir.join("registry.json");
        let (mut store, report) = match open_registry(&dir, Some(&legacy)) {
            Ok(opened) => opened,
            Err(error) => {
                warn!(%error, "the per-label model registry could not be opened; label inference stays off");
                self.set_registry_error(error.to_string());
                return;
            }
        };
        if let Some(report) = &report {
            info!(
                legacy = report.legacy_models,
                quarantined = report.quarantined,
                "migrated the old model registry"
            );
        }
        // A remembered Live restarts as Monitor, and that is saved so the registry and the runtime agree.
        let startup_mode = store.registry().mode_at_startup();
        if startup_mode != store.registry().inference_mode
            && let Err(error) = store.mutate(|r| {
                r.set_inference_mode(startup_mode);
                Ok(())
            })
        {
            warn!(%error, "could not save the startup inference mode");
            // Running in the remembered Live mode is not an option: stay off.
            self.set_registry_error(format!(
                "could not save the startup inference mode: {error}"
            ));
            return;
        }
        let quarantined: Vec<QuarantinedView> = store
            .registry()
            .quarantined
            .iter()
            .map(|q| QuarantinedView {
                id: q.id.clone(),
                diagnostic: q.diagnostic.clone(),
            })
            .collect();
        if let Ok(mut state) = self.state.lock() {
            state.status = LabelRuntimeStatus {
                quarantined,
                ..LabelRuntimeStatus::default()
            };
            state.store = Some(store);
        }
        self.reload_models(app);
    }

    /// Loads whatever the registry now says is active into the runtime and sets its mode from the registry. A model
    /// that is being replaced is released before the new one is used (the runtime does that); anything that fails to
    /// load leaves that label without a model.
    fn reload_models(&self, app: &AppHandle) {
        let Ok(dir) = Self::model_lab_dir(app) else {
            return;
        };
        let registry = match self.state.lock() {
            Ok(state) => state.store.as_ref().map(|s| s.registry().clone()),
            Err(_) => None,
        };
        let Some(registry) = registry else { return };
        let (models, failures) = load_active_models(&registry, &dir);
        for failure in &failures {
            warn!(label = %failure.label, version = %failure.version, detail = %failure.detail, "an active model could not be loaded");
        }
        let mode: RuntimeMode = registry.inference_mode.into();
        let loaded_labels: Vec<String> = models.iter().map(|m| m.label.to_string()).collect();
        let outputs = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            let first = runtime.set_models(models);
            let second = runtime.set_mode(mode);
            [first, second]
        };
        if let Ok(mut state) = self.state.lock() {
            state.status.mode = mode_name(mode).to_string();
            state.status.loaded_labels = loaded_labels;
            state.status.load_failures = failures.iter().map(LoadFailureView::from).collect();
            state.status.registry_error = None;
        }
        for output in outputs {
            self.dispatch(app, output);
        }
    }

    /// Applies one registry change (saved before it is adopted), then reloads the runtime and tells the UI.
    fn change_registry<T>(
        &self,
        app: &AppHandle,
        change: impl FnOnce(&mut model_lab_core::Registry) -> Result<T, model_lab_core::RegistryError>,
    ) -> Result<T, String> {
        let result = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "model state is unavailable".to_string())?;
            let store = state
                .store
                .as_mut()
                .ok_or_else(|| "the model registry is not available".to_string())?;
            store.mutate(change).map_err(|e| e.to_string())?
        };
        self.reload_models(app);
        let _ = app.emit(LABEL_MODELS_EVENT, ());
        Ok(result)
    }

    fn version_for(&self, id: &str) -> Result<model_lab_core::ModelVersion, String> {
        let id = ModelVersionId::new(id).map_err(|e| e.to_string())?;
        self.state
            .lock()
            .map_err(|_| "model state is unavailable".to_string())?
            .store
            .as_ref()
            .and_then(|s| s.registry().versions.get(&id).cloned())
            .ok_or_else(|| "there is no such model".to_string())
    }

    /// Moves a model between Draft, Evaluated, Approved and Archived. Becoming active is only through activation.
    pub fn set_model_state(
        &self,
        app: &AppHandle,
        id: &str,
        to: LifecycleState,
    ) -> Result<(), String> {
        let id = ModelVersionId::new(id).map_err(|e| e.to_string())?;
        let now = Self::now_rfc3339();
        self.change_registry(app, |r| r.transition(&id, to, &now))
    }

    /// Makes an approved model the label's active one. The model is loaded and checked first: a model that cannot run
    /// is never made active, so activating cannot silently leave a label without one.
    pub fn activate_model(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let version = self.version_for(id)?;
        let dir = Self::model_lab_dir(app)?;
        // Only the files are checked here; the registry still has to agree to the move.
        label_inference::check_loadable(&version, &dir)?;
        let now = Self::now_rfc3339();
        let vid = version.id.clone();
        self.change_registry(app, |r| r.activate(&vid, &now).map(|_| ()))
    }

    pub fn deactivate_label(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        let label = LabelId::new(label).map_err(|e| e.to_string())?;
        let now = Self::now_rfc3339();
        self.change_registry(app, |r| r.deactivate(&label, &now).map(|_| ()))
    }

    pub fn rollback_label(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        let label = LabelId::new(label).map_err(|e| e.to_string())?;
        let now = Self::now_rfc3339();
        self.change_registry(app, |r| r.rollback(&label, &now).map(|_| ()))
    }

    /// Off, Monitor or Live. Monitor and Live need at least one active model to mean anything, but are allowed without.
    pub fn set_mode(
        &self,
        app: &AppHandle,
        mode: model_lab_core::InferenceMode,
    ) -> Result<(), String> {
        self.change_registry(app, |r| {
            r.set_inference_mode(mode);
            Ok(())
        })
    }

    fn now_rfc3339() -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    fn model_lab_dir(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map(|base| base.join(MODEL_LAB_DIR_NAME))
            .map_err(|error| error.to_string())
    }

    /// Imports an external model bundle from a folder as a Draft. The copy and the validation happen without holding
    /// the registry, so detection is never held up by a slow import. Nothing is approved or activated.
    pub fn import_bundle(
        &self,
        app: &AppHandle,
        source: &str,
    ) -> Result<ImportedModelView, String> {
        let dir = Self::model_lab_dir(app)?;
        let staged =
            stage_bundle(std::path::Path::new(source), &dir).map_err(|error| error.to_string())?;
        let now = Self::now_rfc3339();
        let outcome = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "model state is unavailable")?;
            let store = state.store.as_mut().ok_or_else(|| {
                "the model registry is not available, so nothing can be imported".to_string()
            })?;
            publish_staged(staged, &dir, store, &now).map_err(|error| error.to_string())?
        };
        info!(label = %outcome.label, version = %outcome.version_id, "imported a model as a draft");
        let _ = app.emit(LABEL_MODELS_EVENT, ());
        Ok(ImportedModelView {
            id: outcome.version_id.to_string(),
            label: outcome.label.to_string(),
            model_sha256: outcome.model_sha256,
            project_created: outcome.project_created,
        })
    }

    pub fn list_models(&self) -> Vec<LabelModelView> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let Some(store) = &state.store else {
            return Vec::new();
        };
        let registry = store.registry();
        registry
            .versions
            .values()
            .map(|v| LabelModelView {
                id: v.id.to_string(),
                label: v.label.to_string(),
                state: v.state,
                deployable: v.deployable,
                imported: matches!(v.origin, model_lab_core::ModelOrigin::Imported),
                model_sha256: v.model_sha256.clone(),
                created_at: v.created_at.clone(),
                active: registry.active_by_label.get(&v.label) == Some(&v.id),
            })
            .collect()
    }

    fn set_registry_error(&self, error: String) {
        if let Ok(mut state) = self.state.lock() {
            state.status = LabelRuntimeStatus {
                mode: "off".into(),
                registry_error: Some(error),
                ..LabelRuntimeStatus::default()
            };
        }
    }

    fn with_runtime(&self, app: &AppHandle, step: impl FnOnce(&mut LabelRuntime) -> RuntimeOutput) {
        let output = match self.runtime.lock() {
            Ok(mut runtime) => step(&mut runtime),
            Err(_) => return,
        };
        self.dispatch(app, output);
    }

    pub fn observe_orientation(&self, app: &AppHandle, sample: &WatchOrientationSample) {
        let now = self.now_ns();
        self.with_runtime(app, |runtime| runtime.observe_orientation(sample, now));
    }

    pub fn observe_ppg(&self, app: &AppHandle, batch: &WatchPpgBatchSample) {
        let now = self.now_ns();
        self.with_runtime(app, |runtime| runtime.observe_ppg(batch, now));
    }

    pub fn tick(&self, app: &AppHandle) {
        let now = self.now_ns();
        self.with_runtime(app, |runtime| runtime.tick(now));
    }

    /// The watch disconnected or sent something malformed: everything depending on it lets go.
    pub fn watch_lost(&self, app: &AppHandle) {
        self.with_runtime(app, LabelRuntime::watch_lost);
    }

    pub fn fail(&self, app: &AppHandle, detail: &str) {
        self.with_runtime(app, |runtime| runtime.fail(detail));
    }

    /// Records an output and tells the UI. Releases always get through; a start only does in Live.
    fn dispatch(&self, app: &AppHandle, output: RuntimeOutput) {
        let changed = !output.events.is_empty()
            || !output.conflicts.is_empty()
            || !output.rejections.is_empty();
        let (loaded, held) = match self.state.lock() {
            Ok(mut state) => {
                record(&mut state, &output);
                (
                    state.status.loaded_labels.iter().cloned().collect(),
                    state
                        .actionable_active
                        .iter()
                        .map(ToString::to_string)
                        .collect(),
                )
            }
            Err(_) => (BTreeSet::new(), BTreeSet::new()),
        };
        // Recipes are told when something they can see changes, and by the 100 ms tick when a one-shot's moment is over.
        let (risen, dropped) = recipe_edges(&output);
        let now = self.now_ns();
        let push = self
            .push_gate
            .lock()
            .map(|mut gate| {
                gate.needed(
                    &loaded,
                    &held,
                    !risen.is_empty() || !dropped.is_empty(),
                    now,
                )
            })
            .unwrap_or(true);
        if push {
            app.state::<AutomationRuntime>()
                .set_models(app, loaded, held, &risen, &dropped, now);
        }
        if changed {
            let report = DetectionReport {
                events: output.events.iter().map(DetectionEventView::from).collect(),
                conflicts: output.conflicts.iter().map(conflict_labels).collect(),
                rejections: output
                    .rejections
                    .iter()
                    .map(|r| format!("{}: {}", r.label, r.reason))
                    .collect(),
            };
            let _ = app.emit(LABEL_DETECTIONS_EVENT, report);
        }
    }
}

/// Updates what the host remembers from one runtime output: the latest scores, and which detections are active and
/// cleared to be acted on (only what the runtime marked actionable, so Monitor never adds one).
fn record(state: &mut HostState, output: &RuntimeOutput) {
    for score in &output.scores {
        state
            .status
            .last_scores
            .insert(score.label.to_string(), score.confidence);
    }
    for event in &output.actionable {
        match event {
            DetectionEvent::Rising { label, .. } => {
                state.actionable_active.insert(label.clone());
            }
            DetectionEvent::Falling { label, .. } => {
                state.actionable_active.remove(label);
            }
            DetectionEvent::Active { .. } => {}
        }
    }
    state.status.active_detections = state
        .actionable_active
        .iter()
        .map(ToString::to_string)
        .collect();
}

/// The labels that just started (a one-shot recipe step fires on these) and those whose detection was cut short
/// rather than ending normally (a one-shot waiting on them must not fire).
fn recipe_edges(output: &RuntimeOutput) -> (Vec<String>, Vec<String>) {
    let mut risen = Vec::new();
    let mut dropped = Vec::new();
    for event in &output.actionable {
        match event {
            DetectionEvent::Rising { label, .. } => risen.push(label.to_string()),
            DetectionEvent::Falling { label, reason, .. }
                if *reason != ClearReason::ScoreBelowRelease =>
            {
                dropped.push(label.to_string());
            }
            _ => {}
        }
    }
    (risen, dropped)
}

fn conflict_labels(conflict: &Conflict) -> Vec<String> {
    conflict.labels.iter().map(ToString::to_string).collect()
}

/// Starts the timer that lets the runtime notice a stream that has stopped. Call once at startup.
pub fn spawn_timer(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        loop {
            interval.tick().await;
            app.state::<LabelRuntimeHost>().tick(&app);
        }
    });
}

#[tauri::command]
pub fn get_label_runtime_status(host: State<'_, LabelRuntimeHost>) -> LabelRuntimeStatus {
    host.status()
}

/// Imports a model bundle (a folder with `manifest.json` and one ONNX model). It is added as a Draft.
#[tauri::command]
pub fn import_label_model(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
    path: String,
) -> Result<ImportedModelView, String> {
    host.import_bundle(&app, &path)
}

#[tauri::command]
pub fn list_label_models(host: State<'_, LabelRuntimeHost>) -> Vec<LabelModelView> {
    host.list_models()
}

#[tauri::command]
pub fn set_label_model_state(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
    id: String,
    state: LifecycleState,
) -> Result<(), String> {
    host.set_model_state(&app, &id, state)
}

#[tauri::command]
pub fn activate_label_model(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
    id: String,
) -> Result<(), String> {
    host.activate_model(&app, &id)
}

#[tauri::command]
pub fn deactivate_label_model(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
    label: String,
) -> Result<(), String> {
    host.deactivate_label(&app, &label)
}

#[tauri::command]
pub fn rollback_label_model(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
    label: String,
) -> Result<(), String> {
    host.rollback_label(&app, &label)
}

#[tauri::command]
pub fn set_label_runtime_mode(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
    mode: model_lab_core::InferenceMode,
) -> Result<(), String> {
    host.set_mode(&app, mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use label_inference::LabelScore;
    use model_lab_core::ModelVersionId;

    fn label(id: &str) -> LabelId {
        LabelId::new(id).unwrap()
    }

    fn rising(id: &str) -> DetectionEvent {
        DetectionEvent::Rising {
            label: label(id),
            confidence: 0.9,
            timestamp_ns: 1,
        }
    }

    fn falling(id: &str) -> DetectionEvent {
        DetectionEvent::Falling {
            label: label(id),
            timestamp_ns: 2,
            reason: ClearReason::ScoreBelowRelease,
        }
    }

    #[test]
    fn the_host_tracks_only_what_the_runtime_cleared_to_act_on() {
        let mut state = HostState::default();
        // Monitor: the rising edge is reported (events) but not actionable, so it is not an active detection.
        record(
            &mut state,
            &RuntimeOutput {
                events: vec![rising("swipe_left")],
                ..RuntimeOutput::default()
            },
        );
        assert!(state.actionable_active.is_empty() && state.status.active_detections.is_empty());

        // Live: actionable.
        let live = RuntimeOutput {
            events: vec![rising("swipe_left")],
            actionable: vec![rising("swipe_left")],
            ..RuntimeOutput::default()
        };
        record(&mut state, &live);
        assert_eq!(state.status.active_detections, ["swipe_left"]);

        // A release always gets through and removes it.
        record(
            &mut state,
            &RuntimeOutput {
                events: vec![falling("swipe_left")],
                actionable: vec![falling("swipe_left")],
                ..RuntimeOutput::default()
            },
        );
        assert!(state.status.active_detections.is_empty());
    }

    #[test]
    fn the_latest_score_per_label_is_kept_for_the_status() {
        let mut state = HostState::default();
        let score = |c: f64| LabelScore {
            label: label("fist"),
            model_version: ModelVersionId::new("v1").unwrap(),
            confidence: c,
            timestamp_ns: 5,
            received_ns: 6,
        };
        record(
            &mut state,
            &RuntimeOutput {
                scores: vec![score(0.2)],
                ..RuntimeOutput::default()
            },
        );
        record(
            &mut state,
            &RuntimeOutput {
                scores: vec![score(0.7)],
                ..RuntimeOutput::default()
            },
        );
        assert_eq!(state.status.last_scores["fist"], 0.7);
    }

    #[test]
    fn a_failed_registry_leaves_the_runtime_off_with_the_reason() {
        let host = LabelRuntimeHost::default();
        host.set_registry_error("registry is corrupt".into());
        let status = host.status();
        assert_eq!(status.mode, "off");
        assert_eq!(
            status.registry_error.as_deref(),
            Some("registry is corrupt")
        );
        assert!(status.loaded_labels.is_empty());
    }

    #[test]
    fn recipes_hear_rising_edges_and_abnormal_ends_but_not_ordinary_releases() {
        let label = |name: &str| LabelId::new(name).unwrap();
        let output = RuntimeOutput {
            actionable: vec![
                DetectionEvent::Rising {
                    label: label("a"),
                    confidence: 0.9,
                    timestamp_ns: 1,
                },
                DetectionEvent::Falling {
                    label: label("b"),
                    timestamp_ns: 2,
                    reason: ClearReason::ScoreBelowRelease,
                },
                DetectionEvent::Falling {
                    label: label("c"),
                    timestamp_ns: 3,
                    reason: ClearReason::Rejected("stale".into()),
                },
            ],
            ..RuntimeOutput::default()
        };
        let (risen, dropped) = recipe_edges(&output);
        assert_eq!(risen, ["a"]);
        assert_eq!(dropped, ["c"]);
    }

    fn set(labels: &[&str]) -> BTreeSet<String> {
        labels.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn recipes_are_told_only_when_something_they_can_see_changes() {
        let mut gate = PushGate::default();
        let (loaded, none) = (set(&["snap"]), set(&[]));
        // The first word always goes, so the engine learns what is loaded.
        assert!(gate.needed(&loaded, &none, false, 1));
        // Thousands of identical samples after that are not worth an engine step.
        for n in 2..5000 {
            assert!(!gate.needed(&loaded, &none, false, n * 1_000_000), "{n}");
        }
        assert!(gate.needed(&loaded, &set(&["snap"]), false, 6_000_000_000));
        assert!(!gate.needed(&loaded, &set(&["snap"]), false, 6_001_000_000));
        assert!(gate.needed(
            &set(&["snap", "wave"]),
            &set(&["snap"]),
            false,
            6_002_000_000
        ));
    }

    #[test]
    fn a_one_shot_is_pushed_when_it_starts_and_once_more_when_its_moment_is_over() {
        let mut gate = PushGate::default();
        let (loaded, none) = (set(&["snap"]), set(&[]));
        gate.needed(&loaded, &none, false, 0);
        let start = 10_000_000_000;
        assert!(gate.needed(&loaded, &none, true, start));
        assert!(!gate.needed(&loaded, &none, false, start + 300_000_000));
        // Past the engine's window the engine is told once so it can forget the pulse, and then never again.
        assert!(gate.needed(&loaded, &none, false, start + 800_000_000));
        assert!(!gate.needed(&loaded, &none, false, start + 900_000_000));
    }
}
