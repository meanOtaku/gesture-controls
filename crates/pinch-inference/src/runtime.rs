//! Rust port of `tools/pinch-classifier/src/pinch_classifier/desktop_runtime.py`'s
//! `DesktopPinchRuntime`: the fail-closed threshold state machine that turns
//! one model's raw `[negative, pinch_start, pinch_release]` probabilities
//! into the same [`PinchTransition`] sequence
//! `crate::interaction_engine::GesturePolicy` expects. Kept behaviorally
//! identical to the Python reference so offline training/evaluation and live
//! desktop inference agree on when a pinch starts, holds, and releases.

use interaction_engine::PinchTransition;

use crate::features::FEATURE_COUNT;
use crate::model::{PinchModel, PinchModelError};

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
    pub fn submit(
        &mut self,
        features: &[f32; FEATURE_COUNT],
        timestamp_ns: u64,
    ) -> Option<PinchTransition> {
        match self.classify(features) {
            Ok(probabilities) => self.apply(probabilities, timestamp_ns),
            Err(_) => self.reset(timestamp_ns),
        }
    }

    fn classify(&mut self, features: &[f32; FEATURE_COUNT]) -> Result<[f32; 3], PinchModelError> {
        if features.iter().any(|value| !value.is_finite()) {
            return Err(PinchModelError::NonFiniteOutput);
        }
        let probabilities = self.model.predict(features)?;
        if probabilities.iter().any(|value| !value.is_finite()) {
            return Err(PinchModelError::NonFiniteOutput);
        }
        Ok(probabilities)
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
    use super::*;

    struct StubModel {
        outputs: std::collections::VecDeque<Result<[f32; 3], PinchModelError>>,
    }

    impl StubModel {
        fn new(outputs: Vec<Result<[f32; 3], PinchModelError>>) -> Self {
            Self {
                outputs: outputs.into(),
            }
        }
    }

    impl PinchModel for StubModel {
        fn predict(
            &mut self,
            _features: &[f32; FEATURE_COUNT],
        ) -> Result<[f32; 3], PinchModelError> {
            self.outputs
                .pop_front()
                .unwrap_or(Err(PinchModelError::Backend(
                    "no more stubbed outputs".to_string(),
                )))
        }
    }

    fn features() -> [f32; FEATURE_COUNT] {
        [0.0; FEATURE_COUNT]
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
        let model = StubModel::new(vec![Ok([0.1, 0.9, 0.0]), Ok([0.1, 0.2, 0.3])]);
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
        let mut runtime = DesktopPinchRuntime::new(model, 0.80, 0.80);
        let mut bad_features = features();
        bad_features[0] = f32::NAN;
        assert_eq!(runtime.submit(&bad_features, 100), None);
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
}
