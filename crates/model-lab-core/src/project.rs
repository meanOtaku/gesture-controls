use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contract::{ContractError, InputContract, QualityRules, Thresholds, TrainerConfig};
use crate::ids::{LabelId, ProjectId, RecordingId};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProjectError {
    #[error("the target label must be marked as a positive example")]
    TargetNotPositive,
    #[error("the label mapping has no positive example")]
    NoPositives,
    #[error("a project name must be 1 to 80 characters")]
    BadName,
    #[error("the same recording is selected twice")]
    DuplicateSession,
    #[error(transparent)]
    Contract(#[from] ContractError),
}

/// What a label means for one model: a positive example, a negative example, or left out. A label that is not listed
/// is not silently treated as negative; the snapshot step rejects any label found in the data that has no entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExampleRole {
    Positive,
    Negative,
    Exclude,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelMapping {
    pub entries: BTreeMap<LabelId, ExampleRole>,
}

impl LabelMapping {
    pub fn labels_with(&self, role: ExampleRole) -> impl Iterator<Item = &LabelId> {
        self.entries
            .iter()
            .filter(move |(_, r)| **r == role)
            .map(|(l, _)| l)
    }
}

/// Owns the model-development work for one target label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelProject {
    pub id: ProjectId,
    pub name: String,
    pub target: LabelId,
    /// The recordings selected for this project. They live in the one shared recording store; nothing is copied.
    pub sessions: Vec<RecordingId>,
    pub mapping: LabelMapping,
    pub input: InputContract,
    pub quality: QualityRules,
    pub trainer: TrainerConfig,
    pub thresholds: Thresholds,
    pub created_at: String,
    pub updated_at: String,
}

impl LabelProject {
    pub fn validate(&self) -> Result<(), ProjectError> {
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(ProjectError::BadName);
        }
        if self.mapping.entries.get(&self.target) != Some(&ExampleRole::Positive) {
            return Err(ProjectError::TargetNotPositive);
        }
        if self
            .mapping
            .labels_with(ExampleRole::Positive)
            .next()
            .is_none()
        {
            return Err(ProjectError::NoPositives);
        }
        let mut seen = std::collections::BTreeSet::new();
        if !self.sessions.iter().all(|s| seen.insert(s)) {
            return Err(ProjectError::DuplicateSession);
        }
        self.input.validate()?;
        self.quality.validate()?;
        self.thresholds.validate()?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::contract::{StreamSource, TrainerBackend};

    pub fn label(id: &str) -> LabelId {
        LabelId::new(id).unwrap()
    }

    pub fn input() -> InputContract {
        InputContract {
            sources: vec![StreamSource::WatchPpg, StreamSource::WatchOrientation],
            features: vec!["ppg_green_mean".into(), "roll_deg".into()],
            window_ms: 1000,
            stride_ms: 100,
            max_gap_ms: 200,
            min_samples: 3,
        }
    }

    pub fn project(id: &str, target: &str) -> LabelProject {
        LabelProject {
            id: ProjectId::new(id).unwrap(),
            name: format!("{target} model"),
            target: label(target),
            sessions: vec![
                RecordingId::new("rec1").unwrap(),
                RecordingId::new("rec2").unwrap(),
            ],
            mapping: LabelMapping {
                entries: [
                    (label(target), ExampleRole::Positive),
                    (label("idle"), ExampleRole::Negative),
                    (label("walking"), ExampleRole::Exclude),
                ]
                .into(),
            },
            input: input(),
            quality: QualityRules::default(),
            trainer: TrainerConfig {
                backend: TrainerBackend::ScikitLearn,
                params: BTreeMap::new(),
            },
            thresholds: Thresholds::default(),
            created_at: "2026-10-04T00:00:00Z".into(),
            updated_at: "2026-10-04T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_complete_project_is_valid_and_a_label_needs_no_model() {
        project("p1", "pinch_start").validate().unwrap();
    }

    #[test]
    fn the_target_must_be_a_positive_and_the_contract_must_be_sound() {
        let mut p = project("p1", "pinch_start");
        p.mapping
            .entries
            .insert(label("pinch_start"), ExampleRole::Negative);
        assert_eq!(p.validate(), Err(ProjectError::TargetNotPositive));

        let mut p = project("p1", "pinch_start");
        p.mapping.entries.remove(&label("pinch_start"));
        assert_eq!(p.validate(), Err(ProjectError::TargetNotPositive));

        let mut p = project("p1", "pinch_start");
        p.input.stride_ms = 5000;
        assert!(matches!(p.validate(), Err(ProjectError::Contract(_))));

        let mut p = project("p1", "pinch_start");
        p.thresholds.release = 0.95;
        p.thresholds.activation = 0.5;
        assert!(matches!(
            p.validate(),
            Err(ProjectError::Contract(ContractError::BadThreshold(_)))
        ));

        let mut p = project("p1", "pinch_start");
        p.sessions.push(p.sessions[0].clone());
        assert_eq!(p.validate(), Err(ProjectError::DuplicateSession));

        let mut p = project("p1", "pinch_start");
        p.name = "  ".into();
        assert_eq!(p.validate(), Err(ProjectError::BadName));
    }

    #[test]
    fn the_input_contract_names_what_it_reads() {
        let mut c = input();
        assert!(c.validate().is_ok());
        c.sources.push(StreamSource::WatchPpg);
        assert_eq!(c.validate(), Err(ContractError::DuplicateSource));
        let mut c = input();
        c.features.push("roll_deg".into());
        assert_eq!(c.validate(), Err(ContractError::BadFeature));
        let mut c = input();
        c.sources.clear();
        assert_eq!(c.validate(), Err(ContractError::NoSources));
    }

    #[test]
    fn a_project_round_trips_through_json() {
        let p = project("p1", "swipe_left");
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"windowMs\"") && json.contains("\"watchPpg\""));
        assert_eq!(serde_json::from_str::<LabelProject>(&json).unwrap(), p);
    }
}
