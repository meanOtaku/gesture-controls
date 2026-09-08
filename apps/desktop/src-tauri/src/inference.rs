//! Desktop-owned fail-closed gesture policy runtime.
//!
//! Turns typed pinch model transitions (Started/Held/Released, produced by
//! whatever runs desktop-side inference against the active model in
//! [`crate::model_registry`]) into the closed set of safe fixed intents in
//! [`interaction_engine::GestureIntent`], gated by the registry's
//! Off/Monitor/Live inference mode. See Milestone 11 in
//! `docs/architecture/project-brief.md` and `apps/desktop/ARCHITECTURE.md`.
//!
//! [`ingest_ppg_window`] is the desktop's single entry point for a raw fused
//! PPG window (see `crate::watch::WatchEvent::Ppg` handling in
//! `crate::lib::run`): it gates the window on sensor quality and ordering,
//! then emits a [`PpgWindowObservation`] regardless of outcome. An accepted
//! window is fused with the last-known watch orientation (see
//! [`PinchInferenceRuntime::observe_orientation`], driven by
//! `WatchEvent::Orientation`) and classified by the active model from
//! [`crate::model_registry`] via the `pinch-inference` crate. [`ingest_ppg_window`]
//! plus [`report_pinch_transition`] are both seams into
//! [`GesturePolicyRuntime`]: the former is live desktop inference, the latter
//! is for replay/testing tooling that has already classified a window itself.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use interaction_engine::{
    DecisionReason, ForceReleaseReason, GestureIntent, GesturePolicy, GesturePolicyConfig,
    PinchTransition, PolicyDecision, PolicyMode,
};
use pinch_inference::{DesktopPinchRuntime, PinchModel, TelemetryFusion};
use serde::{Deserialize, Serialize};
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::model_registry::{
    self, InferenceMode, ModelThresholds, QualityGateConfig, QualityGateRejection,
};
use crate::overlay::OverlayRuntime;

pub const GESTURE_POLICY_EVENT: &str = "gesture-policy-decision";

/// Emitted once per raw PPG window that reaches [`ingest_ppg_window`],
/// whatever the outcome -- accepted or rejected. This is the full
/// replay/comparison observability trail the project brief's Milestone 11
/// calls for: a replay tool can reconstruct exactly what the desktop did
/// with every window (not just the ones it rejected) and compare it against
/// an offline re-run once real inference exists. `timestamp_ns` is always
/// the watch-reported envelope timestamp (see
/// `WatchPpgBatchSample::timestamp_ns` in `spatial_protocol`), never a
/// desktop-side substitute.
pub const PPG_WINDOW_OBSERVED_EVENT: &str = "gesture-ppg-window-observed";

/// Why [`ingest_ppg_window`] did or did not let a window proceed.
/// `Accepted` is the architecture seam: no LiteRT execution runs here yet
/// (see module docs) -- this is what a future local inference runner or
/// offline replay tool would consume to classify the window and call
/// [`report_pinch_transition`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PpgWindowOutcome {
    Accepted,
    RejectedByQualityGate(QualityGateRejection),
    /// The window's envelope timestamp did not strictly increase over the
    /// last window seen from this device -- a replayed, duplicated, or
    /// out-of-order batch, rejected before the quality gate ever ran since
    /// its contact-quality mean would be untrustworthy too.
    RejectedStaleOrOutOfOrder {
        last_timestamp_ns: u64,
    },
}

impl PpgWindowOutcome {
    fn is_accepted(self) -> bool {
        matches!(self, PpgWindowOutcome::Accepted)
    }
}

/// One raw PPG window's full ingestion record, suitable for replay and
/// comparison tooling: everything needed to reconstruct why the desktop
/// accepted or rejected this window, without re-deriving it from the raw
/// batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PpgWindowObservation {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub contact_quality_mean: Option<f64>,
    pub active_model_id: String,
    pub outcome: PpgWindowOutcome,
}

/// Samsung's PPG status convention is 0 = valid, non-zero = degraded/invalid
/// (see [`QualityGateConfig::max_contact_quality`]), and a sample is only as
/// good as its worst channel, so the per-sample defect code is the max across
/// green/red/ir -- matching `telemetryStore.ts`'s `contactQuality` derivation
/// on the recorder side of the same contract.
fn mean_contact_quality(sample: &WatchPpgBatchSample) -> Option<f64> {
    let len = sample.sample_count as usize;
    if len == 0
        || sample.green_status.len() != len
        || sample.red_status.len() != len
        || sample.ir_status.len() != len
    {
        return None;
    }
    let sum: i64 = (0..len)
        .map(|index| {
            sample.green_status[index]
                .max(sample.red_status[index])
                .max(sample.ir_status[index]) as i64
        })
        .sum();
    Some(sum as f64 / len as f64)
}

