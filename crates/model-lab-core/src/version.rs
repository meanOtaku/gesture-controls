use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contract::{InputContract, QualityRules, Thresholds};
use crate::ids::{LabelId, ModelVersionId, ProjectId, RunId};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum VersionError {
    #[error("a model cannot move from {from:?} to {to:?} this way")]
    IllegalTransition {
        from: LifecycleState,
        to: LifecycleState,
    },
    #[error("this model is evaluation-only and cannot be approved or activated")]
    NotDeployable,
    #[error("a deployable model needs the SHA-256 of its model file")]
    MissingHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LifecycleState {
    Draft,
    Evaluated,
    Approved,
    Active,
    Archived,
}

/// The moves allowed through [`crate::Registry::transition`]. Becoming or ceasing to be Active is only done by
/// activation, deactivation and rollback, because those also have to move whatever else holds the label's slot.
pub fn legal_transition(from: LifecycleState, to: LifecycleState) -> bool {
    use LifecycleState::*;
    matches!(
        (from, to),
        (Draft, Evaluated)
            | (Evaluated, Approved)
            | (Evaluated, Archived)
            | (Approved, Archived)
            | (Approved, Evaluated)
            | (Archived, Draft)
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ModelOrigin {
    /// Produced by a training run.
    Trained { run_id: RunId },
    /// Brought in as an external bundle, then validated.
    Imported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateTransition {
    pub from: Option<LifecycleState>,
    pub to: LifecycleState,
    pub at: String,
}

/// One candidate binary model for one label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVersion {
    pub id: ModelVersionId,
    pub project_id: ProjectId,
    /// The one label this model detects.
    pub label: LabelId,
    pub origin: ModelOrigin,
    pub state: LifecycleState,
    /// False for an evaluation-only model: it can be reviewed but never approved or activated.
    pub deployable: bool,
    /// SHA-256 of the model file. Required for a deployable model.
    pub model_sha256: Option<String>,
    /// The model's directory, relative to the model-lab directory.
    pub artifact_dir: String,
    pub input: InputContract,
    pub thresholds: Thresholds,
    pub quality: QualityRules,
    pub created_at: String,
    pub history: Vec<StateTransition>,
}

impl ModelVersion {
    /// A new version, in Draft.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: ModelVersionId,
        project_id: ProjectId,
        label: LabelId,
        origin: ModelOrigin,
        deployable: bool,
        model_sha256: Option<String>,
        artifact_dir: String,
        input: InputContract,
        thresholds: Thresholds,
        quality: QualityRules,
        at: &str,
    ) -> Result<Self, VersionError> {
        if deployable && !model_sha256.as_deref().is_some_and(crate::is_sha256_hex) {
            return Err(VersionError::MissingHash);
        }
        Ok(Self {
            id,
            project_id,
            label,
            origin,
            state: LifecycleState::Draft,
            deployable,
            model_sha256,
            artifact_dir,
            input,
            thresholds,
            quality,
            created_at: at.to_string(),
            history: vec![StateTransition {
                from: None,
                to: LifecycleState::Draft,
                at: at.to_string(),
            }],
        })
    }

    pub(crate) fn move_to(&mut self, to: LifecycleState, at: &str) {
        self.history.push(StateTransition {
            from: Some(self.state),
            to,
            at: at.to_string(),
        });
        self.state = to;
    }
}
