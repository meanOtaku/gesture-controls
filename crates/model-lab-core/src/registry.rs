use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::ids::{LabelId, ModelVersionId, ProjectId, RunId, SnapshotId};
use crate::migrate::QuarantinedModel;
use crate::project::{LabelProject, ProjectError};
use crate::run::{ArtifactRef, RunError, RunOutcome, RunStatus, TrainingRun};
use crate::snapshot::{DatasetSnapshot, SnapshotError};
use crate::version::{LifecycleState, ModelOrigin, ModelVersion, VersionError, legal_transition};

pub const REGISTRY_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RegistryError {
    #[error("there is no project '{0}'")]
    NoProject(ProjectId),
    #[error("a project '{0}' already exists")]
    DuplicateProject(ProjectId),
    #[error("the label '{0}' already has a project")]
    LabelHasProject(LabelId),
    #[error("there is no snapshot '{0}'")]
    NoSnapshot(SnapshotId),
    #[error("a snapshot '{0}' already exists")]
    DuplicateSnapshot(SnapshotId),
    #[error("there is no run '{0}'")]
    NoRun(RunId),
    #[error("a run '{0}' already exists")]
    DuplicateRun(RunId),
    #[error("there is no model version '{0}'")]
    NoVersion(ModelVersionId),
    #[error("a model version '{0}' already exists")]
    DuplicateVersion(ModelVersionId),
    #[error("{0} belongs to a different project")]
    WrongProject(String),
    #[error(
        "the model for label '{label}' is not in state Approved (it is {state:?}); only an approved model can be activated"
    )]
    NotApproved {
        label: LabelId,
        state: LifecycleState,
    },
    #[error("'{0}' is already the active model for its label")]
    AlreadyActive(ModelVersionId),
    #[error(
        "only an archived model can be deleted, and '{id}' is {state:?}. Archive it first (a model that is active must be deactivated before that)"
    )]
    NotArchived {
        id: ModelVersionId,
        state: LifecycleState,
    },
    #[error("the label '{0}' has no active model")]
    NothingActive(LabelId),
    #[error("the label '{0}' has no previous model to roll back to")]
    NothingToRollBackTo(LabelId),
    #[error("an active model cannot be archived or moved; deactivate or replace it first")]
    ActiveIsPinned,
    #[error("a run that did not produce a deployable model cannot register a deployable version")]
    RunNotDeployable,
    #[error("the registry is inconsistent: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error(transparent)]
    Snapshot(#[from] SnapshotError),
    #[error(transparent)]
    Run(#[from] RunError),
    #[error(transparent)]
    Version(#[from] VersionError),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InferenceMode {
    /// A fresh install never drives desktop actions until the user opts in.
    #[default]
    Off,
    /// Classifies and reports, never actuates.
    Monitor,
    Live,
}

/// What activating a model changed, so the caller can clear the replaced model's detection state and release anything
/// it was holding before the new one takes over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activation {
    pub label: LabelId,
    pub activated: ModelVersionId,
    pub replaced: Option<ModelVersionId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rollback {
    pub label: LabelId,
    pub released: ModelVersionId,
    pub restored: ModelVersionId,
}

/// All of Model Lab's persisted state.
///
/// Every operation either completes or returns an error and changes nothing that matters; callers apply operations
/// through [`crate::RegistryStore`], which also persists and discards the change if persisting fails.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub schema_version: u32,
    pub projects: BTreeMap<ProjectId, LabelProject>,
    pub snapshots: BTreeMap<SnapshotId, DatasetSnapshot>,
    pub runs: BTreeMap<RunId, TrainingRun>,
    pub versions: BTreeMap<ModelVersionId, ModelVersion>,
    /// At most one active version per label. Different labels are independent.
    pub active_by_label: BTreeMap<LabelId, ModelVersionId>,
    pub previous_by_label: BTreeMap<LabelId, ModelVersionId>,
    pub inference_mode: InferenceMode,
    /// Models from an older registry that cannot be represented here, kept whole with the reason.
    #[serde(default)]
    pub quarantined: Vec<QuarantinedModel>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            projects: BTreeMap::new(),
            snapshots: BTreeMap::new(),
            runs: BTreeMap::new(),
            versions: BTreeMap::new(),
            active_by_label: BTreeMap::new(),
            previous_by_label: BTreeMap::new(),
            inference_mode: InferenceMode::Off,
            quarantined: Vec::new(),
        }
    }
}

