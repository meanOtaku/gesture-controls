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

#[derive(Debug, Error)]
pub enum PinchModelError {
    #[error("model input/output contained a non-finite value")]
    NonFiniteOutput,
    #[error("model backend failure: {0}")]
    Backend(String),
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
}
