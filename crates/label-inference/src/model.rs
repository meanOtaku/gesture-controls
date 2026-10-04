use std::sync::Arc;

use model_lab_core::{
    InputContract, LabelId, LifecycleState, ModelVersion, ModelVersionId, QualityRules, Thresholds,
};
use pinch_inference::{FEATURE_COUNT, FEATURE_NAMES};
use thiserror::Error;
use tract_onnx::prelude::*;

use crate::bundle::ValidatedBundle;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ModelError {
    #[error("model '{0}' is not an Active, deployable version, so it may not be loaded")]
    NotRunnable(ModelVersionId),
    #[error("the bundle is for '{bundle}' but model '{version}' is for '{label}'")]
    LabelMismatch {
        version: ModelVersionId,
        label: LabelId,
        bundle: LabelId,
    },
    #[error(
        "the bundle's model hash does not match the registered model's, so it is not the model that was approved"
    )]
    NotTheApprovedModel,
    #[error("the model failed: {0}")]
    Inference(String),
    #[error("the model produced {0}, which is not a probability in [0, 1]")]
    BadOutput(String),
    #[error("a feature value was not finite")]
    NonFiniteFeature,
}

/// A validated model, tied to the registry version that approved it, ready to score windows.
pub struct LoadedModel {
    pub version_id: ModelVersionId,
    pub label: LabelId,
    pub input: InputContract,
    pub thresholds: Thresholds,
    pub quality: QualityRules,
    pub model_sha256: String,
    /// Positions of this model's features within the canonical 55, in the order the model expects them.
    feature_indices: Vec<usize>,
    plan: Arc<TypedRunnableModel<TypedModel>>,
    output_index: usize,
    positive_index: usize,
}

impl LoadedModel {
    /// Only a version that is Active and deployable, whose model file is the one that was approved, can be loaded.
    pub fn load(bundle: ValidatedBundle, version: &ModelVersion) -> Result<Self, ModelError> {
        if version.state != LifecycleState::Active || !version.deployable {
            return Err(ModelError::NotRunnable(version.id.clone()));
        }
        if version.label != bundle.manifest.target_label {
            return Err(ModelError::LabelMismatch {
                version: version.id.clone(),
                label: version.label.clone(),
                bundle: bundle.manifest.target_label.clone(),
            });
        }
        if version.model_sha256.as_deref() != Some(bundle.model_sha256.as_str()) {
            return Err(ModelError::NotTheApprovedModel);
        }
        // The bundle validator already proved every feature name is canonical.
        let feature_indices = bundle
            .manifest
            .input
            .features
            .iter()
            .filter_map(|name| FEATURE_NAMES.iter().position(|canonical| canonical == name))
            .collect();
        Ok(Self {
            version_id: version.id.clone(),
            label: version.label.clone(),
            // The registry is authoritative for the contract and thresholds the model runs under.
            input: version.input.clone(),
            thresholds: version.thresholds,
            quality: version.quality,
            model_sha256: bundle.model_sha256.clone(),
            feature_indices,
            output_index: bundle.output_index,
            positive_index: bundle.manifest.output.positive_index,
            plan: bundle.plan,
        })
    }

    /// The probability that this model's label is present, from the canonical features of one window.
    pub fn predict(&self, canonical: &[f32; FEATURE_COUNT]) -> Result<f64, ModelError> {
        let selected: Vec<f32> = self.feature_indices.iter().map(|&i| canonical[i]).collect();
        if selected.iter().any(|v| !v.is_finite()) {
            return Err(ModelError::NonFiniteFeature);
        }
        let input = tract_ndarray::Array2::from_shape_vec((1, selected.len()), selected)
            .map_err(|e| ModelError::Inference(e.to_string()))?;
        let outputs = self
            .plan
            .run(tvec!(input.into_tensor().into()))
            .map_err(|e| ModelError::Inference(e.to_string()))?;
        let view = outputs
            .get(self.output_index)
            .ok_or_else(|| ModelError::Inference("the output is missing".into()))?
            .to_array_view::<f32>()
            .map_err(|e| ModelError::Inference(e.to_string()))?;
        let value = view
            .iter()
            .nth(self.positive_index)
            .copied()
            .ok_or_else(|| ModelError::Inference("the positive output is missing".into()))?;
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err(ModelError::BadOutput(value.to_string()));
        }
        Ok(f64::from(value))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bundle::tests::fixture_dir;
    use crate::bundle::validate_bundle;
    use model_lab_core::{ModelOrigin, ProjectId};

