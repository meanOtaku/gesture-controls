use std::sync::Arc;

use crate::bundle::TrainingRange;
use model_lab_core::{
    InputContract, LabelId, LifecycleState, ModelVersion, ModelVersionId, QualityRules, Thresholds,
};
use pinch_inference::ppg_onset::FEATURE_COUNT;
use thiserror::Error;

use crate::bundle::ValidatedBundle;
use crate::trees::TreeEnsemble;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ModelError {
    #[error("model '{0}' is not an Active version that may run, so it may not be loaded")]
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
    #[error("the model reads {expected} inputs but was given {actual}")]
    WrongInputCount { expected: usize, actual: usize },
    #[error("the model produced {0}, which is not a probability in [0, 1]")]
    BadOutput(String),
    #[error("a feature value was not finite")]
    NonFiniteFeature,
}

/// How far past its training range an input may be before it counts as outside, as a share of that range's width.
pub const RANGE_MARGIN: f64 = 0.25;
/// An input this many range-widths past its range is far outside it: one such input is enough to say a window is unlike
/// the training ones.
pub const FAR_EXCESS: f64 = 2.0;
/// The most inputs named when a window is unlike the training ones.
const WORST_INPUTS: usize = 3;

/// One input of a live decision that is outside what the model was trained on.
#[derive(Debug, Clone, PartialEq)]
pub struct OutsideInput {
    pub name: String,
    pub value: f64,
    /// The usual low and high of this input in the training decisions.
    pub low: f64,
    pub high: f64,
    /// How far past the nearer end it is, as a share of the range's width (above `RANGE_MARGIN` it counts as outside).
    pub excess: f64,
}

/// How a live decision's inputs compare with the ones the model was trained on.
#[derive(Debug, Clone, PartialEq)]
pub struct InputCheck {
    /// Inputs that could be judged (their training range had some width).
    pub judged: usize,
    /// Of those, the ones further outside their range than the margin allows.
    pub outside: usize,
    /// Of those, the ones far outside it (see [`FAR_EXCESS`]).
    pub far: usize,
    /// The furthest outside, most first.
    pub worst: Vec<OutsideInput>,
}

/// A validated model, tied to the registry version that approved it, ready to score decisions.
pub struct LoadedModel {
    pub version_id: ModelVersionId,
    pub label: LabelId,
    pub input: InputContract,
    pub thresholds: Thresholds,
    pub quality: QualityRules,
    pub model_sha256: String,
    /// An evaluation-only model allowed to run: it reports what it detects, and nothing ever acts on it.
    pub monitor_only: bool,
    /// The inputs' names as the manifest lists them.
    input_names: Vec<String>,
    /// What each input usually is in the training decisions, when the manifest says.
    pub training_range: Option<TrainingRange>,
    trees: Arc<TreeEnsemble>,
}