impl Registry {
    // ---- projects, snapshots, runs -------------------------------------------------------------------------

    /// A label may have no project at all; it gets at most one.
    pub fn create_project(&mut self, project: LabelProject) -> Result<(), RegistryError> {
        project.validate()?;
        if self.projects.contains_key(&project.id) {
            return Err(RegistryError::DuplicateProject(project.id));
        }
        if self.projects.values().any(|p| p.target == project.target) {
            return Err(RegistryError::LabelHasProject(project.target));
        }
        self.projects.insert(project.id.clone(), project);
        Ok(())
    }

    /// Replaces a project's settings. Existing snapshots keep the settings they were sealed with.
    pub fn update_project(&mut self, project: LabelProject) -> Result<(), RegistryError> {
        project.validate()?;
        let existing = self
            .projects
            .get(&project.id)
            .ok_or_else(|| RegistryError::NoProject(project.id.clone()))?;
        if existing.target != project.target {
            return Err(RegistryError::WrongProject(
                "the target label of a project cannot change".into(),
            ));
        }
        self.projects.insert(project.id.clone(), project);
        Ok(())
    }

    pub fn add_snapshot(&mut self, snapshot: DatasetSnapshot) -> Result<(), RegistryError> {
        snapshot.verify()?;
        let project = self
            .projects
            .get(&snapshot.project_id)
            .ok_or_else(|| RegistryError::NoProject(snapshot.project_id.clone()))?;
        if project.target != snapshot.target {
            return Err(RegistryError::WrongProject(format!(
                "snapshot '{}'",
                snapshot.id
            )));
        }
        if self.snapshots.contains_key(&snapshot.id) {
            return Err(RegistryError::DuplicateSnapshot(snapshot.id));
        }
        self.snapshots.insert(snapshot.id.clone(), snapshot);
        Ok(())
    }

    pub fn queue_run(&mut self, run: TrainingRun) -> Result<(), RegistryError> {
        let snapshot = self
            .snapshots
            .get(&run.snapshot_id)
            .ok_or_else(|| RegistryError::NoSnapshot(run.snapshot_id.clone()))?;
        if snapshot.project_id != run.project_id {
            return Err(RegistryError::WrongProject(format!("run '{}'", run.id)));
        }
        if self.runs.contains_key(&run.id) {
            return Err(RegistryError::DuplicateRun(run.id));
        }
        self.runs.insert(run.id.clone(), run);
        Ok(())
    }

    fn run_mut(&mut self, id: &RunId) -> Result<&mut TrainingRun, RegistryError> {
        self.runs
            .get_mut(id)
            .ok_or_else(|| RegistryError::NoRun(id.clone()))
    }

    pub fn start_run(&mut self, id: &RunId, at: &str) -> Result<(), RegistryError> {
        Ok(self.run_mut(id)?.start(at)?)
    }

    pub fn finish_run(
        &mut self,
        id: &RunId,
        outcome: RunOutcome,
        failure: Option<String>,
        artifacts: Vec<ArtifactRef>,
        at: &str,
    ) -> Result<(), RegistryError> {
        Ok(self.run_mut(id)?.finish(outcome, failure, artifacts, at)?)
    }

    // ---- model versions ------------------------------------------------------------------------------------

    /// Adds a Draft version. It belongs to exactly one label, the one its project targets.
    pub fn register_version(&mut self, version: ModelVersion) -> Result<(), RegistryError> {
        let project = self
            .projects
            .get(&version.project_id)
            .ok_or_else(|| RegistryError::NoProject(version.project_id.clone()))?;
        if project.target != version.label {
            return Err(RegistryError::WrongProject(format!(
                "model '{}' (it detects '{}', the project targets '{}')",
                version.id, version.label, project.target
            )));
        }
        if self.versions.contains_key(&version.id) {
            return Err(RegistryError::DuplicateVersion(version.id));
        }
        if version.state != LifecycleState::Draft {
            return Err(RegistryError::Corrupt(
                "a new version must start as a draft".into(),
            ));
        }
        if let ModelOrigin::Trained { run_id } = &version.origin {
            let run = self
                .runs
                .get(run_id)
                .ok_or_else(|| RegistryError::NoRun(run_id.clone()))?;
            if run.project_id != version.project_id {
                return Err(RegistryError::WrongProject(format!("run '{run_id}'")));
            }
            let produced_deployable =
                run.status == RunStatus::Finished && run.outcome == Some(RunOutcome::Deployable);
            if version.deployable && !produced_deployable {
                return Err(RegistryError::RunNotDeployable);
            }
        }
        if version.deployable
            && !version
                .model_sha256
                .as_deref()
                .is_some_and(crate::is_sha256_hex)
        {
            return Err(VersionError::MissingHash.into());
        }
        self.versions.insert(version.id.clone(), version);
        Ok(())
    }

