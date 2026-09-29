//! Rust port of `tools/pinch-classifier/src/pinch_classifier/desktop_runtime.py`'s
//! `DesktopPinchRuntime`: the fail-closed threshold state machine that turns
//! one model's raw `[negative, pinch_start, pinch_release]` probabilities
//! into the same [`PinchTransition`] sequence
//! `crate::interaction_engine::GesturePolicy` expects. Kept behaviorally
//! identical to the Python reference so offline training/evaluation and live
//! desktop inference agree on when a pinch starts, holds, and releases.

use interaction_engine::PinchTransition;

use crate::model::{PinchModel, PinchModelError, validate_probabilities};

/// Desktop-owned, per-model classification state machine. Not `Send`-bound
/// itself; callers running this on a background task should wrap it the same
/// way `GesturePolicyRuntime` wraps `GesturePolicy` (a `Mutex`).
pub struct DesktopPinchRuntime<M> {
    model: M,
    start_threshold: f32,
    release_threshold: f32,
    active: bool,
}

impl<M: PinchModel> DesktopPinchRuntime<M> {
    /// `start_threshold`/`release_threshold` come from
    /// `model_registry::ModelThresholds`, which already validates them to
    /// `(0, 1]` -- this constructor trusts that and does not re-validate.
    pub fn new(model: M, start_threshold: f32, release_threshold: f32) -> Self {
        Self {
            model,
            start_threshold,
            release_threshold,
            active: false,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Forces a safe release if a grab is in progress, without touching the
    /// model. Mirrors Python's `reset()`; used directly on stream loss (watch
    /// disconnect, mode change) where there is no new window to classify.
    pub fn reset(&mut self, timestamp_ns: u64) -> Option<PinchTransition> {
        if !self.active {
            return None;
        }
        self.active = false;
        Some(PinchTransition::Released {
            confidence: 1.0,
            timestamp_ns,
        })
    }

    /// Classifies one fused window's features and advances the state
    /// machine. Any model or input failure (non-finite features, backend
    /// error, non-finite output) is treated exactly like Python's bare
    /// `except Exception: self.reset(timestamp_ns)` -- fail closed by forcing
    /// a release if a grab was active, otherwise do nothing. The failure
    /// itself is swallowed here; a caller that wants to *additionally* report
    /// a hard runtime failure (as opposed to one bad window) should track
    /// model-load/construction errors separately (see
    /// `apps/desktop/src-tauri/src/inference.rs`'s
    /// `report_model_runtime_failure`).
    pub fn submit(&mut self, features: &[f32], timestamp_ns: u64) -> Option<PinchTransition> {
        match self.classify(features) {
            Ok(probabilities) => self.apply(probabilities, timestamp_ns),
            Err(_) => self.reset(timestamp_ns),
        }
    }

    fn classify(&mut self, features: &[f32]) -> Result<[f32; 3], PinchModelError> {
        if features.iter().any(|value| !value.is_finite()) {
            return Err(PinchModelError::NonFiniteOutput);
        }
        let probabilities = self.model.predict(features)?;
        validate_probabilities(&probabilities)
    }

    fn apply(&mut self, probabilities: [f32; 3], timestamp_ns: u64) -> Option<PinchTransition> {
        let [negative, started, released] = probabilities;
        if !self.active
            && started >= self.start_threshold
            && started > negative
            && started > released
        {
            self.active = true;
            return Some(PinchTransition::Started {
                confidence: started.clamp(0.0, 1.0),
                timestamp_ns,
            });
        }
        if self.active
            && released >= self.release_threshold
            && released > negative
            && released > started
        {
            self.active = false;
            return Some(PinchTransition::Released {
                confidence: released.clamp(0.0, 1.0),
                timestamp_ns,
            });
        }
        if self.active {
            let confidence = (1.0 - released).max(0.0);
            return Some(PinchTransition::Held {
                confidence: confidence.clamp(0.0, 1.0),
                timestamp_ns,
            });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use interaction_engine::{
        DecisionReason, ForceReleaseReason, GestureIntent, GesturePolicy, PolicyDecision,
        PolicyMode,
    };

    use super::*;

    struct StubModel {
        outputs: std::collections::VecDeque<Result<[f32; 3], PinchModelError>>,
        /// Shared with the test so it can assert not just *what* the runtime
        /// decided but whether the model was invoked at all -- the only way
        /// to prove a fail-closed path short-circuits before inference.
        calls: Arc<AtomicUsize>,
    }

    impl StubModel {
        fn new(outputs: Vec<Result<[f32; 3], PinchModelError>>) -> Self {
            Self {
                outputs: outputs.into(),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn call_counter(&self) -> Arc<AtomicUsize> {
            Arc::clone(&self.calls)
        }
    }

    impl PinchModel for StubModel {
        fn predict(&mut self, _features: &[f32]) -> Result<[f32; 3], PinchModelError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.outputs
                .pop_front()
                .unwrap_or(Err(PinchModelError::Backend(
                    "no more stubbed outputs".to_string(),
                )))
        }
    }

    fn features() -> [f32; crate::features::FEATURE_COUNT] {
        [0.0; crate::features::FEATURE_COUNT]
    }

    #[test]
    fn starts_when_started_probability_crosses_threshold_and_dominates() {
        let model = StubModel::new(vec![Ok([0.1, 0.85, 0.05])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        let transition = runtime.submit(&features(), 100);
        assert_eq!(
            transition,
            Some(PinchTransition::Started {
                confidence: 0.85,
                timestamp_ns: 100
            })
        );
        assert!(runtime.is_active());
    }

    #[test]
    fn does_not_start_below_threshold() {
        let model = StubModel::new(vec![Ok([0.3, 0.79, 0.0])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        assert_eq!(runtime.submit(&features(), 100), None);
        assert!(!runtime.is_active());
    }

    #[test]
    fn does_not_start_when_started_does_not_dominate() {
        // started >= threshold but negative is higher: must not start.
        let model = StubModel::new(vec![Ok([0.9, 0.85, 0.05])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        assert_eq!(runtime.submit(&features(), 100), None);
    }

    #[test]
    fn holds_while_active_and_released_below_threshold() {
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0]), Ok([0.1, 0.6, 0.3])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        let held = runtime.submit(&features(), 200);
        assert_eq!(
            held,
            Some(PinchTransition::Held {
                confidence: 0.7,
                timestamp_ns: 200
            })
        );
        assert!(runtime.is_active());
    }

    #[test]
    fn releases_when_released_probability_crosses_threshold_and_dominates() {
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0]), Ok([0.05, 0.1, 0.85])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        let released = runtime.submit(&features(), 200);
        assert_eq!(
            released,
            Some(PinchTransition::Released {
                confidence: 0.85,
                timestamp_ns: 200
            })
        );
        assert!(!runtime.is_active());
    }

    #[test]
    fn inactive_and_negative_dominates_emits_nothing() {
        let model = StubModel::new(vec![Ok([0.9, 0.05, 0.05])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        assert_eq!(runtime.submit(&features(), 100), None);
    }

    #[test]
    fn model_error_while_active_forces_a_release() {
        let model = StubModel::new(vec![
            Ok([0.1, 0.9, 0.0]),
            Err(PinchModelError::Backend("boom".to_string())),
        ]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        let released = runtime.submit(&features(), 200);
        assert_eq!(
            released,
            Some(PinchTransition::Released {
                confidence: 1.0,
                timestamp_ns: 200
            })
        );
        assert!(!runtime.is_active());
    }

    #[test]
    fn model_error_while_inactive_emits_nothing() {
        let model = StubModel::new(vec![Err(PinchModelError::Backend("boom".to_string()))]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        assert_eq!(runtime.submit(&features(), 100), None);
        assert!(!runtime.is_active());
    }

    #[test]
    fn non_finite_input_features_fail_closed_without_calling_model() {
        let model = StubModel::new(vec![]);
        let calls = model.call_counter();
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        let mut bad_features = features();
        bad_features[0] = f32::NAN;
        assert_eq!(runtime.submit(&bad_features, 100), None);
        assert_eq!(
            calls.load(Ordering::Relaxed),
            0,
            "the model must never see a non-finite input"
        );
    }

    #[test]
    fn reset_never_invokes_the_model() {
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0])]);
        let calls = model.call_counter();
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        runtime.reset(150);
        assert_eq!(
            calls.load(Ordering::Relaxed),
            1,
            "reset must not run inference"
        );
    }

    #[test]
    fn non_finite_model_output_forces_a_release() {
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0]), Ok([f32::NAN, 0.5, 0.5])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        let released = runtime.submit(&features(), 200);
        assert_eq!(
            released,
            Some(PinchTransition::Released {
                confidence: 1.0,
                timestamp_ns: 200
            })
        );
    }

    #[test]
    fn out_of_range_model_output_forces_a_release() {
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0]), Ok([1.4, 0.3, -0.2])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        assert_eq!(
            runtime.submit(&features(), 200),
            Some(PinchTransition::Released {
                confidence: 1.0,
                timestamp_ns: 200
            })
        );
        assert!(!runtime.is_active());
    }

    #[test]
    fn unnormalized_model_output_forces_a_release() {
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0]), Ok([0.9, 0.9, 0.9])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        assert_eq!(
            runtime.submit(&features(), 200),
            Some(PinchTransition::Released {
                confidence: 1.0,
                timestamp_ns: 200
            })
        );
        assert!(!runtime.is_active());
    }

    #[test]
    fn explicit_reset_releases_active_grab() {
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        runtime.submit(&features(), 100);
        assert_eq!(
            runtime.reset(150),
            Some(PinchTransition::Released {
                confidence: 1.0,
                timestamp_ns: 150
            })
        );
        assert!(!runtime.is_active());
    }

    #[test]
    fn reset_when_inactive_is_a_no_op() {
        let model = StubModel::new(vec![]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        assert_eq!(runtime.reset(150), None);
    }

    /// Mirrors the desktop's live seam (`inference.rs::ingest_ppg_window`):
    /// `Off` must never reach the model, `Monitor`/`Live` classify and hand
    /// every resulting transition to `GesturePolicy` and nothing else. Kept
    /// here so the crate that owns the classifier proves the mode contract
    /// against a real `GesturePolicy`, not a restatement of it.
    fn run_windows(
        mode: PolicyMode,
        outputs: Vec<Result<[f32; 3], PinchModelError>>,
    ) -> (Vec<PolicyDecision>, usize) {
        let window_count = outputs.len();
        let model = StubModel::new(outputs);
        let calls = model.call_counter();
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        let mut policy = GesturePolicy::default();
        policy.set_mode(mode);

        let mut decisions = Vec::new();
        for index in 0..window_count {
            if mode == PolicyMode::Off {
                continue;
            }
            let timestamp_ns = (index as u64 + 1) * 100;
            if let Some(transition) = runtime.submit(&features(), timestamp_ns) {
                decisions.push(policy.on_transition(transition));
            }
        }
        (decisions, calls.load(Ordering::Relaxed))
    }

    /// A decision that would actually reach an action-performing desktop
    /// adapter (the overlay / volume backend), matching
    /// `inference.rs::decision_actuates`.
    fn actuates(decision: &PolicyDecision) -> bool {
        decision.live
            && matches!(
                decision.intent,
                GestureIntent::VolumeGrab | GestureIntent::VolumeRelease
            )
    }

    fn pinch_arc() -> Vec<Result<[f32; 3], PinchModelError>> {
        vec![
            Ok([0.05, 0.9, 0.05]),  // start
            Ok([0.1, 0.6, 0.3]),    // hold
            Ok([0.05, 0.05, 0.90]), // release
        ]
    }

    #[test]
    fn off_mode_never_invokes_the_model_and_produces_no_decisions() {
        let (decisions, calls) = run_windows(PolicyMode::Off, pinch_arc());
        assert_eq!(calls, 0, "Off must never reach the model backend");
        assert!(decisions.is_empty());
    }

    #[test]
    fn monitor_mode_classifies_every_window_but_actuates_nothing() {
        let (decisions, calls) = run_windows(PolicyMode::Monitor, pinch_arc());
        assert_eq!(calls, 3, "Monitor must still classify every window");
        let reasons: Vec<_> = decisions.iter().map(|decision| decision.reason).collect();
        assert_eq!(
            reasons,
            vec![
                DecisionReason::Started,
                DecisionReason::Held,
                DecisionReason::Released
            ],
            "Monitor must record the full grab/release arc for observability"
        );
        assert!(
            !decisions.iter().any(actuates),
            "Monitor produced an executable decision: {decisions:?}"
        );
    }

    #[test]
    fn live_mode_classifies_and_actuates_the_grab_and_its_release() {
        let (decisions, calls) = run_windows(PolicyMode::Live, pinch_arc());
        assert_eq!(calls, 3);
        assert!(actuates(&decisions[0]));
        assert_eq!(decisions[0].intent, GestureIntent::VolumeGrab);
        assert!(!actuates(&decisions[1]), "Held must not actuate");
        assert!(actuates(&decisions[2]));
        assert_eq!(decisions[2].intent, GestureIntent::VolumeRelease);
    }

    #[test]
    fn a_backend_failure_mid_grab_releases_in_live_but_stays_inert_in_monitor() {
        let failing_arc = || {
            vec![
                Ok([0.05, 0.9, 0.05]),
                Err(PinchModelError::Backend("backend died".to_string())),
            ]
        };
        let (live, _) = run_windows(PolicyMode::Live, failing_arc());
        assert_eq!(live[1].intent, GestureIntent::VolumeRelease);
        assert!(
            live[1].live,
            "a failed backend must release a grab it really took"
        );

        let (monitor, calls) = run_windows(PolicyMode::Monitor, failing_arc());
        assert_eq!(calls, 2, "Monitor still runs the failing window");
        assert_eq!(monitor[1].intent, GestureIntent::VolumeRelease);
        assert!(
            !monitor[1].live,
            "Monitor must not reach the overlay even to release"
        );
    }

    #[test]
    fn a_monitor_grab_survives_no_mode_change_and_its_forced_release_stays_inert() {
        // The desktop force-releases the policy on a rejected/stale window
        // (`force_release_policy`). Under Monitor that must stay inert, or a
        // dropped PPG window would cancel an unrelated Watch-button grab.
        let model = StubModel::new(vec![Ok([0.05, 0.9, 0.05])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Monitor);
        let transition = runtime.submit(&features(), 100).expect("must start");
        assert!(!policy.on_transition(transition).live);

        runtime.reset(200);
        let decision = policy.force_release(ForceReleaseReason::SensorQualityRejected);
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        assert!(!decision.live);
        assert!(!runtime.is_active());
    }

    #[test]
    fn submit_accepts_a_reduced_length_feature_slice() {
        // A custom bundle's model may take fewer than FEATURE_COUNT inputs;
        // submit/classify must accept whatever slice length the caller
        // resolved via `select_features`, not just the full canonical array.
        let model = StubModel::new(vec![Ok([0.1, 0.85, 0.05])]);
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        let subset_features = [0.1f32, 0.2, 0.3];
        let transition = runtime.submit(&subset_features, 100);
        assert_eq!(
            transition,
            Some(PinchTransition::Started {
                confidence: 0.85,
                timestamp_ns: 100
            })
        );
    }
}
