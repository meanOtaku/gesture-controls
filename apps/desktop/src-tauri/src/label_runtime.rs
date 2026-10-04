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

use label_inference::{
    ClearReason, Conflict, DetectionEvent, LabelRuntime, ModelLoadFailure, RuntimeMode,
    RuntimeOutput, load_active_models,
};
use model_lab_core::{FileStore, LabelId, RegistryStore, open_registry};
use serde::Serialize;
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{info, warn};

use crate::model_lab::MODEL_LAB_DIR_NAME;

pub const LABEL_DETECTIONS_EVENT: &str = "label-detections";
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

#[derive(Default)]
struct HostState {
    status: LabelRuntimeStatus,
    /// Labels whose detection is currently active and allowed to be acted on.
    actionable_active: BTreeSet<LabelId>,
    store: Option<RegistryStore<FileStore>>,
}

pub struct LabelRuntimeHost {
    runtime: Mutex<LabelRuntime>,
    state: Mutex<HostState>,
    started_at: Instant,
}

impl Default for LabelRuntimeHost {
    fn default() -> Self {
        Self {
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

    /// The labels with a detection that is active and cleared to be acted on. This is what the recipe engine will read
    /// (the next step wires it in); until then only the status command shows it.
    #[allow(dead_code)]
    pub fn active_detections(&self) -> BTreeSet<LabelId> {
        self.state
            .lock()
            .map(|s| s.actionable_active.clone())
            .unwrap_or_default()
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
        }
        let (models, failures) = load_active_models(store.registry(), &dir);
        for failure in &failures {
            warn!(label = %failure.label, version = %failure.version, detail = %failure.detail, "an active model could not be loaded");
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
        let mode: RuntimeMode = startup_mode.into();
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
            state.status = LabelRuntimeStatus {
                mode: mode_name(mode).to_string(),
                loaded_labels,
                load_failures: failures.iter().map(LoadFailureView::from).collect(),
                quarantined,
                ..LabelRuntimeStatus::default()
            };
            state.store = Some(store);
        }
        for output in outputs {
            self.dispatch(app, output);
        }
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
        if let Ok(mut state) = self.state.lock() {
            record(&mut state, &output);
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
}
