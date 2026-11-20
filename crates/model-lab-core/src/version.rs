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
    #[error("a model that can run needs the SHA-256 of its model file")]
    MissingHash,
    #[error("a deployable model cannot be marked monitor-only")]
    DeployableNotMonitorOnly,
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

/// A change of a model's thresholds after it was made, kept so its history says what it ran under and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdChange {
    pub from_activation: f64,
    pub from_release: f64,
    pub to_activation: f64,
    pub to_release: f64,
    pub at: String,
    /// For a multi-gesture model: the output (its gesture's label) whose thresholds changed. Absent: the model's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<LabelId>,
    /// How the model did at the new thresholds on its held-out recordings, when it was measured as they were set (the
    /// Threshold card replays them). Absent: not measured then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub figures: Option<ThresholdFigures>,
}

/// A model's held-out results at one threshold, played through its test recordings as it runs live.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdFigures {
    /// The share of gesture starts it caught, 0 to 1; absent with no gesture in the recordings.
    pub recall: Option<f64>,
    /// False activations an hour with no gesture under way; absent with no such time.
    pub false_activations_per_hour: Option<f64>,
    /// How many test recordings they come from.
    pub recordings: usize,
}

/// One gesture a multi-gesture model detects: its label, which of the network's outputs it reads, and the thresholds
/// that output runs at. One model file, one state: the model is activated, approved or archived as a whole, and is the
/// active model of every one of its gestures at once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOutput {
    pub label: LabelId,
    /// The network output it reads (0 is "nothing").
    pub index: usize,
    pub thresholds: Thresholds,
    /// How it did on the model's held-out recordings, at `thresholds` (from training, or measured as they were set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub figures: Option<ThresholdFigures>,
}

/// The longest name a model may be given, in characters.
pub const MAX_MODEL_NAME_CHARS: usize = 60;

/// One candidate binary model for one label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVersion {
    pub id: ModelVersionId,
    pub project_id: ProjectId,
    /// The label this model detects; for a multi-gesture model, its first gesture (its project's target), its others in
    /// `outputs`.
    pub label: LabelId,
    /// A name the user gave it, shown in place of its id. Only what is shown: the id, the files and the state stay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub origin: ModelOrigin,
    pub state: LifecycleState,
    /// False for an evaluation-only model: it did not pass the checks for going live.
    pub deployable: bool,
    /// An evaluation-only model that still has a validated model file: it may be approved and activated, but it only ever
    /// runs in Monitor (it reports what it detects and never acts). False for a deployable model.
    #[serde(default)]
    pub monitor_only: bool,
    /// When the user let this monitor-only model act in Live anyway, knowing it failed the checks for going live
    /// (`Registry::set_live_override`). `None`: it only reports, as monitor-only models do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_override: Option<String>,
    /// SHA-256 of the model file. Required for a deployable model.
    pub model_sha256: Option<String>,
    /// The model's directory, relative to the model-lab directory.
    pub artifact_dir: String,
    pub input: InputContract,
    pub thresholds: Thresholds,
    pub quality: QualityRules,
    pub created_at: String,
    pub history: Vec<StateTransition>,
    /// Each change of its thresholds since it was made, oldest first (`Registry::set_thresholds`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threshold_changes: Vec<ThresholdChange>,
    /// A multi-gesture model's gestures, `label`'s first (its thresholds are also `thresholds`). Empty for a model of
    /// one gesture.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<ModelOutput>,
}

impl ModelVersion {
    /// Every label it detects: its outputs', or its own.
    pub fn labels(&self) -> Vec<LabelId> {
        if self.outputs.is_empty() {
            vec![self.label.clone()]
        } else {
            self.outputs.iter().map(|o| o.label.clone()).collect()
        }
    }

    /// Whether it detects `label`.
    pub fn detects(&self, label: &LabelId) -> bool {
        self.label == *label || self.outputs.iter().any(|o| o.label == *label)
    }

    /// The thresholds it runs `label` at, and the output index it reads for it (1 for a model of one gesture).
    pub fn output_for(&self, label: &LabelId) -> Option<(usize, Thresholds)> {
        if self.outputs.is_empty() {
            return (self.label == *label).then_some((1, self.thresholds));
        }
        self.outputs
            .iter()
            .find(|o| o.label == *label)
            .map(|o| (o.index, o.thresholds))
    }

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
            name: None,
            origin,
            state: LifecycleState::Draft,
            deployable,
            monitor_only: false,
            live_override: None,
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
            threshold_changes: Vec::new(),
            outputs: Vec::new(),
        })
    }

    /// This evaluation-only version as one that may run in Monitor: it must carry its model file's hash.
    pub fn for_monitor_only(mut self) -> Result<Self, VersionError> {
        if self.deployable {
            return Err(VersionError::DeployableNotMonitorOnly);
        }
        if !self
            .model_sha256
            .as_deref()
            .is_some_and(crate::is_sha256_hex)
        {
            return Err(VersionError::MissingHash);
        }
        self.monitor_only = true;
        Ok(self)
    }

    /// Whether it may start recipes in Live: it passed the checks for going live, or the user let it act anyway.
    pub fn may_act(&self) -> bool {
        self.deployable || (self.monitor_only && self.live_override.is_some())
    }

    /// Whether its model file may be loaded and run: a deployable model, or a monitor-only one.
    pub fn runnable(&self) -> bool {
        self.deployable || self.monitor_only
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