    fn version_mut(&mut self, id: &ModelVersionId) -> Result<&mut ModelVersion, RegistryError> {
        self.versions
            .get_mut(id)
            .ok_or_else(|| RegistryError::NoVersion(id.clone()))
    }

    /// Draft, Evaluated, Approved and Archived moves. Approving an evaluation-only model is refused.
    pub fn transition(
        &mut self,
        id: &ModelVersionId,
        to: LifecycleState,
        at: &str,
    ) -> Result<(), RegistryError> {
        let version = self.version_mut(id)?;
        let from = version.state;
        if from == LifecycleState::Active || to == LifecycleState::Active {
            return Err(RegistryError::ActiveIsPinned);
        }
        if !legal_transition(from, to) {
            return Err(VersionError::IllegalTransition { from, to }.into());
        }
        if to == LifecycleState::Approved && !version.deployable {
            return Err(VersionError::NotDeployable.into());
        }
        version.move_to(to, at);
        let label = version.label.clone();
        // A model that is archived can no longer be the one to roll back to.
        if to == LifecycleState::Archived && self.previous_by_label.get(&label) == Some(id) {
            self.previous_by_label.remove(&label);
        }
        Ok(())
    }

    /// Removes an archived model from the registry and returns it, so the caller can delete its files. Only an archived
    /// model can go: anything else may be in use or still under review. The training run that made it stays, as the
    /// record of what was tried.
    pub fn remove_version(&mut self, id: &ModelVersionId) -> Result<ModelVersion, RegistryError> {
        let state = self
            .versions
            .get(id)
            .ok_or_else(|| RegistryError::NoVersion(id.clone()))?
            .state;
        if state != LifecycleState::Archived {
            return Err(RegistryError::NotArchived {
                id: id.clone(),
                state,
            });
        }
        self.previous_by_label.retain(|_, previous| previous != id);
        self.active_by_label.retain(|_, active| active != id);
        self.versions
            .remove(id)
            .ok_or_else(|| RegistryError::NoVersion(id.clone()))
    }

    /// Makes an approved model the active one for its label. Whatever was active for *that label* is demoted to
    /// Approved and remembered for rollback; every other label is untouched.
    pub fn activate(&mut self, id: &ModelVersionId, at: &str) -> Result<Activation, RegistryError> {
        let version = self
            .versions
            .get(id)
            .ok_or_else(|| RegistryError::NoVersion(id.clone()))?;
        let label = version.label.clone();
        if version.state == LifecycleState::Active {
            return Err(RegistryError::AlreadyActive(id.clone()));
        }
        if version.state != LifecycleState::Approved {
            return Err(RegistryError::NotApproved {
                label,
                state: version.state,
            });
        }
        if !version.deployable {
            return Err(VersionError::NotDeployable.into());
        }
        let replaced = self.active_by_label.get(&label).cloned();
        if let Some(old) = &replaced {
            self.version_mut(old)?.move_to(LifecycleState::Approved, at);
            self.previous_by_label.insert(label.clone(), old.clone());
        }
        self.version_mut(id)?.move_to(LifecycleState::Active, at);
        self.active_by_label.insert(label.clone(), id.clone());
        Ok(Activation {
            label,
            activated: id.clone(),
            replaced,
        })
    }

    /// Turns a label's model off. The caller must clear its detection state; the model stays Approved and is kept
    /// as the one to restore.
    pub fn deactivate(
        &mut self,
        label: &LabelId,
        at: &str,
    ) -> Result<ModelVersionId, RegistryError> {
        let active = self
            .active_by_label
            .remove(label)
            .ok_or_else(|| RegistryError::NothingActive(label.clone()))?;
        self.version_mut(&active)?
            .move_to(LifecycleState::Approved, at);
        self.previous_by_label.insert(label.clone(), active.clone());
        Ok(active)
    }

