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
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::model_registry::InferenceMode;
use crate::overlay::OverlayRuntime;

pub const GESTURE_POLICY_EVENT: &str = "gesture-policy-decision";

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