impl LoadedModel {
    /// Only a version that is Active and may run (deployable, or monitor-only), whose model file is the one that was
    /// approved, can be loaded.
    pub fn load(bundle: ValidatedBundle, version: &ModelVersion) -> Result<Self, ModelError> {
        if version.state != LifecycleState::Active || !version.runnable() {
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
        Ok(Self {
            version_id: version.id.clone(),
            label: version.label.clone(),
            // The registry is authoritative for the contract and thresholds the model runs under.
            input: version.input.clone(),
            thresholds: version.thresholds,
            quality: version.quality,
            model_sha256: bundle.model_sha256.clone(),
            monitor_only: !version.deployable,
            input_names: bundle.manifest.input.features.clone(),
            training_range: bundle.manifest.input.training_range.clone(),
            trees: bundle.trees,
        })
    }

    /// How the inputs this model is about to read compare with the decisions it was trained on: `None` when the trainer
    /// recorded no range, or the inputs are the wrong number to compare.
    pub fn check_input(&self, input: &[f64]) -> Option<InputCheck> {
        let range = self.training_range.as_ref()?;
        if input.len() != self.input_names.len() || range.low.len() != input.len() {
            return None;
        }
        let mut judged = 0;
        let mut outside = Vec::new();
        for (index, name) in self.input_names.iter().enumerate() {
            let (low, high) = (range.low[index], range.high[index]);
            let width = high - low;
            if width <= 0.0 || width.is_nan() {
                continue; // it never varied in training: nothing to compare with
            }
            judged += 1;
            let value = input[index];
            let excess = if value < low {
                (low - value) / width
            } else if value > high {
                (value - high) / width
            } else {
                0.0
            };
            if excess > RANGE_MARGIN {
                outside.push(OutsideInput {
                    name: name.clone(),
                    value,
                    low,
                    high,
                    excess,
                });
            }
        }
        let count = outside.len();
        let far = outside.iter().filter(|o| o.excess >= FAR_EXCESS).count();
        outside.sort_by(|a, b| b.excess.total_cmp(&a.excess));
        outside.truncate(WORST_INPUTS);
        Some(InputCheck {
            judged,
            outside: count,
            far,
            worst: outside,
        })
    }

    /// The probability that this model's label just started, from the [`FEATURE_COUNT`] features of one decision.
    pub fn predict(&self, features: &[f64]) -> Result<f64, ModelError> {
        if features.len() != FEATURE_COUNT {
            return Err(ModelError::WrongInputCount {
                expected: FEATURE_COUNT,
                actual: features.len(),
            });
        }
        if features.iter().any(|v| !v.is_finite()) {
            return Err(ModelError::NonFiniteFeature);
        }
        let value = self.trees.predict(features);
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err(ModelError::BadOutput(value.to_string()));
        }
        Ok(value)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bundle::tests::fixture_dir;
    use crate::bundle::validate_bundle;
    use model_lab_core::{ModelOrigin, ProjectId};
    use pinch_inference::ppg_onset::{PpgSample, features};

    /// The registered version the fixture bundle was approved as.
    pub fn active_version(bundle: &ValidatedBundle) -> ModelVersion {
        let mut v = ModelVersion::new(
            ModelVersionId::new("pinch-v1").unwrap(),
            ProjectId::new("p-pinch").unwrap(),
            bundle.manifest.target_label.clone(),
            ModelOrigin::Imported,
            true,
            Some(bundle.model_sha256.clone()),
            "models/pinch-v1".into(),
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

    /// The PPG trace in the fixture and the probability the trainer gives each of its samples (`None`: no features).
    pub fn expected() -> (Vec<PpgSample>, Vec<Option<f64>>) {
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(fixture_dir().join("expected.json")).unwrap(),
        )
        .unwrap();
        let samples = raw["samples"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                let r = row.as_array().unwrap();
                PpgSample {
                    ts_ns: r[0].as_u64().unwrap(),
                    green: r[1].as_f64().unwrap(),
                    red: r[2].as_f64().unwrap(),
                    ir: r[3].as_f64().unwrap(),
                }
            })
            .collect();
        let probabilities = raw["probabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(serde_json::Value::as_f64)
            .collect();
        (samples, probabilities)
    }

    #[test]
    fn the_runtime_scores_every_decision_as_the_trainer_did() {
        let model = loaded();
        let (samples, probabilities) = expected();
        let mut scored = 0;
        for (i, want) in probabilities.iter().enumerate() {
            let got = features(&samples[..=i], samples[i].ts_ns);
            match (got, want) {
                (None, None) => {}
                (Some(x), Some(want)) => {
                    let p = model.predict(&x).unwrap();
                    assert!((p - want).abs() < 1e-6, "sample {i}: {p} vs {want}");
                    scored += 1;
                }
                (got, want) => panic!("sample {i}: runtime features {}, trainer {}", got.is_some(), want.is_some()),
            }
        }
        assert!(scored > 300);
        // It tells the trace's pinch starts from the rest.
        let high = probabilities.iter().flatten().filter(|p| **p >= model.thresholds.activation).count();
        assert!(high > 0 && high < scored / 2);
    }

    #[test]
    fn inputs_far_outside_the_training_range_are_counted_and_the_furthest_named() {
        let mut model = loaded();
        let n = FEATURE_COUNT;
        let quiet = vec![0.2f64; n];
        let mut low = vec![0.0; n];
        let mut high = vec![0.5; n];
        high[0] = 0.0; // this one never varied in training: it cannot be judged
        low[0] = 0.0;
        model.training_range = Some(TrainingRange { low, high });
        let at_home = model.check_input(&quiet).unwrap();
        assert_eq!((at_home.judged, at_home.outside), (n - 1, 0));
        let mut edge = quiet.clone();
        edge[1] = 0.5 + 0.1; // 20% of the width past the high end: allowed
        assert_eq!(model.check_input(&edge).unwrap().outside, 0);
        let mut far = quiet.clone();
        far[1] = 0.5 + 0.2; // 40% past
        far[2] = -3.0; // six widths below
        let found = model.check_input(&far).unwrap();
        assert_eq!((found.outside, found.far), (2, 1));
        assert_eq!(found.worst[0].name, model.input_names[2]);
        assert!(model.check_input(&quiet[..n - 1]).is_none());
    }

    #[test]
    fn a_non_finite_or_missing_input_is_refused_rather_than_guessed_at() {
        let model = loaded();
        let mut bad = vec![0.0; FEATURE_COUNT];
        bad[7] = f64::NAN;
        assert_eq!(model.predict(&bad), Err(ModelError::NonFiniteFeature));
        assert!(matches!(
            model.predict(&[0.0; 10]),
            Err(ModelError::WrongInputCount { .. })
        ));
    }

    #[test]
    fn only_an_active_runnable_version_whose_hash_matches_can_be_loaded() {
        let load = |change: &dyn Fn(&mut ModelVersion)| {
            let bundle = validate_bundle(&fixture_dir(), None).unwrap();
            let mut version = active_version(&bundle);
            change(&mut version);
            LoadedModel::load(bundle, &version).map(|m| m.monitor_only)
        };
        assert_eq!(load(&|_| {}), Ok(false));
        assert!(matches!(
            load(&|v| v.state = LifecycleState::Approved),
            Err(ModelError::NotRunnable(_))
        ));
        assert!(matches!(
            load(&|v| v.deployable = false),
            Err(ModelError::NotRunnable(_))
        ));
        // An evaluation-only model that kept its file runs, but only in Monitor.
        assert_eq!(
            load(&|v| {
                v.deployable = false;
                v.monitor_only = true;
            }),
            Ok(true)
        );
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
