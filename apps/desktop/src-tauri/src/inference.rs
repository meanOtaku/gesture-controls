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
//! `crate::lib::run`): it gates the window first on the registry's
//! [`InferenceMode`] (see [`mode_classifies`] -- under `Off` it returns
//! before the window is inspected at all, so no model execution can
//! happen), then on sensor quality and ordering, then emits a
//! [`PpgWindowObservation`] regardless of outcome. An accepted window is
//! fused with the last-known watch orientation (see
//! [`PinchInferenceRuntime::observe_orientation`], driven by
//! `WatchEvent::Orientation`) and classified by the active model from
//! [`crate::model_registry`] via the `pinch-inference` crate -- running the
//! real LiteRT backend when this build carries the `litert-inference`
//! feature, and failing closed against
//! [`pinch_inference::UnavailablePinchModel`] when it does not (see
//! [`load_model_backend`]). [`ingest_ppg_window`] is the only way a
//! classified transition reaches [`GesturePolicyRuntime`]; there is
//! deliberately no webview command that injects one (a fabricated transition
//! would bypass the watermark, quality gate, fusion, model and bindings).
//! Nothing executes anything directly: [`apply_decision`] is the sole actuation point and
//! only ever runs what [`GesturePolicy`] itself marked live, which is why
//! `Monitor` classifies and reports without ever reaching the overlay or
//! the volume backend.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use interaction_engine::{
    DecisionReason, ForceReleaseReason, GestureIntent, GesturePolicy, GesturePolicyConfig,
    PinchTransition, PolicyDecision, PolicyMode,
};
use pinch_inference::{DesktopPinchRuntime, FusionRejection, PinchModel, TelemetryFusion};
use serde::{Deserialize, Serialize};
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::automation::AutomationRuntime;
use crate::model_registry::{
    self, InferenceMode, ModelThresholds, QualityGateConfig, QualityGateRejection,
};

/// Mirrored in `src/shared/protocol/events.ts`; `event_names_match_the_frontend_protocol`
/// fails if the two drift.
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
/// `Accepted` is the architecture seam: an accepted window is what the live
/// path fuses and classifies against the active model (see
/// [`PinchInferenceRuntime::classify`]), and equally what an offline replay
/// tool consumes to classify the same window itself.
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
    /// This window's duration against the window the active model was
    /// trained on (R-M3-1). `None` when the bundle could not be loaded.
    #[serde(default)]
    pub window: Option<model_registry::WindowCheck>,
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
    /// The most recent window check and the model it was made against, so
    /// selecting `Live` can be refused while the live windows do not match
    /// what the active model was trained on.
    last_window_check: Mutex<Option<(String, model_registry::WindowCheck)>>,
}

impl PpgIngestRuntime {
    /// Forgets every device's watermark. Called when the watch link drops
    /// (any transport, including a transport switch): the watch's envelope
    /// clock is boot-relative, so after a reboot a fresh connection starts
    /// from a lower timestamp than the stale watermark and every window
    /// would otherwise be rejected (and force a release) until the desktop
    /// process restarted. Ordering within one connection is still enforced.
    pub(crate) fn clear(&self) {
        match self.last_timestamp_ns.lock() {
            Ok(mut last_seen) => last_seen.clear(),
            Err(_) => warn!("PPG ingest watermark lock was poisoned; could not clear"),
        }
        // A new connection may stream different windows; forget the old verdict.
        if let Ok(mut check) = self.last_window_check.lock() {
            *check = None;
        }
    }

    fn record_window_check(&self, model_id: &str, check: Option<model_registry::WindowCheck>) {
        if let Ok(mut last) = self.last_window_check.lock() {
            *last = check.map(|check| (model_id.to_string(), check));
        }
    }