/// Pure gate over one raw PPG batch: never touches an `AppHandle`, so it is
/// trivially unit-testable, mirroring [`model_registry::evaluate_quality_gate`]
/// which it wraps. A malformed batch (channel arrays that disagree with
/// `sampleCount`) fails closed as a low-sample-count rejection rather than
/// silently passing a bad mean through.
fn evaluate_ppg_window_quality(
    config: &QualityGateConfig,
    sample: &WatchPpgBatchSample,
) -> Result<(), QualityGateRejection> {
    let mean = mean_contact_quality(sample).ok_or(QualityGateRejection::LowSampleCount {
        actual: 0,
        required: config.min_sample_count,
    })?;
    model_registry::evaluate_quality_gate(config, mean, sample.sample_count)
}

/// Pure decision over one raw PPG window: checks ordering against
/// `previous_timestamp_ns` (the last in-order window seen from this device)
/// before ever running the quality gate, then applies the quality gate.
/// Returns the outcome plus the new watermark timestamp callers should
/// persist for this device (`None` when the window was out of order/stale,
/// so a bad arrival can never advance the watermark and mask a real one
/// that arrives later).
fn evaluate_ppg_window(
    quality_gate: &QualityGateConfig,
    sample: &WatchPpgBatchSample,
    previous_timestamp_ns: Option<u64>,
) -> (PpgWindowOutcome, Option<u64>) {
    let in_order = match previous_timestamp_ns {
        Some(last) => sample.timestamp_ns > last,
        None => true,
    };
    if !in_order {
        return (
            PpgWindowOutcome::RejectedStaleOrOutOfOrder {
                last_timestamp_ns: previous_timestamp_ns.unwrap_or_default(),
            },
            None,
        );
    }
    let outcome = match evaluate_ppg_window_quality(quality_gate, sample) {
        Ok(()) => PpgWindowOutcome::Accepted,
        Err(rejection) => PpgWindowOutcome::RejectedByQualityGate(rejection),
    };
    (outcome, Some(sample.timestamp_ns))
}

/// Per-device watermark of the last in-order raw PPG window timestamp, so
/// [`ingest_ppg_window`] can reject a replayed/out-of-order batch before it
/// ever reaches the sensor-quality gate. Kept separate from
/// [`GesturePolicyRuntime`] since it tracks raw ingestion, not policy state.
#[derive(Default)]
pub struct PpgIngestRuntime {
    last_timestamp_ns: Mutex<HashMap<String, u64>>,
}

impl PpgIngestRuntime {
    fn evaluate(
        &self,
        sample: &WatchPpgBatchSample,
        quality_gate: &QualityGateConfig,
    ) -> Result<PpgWindowOutcome, String> {
        let mut last_seen = self
            .last_timestamp_ns
            .lock()
            .map_err(|_| "PPG ingest watermark lock was poisoned".to_string())?;
        let previous = last_seen.get(&sample.device_id).copied();
        let (outcome, advance_to) = evaluate_ppg_window(quality_gate, sample, previous);
        if let Some(timestamp_ns) = advance_to {
            last_seen.insert(sample.device_id.clone(), timestamp_ns);
        }
        Ok(outcome)
    }
}