    /// The registered version the fixture bundle was approved as.
    pub fn active_version(bundle: &ValidatedBundle) -> ModelVersion {
        let mut v = ModelVersion::new(
            ModelVersionId::new("shake-v1").unwrap(),
            ProjectId::new("p-shake").unwrap(),
            bundle.manifest.target_label.clone(),
            ModelOrigin::Imported,
            true,
            Some(bundle.model_sha256.clone()),
            "models/shake-v1".into(),
            bundle.manifest.input_contract(),
            bundle.manifest.threshold_config(),
            bundle.manifest.quality,
            "2026-10-04T00:00:00Z",
        )
        .unwrap();
        v.state = LifecycleState::Active;
        v
    }

    pub fn loaded() -> LoadedModel {
        let bundle = validate_bundle(&fixture_dir(), None).unwrap();
        let version = active_version(&bundle);
        LoadedModel::load(bundle, &version).unwrap()
    }

    /// Canonical features with the four std features this fixture reads set to `level`.
    pub fn features_at(level: f32) -> [f32; FEATURE_COUNT] {
        let mut f = [0.0; FEATURE_COUNT];
        for name in [
            "accel_x_std",
            "accel_y_std",
            "accel_z_std",
            "accel_magnitude_std",
        ] {
            f[FEATURE_NAMES.iter().position(|n| *n == name).unwrap()] = level;
        }
        f
    }

    #[test]
    fn a_loaded_model_scores_quiet_low_and_shaking_high_using_only_its_declared_features() {
        let model = loaded();
        assert!(model.predict(&features_at(0.25)).unwrap() < 0.1);
        assert!(model.predict(&features_at(5.0)).unwrap() > 0.9);
        // Features it does not declare are ignored, however wild.
        let mut noisy = features_at(0.25);
        noisy[0] = 9999.0;
        assert_eq!(
            model.predict(&noisy).unwrap(),
            model.predict(&features_at(0.25)).unwrap()
        );
    }

    #[test]
    fn a_non_finite_feature_is_refused_rather_than_guessed_at() {
        let model = loaded();
        let mut bad = features_at(1.0);
        bad[FEATURE_NAMES
            .iter()
            .position(|n| *n == "accel_x_std")
            .unwrap()] = f32::NAN;
        assert_eq!(model.predict(&bad), Err(ModelError::NonFiniteFeature));
    }

    #[test]
    fn only_an_active_deployable_version_whose_hash_matches_can_be_loaded() {
        let load = |change: &dyn Fn(&mut ModelVersion)| {
            let bundle = validate_bundle(&fixture_dir(), None).unwrap();
            let mut version = active_version(&bundle);
            change(&mut version);
            LoadedModel::load(bundle, &version).map(|_| ())
        };
        assert!(load(&|_| {}).is_ok());
        assert!(matches!(
            load(&|v| v.state = LifecycleState::Approved),
            Err(ModelError::NotRunnable(_))
        ));
        assert!(matches!(
            load(&|v| v.deployable = false),
            Err(ModelError::NotRunnable(_))
        ));
        assert!(matches!(
            load(&|v| v.label = LabelId::new("swipe_left").unwrap()),
            Err(ModelError::LabelMismatch { .. })
        ));
        assert!(matches!(
            load(&|v| v.model_sha256 = Some("0".repeat(64))),
            Err(ModelError::NotTheApprovedModel)
        ));
    }
}