    /// Swaps a label back to the model it replaced. The current one becomes the new "previous", so rolling back twice
    /// goes forward again.
    pub fn rollback(&mut self, label: &LabelId, at: &str) -> Result<Rollback, RegistryError> {
        let previous = self
            .previous_by_label
            .get(label)
            .cloned()
            .ok_or_else(|| RegistryError::NothingToRollBackTo(label.clone()))?;
        let state = self
            .versions
            .get(&previous)
            .ok_or_else(|| RegistryError::NoVersion(previous.clone()))?
            .state;
        if state != LifecycleState::Approved {
            return Err(RegistryError::NotApproved {
                label: label.clone(),
                state,
            });
        }
        let current = self.active_by_label.get(label).cloned();
        if let Some(current) = &current {
            self.version_mut(current)?
                .move_to(LifecycleState::Approved, at);
            self.previous_by_label
                .insert(label.clone(), current.clone());
        } else {
            self.previous_by_label.remove(label);
        }
        self.version_mut(&previous)?
            .move_to(LifecycleState::Active, at);
        self.active_by_label.insert(label.clone(), previous.clone());
        Ok(Rollback {
            label: label.clone(),
            released: current.unwrap_or_else(|| previous.clone()),
            restored: previous,
        })
    }

    pub fn set_inference_mode(&mut self, mode: InferenceMode) {
        self.inference_mode = mode;
    }

    /// The mode to run in after a restart: a remembered Live is reduced to Monitor, so a restart never resumes
    /// actuating without the user choosing it again.
    pub fn mode_at_startup(&self) -> InferenceMode {
        match self.inference_mode {
            InferenceMode::Live => InferenceMode::Monitor,
            other => other,
        }
    }