    /// The mismatch that must keep `model_id` out of `Live`: its most recent
    /// observed window did not match the window it was trained on. `None`
    /// when compatible or when no window has been observed yet (the per-window
    /// enforcement in [`ingest_ppg_window`] still applies in `Live`).
    pub(crate) fn live_blocking_window_mismatch(
        &self,
        model_id: &str,
    ) -> Option<model_registry::WindowCheck> {
        let last = self.last_window_check.lock().ok()?;
        match last.as_ref() {
            Some((id, check)) if id == model_id && !check.compatible => Some(*check),
            _ => None,
        }
    }

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

/// The Off/Monitor/Live gate for the live desktop inference path, and the
/// only place `Off` is interpreted. `Off` must never reach a model at all --
/// not the fusion state, not the feature extractor, not the backend -- so
/// [`ingest_ppg_window`] returns on `false` before it touches the window.
/// `Monitor` and `Live` both classify identically; the difference between
/// them is decided downstream by [`GesturePolicy`] alone and enforced in
/// [`decision_actuates`], never by short-circuiting classification here
/// (which is exactly what makes Monitor a faithful preview of Live).
fn mode_classifies(mode: InferenceMode) -> bool {
    match mode {
        InferenceMode::Off => false,
        InferenceMode::Monitor | InferenceMode::Live => true,
    }
}

/// A window that does not match what the model was trained on is still
/// classified and reported in `Monitor` (so the mismatch can be inspected),
/// but never reaches a model in `Live`, where it could drive real actions.
fn window_mismatch_blocks(mode: InferenceMode) -> bool {
    matches!(mode, InferenceMode::Live)
}

/// Ingests one raw PPG batch into the desktop gesture-policy pipeline: the
/// single call site `WatchEvent::Ppg` is routed through (see `crate::lib`).
/// Skipped entirely when inference is `Off` (see [`mode_classifies`]) or no
/// model is active (see [`model_registry::active_model_runtime_config`]) --
/// there is no grab to protect and nothing for replay tooling to usefully
/// compare against. Otherwise every window -- accepted or rejected -- is
/// reported once via [`PPG_WINDOW_OBSERVED_EVENT`] for replay/comparison
/// observability. A rejection (whether from stale/out-of-order ordering or
/// the sensor-quality gate) forces an immediate, safe release, exactly like
/// an explicit model-runtime failure. An accepted window is fused with the
/// last-known watch orientation and classified against the active model; the
/// resulting transition (if any) is fed straight into
/// [`GesturePolicyRuntime`] and nowhere else.
pub(crate) fn ingest_ppg_window(app: &AppHandle, sample: &WatchPpgBatchSample) {
    let Some(config) = model_registry::active_model_runtime_config(app) else {
        return;
    };
    if !mode_classifies(config.inference_mode) {
        return;
    }
    let config_mode = config.inference_mode;
    let model_registry::ActiveModelRuntimeConfig {
        model_id: active_model_id,
        thresholds,
        quality_gate,
        ..
    } = config;
    let ingest = app.state::<PpgIngestRuntime>();
    let pinch = app.state::<PinchInferenceRuntime>();
    // Hold the window to what the model was trained on (R-M3-1): the bundle's
    // `min_samples_per_window` can only tighten the registry's sample gate,
    // and the window's duration is compared with its `window_ms`. A bundle
    // that cannot be loaded yields no declaration; classification below then
    // fails closed on the same load error.
    let declared = pinch
        .declared_window(app, &active_model_id, thresholds)
        .ok();
    let mut quality_gate = quality_gate;
    if let Some(declared) = declared {
        quality_gate.min_sample_count = quality_gate
            .min_sample_count
            .max(declared.min_samples_per_window);
    }
    let window_check = declared.map(|declared| {
        model_registry::check_window(
            declared,
            model_registry::observed_window_ms(&sample.timestamps_ns),
        )
    });
    ingest.record_window_check(&active_model_id, window_check);
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
        window: window_check,
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
        force_release_policy(app, reason);
        return;
    }
    // `Accepted` only happens once `evaluate_ppg_window_quality` has already
    // resolved a contact-quality mean, so this is always `Some` -- the `else`
    // arm only guards against that invariant ever silently breaking.
    let Some(contact_quality_mean) = contact_quality_mean else {
        warn!("accepted PPG window unexpectedly had no contact-quality mean");
        return;
    };
    if let Some(check) = window_check
        && !check.compatible
        && window_mismatch_blocks(config_mode)
    {
        warn!(model_id = %active_model_id, "{}; refusing to classify in Live", check.describe());
        force_release_policy(app, ForceReleaseReason::ModelRuntimeFailure);
        return;
    }
    match pinch.classify(
        app,
        &active_model_id,
        thresholds,
        sample,
        contact_quality_mean,
    ) {
        ClassifyOutcome::Transition(transition) => {
            let gesture_policy = app.state::<GesturePolicyRuntime>();
            // `on_transition` only sees the generic, pre-binding intent (every
            // `Started` is provisionally `VolumeGrab`). The bindings remap
            // runs and the policy's `executed` flag is corrected inside one
            // policy-lock acquisition, so no other transition (watchdog,
            // forced release, mode change) can interleave and see
            // the stale flag -- otherwise a model that binds `pinch_start` to
            // `NoAction` would still have its later `pinch_release` actuate a
            // real overlay release for a grab that never happened.
            match gesture_policy
                .on_transition_resolved(transition, |decision| pinch.resolve_intent(decision))
            {
                Ok(decision) => {
                    apply_decision(app, decision);
                }
                Err(error) => warn!(%error, "failed to apply classified pinch transition"),
            }
        }
        ClassifyOutcome::NoChange => {}
        ClassifyOutcome::LoadFailed(error) => {
            warn!(%error, model_id = %active_model_id, "failed to load pinch inference model backend");
            force_release_policy(app, ForceReleaseReason::ModelRuntimeFailure);
        }
        ClassifyOutcome::FusionRejected(rejection) => {
            warn!(?rejection, model_id = %active_model_id, "rejected PPG window during telemetry fusion");
            force_release_policy(app, ForceReleaseReason::StaleSensorWindow);
        }
    }
}

