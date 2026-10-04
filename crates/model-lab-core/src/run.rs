use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contract::TrainerConfig;
use crate::ids::{ProjectId, RunId, SnapshotId};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RunError {
    #[error("the run has already finished and is immutable")]
    Finished,
    #[error("the run has not started")]
    NotStarted,
    #[error("a failed run needs a failure message")]
    FailureNeedsMessage,
    #[error("a deployable run must produce a model artifact with a hash")]
    DeployableNeedsModel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    Finished,
}

/// How a run ended. Evaluation-only means it trained and scored a model but could not produce the deployable format,
/// so it can be reviewed but never activated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunOutcome {
    Deployable,
    EvaluationOnly,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    /// `model`, `manifest`, `evaluation`, `parity`, `log`, ...
    pub kind: String,
    /// Relative to the model-lab directory; never absolute and never containing `..`.
    pub path: String,
    pub sha256: String,
}

/// One attempt by one trainer against one snapshot. Once finished it never changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingRun {
    pub id: RunId,
    pub project_id: ProjectId,
    pub snapshot_id: SnapshotId,
    pub trainer: TrainerConfig,
    pub status: RunStatus,
    pub outcome: Option<RunOutcome>,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub failure: Option<String>,
    pub artifacts: Vec<ArtifactRef>,
}

impl TrainingRun {
    pub fn queue(
        id: RunId,
        project_id: ProjectId,
        snapshot_id: SnapshotId,
        trainer: TrainerConfig,
        at: &str,
    ) -> Self {
        Self {
            id,
            project_id,
            snapshot_id,
            trainer,
            status: RunStatus::Queued,
            outcome: None,
            queued_at: at.to_string(),
            started_at: None,
            finished_at: None,
            failure: None,
            artifacts: Vec::new(),
        }
    }

    pub fn start(&mut self, at: &str) -> Result<(), RunError> {
        match self.status {
            RunStatus::Finished => Err(RunError::Finished),
            _ => {
                self.status = RunStatus::Running;
                self.started_at = Some(at.to_string());
                Ok(())
            }
        }
    }

    pub fn finish(
        &mut self,
        outcome: RunOutcome,
        failure: Option<String>,
        artifacts: Vec<ArtifactRef>,
        at: &str,
    ) -> Result<(), RunError> {
        match self.status {
            RunStatus::Finished => return Err(RunError::Finished),
            RunStatus::Queued => return Err(RunError::NotStarted),
            RunStatus::Running => {}
        }
        if outcome == RunOutcome::Failed && failure.as_deref().is_none_or(|m| m.trim().is_empty()) {
            return Err(RunError::FailureNeedsMessage);
        }
        if outcome == RunOutcome::Deployable
            && !artifacts
                .iter()
                .any(|a| a.kind == "model" && crate::is_sha256_hex(&a.sha256))
        {
            return Err(RunError::DeployableNeedsModel);
        }
        self.status = RunStatus::Finished;
        self.outcome = Some(outcome);
        self.finished_at = Some(at.to_string());
        self.failure = failure;
        self.artifacts = artifacts;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::contract::TrainerBackend;
    use crate::sha256_hex;
    use std::collections::BTreeMap;

    pub fn run(id: &str) -> TrainingRun {
        TrainingRun::queue(
            RunId::new(id).unwrap(),
            ProjectId::new("p1").unwrap(),
            SnapshotId::new("snap1").unwrap(),
            TrainerConfig {
                backend: TrainerBackend::ScikitLearn,
                params: BTreeMap::new(),
            },
            "2026-10-04T00:00:00Z",
        )
    }

    pub fn model_artifact() -> ArtifactRef {
        ArtifactRef {
            kind: "model".into(),
            path: "models/m1/model.onnx".into(),
            sha256: sha256_hex(b"m"),
        }
    }

    #[test]
    fn a_run_goes_queued_running_finished_and_then_never_changes() {
        let mut r = run("r1");
        assert_eq!(
            r.finish(RunOutcome::Deployable, None, vec![model_artifact()], "t"),
            Err(RunError::NotStarted)
        );
        r.start("t1").unwrap();
        r.finish(RunOutcome::Deployable, None, vec![model_artifact()], "t2")
            .unwrap();
        assert_eq!(
            (r.status, r.outcome),
            (RunStatus::Finished, Some(RunOutcome::Deployable))
        );
        assert_eq!(r.start("t3"), Err(RunError::Finished));
        assert_eq!(
            r.finish(RunOutcome::Failed, Some("x".into()), vec![], "t3"),
            Err(RunError::Finished)
        );
        assert_eq!(r.finished_at.as_deref(), Some("t2"));
    }

    #[test]
    fn a_failure_keeps_its_reason_and_evaluation_only_is_not_deployable() {
        let mut r = run("r1");
        r.start("t1").unwrap();
        assert_eq!(
            r.finish(RunOutcome::Failed, None, vec![], "t2"),
            Err(RunError::FailureNeedsMessage)
        );
        r.finish(
            RunOutcome::Failed,
            Some("operator Foo is not supported".into()),
            vec![],
            "t2",
        )
        .unwrap();
        assert_eq!(r.failure.as_deref(), Some("operator Foo is not supported"));

        let mut r = run("r2");
        r.start("t1").unwrap();
        assert_eq!(
            r.finish(RunOutcome::Deployable, None, vec![], "t2"),
            Err(RunError::DeployableNeedsModel)
        );
        r.finish(RunOutcome::EvaluationOnly, None, vec![], "t2")
            .unwrap();
        assert_eq!(r.outcome, Some(RunOutcome::EvaluationOnly));
    }
}