/// Ingests one raw PPG batch into the desktop gesture-policy pipeline: the
/// single call site `WatchEvent::Ppg` is routed through (see `crate::lib`).
/// Skipped entirely when inference is `Off` or no model is active (see
/// [`model_registry::active_model_runtime_config`]) -- there is no grab to
/// protect and nothing for replay tooling to usefully compare against.
/// Otherwise every window -- accepted or rejected -- is reported once via
/// [`PPG_WINDOW_OBSERVED_EVENT`] for replay/comparison observability. A
/// rejection (whether from stale/out-of-order ordering or the sensor-quality
/// gate) forces an immediate, safe release, exactly like an explicit
/// model-runtime failure. An accepted window is fused with the last-known
/// watch orientation and classified against the active model; the resulting
/// transition (if any) is fed straight into [`GesturePolicyRuntime`].
pub(crate) fn ingest_ppg_window(app: &AppHandle, sample: &WatchPpgBatchSample) {
    let Some((active_model_id, thresholds, quality_gate)) =
        model_registry::active_model_runtime_config(app)
    else {
        return;
    };
    let ingest = app.state::<PpgIngestRuntime>();
    let outcome = match ingest.evaluate(sample, &quality_gate) {
        Ok(outcome) => outcome,
        Err(error) => {
            warn!(%error, "failed to evaluate PPG window ingestion");
            return;
        }
    };
    let contact_quality_mean = mean_contact_quality(sample);
    let observation = PpgWindowObservation {
        device_id: sample.device_id.clone(),
        sequence: sample.sequence,
        timestamp_ns: sample.timestamp_ns,
        sample_count: sample.sample_count,
        contact_quality_mean,
        active_model_id: active_model_id.clone(),
        outcome,
    };
    if let Err(error) = app.emit(PPG_WINDOW_OBSERVED_EVENT, &observation) {
        warn!(%error, "failed to emit PPG window observation");
    }
    if !outcome.is_accepted() {
        let reason = match outcome {
            PpgWindowOutcome::RejectedByQualityGate(_) => ForceReleaseReason::SensorQualityRejected,
            PpgWindowOutcome::RejectedStaleOrOutOfOrder { .. } => {
                ForceReleaseReason::StaleSensorWindow
            }
            PpgWindowOutcome::Accepted => unreachable!("handled above"),
        };
        let runtime = app.state::<GesturePolicyRuntime>();
        match runtime.force_release(reason) {
            Ok(decision) => apply_decision(app, decision),
            Err(error) => {
                warn!(%error, "failed to force-release gesture policy on rejected PPG window")
            }
        }
        return;
    }
    // `Accepted` only happens once `evaluate_ppg_window_quality` has already
    // resolved a contact-quality mean, so this is always `Some` -- the `else`
    // arm only guards against that invariant ever silently breaking.
    let Some(contact_quality_mean) = contact_quality_mean else {
        warn!("accepted PPG window unexpectedly had no contact-quality mean");
        return;
    };
    let pinch = app.state::<PinchInferenceRuntime>();
    match pinch.classify(
        app,
        &active_model_id,
        thresholds,
        sample,
        contact_quality_mean,
    ) {
        ClassifyOutcome::Transition(transition) => {
            let gesture_policy = app.state::<GesturePolicyRuntime>();
            match gesture_policy.on_transition(transition) {
                Ok(decision) => {
                    let decision = pinch.resolve_intent(decision);
                    apply_decision(app, decision);
                }
                Err(error) => warn!(%error, "failed to apply classified pinch transition"),
            }
        }
        ClassifyOutcome::NoChange => {}
        ClassifyOutcome::LoadFailed(error) => {
            warn!(%error, model_id = %active_model_id, "failed to load pinch inference model backend");
            let gesture_policy = app.state::<GesturePolicyRuntime>();
            match gesture_policy.force_release(ForceReleaseReason::ModelRuntimeFailure) {
                Ok(decision) => apply_decision(app, decision),
                Err(error) => {
                    warn!(%error, "failed to force-release gesture policy on model load failure")
                }
            }
        }
    }
}

/// Loads the real LiteRT backend when the desktop app was built with the
/// `litert-inference` feature (which forwards to `pinch-inference/litert`),
/// otherwise falls back to a backend that fails closed on every window. See
/// `crates/pinch-inference/Cargo.toml` for why the native LiteRT dependency
/// stays opt-in.
#[cfg(feature = "litert-inference")]
fn load_model_backend(path: &Path) -> Result<Box<dyn PinchModel>, String> {
    pinch_inference::LiteRtPinchModel::load(path)
        .map(|model| Box::new(model) as Box<dyn PinchModel>)
        .map_err(|error| error.to_string())
}

#[cfg(not(feature = "litert-inference"))]
fn load_model_backend(_path: &Path) -> Result<Box<dyn PinchModel>, String> {
    warn!(
        "no LiteRT backend compiled in; pinch inference will fail closed until this build is \
         compiled with --features litert-inference"
    );
    Ok(Box::new(pinch_inference::UnavailablePinchModel))
}

/// One loaded model backend, tied to the verified snapshot it was built
/// from -- a changed active model id or edited thresholds invalidates it so
/// the next window rebuilds it (and revalidates the bundle contract, digest,
/// and bindings from scratch; see [`model_registry::ActiveModelSnapshot::verified`]).
struct LoadedPinchModel {
    snapshot: model_registry::ActiveModelSnapshot,
    runtime: DesktopPinchRuntime<Box<dyn PinchModel>>,
}

