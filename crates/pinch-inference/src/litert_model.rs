//! Real LiteRT-backed [`PinchModel`], loading a `model.tflite` bundle
//! produced by the desktop Model Lab's `tflite` training backend (see
//! `bundle.py`). Gated behind the `litert` Cargo feature: `litert-sys` (the
//! native binding this pulls in) fetches a prebuilt LiteRT shared library at
//! build time, which is unsuitable as a default dependency of every
//! `cargo check`/`cargo test` run -- see this crate's `Cargo.toml`.

use std::path::Path;

use litert::{
    CompilationOptions, CompiledModel, ElementType, Environment, Model, TensorBuffer, TensorShape,
};

use crate::features::FEATURE_COUNT;
use crate::model::{CLASS_COUNT, PinchModel, PinchModelError};

impl From<litert::Error> for PinchModelError {
    fn from(error: litert::Error) -> Self {
        PinchModelError::Backend(error.to_string())
    }
}

/// One loaded LiteRT model, compiled for CPU execution. `env` is kept
/// separate from the `Environment` consumed by [`CompiledModel::new`] since
/// `CompiledModel` does not expose its environment back out, and
/// [`TensorBuffer::managed_host`] needs one to allocate input/output buffers.
pub struct LiteRtPinchModel {
    env: Environment,
    compiled: CompiledModel,
}

impl LiteRtPinchModel {
    /// Loads and compiles `model_path` (a validated bundle's `model.tflite`,
    /// see `model_registry::model_is_activatable`). The bundle's own
    /// `metadata.json` has already validated the feature/class contract
    /// before this is ever called -- this just runs it.
    pub fn load(model_path: &Path) -> Result<Self, PinchModelError> {
        let env = Environment::new()?;
        let model = Model::from_file(model_path)?;
        let options = CompilationOptions::new()?;
        let compiled = CompiledModel::new(Environment::new()?, model, &options)?;
        Ok(Self { env, compiled })
    }
}

impl PinchModel for LiteRtPinchModel {
    fn predict(
        &mut self,
        features: &[f32; FEATURE_COUNT],
    ) -> Result<[f32; CLASS_COUNT], PinchModelError> {
        let input_shape = TensorShape {
            element_type: ElementType::Float32,
            dims: vec![1, FEATURE_COUNT as i32],
        };
        let mut input = TensorBuffer::managed_host(&self.env, &input_shape)?;
        {
            let mut guard = input.lock_for_write::<f32>()?;
            guard.copy_from_slice(features);
        }

        let output_shape = TensorShape {
            element_type: ElementType::Float32,
            dims: vec![1, CLASS_COUNT as i32],
        };
        let output = TensorBuffer::managed_host(&self.env, &output_shape)?;
        // `CompiledModel::run` owns its input/output buffer slices. Retain
        // the output in a local array so the resulting tensor remains
        // available for the read lock after execution.
        let mut inputs = [input];
        let mut outputs = [output];
        self.compiled.run(&mut inputs, &mut outputs)?;

        let guard = outputs[0].lock_for_read::<f32>()?;
        if guard.len() != CLASS_COUNT {
            return Err(PinchModelError::Backend(format!(
                "model output has {} elements, expected exactly {CLASS_COUNT}",
                guard.len()
            )));
        }
        let mut probabilities = [0.0f32; CLASS_COUNT];
        probabilities.copy_from_slice(&guard[..CLASS_COUNT]);
        Ok(probabilities)
    }
}