    /// Checks every rule that must hold, so a registry read from disk that breaks one is refused rather than used.
    pub fn validate(&self) -> Result<(), RegistryError> {
        let bad = |message: String| Err(RegistryError::Corrupt(message));
        if self.schema_version != REGISTRY_SCHEMA_VERSION {
            return bad(format!(
                "schema version {} is not {REGISTRY_SCHEMA_VERSION}",
                self.schema_version
            ));
        }
        let mut labels_with_projects = std::collections::BTreeSet::new();
        for (id, project) in &self.projects {
            if *id != project.id {
                return bad(format!("project '{id}' is stored under another id"));
            }
            project.validate()?;
            if !labels_with_projects.insert(&project.target) {
                return bad(format!("label '{}' has two projects", project.target));
            }
        }
        for (id, snapshot) in &self.snapshots {
            if *id != snapshot.id || !self.projects.contains_key(&snapshot.project_id) {
                return bad(format!("snapshot '{id}' is inconsistent"));
            }
            snapshot.verify()?;
        }
        for (id, run) in &self.runs {
            let snapshot_ok = self
                .snapshots
                .get(&run.snapshot_id)
                .is_some_and(|s| s.project_id == run.project_id);
            if *id != run.id || !snapshot_ok {
                return bad(format!("run '{id}' is inconsistent"));
            }
        }
        let mut active_per_label: BTreeMap<&LabelId, usize> = BTreeMap::new();
        for (id, version) in &self.versions {
            let project = self.projects.get(&version.project_id);
            if *id != version.id || project.is_none_or(|p| p.target != version.label) {
                return bad(format!(
                    "model '{id}' does not belong to its label's project"
                ));
            }
            if let ModelOrigin::Trained { run_id } = &version.origin
                && !self.runs.contains_key(run_id)
            {
                return bad(format!("model '{id}' refers to a missing run '{run_id}'"));
            }
            if version.deployable
                && !version
                    .model_sha256
                    .as_deref()
                    .is_some_and(crate::is_sha256_hex)
            {
                return bad(format!("deployable model '{id}' has no model hash"));
            }
            if !version.deployable
                && matches!(
                    version.state,
                    LifecycleState::Approved | LifecycleState::Active
                )
            {
                return bad(format!(
                    "evaluation-only model '{id}' is {:?}",
                    version.state
                ));
            }
            if version.state == LifecycleState::Active {
                *active_per_label.entry(&version.label).or_default() += 1;
                if self.active_by_label.get(&version.label) != Some(id) {
                    return bad(format!(
                        "model '{id}' is Active but is not its label's active slot"
                    ));
                }
            }
        }
        for (label, count) in &active_per_label {
            if *count > 1 {
                return bad(format!("label '{label}' has {count} active models"));
            }
        }
        for (label, id) in &self.active_by_label {
            match self.versions.get(id) {
                Some(v) if v.label == *label && v.state == LifecycleState::Active => {}
                _ => {
                    return bad(format!(
                        "the active slot for '{label}' points at '{id}', which is not an active model of that label"
                    ));
                }
            }
        }
        for (label, id) in &self.previous_by_label {
            if !self.versions.get(id).is_some_and(|v| v.label == *label) {
                return bad(format!(
                    "the previous slot for '{label}' points at '{id}', which is not a model of that label"
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::contract::{QualityRules, Thresholds};
    use crate::project::tests::{input, label, project};
    use crate::run::tests::{model_artifact, run};
    use crate::sha256_hex;

    pub const T: &str = "2026-10-04T00:00:00Z";

    /// A registry with a project, a sealed snapshot and a finished deployable run for `target`.
    pub fn with_project(r: &mut Registry, project_id: &str, target: &str) {
        let mut p = project(project_id, target);
        p.id = ProjectId::new(project_id).unwrap();
        r.create_project(p).unwrap();
        // The content hash covers the id and the project, so each project gets a snapshot sealed for it.
        let f = crate::snapshot::tests::fixture();
        let mut draft = crate::snapshot::tests::draft(target);
        draft.id = SnapshotId::new(format!("snap-{project_id}")).unwrap();
        draft.project_id = ProjectId::new(project_id).unwrap();
        // The labels found in the recordings are exactly the ones this project's mapping covers.
        let in_data = draft.mapping.entries.keys().cloned().collect();
        r.add_snapshot(DatasetSnapshot::seal(draft, &f.labels, &f.store, &in_data).unwrap())
            .unwrap();
    }

    pub fn deployable_run(r: &mut Registry, run_id: &str, project_id: &str) {
        let mut tr = run(run_id);
        tr.project_id = ProjectId::new(project_id).unwrap();
        tr.snapshot_id = SnapshotId::new(format!("snap-{project_id}")).unwrap();
        r.queue_run(tr).unwrap();
        let id = RunId::new(run_id).unwrap();
        r.start_run(&id, T).unwrap();
        r.finish_run(&id, RunOutcome::Deployable, None, vec![model_artifact()], T)
            .unwrap();
    }

    pub fn version(
        id: &str,
        project_id: &str,
        target: &str,
        run_id: &str,
        deployable: bool,
    ) -> ModelVersion {
        ModelVersion::new(
            ModelVersionId::new(id).unwrap(),
            ProjectId::new(project_id).unwrap(),
            label(target),
            ModelOrigin::Trained {
                run_id: RunId::new(run_id).unwrap(),
            },
            deployable,
            deployable.then(|| sha256_hex(id.as_bytes())),
            format!("models/{id}"),
            input(),
            Thresholds::default(),
            QualityRules::default(),
            T,
        )
        .unwrap()
    }

    pub fn approve(r: &mut Registry, id: &str) {
        let id = ModelVersionId::new(id).unwrap();
        r.transition(&id, LifecycleState::Evaluated, T).unwrap();
        r.transition(&id, LifecycleState::Approved, T).unwrap();
    }

    fn mid(id: &str) -> ModelVersionId {
        ModelVersionId::new(id).unwrap()
    }

    /// Two labels, each with a project and a deployable run; `a1`, `a2` for pinch_start and `b1` for swipe_left.
    pub fn two_label_registry() -> Registry {
        let mut r = Registry::default();
        with_project(&mut r, "pa", "pinch_start");
        with_project(&mut r, "pb", "swipe_left");
        deployable_run(&mut r, "ra", "pa");
        deployable_run(&mut r, "rb", "pb");
        for (id, p, l, run) in [
            ("a1", "pa", "pinch_start", "ra"),
            ("a2", "pa", "pinch_start", "ra"),
            ("b1", "pb", "swipe_left", "rb"),
        ] {
            r.register_version(version(id, p, l, run, true)).unwrap();
            approve(&mut r, id);
        }
        r
    }

    #[test]
    fn a_label_can_exist_with_no_project_and_a_project_with_no_model() {
        let mut r = Registry::default();
        r.validate().unwrap();
        with_project(&mut r, "pa", "pinch_start");
        r.validate().unwrap();
        assert!(r.versions.is_empty() && r.active_by_label.is_empty());
        // One project per label.
        let mut second = project("pa2", "pinch_start");
        second.id = ProjectId::new("pa2").unwrap();
        assert_eq!(
            r.create_project(second),
            Err(RegistryError::LabelHasProject(label("pinch_start")))
        );
    }

    #[test]
    fn each_version_belongs_to_exactly_one_label_and_must_match_its_project() {
        let mut r = Registry::default();
        with_project(&mut r, "pa", "pinch_start");
        deployable_run(&mut r, "ra", "pa");
        // A model for a different label than the project's.
        let wrong = version("x1", "pa", "swipe_left", "ra", true);
        assert!(matches!(
            r.register_version(wrong),
            Err(RegistryError::WrongProject(_))
        ));
        r.register_version(version("a1", "pa", "pinch_start", "ra", true))
            .unwrap();
        assert_eq!(
            r.register_version(version("a1", "pa", "pinch_start", "ra", true)),
            Err(RegistryError::DuplicateVersion(mid("a1")))
        );
        r.validate().unwrap();
    }

    #[test]
    fn several_labels_can_be_active_at_once_and_activating_one_leaves_the_others_alone() {
        let mut r = two_label_registry();
        r.activate(&mid("a1"), T).unwrap();
        r.activate(&mid("b1"), T).unwrap();
        assert_eq!(r.active_by_label.len(), 2);
        let b_before = r.versions[&mid("b1")].clone();
        // Replace pinch_start's model: swipe_left's active model must not change at all.
        let act = r.activate(&mid("a2"), T).unwrap();
        assert_eq!(act.replaced, Some(mid("a1")));
        assert_eq!(r.versions[&mid("b1")], b_before);
        assert_eq!(r.active_by_label[&label("swipe_left")], mid("b1"));
        r.validate().unwrap();
    }

    #[test]
    fn only_one_version_is_active_per_label_and_the_replaced_one_is_reported_for_release() {
        let mut r = two_label_registry();
        r.activate(&mid("a1"), T).unwrap();
        assert_eq!(
            r.activate(&mid("a1"), T),
            Err(RegistryError::AlreadyActive(mid("a1")))
        );
        let act = r.activate(&mid("a2"), T).unwrap();
        assert_eq!(
            act.replaced,
            Some(mid("a1")),
            "the caller must release a1's detection before a2 takes over"
        );
        assert_eq!(r.versions[&mid("a1")].state, LifecycleState::Approved);
        assert_eq!(r.versions[&mid("a2")].state, LifecycleState::Active);
        assert_eq!(r.previous_by_label[&label("pinch_start")], mid("a1"));
        let active: Vec<_> = r
            .versions
            .values()
            .filter(|v| v.state == LifecycleState::Active && v.label == label("pinch_start"))
            .collect();
        assert_eq!(active.len(), 1);
    }

    #[test]
    fn rollback_is_per_label_and_swaps_back_and_forth() {
        let mut r = two_label_registry();
        r.activate(&mid("a1"), T).unwrap();
        r.activate(&mid("b1"), T).unwrap();
        r.activate(&mid("a2"), T).unwrap();
        let back = r.rollback(&label("pinch_start"), T).unwrap();
        assert_eq!((back.released, back.restored), (mid("a2"), mid("a1")));
        assert_eq!(r.active_by_label[&label("pinch_start")], mid("a1"));
        assert_eq!(
            r.active_by_label[&label("swipe_left")],
            mid("b1"),
            "an unrelated label is untouched"
        );
        let forward = r.rollback(&label("pinch_start"), T).unwrap();
        assert_eq!(forward.restored, mid("a2"));
        // A label that never replaced anything has nothing to roll back to.
        assert_eq!(
            r.rollback(&label("swipe_left"), T),
            Err(RegistryError::NothingToRollBackTo(label("swipe_left")))
        );
        r.validate().unwrap();
    }

    #[test]
    fn deactivating_frees_the_slot_and_keeps_the_model_to_restore() {
        let mut r = two_label_registry();
        r.activate(&mid("a1"), T).unwrap();
        assert_eq!(r.deactivate(&label("pinch_start"), T).unwrap(), mid("a1"));
        assert!(r.active_by_label.is_empty());
        assert_eq!(r.versions[&mid("a1")].state, LifecycleState::Approved);
        assert_eq!(
            r.deactivate(&label("pinch_start"), T),
            Err(RegistryError::NothingActive(label("pinch_start")))
        );
        assert_eq!(
            r.rollback(&label("pinch_start"), T).unwrap().restored,
            mid("a1")
        );
        r.validate().unwrap();
    }

    #[test]
    fn only_an_approved_deployable_model_can_activate_and_an_active_one_is_pinned() {
        let mut r = Registry::default();
        with_project(&mut r, "pa", "pinch_start");
        deployable_run(&mut r, "ra", "pa");
        r.register_version(version("a1", "pa", "pinch_start", "ra", true))
            .unwrap();
        assert!(
            matches!(
                r.activate(&mid("a1"), T),
                Err(RegistryError::NotApproved { .. })
            ),
            "a draft cannot activate"
        );
        approve(&mut r, "a1");
        r.activate(&mid("a1"), T).unwrap();
        assert_eq!(
            r.transition(&mid("a1"), LifecycleState::Archived, T),
            Err(RegistryError::ActiveIsPinned)
        );
        assert_eq!(
            r.transition(&mid("a1"), LifecycleState::Evaluated, T),
            Err(RegistryError::ActiveIsPinned)
        );
    }

    #[test]
    fn an_evaluation_only_model_can_be_reviewed_but_never_approved_or_activated() {
        let mut r = Registry::default();
        with_project(&mut r, "pa", "pinch_start");
        // A run that trained and scored but could not produce the deployable format.
        let mut tr = run("re");
        tr.project_id = ProjectId::new("pa").unwrap();
        tr.snapshot_id = SnapshotId::new("snap-pa").unwrap();
        r.queue_run(tr).unwrap();
        let id = RunId::new("re").unwrap();
        r.start_run(&id, T).unwrap();
        r.finish_run(&id, RunOutcome::EvaluationOnly, None, vec![], T)
            .unwrap();
        // It cannot claim to be deployable.
        assert_eq!(
            r.register_version(version("e1", "pa", "pinch_start", "re", true)),
            Err(RegistryError::RunNotDeployable)
        );
        r.register_version(version("e1", "pa", "pinch_start", "re", false))
            .unwrap();
        r.transition(&mid("e1"), LifecycleState::Evaluated, T)
            .unwrap();
        assert_eq!(
            r.transition(&mid("e1"), LifecycleState::Approved, T),
            Err(RegistryError::Version(VersionError::NotDeployable))
        );
        assert!(r.activate(&mid("e1"), T).is_err());
    }

    #[test]
    fn archiving_the_previous_model_removes_it_as_the_rollback_target() {
        let mut r = two_label_registry();
        r.activate(&mid("a1"), T).unwrap();
        r.activate(&mid("a2"), T).unwrap();
        r.transition(&mid("a1"), LifecycleState::Archived, T)
            .unwrap();
        assert!(!r.previous_by_label.contains_key(&label("pinch_start")));
        assert_eq!(
            r.rollback(&label("pinch_start"), T),
            Err(RegistryError::NothingToRollBackTo(label("pinch_start")))
        );
        r.validate().unwrap();
    }

    #[test]
    fn a_remembered_live_mode_restarts_as_monitor() {
        let mut r = Registry::default();
        assert_eq!(r.mode_at_startup(), InferenceMode::Off);
        r.set_inference_mode(InferenceMode::Live);
        assert_eq!(r.mode_at_startup(), InferenceMode::Monitor);
        r.set_inference_mode(InferenceMode::Monitor);
        assert_eq!(r.mode_at_startup(), InferenceMode::Monitor);
    }

    #[test]
    fn validation_refuses_a_registry_that_breaks_a_rule() {
        let mut r = two_label_registry();
        r.activate(&mid("a1"), T).unwrap();
        r.validate().unwrap();

        // Two versions both marked Active for one label.
        let mut bad = r.clone();
        bad.versions.get_mut(&mid("a2")).unwrap().state = LifecycleState::Active;
        assert!(matches!(bad.validate(), Err(RegistryError::Corrupt(_))));
        // A slot pointing at the wrong label's model.
        let mut bad = r.clone();
        bad.active_by_label.insert(label("swipe_left"), mid("a1"));
        assert!(matches!(bad.validate(), Err(RegistryError::Corrupt(_))));
        // A model detached from its project's label.
        let mut bad = r.clone();
        bad.versions.get_mut(&mid("b1")).unwrap().label = label("pinch_start");
        assert!(matches!(bad.validate(), Err(RegistryError::Corrupt(_))));
        // An unknown schema.
        let mut bad = r.clone();
        bad.schema_version = 99;
        assert!(matches!(bad.validate(), Err(RegistryError::Corrupt(_))));
        // A tampered snapshot.
        let mut bad = r.clone();
        bad.snapshots
            .values_mut()
            .next()
            .unwrap()
            .mapping
            .entries
            .insert(label("idle"), crate::ExampleRole::Positive);
        assert!(matches!(bad.validate(), Err(RegistryError::Snapshot(_))));
        // An evaluation-only model marked Approved.
        let mut bad = r.clone();
        let v = bad.versions.get_mut(&mid("a2")).unwrap();
        v.deployable = false;
        assert!(matches!(bad.validate(), Err(RegistryError::Corrupt(_))));
    }

    #[test]
    fn project_and_snapshot_rules_are_enforced_on_the_way_in() {
        let mut r = Registry::default();
        with_project(&mut r, "pa", "pinch_start");
        // A snapshot for another project's target.
        let f = crate::snapshot::tests::fixture();
        let mut draft = crate::snapshot::tests::draft("pinch_start");
        draft.id = SnapshotId::new("snap-x").unwrap();
        draft.project_id = ProjectId::new("nope").unwrap();
        let s = DatasetSnapshot::seal(draft, &f.labels, &f.store, &f.in_data).unwrap();
        assert!(matches!(
            r.add_snapshot(s),
            Err(RegistryError::NoProject(_))
        ));
        // A run that points at a missing snapshot.
        let mut tr = run("rx");
        tr.snapshot_id = SnapshotId::new("missing").unwrap();
        assert!(matches!(r.queue_run(tr), Err(RegistryError::NoSnapshot(_))));
        // A project's target label cannot be changed by an update.
        let mut changed = project("pa", "pinch_start");
        changed.id = ProjectId::new("pa").unwrap();
        changed.target = label("swipe_left");
        changed
            .mapping
            .entries
            .insert(label("swipe_left"), crate::ExampleRole::Positive);
        assert!(matches!(
            r.update_project(changed),
            Err(RegistryError::WrongProject(_))
        ));
    }

    #[test]
    fn only_an_archived_model_can_be_removed_and_nothing_else_changes() {
        let id = |v: &str| ModelVersionId::new(v).unwrap();
        let mut r = two_label_registry();
        r.activate(&id("a1"), "t").unwrap();
        // Approved, active: both refused, and nothing is lost.
        for target in ["a1", "a2"] {
            assert!(matches!(
                r.remove_version(&id(target)),
                Err(RegistryError::NotArchived { .. })
            ));
        }
        assert_eq!(r.versions.len(), 3);
        // Archive the approved one, then it can go. Another label's model and the active one are untouched.
        r.transition(&id("a2"), LifecycleState::Evaluated, "t")
            .unwrap();
        r.transition(&id("a2"), LifecycleState::Archived, "t")
            .unwrap();
        let removed = r.remove_version(&id("a2")).unwrap();
        assert_eq!(removed.id, id("a2"));
        assert!(!r.versions.contains_key(&id("a2")));
        assert!(r.versions.contains_key(&id("a1")) && r.versions.contains_key(&id("b1")));
        assert_eq!(r.active_by_label[&label("pinch_start")], id("a1"));
        r.validate().unwrap();
        assert_eq!(
            r.remove_version(&id("a2")),
            Err(RegistryError::NoVersion(id("a2")))
        );
    }
}