/// Result of classifying one accepted, quality-gated PPG window.
pub(crate) enum ClassifyOutcome {
    Transition(PinchTransition),
    NoChange,
    /// The active model's backend could not be (re)loaded -- distinct from a
    /// per-window classification failure, which `DesktopPinchRuntime` already
    /// handles by failing closed internally.
    LoadFailed(String),
}

/// Desktop-only telemetry fusion and model execution: subscribes to watch
/// orientation samples to keep [`TelemetryFusion`]'s carry-forward state
/// current, and lazily (re)loads the active model's backend to classify each
/// accepted PPG window. See the module-level docs and
/// `docs/architecture/project-brief.md` Milestone 11 for why this must never
/// run anywhere but the desktop.
#[derive(Default)]
pub struct PinchInferenceRuntime {
    fusion: Mutex<TelemetryFusion>,
    loaded: Mutex<Option<LoadedPinchModel>>,
}

impl PinchInferenceRuntime {
    /// Feeds one watch orientation sample into the carry-forward fusion
    /// state. Called from every `WatchEvent::Orientation`, independent of
    /// whether inference is currently running, so a model activated mid-
    /// session immediately has a fresh orientation snapshot to fuse.
    pub(crate) fn observe_orientation(&self, sample: &WatchOrientationSample) {
        if let Ok(mut fusion) = self.fusion.lock() {
            fusion.observe_orientation(sample);
        } else {
            warn!("pinch inference fusion lock was poisoned; dropping orientation sample");
        }
    }

    /// Clears any in-progress classification without touching
    /// `GesturePolicy` (which handles its own forced release independently)
    /// -- called on watch disconnect so the classifier's internal "active"
    /// flag doesn't stay stuck true forever, blocking a fresh grab from ever
    /// starting again after reconnect.
    pub(crate) fn reset(&self) {
        if let Ok(mut loaded) = self.loaded.lock()
            && let Some(model) = loaded.as_mut()
        {
            model.runtime.reset(0);
        }
    }

    /// Fuses `sample` with the last-known orientation, extracts features, and
    /// classifies the window against `model_id`'s backend -- (re)loading it
    /// first if it isn't already loaded with matching `thresholds`.
    fn classify(
        &self,
        app: &AppHandle,
        model_id: &str,
        thresholds: ModelThresholds,
        sample: &WatchPpgBatchSample,
        contact_quality_mean: f64,
    ) -> ClassifyOutcome {
        let features = {
            let fusion = match self.fusion.lock() {
                Ok(fusion) => fusion,
                Err(_) => {
                    return ClassifyOutcome::LoadFailed(
                        "pinch inference fusion lock was poisoned".to_string(),
                    );
                }
            };
            let window = fusion.fuse_ppg_window(sample, contact_quality_mean);
            pinch_inference::extract_features(&window)
        };

        let mut loaded = match self.loaded.lock() {
            Ok(loaded) => loaded,
            Err(_) => {
                return ClassifyOutcome::LoadFailed(
                    "pinch inference model lock was poisoned".to_string(),
                );
            }
        };
        let needs_reload = match loaded.as_ref() {
            Some(current) => {
                current.snapshot.model_id != model_id || current.snapshot.thresholds != thresholds
            }
            None => true,
        };
        if needs_reload {
            // Revalidate the full bundle contract, digest, and bindings at
            // every (re)load -- never trust that activation's earlier
            // validation still holds for bytes now on disk.
            let snapshot = match model_registry::ActiveModelSnapshot::verified(app, model_id) {
                Ok(snapshot) => snapshot,
                Err(error) => return ClassifyOutcome::LoadFailed(error),
            };
            let path = match model_registry::active_model_file_path(app, model_id) {
                Ok(path) => path,
                Err(error) => return ClassifyOutcome::LoadFailed(error),
            };
            let backend = match load_model_backend(&path) {
                Ok(backend) => backend,
                Err(error) => return ClassifyOutcome::LoadFailed(error),
            };
            *loaded = Some(LoadedPinchModel {
                runtime: DesktopPinchRuntime::new(
                    backend,
                    snapshot.thresholds.start_threshold as f32,
                    snapshot.thresholds.release_threshold as f32,
                ),
                snapshot,
            });
        }
        let Some(model) = loaded.as_mut() else {
            return ClassifyOutcome::LoadFailed("pinch inference model failed to load".to_string());
        };
        match model.runtime.submit(&features, sample.timestamp_ns) {
            Some(transition) => ClassifyOutcome::Transition(transition),
            None => ClassifyOutcome::NoChange,
        }
    }

