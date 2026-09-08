//! Desktop-owned fail-closed gesture policy runtime.
//!
//! Turns typed pinch model transitions (Started/Held/Released, produced by
//! whatever runs desktop-side inference against the active model in
//! [`crate::model_registry`]) into the closed set of safe fixed intents in
//! [`interaction_engine::GestureIntent`], gated by the registry's
//! Off/Monitor/Live inference mode. See Milestone 11 in
//! `docs/architecture/project-brief.md` and `apps/desktop/ARCHITECTURE.md`.
//!
//! This module does not run any model itself -- no LiteRT execution happens
//! in Rust yet. [`report_pinch_transition`] is the seam a future inference
//! pipeline calls once it has already classified a window; until then it
//! also serves as the integration point for replay/observability tooling.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use interaction_engine::{
    ForceReleaseReason, GestureIntent, GesturePolicy, GesturePolicyConfig, PinchTransition,
    PolicyDecision, PolicyMode,
};
use serde::Serialize;
use spatial_protocol::WatchPpgBatchSample;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::model_registry::{self, InferenceMode, QualityGateConfig, QualityGateRejection};
use crate::overlay::OverlayRuntime;

pub const GESTURE_POLICY_EVENT: &str = "gesture-policy-decision";

/// Emitted whenever a raw PPG window is rejected by the active model's
/// sensor-quality gate before it could ever reach inference. `timestamp_ns`
/// is the watch-reported envelope timestamp for the batch (see
/// `WatchPpgBatchSample::timestamp_ns` in `spatial_protocol`), never a
/// desktop-side substitute, so replay/observability tooling can line this up
/// against the raw telemetry it was rejected from.
pub const SENSOR_QUALITY_EVENT: &str = "gesture-sensor-quality-rejected";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct SensorQualityRejectionEvent {
    rejection: QualityGateRejection,
    timestamp_ns: u64,
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

/// Feeds one raw PPG batch through the active model's sensor-quality gate.
/// Skipped entirely when inference is `Off` or no model is active (see
/// [`model_registry::active_quality_gate`]) -- there is no grab to protect.
/// A rejection is reported for observability and forces an immediate, safe
/// release, exactly like an explicit model-runtime failure: sensor quality
/// is evaluated *before* a window would ever reach inference, so this is the
/// gate the project brief's "sensor freshness/contact-quality gates" refers
/// to.
pub(crate) fn evaluate_ppg_quality(app: &AppHandle, sample: &WatchPpgBatchSample) {
    let Some(quality_gate) = model_registry::active_quality_gate(app) else {
        return;
    };
    let Err(rejection) = evaluate_ppg_window_quality(&quality_gate, sample) else {
        return;
    };
    if let Err(error) = app.emit(
        SENSOR_QUALITY_EVENT,
        SensorQualityRejectionEvent {
            rejection,
            timestamp_ns: sample.timestamp_ns,
        },
    ) {
        warn!(%error, "failed to emit sensor quality rejection");
    }
    let runtime = app.state::<GesturePolicyRuntime>();
    match runtime.force_release(ForceReleaseReason::SensorQualityRejected) {
        Ok(decision) => apply_decision(app, decision),
        Err(error) => {
            warn!(%error, "failed to force-release gesture policy on sensor quality rejection")
        }
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
mod ppg_quality_tests {
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
}