/// Resets the pinch classifier's own internal "active" flag and force-
/// releases [`GesturePolicyRuntime`] -- the shared core every model-scoped
/// "this telemetry can no longer be trusted" case funnels through (a
/// rejected/stale PPG window, a fusion rejection, or a model load failure).
/// Deliberately does not touch the overlay directly: [`apply_decision`]
/// already releases it if (and only if) the policy was actually tracking a
/// model-driven grab, so a button-driven grab that has nothing to do with
/// model classification is left alone. Resetting the classifier keeps its
/// internal state in sync with the policy immediately, rather than waiting
/// for a future released-dominant window to self-heal it.
fn force_release_policy(app: &AppHandle, reason: ForceReleaseReason) {
    app.state::<PinchInferenceRuntime>().reset();
    let gesture_policy = app.state::<GesturePolicyRuntime>();
    match gesture_policy.force_release(reason) {
        Ok(decision) => apply_decision(app, decision),
        Err(error) => warn!(%error, "failed to force-release gesture policy"),
    }
}

/// [`force_release_policy`] plus an unconditional overlay release -- for
/// watch-connection-level anomalies (disconnect, a malformed/out-of-order
/// inbound message, an unavailable/errored PPG sensor, or a lagged event
/// channel) where the watch's own last-reported button state can no longer
/// be trusted either, unlike a single rejected PPG window.
pub(crate) fn force_release_and_hide(app: &AppHandle, reason: ForceReleaseReason) {
    app.state::<AutomationRuntime>().cancel(app);
    force_release_policy(app, reason);
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
    /// The window could not be safely fused with a trustworthy orientation
    /// snapshot (stale, mismatched device, non-finite, or internally
    /// out-of-order) -- see [`pinch_inference::FusionRejection`].
    FusionRejected(FusionRejection),
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
            fusion.observe_orientation(sample, desktop_monotonic_now_ns());
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

    /// Returns the loaded backend for `model_id`, (re)loading it first if it
    /// is missing or was built for a different model or thresholds.
    fn ensure_loaded<'a>(
        loaded: &'a mut Option<LoadedPinchModel>,
        app: &AppHandle,
        model_id: &str,
        thresholds: ModelThresholds,
    ) -> Result<&'a mut LoadedPinchModel, String> {
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
            let snapshot = model_registry::ActiveModelSnapshot::verified(app, model_id)?;
            let path = model_registry::active_model_file_path(app, model_id)?;
            let backend = load_model_backend(&path)?;
            *loaded = Some(LoadedPinchModel {
                runtime: DesktopPinchRuntime::new(
                    backend,
                    snapshot.thresholds.start_threshold as f32,
                    snapshot.thresholds.release_threshold as f32,
                ),
                snapshot,
            });
        }
        loaded
            .as_mut()
            .ok_or_else(|| "pinch inference model failed to load".to_string())
    }

    /// The window settings the active model's bundle declares, loading (and
    /// fully revalidating) the model first if needed. Used to hold each live
    /// window to what the model was trained on before it is classified.
    fn declared_window(
        &self,
        app: &AppHandle,
        model_id: &str,
        thresholds: ModelThresholds,
    ) -> Result<model_registry::DeclaredWindow, String> {
        let mut loaded = self
            .loaded
            .lock()
            .map_err(|_| "pinch inference model lock was poisoned".to_string())?;
        Ok(Self::ensure_loaded(&mut loaded, app, model_id, thresholds)?
            .snapshot
            .declared_window)
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
            let window = match fusion.fuse_ppg_window(
                sample,
                contact_quality_mean,
                desktop_monotonic_now_ns(),
            ) {
                Ok(window) => window,
                Err(rejection) => return ClassifyOutcome::FusionRejected(rejection),
            };
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
        let model = match Self::ensure_loaded(&mut loaded, app, model_id, thresholds) {
            Ok(model) => model,
            Err(error) => return ClassifyOutcome::LoadFailed(error),
        };
        // A custom bundle may declare a strict subset of the canonical
        // feature registry; select exactly the values this model's own
        // verified contract declared, in its declared order (never the full
        // vector unconditionally) -- see `ActiveModelSnapshot::feature_indices`.
        let selected = pinch_inference::select_features(&features, &model.snapshot.feature_indices);
        // Desktop receive-time, not `sample.timestamp_ns` -- the watch's own
        // envelope timestamp runs on an unrelated, unsynchronized device
        // clock, and `GesturePolicy::on_tick`'s staleness watchdog compares
        // whatever timestamp lands in the resulting `PinchTransition` against
        // its own desktop-side "now" (see [`GesturePolicyRuntime::tick`]).
        match model.runtime.submit(&selected, desktop_monotonic_now_ns()) {
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

/// Desktop-side monotonic receive-time clock, anchored once at first call.
/// Immune to wall-clock/NTP adjustments (unlike `SystemTime`), and never
/// derived from a watch-sourced timestamp: comparing this module's own
/// "now" against a raw Watch envelope timestamp would mix two independent,
/// unsynchronized device clocks, defeating [`STALENESS_WATCHDOG_INTERVAL`]'s
/// purpose. Raw Watch timestamps stay in play only for ordering/diagnostics
/// (see [`PpgIngestRuntime`] and [`PpgWindowObservation::timestamp_ns`]).
fn desktop_monotonic_now_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    let start = START.get_or_init(Instant::now);
    start.elapsed().as_nanos() as u64
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

    #[cfg(test)]
    fn on_transition(&self, transition: PinchTransition) -> Result<PolicyDecision, String> {
        let mut policy = self
            .policy
            .lock()
            .map_err(|_| "gesture policy lock was poisoned".to_string())?;
        Ok(policy.on_transition(transition))
    }

    /// [`Self::on_transition`] plus model-binding resolution as one atomic
    /// step. `resolve` remaps the generic decision through the active
    /// model's intent bindings; when that remaps a `Started` decision, the
    /// policy's recorded `executed` state is corrected to match (see
    /// [`GesturePolicy::correct_grab_executed`], which must run before any
    /// further transition). The policy lock is held across all three, so the
    /// correction can never be interleaved by another producer. `resolve`
    /// must not take the policy lock.
    fn on_transition_resolved(
        &self,
        transition: PinchTransition,
        resolve: impl FnOnce(PolicyDecision) -> PolicyDecision,
    ) -> Result<PolicyDecision, String> {
        let mut policy = self
            .policy
            .lock()
            .map_err(|_| "gesture policy lock was poisoned".to_string())?;
        let decision = resolve(policy.on_transition(transition));
        if decision.reason == DecisionReason::Started {
            policy.correct_grab_executed(decision_actuates(decision));
        }
        Ok(decision)
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
        Ok(policy.on_tick(desktop_monotonic_now_ns()))
    }
}

/// Whether `decision` will reach an action-performing desktop adapter (the
/// overlay window / volume backend) at all. This is the single predicate
/// that separates `Monitor` from `Live` on the desktop side: every decision
/// is emitted for observability, but only one this returns `true` for is
/// executed. Intents not yet wired to a desktop action (`Mute`, `PlayPause`,
/// `PreviousTrack`, `NextTrack`) are reported but never executed: no model
/// in this milestone produces them, and adding the action here without a
/// real producer would be dead code.
fn decision_actuates(decision: PolicyDecision) -> bool {
    decision.live
        && matches!(
            decision.intent,
            GestureIntent::VolumeGrab | GestureIntent::VolumeRelease
        )
}

/// Emits `decision` for observability, then executes it against the overlay
/// if (and only if) [`decision_actuates`] says it may.
pub(crate) fn apply_decision(app: &AppHandle, decision: PolicyDecision) {
    if let Err(error) = app.emit(GESTURE_POLICY_EVENT, decision) {
        warn!(%error, "failed to emit gesture policy decision");
    }
    if !decision_actuates(decision) {
        return;
    }
    let automation = app.state::<AutomationRuntime>();
    match decision.intent {
        GestureIntent::VolumeGrab => automation.set_pinch(app, true),
        GestureIntent::VolumeRelease => match decision.reason {
            // A forced release (model failure, stale window, disconnect) also cancels what the pinch started.
            DecisionReason::ForcedRelease(_) => automation.cancel(app),
            _ => automation.set_pinch(app, false),
        },
        GestureIntent::NoAction
        | GestureIntent::Mute
        | GestureIntent::PlayPause
        | GestureIntent::PreviousTrack
        | GestureIntent::NextTrack => {}
    }
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

/// Covers the Off/Monitor/Live gating this module owns, end to end over a
/// real [`GesturePolicy`], without needing a Tauri `AppHandle`: the two pure
/// seams [`mode_classifies`] (does a window reach the model at all?) and
/// [`decision_actuates`] (does a decision reach the overlay/volume backend?)
/// are exactly what `ingest_ppg_window` and `apply_decision` branch on, so
/// pinning them pins the modes' real behavior.
#[cfg(test)]
mod inference_mode_tests {
    use super::*;

    /// Drives `transitions` through a policy in `mode` and returns every
    /// decision that `apply_decision` would actually execute.
    fn actuated(mode: InferenceMode, transitions: &[PinchTransition]) -> Vec<PolicyDecision> {
        let mut policy = GesturePolicy::new(GesturePolicyConfig::default());
        policy.set_mode(to_policy_mode(mode));
        transitions
            .iter()
            .map(|transition| policy.on_transition(*transition))
            .filter(|decision| decision_actuates(*decision))
            .collect()
    }

    fn pinch_arc() -> [PinchTransition; 3] {
        [
            PinchTransition::Started {
                confidence: 0.9,
                timestamp_ns: 100,
            },
            PinchTransition::Held {
                confidence: 0.9,
                timestamp_ns: 200,
            },
            PinchTransition::Released {
                confidence: 0.9,
                timestamp_ns: 300,
            },
        ]
    }

    #[test]
    fn only_monitor_and_live_ever_reach_the_model() {
        assert!(!mode_classifies(InferenceMode::Off));
        assert!(mode_classifies(InferenceMode::Monitor));
        assert!(mode_classifies(InferenceMode::Live));
    }

    #[test]
    fn off_is_the_registrys_default_so_a_fresh_install_never_classifies() {
        assert!(!mode_classifies(InferenceMode::default()));
    }

    #[test]
    fn a_full_monitor_gesture_never_reaches_an_action_performing_adapter() {
        assert_eq!(
            actuated(InferenceMode::Monitor, &pinch_arc()),
            Vec::new(),
            "Monitor must classify and report only -- never touch the overlay"
        );
    }

    #[test]
    fn a_full_off_gesture_never_reaches_an_action_performing_adapter() {
        // `Off` never gets this far (see `mode_classifies`), but if a
        // transition arrives anyway, it must be just as inert.
        assert_eq!(actuated(InferenceMode::Off, &pinch_arc()), Vec::new());
    }

    #[test]
    fn a_full_live_gesture_actuates_exactly_the_grab_and_its_release() {
        let executed = actuated(InferenceMode::Live, &pinch_arc());
        let intents: Vec<_> = executed.iter().map(|decision| decision.intent).collect();
        assert_eq!(
            intents,
            vec![GestureIntent::VolumeGrab, GestureIntent::VolumeRelease],
            "Held must not actuate; grab and release must"
        );
    }

    #[test]
    fn a_monitor_mode_forced_release_never_reaches_the_overlay() {
        // The overlay may well be grabbed right now by the Watch button,
        // which routes around this policy entirely (see `crate::run`'s
        // `WatchEvent::Button` handling). A dropped PPG window under Monitor
        // must not tear that grab down.
        for reason in [
            ForceReleaseReason::SensorQualityRejected,
            ForceReleaseReason::StaleSensorWindow,
            ForceReleaseReason::ModelRuntimeFailure,
        ] {
            let mut policy = GesturePolicy::new(GesturePolicyConfig::default());
            policy.set_mode(PolicyMode::Monitor);
            policy.on_transition(pinch_arc()[0]);
            assert!(
                !decision_actuates(policy.force_release(reason)),
                "Monitor actuated a forced release for {reason:?}"
            );
        }
    }

    #[test]
    fn a_live_mode_forced_release_does_reach_the_overlay() {
        for reason in [
            ForceReleaseReason::SensorQualityRejected,
            ForceReleaseReason::StaleSensorWindow,
            ForceReleaseReason::ModelRuntimeFailure,
            ForceReleaseReason::WatchDisconnected,
        ] {
            let mut policy = GesturePolicy::new(GesturePolicyConfig::default());
            policy.set_mode(PolicyMode::Live);
            policy.on_transition(pinch_arc()[0]);
            let decision = policy.force_release(reason);
            assert!(
                decision_actuates(decision),
                "Live failed to release a real grab for {reason:?}"
            );
            assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        }
    }

    #[test]
    fn decision_actuates_ignores_intents_with_no_desktop_action() {
        for intent in [
            GestureIntent::NoAction,
            GestureIntent::Mute,
            GestureIntent::PlayPause,
            GestureIntent::PreviousTrack,
            GestureIntent::NextTrack,
        ] {
            assert!(!decision_actuates(PolicyDecision {
                intent,
                reason: DecisionReason::Started,
                live: true,
            }));
        }
    }

    #[test]
    fn inference_mode_maps_onto_the_matching_policy_mode() {
        assert_eq!(to_policy_mode(InferenceMode::Off), PolicyMode::Off);
        assert_eq!(to_policy_mode(InferenceMode::Monitor), PolicyMode::Monitor);
        assert_eq!(to_policy_mode(InferenceMode::Live), PolicyMode::Live);
    }
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

    /// D-M2-2: a watch reboot restarts its boot-relative clock, so the first
    /// window after reconnecting is "older" than the stale watermark. The
    /// watermark must be cleared on disconnect so ingestion recovers.
    #[test]
    fn clearing_the_watermark_lets_a_rebooted_watch_resume_ingestion() {
        let runtime = PpgIngestRuntime::default();
        let config = QualityGateConfig::default();
        let before_reboot = ppg_sample(1_000_000, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        let after_reboot = ppg_sample(10, &[(0, 0, 0), (0, 0, 0), (0, 0, 0)]);
        assert_eq!(
            runtime.evaluate(&before_reboot, &config).unwrap(),
            PpgWindowOutcome::Accepted
        );
        assert!(matches!(
            runtime.evaluate(&after_reboot, &config).unwrap(),
            PpgWindowOutcome::RejectedStaleOrOutOfOrder { .. }
        ));

        runtime.clear();

        assert_eq!(
            runtime.evaluate(&after_reboot, &config).unwrap(),
            PpgWindowOutcome::Accepted
        );
        // Ordering within the new connection is still enforced.
        assert!(matches!(
            runtime.evaluate(&after_reboot, &config).unwrap(),
            PpgWindowOutcome::RejectedStaleOrOutOfOrder { .. }
        ));
    }

    /// R-M3-1: only `Live` may refuse a window for not matching the model's
    /// training window; `Monitor` and `Off` never block on it.
    #[test]
    fn only_live_blocks_on_a_window_mismatch() {
        assert!(window_mismatch_blocks(InferenceMode::Live));
        assert!(!window_mismatch_blocks(InferenceMode::Monitor));
        assert!(!window_mismatch_blocks(InferenceMode::Off));
    }

    #[test]
    fn a_mismatched_window_keeps_its_model_out_of_live_until_a_compatible_one_arrives() {
        let runtime = PpgIngestRuntime::default();
        let declared = model_registry::DeclaredWindow {
            window_ms: 500.0,
            min_samples_per_window: 3,
        };
        let mismatched = model_registry::check_window(declared, Some(960.0));
        let compatible = model_registry::check_window(declared, Some(480.0));

        // Nothing observed yet: nothing to refuse on.
        assert!(runtime.live_blocking_window_mismatch("m1").is_none());

        runtime.record_window_check("m1", Some(mismatched));
        assert_eq!(
            runtime.live_blocking_window_mismatch("m1"),
            Some(mismatched)
        );
        // The verdict belongs to the model it was made against.
        assert!(runtime.live_blocking_window_mismatch("m2").is_none());

        runtime.record_window_check("m1", Some(compatible));
        assert!(runtime.live_blocking_window_mismatch("m1").is_none());

        // A disconnect forgets the verdict.
        runtime.record_window_check("m1", Some(mismatched));
        runtime.clear();
        assert!(runtime.live_blocking_window_mismatch("m1").is_none());
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
            window: Some(model_registry::check_window(
                model_registry::DeclaredWindow {
                    window_ms: 500.0,
                    min_samples_per_window: 3,
                },
                Some(480.0),
            )),
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

    /// End-to-end regression for the asymmetric-binding gap: a valid model
    /// may bind `pinch_start` to `NoAction` while `pinch_release` stays bound
    /// to `VolumeRelease`. Drives a real `GesturePolicy` through the same
    /// `on_transition` -> `resolve_intent` -> correct-executed sequence
    /// `ingest_ppg_window` uses, and proves the eventual `Released` -- for a
    /// `Started` that resolved to `NoAction` -- never actuates. Before the
    /// fix, `GesturePolicy` recorded `executed` from the raw pre-binding
    /// `VolumeGrab` decision (live in `Live` mode), so the matching release
    /// would actuate and tear down an unrelated Watch-button grab even
    /// though nothing was ever really grabbed.
    #[test]
    fn asymmetric_bindings_prevent_a_resolved_no_action_start_from_leaking_into_the_release() {
        let runtime = runtime_with_loaded_snapshot(&[
            ("negative", GestureIntent::NoAction),
            ("pinch_start", GestureIntent::NoAction),
            ("pinch_release", GestureIntent::VolumeRelease),
        ]);
        let mut policy = GesturePolicy::new(GesturePolicyConfig::default());
        policy.set_mode(PolicyMode::Live);

        let started = policy.on_transition(PinchTransition::Started {
            confidence: 0.9,
            timestamp_ns: 1,
        });
        let started = runtime.resolve_intent(started);
        assert_eq!(started.intent, GestureIntent::NoAction);
        if started.reason == DecisionReason::Started {
            policy.correct_grab_executed(decision_actuates(started));
        }
        assert!(
            !decision_actuates(started),
            "a NoAction start must never actuate"
        );

        let released = policy.on_transition(PinchTransition::Released {
            confidence: 0.9,
            timestamp_ns: 2,
        });
        let released = runtime.resolve_intent(released);
        assert_eq!(released.intent, GestureIntent::VolumeRelease);
        assert!(
            !decision_actuates(released),
            "a start that resolved to NoAction must never let its matching release actuate \
             and tear down an unrelated Watch-button grab"
        );
    }

    /// D-M4-2 regression: the `executed` correction used to run in a separate
    /// lock acquisition from `on_transition`, so a `Released` from another
    /// producer could interleave and actuate a live release for a grab the
    /// model bound to `NoAction`. Here a second thread submits that
    /// `Released` while the first is still inside its resolve step.
    #[test]
    fn interleaved_release_cannot_see_the_uncorrected_executed_flag() {
        let runtime = GesturePolicyRuntime::default();
        runtime.set_mode(InferenceMode::Live).unwrap();

        let (started, released) = std::thread::scope(|scope| {
            let mut interposed = None;
            let started = runtime
                .on_transition_resolved(
                    PinchTransition::Started {
                        confidence: 0.9,
                        timestamp_ns: 1,
                    },
                    |decision| {
                        interposed = Some(scope.spawn(|| {
                            runtime
                                .on_transition(PinchTransition::Released {
                                    confidence: 0.9,
                                    timestamp_ns: 2,
                                })
                                .unwrap()
                        }));
                        // Give the other thread ample time to win the lock if
                        // the policy lock were not held across this step.
                        std::thread::sleep(Duration::from_millis(100));
                        PolicyDecision {
                            intent: GestureIntent::NoAction,
                            ..decision
                        }
                    },
                )
                .unwrap();
            (started, interposed.unwrap().join().unwrap())
        });

        assert!(!decision_actuates(started));
        assert_eq!(released.intent, GestureIntent::VolumeRelease);
        assert!(
            !decision_actuates(released),
            "a start resolved to NoAction must never let an interleaved release actuate"
        );
    }

    /// R-M4-7: event names are a hand-maintained cross-language contract; the
    /// frontend's single declaration must equal the Rust constant.
    #[test]
    fn event_names_match_the_frontend_protocol() {
        let events_ts = include_str!("../../src/shared/protocol/events.ts");
        for (name, value) in [
            ("GESTURE_POLICY_EVENT", GESTURE_POLICY_EVENT),
            ("OVERLAY_STATE_EVENT", crate::overlay::OVERLAY_STATE_EVENT),
        ] {
            let declaration = format!("export const {name} = \"{value}\";");
            assert!(
                events_ts.contains(&declaration),
                "events.ts must declare `{declaration}`"
            );
        }
    }
}