    /// Resolves `decision`'s executed intent through the currently loaded
    /// model's verified snapshot bindings: a `Started`/`Released` decision
    /// only ever executes the safe intent this specific model bound its
    /// `pinch_start`/`pinch_release` class to (`VolumeGrab`/`VolumeRelease`
    /// or `NoAction`) -- never the policy's own generic default. Any other
    /// reason (including every `ForcedRelease`) passes through unchanged,
    /// since a forced release must always be able to execute a real release
    /// regardless of what a class is bound to.
    fn resolve_intent(&self, decision: PolicyDecision) -> PolicyDecision {
        let Ok(loaded) = self.loaded.lock() else {
            warn!("pinch inference model lock was poisoned; using unresolved decision intent");
            return decision;
        };
        let Some(model) = loaded.as_ref() else {
            return decision;
        };
        let intent = match decision.reason {
            DecisionReason::Started => model.snapshot.intent_for_class("pinch_start"),
            DecisionReason::Released => model.snapshot.intent_for_class("pinch_release"),
            _ => decision.intent,
        };
        PolicyDecision { intent, ..decision }
    }
}

/// How often [`crate::run`] drives [`GesturePolicyRuntime::tick`] to enforce
/// the staleness timeout in [`GesturePolicyConfig`].
pub const STALENESS_WATCHDOG_INTERVAL: Duration = Duration::from_millis(200);

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0)
}

fn to_policy_mode(mode: InferenceMode) -> PolicyMode {
    match mode {
        InferenceMode::Off => PolicyMode::Off,
        InferenceMode::Monitor => PolicyMode::Monitor,
        InferenceMode::Live => PolicyMode::Live,
    }
}

pub struct GesturePolicyRuntime {
    policy: Mutex<GesturePolicy>,
}

impl Default for GesturePolicyRuntime {
    fn default() -> Self {
        Self {
            policy: Mutex::new(GesturePolicy::new(GesturePolicyConfig::default())),
        }
    }
}

impl GesturePolicyRuntime {
    pub(crate) fn set_mode(&self, mode: InferenceMode) -> Result<Option<PolicyDecision>, String> {
        let mut policy = self
            .policy
            .lock()
            .map_err(|_| "gesture policy lock was poisoned".to_string())?;
        Ok(policy.set_mode(to_policy_mode(mode)))
    }

    fn on_transition(&self, transition: PinchTransition) -> Result<PolicyDecision, String> {
        let mut policy = self
            .policy
            .lock()
            .map_err(|_| "gesture policy lock was poisoned".to_string())?;
        Ok(policy.on_transition(transition))
    }

    pub(crate) fn force_release(
        &self,
        reason: ForceReleaseReason,
    ) -> Result<PolicyDecision, String> {
        let mut policy = self
            .policy
            .lock()
            .map_err(|_| "gesture policy lock was poisoned".to_string())?;
        Ok(policy.force_release(reason))
    }

    pub(crate) fn tick(&self) -> Result<Option<PolicyDecision>, String> {
        let mut policy = self
            .policy
            .lock()
            .map_err(|_| "gesture policy lock was poisoned".to_string())?;
        Ok(policy.on_tick(now_ns()))
    }
}

/// Emits `decision` for observability, then executes it against the overlay
/// if (and only if) [`PolicyDecision::live`] says it is safe to. Intents not
/// yet wired to a desktop action (`Mute`, `PlayPause`, `PreviousTrack`,
/// `NextTrack`) are reported but intentionally not executed: no model in
/// this milestone produces them, and adding the action here without a real
/// producer would be dead code.
pub(crate) fn apply_decision(app: &AppHandle, decision: PolicyDecision) {
    if let Err(error) = app.emit(GESTURE_POLICY_EVENT, decision) {
        warn!(%error, "failed to emit gesture policy decision");
    }
    if !decision.live {
        return;
    }
    let overlay = app.state::<OverlayRuntime>();
    match decision.intent {
        GestureIntent::VolumeGrab => {
            if let Err(error) = overlay.grab(app) {
                warn!(%error, "failed to grab overlay from gesture policy decision");
            }
        }
        GestureIntent::VolumeRelease => {
            if let Err(error) = overlay.release(app) {
                warn!(%error, "failed to release overlay from gesture policy decision");
            }
        }
        GestureIntent::NoAction
        | GestureIntent::Mute
        | GestureIntent::PlayPause
        | GestureIntent::PreviousTrack
        | GestureIntent::NextTrack => {}
    }
}

