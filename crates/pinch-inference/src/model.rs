//! The model backend seam. [`PinchModel`] is intentionally minimal (one
//! method, plain arrays) so it is trivial to mock in tests and to implement
//! against a real runtime -- see [`crate::litert_model::LiteRtPinchModel`]
//! (behind the `litert` feature) for the real backend.

use thiserror::Error;

use crate::features::FEATURE_COUNT;

/// `[negative, pinch_start, pinch_release]`, matching `bundle.py`'s
/// `CLASS_NAMES` order exactly -- a model's output tensor must be laid out
/// this way for [`crate::runtime::DesktopPinchRuntime`] to interpret it
/// correctly.
pub const CLASS_COUNT: usize = 3;

/// Per-value tolerance around the documented `[0, 1]` probability range.
/// Real softmax output never leaves this band; a value outside it indicates
/// a raw logit or a corrupt tensor, not floating-point noise.
pub const PROBABILITY_TOLERANCE: f32 = 1e-3;

/// Tolerance for how far `sum(probabilities)` may drift from `1.0`. Wider
/// than [`PROBABILITY_TOLERANCE`] because it accumulates rounding error
/// across all classes, but still tight enough to reject unnormalized or
/// raw-logit output.
pub const PROBABILITY_SUM_TOLERANCE: f32 = 1e-2;

#[derive(Debug, Error)]
pub enum PinchModelError {
    #[error("model input/output contained a non-finite value")]
    NonFiniteOutput,
    #[error("model output was not a valid probability distribution")]
    InvalidOutput,
    #[error("model backend failure: {0}")]
    Backend(String),
}

/// Validates a model's raw output tensor against the documented contract:
/// every value finite and within [`PROBABILITY_TOLERANCE`] of `[0, 1]`, and
/// the values summing to `1.0` within [`PROBABILITY_SUM_TOLERANCE`]. Values
/// that pass are clamped into `[0, 1]` exactly so downstream threshold/
/// dominance logic never sees an out-of-band float.
pub fn validate_probabilities(
    probabilities: &[f32; CLASS_COUNT],
) -> Result<[f32; CLASS_COUNT], PinchModelError> {
    let mut clamped = [0.0f32; CLASS_COUNT];
    let mut sum = 0.0f32;
    for (index, &value) in probabilities.iter().enumerate() {
        if !value.is_finite()
            || value < -PROBABILITY_TOLERANCE
            || value > 1.0 + PROBABILITY_TOLERANCE
        {
            return Err(PinchModelError::InvalidOutput);
        }
        let value = value.clamp(0.0, 1.0);
        clamped[index] = value;
        sum += value;
    }
    if (sum - 1.0).abs() > PROBABILITY_SUM_TOLERANCE {
        return Err(PinchModelError::InvalidOutput);
    }
    Ok(clamped)
}

/// One loaded, ready-to-run pinch classifier. Implementations own whatever
/// runtime handle they need (a `litert::CompiledModel`, a mock, ...) and are
/// free to be stateful (e.g. cache buffers) since `predict` takes `&mut self`.
pub trait PinchModel: Send {
    fn predict(
        &mut self,
        features: &[f32; FEATURE_COUNT],
    ) -> Result<[f32; CLASS_COUNT], PinchModelError>;
}

/// Lets `DesktopPinchRuntime<Box<dyn PinchModel>>` hold a backend picked at
/// runtime (the real LiteRT backend or [`UnavailablePinchModel`]) behind one
/// concrete type.
impl PinchModel for Box<dyn PinchModel> {
    fn predict(
        &mut self,
        features: &[f32; FEATURE_COUNT],
    ) -> Result<[f32; CLASS_COUNT], PinchModelError> {
        (**self).predict(features)
    }
}

/// Fallback backend used when no real model backend is compiled in (the
/// `litert` feature is off). Every prediction fails, which
/// [`crate::runtime::DesktopPinchRuntime::submit`] treats as fail-closed
/// (forces a release if a grab was active, otherwise emits nothing) --
/// exactly the same behavior as a real backend crashing mid-session.
pub struct UnavailablePinchModel;

impl PinchModel for UnavailablePinchModel {
    fn predict(
        &mut self,
        _features: &[f32; FEATURE_COUNT],
    ) -> Result<[f32; CLASS_COUNT], PinchModelError> {
        Err(PinchModelError::Backend(
            "no inference backend compiled in (enable the `litert` crate feature)".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_pinch_model_always_errors() {
        let mut model = UnavailablePinchModel;
        assert!(model.predict(&[0.0; FEATURE_COUNT]).is_err());
    }

    #[test]
    fn validate_probabilities_accepts_a_clean_softmax_output() {
        let output = [0.7, 0.2, 0.1];
        assert_eq!(validate_probabilities(&output).unwrap(), output);
    }

    #[test]
    fn validate_probabilities_accepts_values_within_tolerance_of_the_bounds() {
        let output = [1.0 + PROBABILITY_TOLERANCE / 2.0, 0.0, 0.0];
        let clamped = validate_probabilities(&output).unwrap();
        assert_eq!(clamped, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn validate_probabilities_rejects_a_value_far_outside_zero_one() {
        let output = [1.5, -0.3, -0.2];
        assert!(matches!(
            validate_probabilities(&output),
            Err(PinchModelError::InvalidOutput)
        ));
    }

    #[test]
    fn validate_probabilities_rejects_a_non_finite_value() {
        let output = [f32::NAN, 0.5, 0.5];
        assert!(matches!(
            validate_probabilities(&output),
            Err(PinchModelError::InvalidOutput)
        ));
    }

    #[test]
    fn validate_probabilities_rejects_unnormalized_raw_logit_output() {
        let output = [2.0, 3.0, 1.0];
        assert!(matches!(
            validate_probabilities(&output),
            Err(PinchModelError::InvalidOutput)
        ));
    }

    #[test]
    fn validate_probabilities_accepts_a_sum_slightly_off_by_tolerance() {
        let output = [0.5, 0.3, 0.2 - PROBABILITY_SUM_TOLERANCE / 2.0];
        assert!(validate_probabilities(&output).is_ok());
    }
}