/// Feeds one classified pinch model transition into the desktop gesture
/// policy. This is the seam a future desktop inference pipeline calls after
/// classifying a fused sensor window; it is also usable directly (e.g. from
/// replay/testing tooling) since the policy itself has no dependency on how
/// the transition was produced.
#[tauri::command]
pub fn report_pinch_transition(
    transition: PinchTransition,
    app: AppHandle,
    runtime: State<'_, GesturePolicyRuntime>,
) -> Result<PolicyDecision, String> {
    let decision = runtime.on_transition(transition)?;
    apply_decision(&app, decision);
    Ok(decision)
}

/// Reports that desktop inference itself failed (crashed, threw, produced an
/// unparseable result, etc.) and forces an immediate, safe release.
#[tauri::command]
pub fn report_model_runtime_failure(
    app: AppHandle,
    runtime: State<'_, GesturePolicyRuntime>,
) -> Result<PolicyDecision, String> {
    let decision = runtime.force_release(ForceReleaseReason::ModelRuntimeFailure)?;
    apply_decision(&app, decision);
    Ok(decision)
}

#[cfg(test)]
mod ppg_window_tests {
    use super::*;

    fn ppg_sample(timestamp_ns: u64, statuses: &[(i32, i32, i32)]) -> WatchPpgBatchSample {
        let sample_count = statuses.len() as u32;
        WatchPpgBatchSample {
            device_id: "watch-1".to_string(),
            sequence: 1,
            timestamp_ns,
            sample_count,
            timestamps_ns: (0..statuses.len() as u64).collect(),
            green: vec![0; statuses.len()],
            green_status: statuses.iter().map(|(g, _, _)| *g).collect(),
            red: vec![0; statuses.len()],
            red_status: statuses.iter().map(|(_, r, _)| *r).collect(),
            ir: vec![0; statuses.len()],
            ir_status: statuses.iter().map(|(_, _, i)| *i).collect(),
        }
    }

    #[test]
    fn mean_contact_quality_takes_worst_channel_per_sample() {
        let sample = ppg_sample(1, &[(0, 0, 0), (0, 3, 1), (2, 0, 0)]);
        // Per-sample worst-of-three: 0, 3, 2 -> mean 5/3.
        assert_eq!(mean_contact_quality(&sample), Some(5.0 / 3.0));
    }

    #[test]
    fn mean_contact_quality_rejects_mismatched_channel_lengths() {
        let mut sample = ppg_sample(1, &[(0, 0, 0), (0, 0, 0)]);
        sample.red_status.pop();
        assert_eq!(mean_contact_quality(&sample), None);
    }

    #[test]
    fn evaluate_ppg_window_quality_accepts_clean_window() {
        let config = QualityGateConfig::default();
        let sample = ppg_sample(1, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        assert_eq!(evaluate_ppg_window_quality(&config, &sample), Ok(()));
    }

    #[test]
    fn evaluate_ppg_window_quality_rejects_degraded_contact() {
        let config = QualityGateConfig::default();
        let sample = ppg_sample(1, &[(0, 0, 0), (1, 0, 0), (0, 0, 0)]);
        assert_eq!(
            evaluate_ppg_window_quality(&config, &sample),
            Err(QualityGateRejection::DegradedContactQuality {
                actual: 1.0 / 3.0,
                max_allowed: config.max_contact_quality,
            })
        );
    }

    #[test]
    fn evaluate_ppg_window_quality_fails_closed_on_malformed_batch() {
        let config = QualityGateConfig::default();
        let mut sample = ppg_sample(1, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        sample.green_status.truncate(1);
        assert_eq!(
            evaluate_ppg_window_quality(&config, &sample),
            Err(QualityGateRejection::LowSampleCount {
                actual: 0,
                required: config.min_sample_count,
            })
        );
    }

    #[test]
    fn evaluate_ppg_window_accepts_first_window_with_no_watermark() {
        let config = QualityGateConfig::default();
        let sample = ppg_sample(100, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        let (outcome, advance_to) = evaluate_ppg_window(&config, &sample, None);
        assert_eq!(outcome, PpgWindowOutcome::Accepted);
        assert_eq!(advance_to, Some(100));
    }

    #[test]
    fn evaluate_ppg_window_accepts_strictly_later_window() {
        let config = QualityGateConfig::default();
        let sample = ppg_sample(200, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        let (outcome, advance_to) = evaluate_ppg_window(&config, &sample, Some(100));
        assert_eq!(outcome, PpgWindowOutcome::Accepted);
        assert_eq!(advance_to, Some(200));
    }

    #[test]
    fn evaluate_ppg_window_rejects_duplicate_timestamp_without_advancing_watermark() {
        let config = QualityGateConfig::default();
        let sample = ppg_sample(100, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        let (outcome, advance_to) = evaluate_ppg_window(&config, &sample, Some(100));
        assert_eq!(
            outcome,
            PpgWindowOutcome::RejectedStaleOrOutOfOrder {
                last_timestamp_ns: 100
            }
        );
        assert_eq!(advance_to, None);
    }

    #[test]
    fn evaluate_ppg_window_rejects_out_of_order_timestamp() {
        let config = QualityGateConfig::default();
        let sample = ppg_sample(50, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        let (outcome, advance_to) = evaluate_ppg_window(&config, &sample, Some(100));
        assert_eq!(
            outcome,
            PpgWindowOutcome::RejectedStaleOrOutOfOrder {
                last_timestamp_ns: 100
            }
        );
        assert_eq!(advance_to, None);
    }

    #[test]
    fn evaluate_ppg_window_runs_quality_gate_only_when_in_order() {
        let config = QualityGateConfig::default();
        // Degraded contact quality, but also out of order: ordering must win
        // and the quality gate must never even run, since a bad-ordering
        // window's contact-quality mean is untrustworthy in the first place.
        let sample = ppg_sample(50, &[(1, 0, 0), (1, 0, 0), (1, 0, 0)]);
        let (outcome, _) = evaluate_ppg_window(&config, &sample, Some(100));
        assert_eq!(
            outcome,
            PpgWindowOutcome::RejectedStaleOrOutOfOrder {
                last_timestamp_ns: 100
            }
        );
    }

    #[test]
    fn ppg_ingest_runtime_rejects_replayed_window_for_same_device() {
        let runtime = PpgIngestRuntime::default();
        let config = QualityGateConfig::default();
        let first = ppg_sample(100, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        assert_eq!(
            runtime.evaluate(&first, &config).unwrap(),
            PpgWindowOutcome::Accepted
        );
        let replayed = ppg_sample(100, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        assert_eq!(
            runtime.evaluate(&replayed, &config).unwrap(),
            PpgWindowOutcome::RejectedStaleOrOutOfOrder {
                last_timestamp_ns: 100
            }
        );
    }

    #[test]
    fn ppg_ingest_runtime_tracks_watermark_independently_per_device() {
        let runtime = PpgIngestRuntime::default();
        let config = QualityGateConfig::default();
        let mut device_a = ppg_sample(100, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        device_a.device_id = "watch-a".to_string();
        let mut device_b = ppg_sample(10, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        device_b.device_id = "watch-b".to_string();
        assert_eq!(
            runtime.evaluate(&device_a, &config).unwrap(),
            PpgWindowOutcome::Accepted
        );
        // Device B's first window has an earlier timestamp than device A's
        // last one, but that must not matter -- watermarks are per device.
        assert_eq!(
            runtime.evaluate(&device_b, &config).unwrap(),
            PpgWindowOutcome::Accepted
        );
    }

    #[test]
    fn ppg_window_observation_round_trips_through_json() {
        let observation = PpgWindowObservation {
            device_id: "watch-1".to_string(),
            sequence: 7,
            timestamp_ns: 42,
            sample_count: 3,
            contact_quality_mean: Some(0.0),
            active_model_id: "model-1".to_string(),
            outcome: PpgWindowOutcome::Accepted,
        };
        let json = serde_json::to_string(&observation).expect("must serialize");
        assert!(json.contains("\"outcome\":{\"kind\":\"accepted\"}"));
        let restored: PpgWindowObservation = serde_json::from_str(&json).expect("must deserialize");
        assert_eq!(restored, observation);
    }

    #[test]
    fn ppg_window_outcome_rejection_round_trips_through_json() {
        let outcome =
            PpgWindowOutcome::RejectedByQualityGate(QualityGateRejection::DegradedContactQuality {
                actual: 1.0,
                max_allowed: 0.0,
            });
        let json = serde_json::to_string(&outcome).expect("must serialize");
        let restored: PpgWindowOutcome = serde_json::from_str(&json).expect("must deserialize");
        assert_eq!(restored, outcome);
    }

    fn decision(intent: GestureIntent, reason: DecisionReason) -> PolicyDecision {
        PolicyDecision {
            intent,
            reason,
            live: true,
        }
    }

    fn runtime_with_loaded_snapshot(bindings: &[(&str, GestureIntent)]) -> PinchInferenceRuntime {
        let runtime = PinchInferenceRuntime::default();
        let snapshot = model_registry::ActiveModelSnapshot::for_test("model-under-test", bindings);
        *runtime.loaded.lock().unwrap() = Some(LoadedPinchModel {
            snapshot,
            runtime: DesktopPinchRuntime::new(
                Box::new(pinch_inference::UnavailablePinchModel),
                0.5,
                0.5,
            ),
        });
        runtime
    }

    #[test]
    fn resolve_intent_with_no_loaded_model_passes_the_decision_through_unchanged() {
        let runtime = PinchInferenceRuntime::default();
        let original = decision(GestureIntent::VolumeGrab, DecisionReason::Started);
        assert_eq!(runtime.resolve_intent(original), original);
    }

    #[test]
    fn resolve_intent_remaps_started_through_the_pinch_start_binding() {
        let runtime = runtime_with_loaded_snapshot(&[
            ("negative", GestureIntent::NoAction),
            ("pinch_start", GestureIntent::VolumeGrab),
            ("pinch_release", GestureIntent::VolumeRelease),
        ]);
        let resolved =
            runtime.resolve_intent(decision(GestureIntent::VolumeGrab, DecisionReason::Started));
        assert_eq!(resolved.intent, GestureIntent::VolumeGrab);
    }

    #[test]
    fn resolve_intent_started_cannot_grab_volume_when_the_class_is_bound_to_no_action() {
        let runtime = runtime_with_loaded_snapshot(&[
            ("negative", GestureIntent::NoAction),
            ("pinch_start", GestureIntent::NoAction),
            ("pinch_release", GestureIntent::VolumeRelease),
        ]);
        // The policy proposed VolumeGrab, but this model bound pinch_start to
        // NoAction -- the resolved intent must not be able to actuate.
        let resolved =
            runtime.resolve_intent(decision(GestureIntent::VolumeGrab, DecisionReason::Started));
        assert_eq!(resolved.intent, GestureIntent::NoAction);
    }

    #[test]
    fn resolve_intent_remaps_released_through_the_pinch_release_binding() {
        let runtime = runtime_with_loaded_snapshot(&[
            ("negative", GestureIntent::NoAction),
            ("pinch_start", GestureIntent::VolumeGrab),
            ("pinch_release", GestureIntent::NoAction),
        ]);
        let resolved = runtime.resolve_intent(decision(
            GestureIntent::VolumeRelease,
            DecisionReason::Released,
        ));
        assert_eq!(resolved.intent, GestureIntent::NoAction);
    }

    #[test]
    fn resolve_intent_leaves_forced_release_untouched_regardless_of_bindings() {
        let runtime = runtime_with_loaded_snapshot(&[
            ("negative", GestureIntent::NoAction),
            ("pinch_start", GestureIntent::NoAction),
            ("pinch_release", GestureIntent::NoAction),
        ]);
        let forced = decision(
            GestureIntent::VolumeRelease,
            DecisionReason::ForcedRelease(ForceReleaseReason::ModelSwapped),
        );
        assert_eq!(runtime.resolve_intent(forced), forced);
    }

    #[test]
    fn resolve_intent_leaves_held_and_ignored_reasons_untouched() {
        let runtime = runtime_with_loaded_snapshot(&[
            ("negative", GestureIntent::NoAction),
            ("pinch_start", GestureIntent::VolumeGrab),
            ("pinch_release", GestureIntent::VolumeRelease),
        ]);
        let held = decision(GestureIntent::NoAction, DecisionReason::Held);
        assert_eq!(runtime.resolve_intent(held), held);
        let ignored = decision(
            GestureIntent::NoAction,
            DecisionReason::IgnoredAlreadyGrabbed,
        );
        assert_eq!(runtime.resolve_intent(ignored), ignored);
    }
}
