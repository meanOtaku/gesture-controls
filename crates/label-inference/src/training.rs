//! The registry's side of training a model: what has to be decided and recorded before a trainer runs, and how a run
//! ends.
//!
//! Before training, [`begin_run`] fixes everything that must not change afterwards: which recordings train and which
//! evaluate (never the same one), what every label in the data means, the streams and window the model may use. It seals
//! that as a snapshot and records a started run, in one saved registry change. The trainer is then only told what to do.
//!
//! A run ends one of two ways. [`fail_run`] records why it did not produce a model. [`complete_run`] stages and validates
//! the bundle the trainer wrote and, in the same saved change, marks the run finished and records the model as a Draft
//! that came from that run. A model is never recorded without the run that made it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use model_lab_core::{
    ArtifactRef, DatasetSnapshot, ExampleRole, InputContract, LabelId, LabelMapping, LabelProject,
    ModelOrigin, Persist, ProjectId, QualityRules, RecordingId, RecordingRef, RegistryStore, RunId,
    RunOutcome, SnapshotDraft, SnapshotId, Split, StreamSource, Thresholds, TrainerBackend,
    TrainerConfig, TrainingRun,
};
use pinch_inference::{FEATURE_NAMES, GridChannel};
use thiserror::Error;

use crate::bundle::{source_of_channel, source_of_feature};
use crate::import::{ImportError, ImportOutcome, StagedBundle, publish_staged_with};

#[derive(Debug, Error)]
pub enum TrainingError {
    #[error(
        "to test a model fairly there must be at least two recordings with '{target}' and two with something else (a recording with both counts for each): one of each to train on and one of each to test on. Record more sessions"
    )]
    NotEnoughRecordings { target: LabelId },
    #[error("'{0}' is in the recordings but has no role (target, negative or excluded)")]
    UnmappedLabel(LabelId),
    #[error("the label to train, '{0}', must be marked as the target")]
    TargetNotPositive(LabelId),
    #[error("{0}")]
    Registry(String),
    #[error(transparent)]
    Import(#[from] ImportError),
    #[error(transparent)]
    Id(#[from] model_lab_core::IdError),
}

fn registry_error(error: impl std::fmt::Display) -> TrainingError {
    TrainingError::Registry(error.to_string())
}

/// One recording, as far as planning needs to know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingInfo {
    pub id: RecordingId,
    /// SHA-256 of the recording's contents.
    pub sha256: String,
    /// Every label on its rows.
    pub labels: BTreeSet<LabelId>,
}

/// A feature about how a signal changes rather than its absolute level: spread, change over the window, and the PPG
/// slope. Absolute levels carry how the watch was held or how well it touched the skin in one session, which a model can
/// memorise. The trainer applies the same rule (`is_movement_feature` in `label_train.py`); both are tested against the
/// same list.
pub fn is_movement_feature(name: &str) -> bool {
    name.ends_with("_std")
        || name == "quat_delta_angle_deg"
        || (name.starts_with("ppg_") && name.ends_with("_slope"))
        || is_spike_feature(name)
}

/// A pulse-sensor spike feature: what is left of a PPG channel once its baseline is taken away (its biggest spike and
/// its steepest rise and fall). These come after the 55 base features and are only used when asked for.
pub fn is_spike_feature(name: &str) -> bool {
    name.starts_with("ppg_") && (name.contains("_spike_") || name.contains("_deriv_"))
}

/// Every canonical feature computed from the given streams, in canonical order, optionally only the movement ones. A
/// window-level value (sample count, duration, contact quality) comes with the PPG stream. The pulse-sensor spike
/// features are left out unless `spikes` asks for them (and the PPG stream is chosen).
pub fn canonical_features_for(
    sources: &[StreamSource],
    movement_only: bool,
    spikes: bool,
) -> Vec<String> {
    canonical_features_with_channels(sources, movement_only, spikes, &PPG_CHANNELS)
}

/// The three light channels of the watch's pulse sensor, as they appear in feature names (`ppg_green_std`).
pub const PPG_CHANNELS: [&str; 3] = ["green", "red", "ir"];

/// [`canonical_features_for`] limited to some of the pulse sensor's channels. A feature of a channel that is not listed is
/// left out; the window-level values that come with the pulse sensor (sample count, duration, contact quality) stay.
pub fn canonical_features_with_channels(
    sources: &[StreamSource],
    movement_only: bool,
    spikes: bool,
    ppg_channels: &[&str],
) -> Vec<String> {
    let wanted = |name: &str| {
        let channel = name
            .strip_prefix("ppg_")
            .and_then(|rest| rest.split('_').next());
        match channel {
            Some(channel) if PPG_CHANNELS.contains(&channel) => ppg_channels.contains(&channel),
            _ => true,
        }
    };
    FEATURE_NAMES
        .iter()
        .filter(|name| wanted(name))
        .filter(|name| spikes || !is_spike_feature(name))
        .filter(|name| source_of_feature(name).is_some_and(|s| sources.contains(&s)))
        .filter(|name| !movement_only || is_movement_feature(name))
        .map(ToString::to_string)
        .collect()
}

/// The grid channels a convolutional model reads from the chosen streams, in canonical order: for the pulse sensor only
/// the lights in `ppg_channels`. Mirrors `channels_for` in the trainer's `grid.py`.
pub fn grid_channels_for(sources: &[StreamSource], ppg_channels: &[&str]) -> Vec<String> {
    GridChannel::ALL
        .into_iter()
        .filter(|channel| sources.contains(&source_of_channel(*channel)))
        .filter(|channel| {
            !channel.is_ppg()
                || channel
                    .name()
                    .strip_prefix("ppg_")
                    .is_some_and(|light| ppg_channels.contains(&light))
        })
        .map(|channel| channel.name().to_string())
        .collect()
}

/// Splits the recordings into those a model trains on and those that test it. Deterministic (the same recordings always
/// split the same way), about 30% held out, and never leaving either side without both the target and something else.
pub fn plan_split(
    recordings: &[RecordingInfo],
    mapping: &LabelMapping,
    target: &LabelId,
) -> Result<Split, TrainingError> {
    let has_target = |r: &RecordingInfo| r.labels.contains(target);
    let has_other = |r: &RecordingInfo| {
        r.labels
            .iter()
            .any(|l| mapping.entries.get(l) == Some(&ExampleRole::Negative))
    };
    let not_enough = || TrainingError::NotEnoughRecordings {
        target: target.clone(),
    };

    let mut order: Vec<&RecordingInfo> = recordings.iter().collect();
    order.sort_by_key(|r| model_lab_core::sha256_hex(r.id.as_str().as_bytes()));

    // Positions in `order` of the recordings held out for testing.
    let mut held: Vec<usize> = Vec::new();
    // Make sure testing sees each kind: the first of each (in the fixed order) that is not already covered.
    for covers in [&has_target as &dyn Fn(&RecordingInfo) -> bool, &has_other] {
        if !held.iter().any(|&i| covers(order[i]))
            && let Some(position) =
                (0..order.len()).find(|i| covers(order[*i]) && !held.contains(i))
        {
            held.push(position);
        }
    }
    // Then fill up to about 30%, while what is left to train on still has both kinds.
    let wanted = ((recordings.len() as f64) * 0.3).round() as usize;
    for candidate in 0..order.len() {
        if held.len() >= wanted {
            break;
        }
        if held.contains(&candidate) {
            continue;
        }
        let rest = || (0..order.len()).filter(|i| *i != candidate && !held.contains(i));
        if rest().any(|i| has_target(order[i])) && rest().any(|i| has_other(order[i])) {
            held.push(candidate);
        }
    }

    let side = |held_out: bool| -> Vec<&RecordingInfo> {
        (0..order.len())
            .filter(|i| held.contains(i) == held_out)
            .map(|i| order[i])
            .collect()
    };
    let (evaluation, train) = (side(true), side(false));
    let both = |set: &[&RecordingInfo]| {
        set.iter().any(|r| has_target(r)) && set.iter().any(|r| has_other(r))
    };
    if !both(&evaluation) || !both(&train) {
        return Err(not_enough());
    }
    let ids = |set: Vec<&RecordingInfo>| set.into_iter().map(|r| r.id.clone()).collect();
    Ok(Split {
        train: ids(train),
        evaluation: ids(evaluation),
    })
}

/// Like [`plan_split`], but the recordings in `train_only` can only train, never test. The rest are split exactly as
/// they would be without them, so adding recordings to train on (to fine-tune a model on corrections) never changes which
/// recordings the model is tested on, and its score before and after stay comparable.
pub fn plan_split_keeping(
    recordings: &[RecordingInfo],
    mapping: &LabelMapping,
    target: &LabelId,
    train_only: &[RecordingId],
) -> Result<Split, TrainingError> {
    if train_only.is_empty() {
        return plan_split(recordings, mapping, target);
    }
    let base: Vec<RecordingInfo> = recordings
        .iter()
        .filter(|r| !train_only.contains(&r.id))
        .cloned()
        .collect();
    let mut split = plan_split(&base, mapping, target)?;
    for recording in recordings {
        if train_only.contains(&recording.id) {
            split.train.push(recording.id.clone());
        }
    }
    Ok(split)
}

/// Everything about a training request that is decided up front.
#[derive(Debug, Clone)]
pub struct RunPlan {
    pub target: LabelId,
    pub mapping: LabelMapping,
    pub input: InputContract,
    pub quality: QualityRules,
    pub trainer: TrainerConfig,
    pub recordings: Vec<RecordingInfo>,
    /// Recordings that may train but never test (see [`plan_split_keeping`]); empty for an ordinary run.
    pub train_only: Vec<RecordingId>,
    /// Ends of the unique names for this run's records, e.g. a short random string.
    pub unique: String,
}

/// A run that has been recorded as started.
#[derive(Debug, Clone, PartialEq)]
pub struct BegunRun {
    pub run_id: RunId,
    pub snapshot_id: SnapshotId,
    pub project_id: ProjectId,
    pub split: Split,
}

/// Seals the plan as a snapshot and records the run as started, in one saved registry change. Refused, with nothing
/// recorded, if a label has no role, the data cannot be split fairly, or a recording is not what it was.
pub fn begin_run<P: Persist>(
    store: &mut RegistryStore<P>,
    plan: &RunPlan,
    known_labels: &BTreeSet<LabelId>,
    now: &str,
) -> Result<BegunRun, TrainingError> {
    if plan.mapping.entries.get(&plan.target) != Some(&ExampleRole::Positive) {
        return Err(TrainingError::TargetNotPositive(plan.target.clone()));
    }
    let labels_in_data: BTreeSet<LabelId> = plan
        .recordings
        .iter()
        .flat_map(|r| r.labels.iter().cloned())
        .collect();
    if let Some(missing) = labels_in_data
        .iter()
        .find(|l| !plan.mapping.entries.contains_key(*l))
    {
        return Err(TrainingError::UnmappedLabel(missing.clone()));
    }
    let split = plan_split_keeping(
        &plan.recordings,
        &plan.mapping,
        &plan.target,
        &plan.train_only,
    )?;

    let run_id = RunId::new(format!("run-{}", plan.unique))?;
    let snapshot_id = SnapshotId::new(format!("snap-{}", plan.unique))?;
    let existing = store
        .registry()
        .projects
        .values()
        .find(|p| p.target == plan.target)
        .cloned();
    let project_id = match &existing {
        Some(project) => project.id.clone(),
        None => ProjectId::new(format!("p-{}", plan.target))?,
    };
    let sessions: Vec<RecordingId> = plan.recordings.iter().map(|r| r.id.clone()).collect();
    let store_view: BTreeMap<RecordingId, String> = plan
        .recordings
        .iter()
        .map(|r| (r.id.clone(), r.sha256.clone()))
        .collect();
    let draft = SnapshotDraft {
        id: snapshot_id.clone(),
        project_id: project_id.clone(),
        target: plan.target.clone(),
        mapping: plan.mapping.clone(),
        input: plan.input.clone(),
        quality: plan.quality,
        recordings: plan
            .recordings
            .iter()
            .map(|r| RecordingRef {
                id: r.id.clone(),
                sha256: r.sha256.clone(),
            })
            .collect(),
        split: split.clone(),
        created_at: now.to_string(),
    };

    store
        .mutate(|registry| {
            let project = LabelProject {
                id: project_id.clone(),
                name: existing
                    .as_ref()
                    .map_or_else(|| plan.target.to_string(), |p| p.name.clone()),
                target: plan.target.clone(),
                sessions: sessions.clone(),
                mapping: plan.mapping.clone(),
                input: plan.input.clone(),
                quality: plan.quality,
                trainer: plan.trainer.clone(),
                thresholds: existing
                    .as_ref()
                    .map_or_else(Thresholds::default, |p| p.thresholds),
                created_at: existing
                    .as_ref()
                    .map_or_else(|| now.to_string(), |p| p.created_at.clone()),
                updated_at: now.to_string(),
            };
            if existing.is_some() {
                registry.update_project(project)?;
            } else {
                registry.create_project(project)?;
            }
            let snapshot = DatasetSnapshot::seal(draft, known_labels, &store_view, &labels_in_data)
                .map_err(|e| model_lab_core::RegistryError::Corrupt(e.to_string()))?;
            registry.add_snapshot(snapshot)?;
            registry.queue_run(TrainingRun::queue(
                run_id.clone(),
                project_id.clone(),
                snapshot_id.clone(),
                plan.trainer.clone(),
                now,
            ))?;
            registry.start_run(&run_id, now)
        })
        .map_err(registry_error)?;
    Ok(BegunRun {
        run_id,
        snapshot_id,
        project_id,
        split,
    })
}

/// Records that the run did not produce a model, and why. The message is shown to the person who started it.
pub fn fail_run<P: Persist>(
    store: &mut RegistryStore<P>,
    run_id: &RunId,
    message: &str,
    now: &str,
) -> Result<(), TrainingError> {
    store
        .mutate(|registry| {
            registry.finish_run(
                run_id,
                RunOutcome::Failed,
                Some(message.to_string()),
                Vec::new(),
                now,
            )
        })
        .map_err(registry_error)
}

/// Records that the run trained and scored a model that is not worth keeping, so there is nothing to review or approve.
/// The run is finished (and immutable) with the reason and the evaluation it produced.
pub fn evaluation_only_run<P: Persist>(
    store: &mut RegistryStore<P>,
    run_id: &RunId,
    message: &str,
    artifacts: Vec<ArtifactRef>,
    now: &str,
) -> Result<(), TrainingError> {
    store
        .mutate(|registry| {
            registry.finish_run(
                run_id,
                RunOutcome::EvaluationOnly,
                Some(message.to_string()),
                artifacts,
                now,
            )
        })
        .map_err(registry_error)
}

/// Publishes the model a run produced as a Draft and marks the run finished, in one saved registry change. If the
/// bundle is refused or the registry cannot be saved, neither happens and the caller should [`fail_run`].
pub fn complete_run<P: Persist>(
    store: &mut RegistryStore<P>,
    staged: StagedBundle,
    model_lab_dir: &Path,
    run_id: &RunId,
    artifacts: Vec<ArtifactRef>,
    now: &str,
) -> Result<ImportOutcome, TrainingError> {
    let finished = run_id.clone();
    Ok(publish_staged_with(
        staged,
        model_lab_dir,
        store,
        now,
        ModelOrigin::Trained {
            run_id: run_id.clone(),
        },
        move |registry| {
            registry.finish_run(&finished, RunOutcome::Deployable, None, artifacts, now)
        },
    )?)
}

/// The trainer backends this app offers, as the registry records them.
pub fn trainer_backend(name: &str) -> Option<TrainerBackend> {
    match name {
        "logreg" | "mlp" => Some(TrainerBackend::ScikitLearn),
        "torch-mlp" | "cnn1d" => Some(TrainerBackend::PyTorch),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use model_lab_core::{LifecycleState, Registry, StoreError};

    use super::*;
    use crate::bundle::tests::fixture_dir;
    use crate::import::stage_bundle;

    const NOW: &str = "2026-10-05T00:00:00Z";

    #[derive(Default)]
    struct Memory;
    impl Persist for Memory {
        fn save(&mut self, _: &Registry) -> Result<(), StoreError> {
            Ok(())
        }
    }

    fn label(id: &str) -> LabelId {
        LabelId::new(id).unwrap()
    }

    fn info(id: &str, labels: &[&str]) -> RecordingInfo {
        RecordingInfo {
            id: RecordingId::new(id).unwrap(),
            sha256: model_lab_core::sha256_hex(id.as_bytes()),
            labels: labels.iter().map(|l| label(l)).collect(),
        }
    }

    fn mapping() -> LabelMapping {
        LabelMapping {
            entries: [
                (label("snap"), ExampleRole::Positive),
                (label("idle"), ExampleRole::Negative),
                (label("walking"), ExampleRole::Exclude),
            ]
            .into(),
        }
    }

    fn sessions() -> Vec<RecordingInfo> {
        vec![
            info("s1", &["snap"]),
            info("s2", &["snap"]),
            info("s3", &["snap"]),
            info("i1", &["idle"]),
            info("i2", &["idle"]),
            info("i3", &["idle"]),
            info("w1", &["walking"]),
        ]
    }

    fn plan(recordings: Vec<RecordingInfo>) -> RunPlan {
        let input = InputContract {
            sources: vec![
                StreamSource::WatchAcceleration,
                StreamSource::WatchGyroscope,
            ],
            features: canonical_features_for(
                &[
                    StreamSource::WatchAcceleration,
                    StreamSource::WatchGyroscope,
                ],
                false,
                false,
            ),
            window_ms: 500,
            stride_ms: 150,
            max_gap_ms: 250,
            min_samples: 3,
        };
        RunPlan {
            target: label("snap"),
            mapping: mapping(),
            input,
            quality: QualityRules::default(),
            trainer: TrainerConfig {
                backend: TrainerBackend::ScikitLearn,
                params: BTreeMap::new(),
            },
            recordings,
            train_only: Vec::new(),
            unique: "abc12345".into(),
        }
    }

    fn known() -> BTreeSet<LabelId> {
        ["snap", "idle", "walking"]
            .iter()
            .map(|l| label(l))
            .collect()
    }

    fn store() -> RegistryStore<Memory> {
        RegistryStore::new(Registry::default(), Memory).unwrap()
    }

    #[test]
    fn the_split_never_shares_a_recording_and_leaves_both_kinds_on_both_sides() {
        let recordings = sessions();
        let split = plan_split(&recordings, &mapping(), &label("snap")).unwrap();
        let set =
            |ids: &[RecordingId]| ids.iter().map(ToString::to_string).collect::<BTreeSet<_>>();
        let (train, eval) = (set(&split.train), set(&split.evaluation));
        assert!(train.is_disjoint(&eval));
        assert_eq!(train.len() + eval.len(), recordings.len());
        for side in [&train, &eval] {
            assert!(side.iter().any(|id| id.starts_with('s')), "{side:?}");
            assert!(side.iter().any(|id| id.starts_with('i')), "{side:?}");
        }
        // About 30% are held out, and the same recordings always split the same way.
        assert_eq!(eval.len(), 2);
        assert_eq!(
            split,
            plan_split(&recordings, &mapping(), &label("snap")).unwrap()
        );
        // The order they are given in makes no difference.
        let mut reversed = recordings.clone();
        reversed.reverse();
        let again = plan_split(&reversed, &mapping(), &label("snap")).unwrap();
        assert_eq!(set(&again.evaluation), eval);
    }

    #[test]
    fn a_timeline_recording_with_both_kinds_can_stand_for_each() {
        let recordings = vec![info("a", &["snap", "idle"]), info("b", &["snap", "idle"])];
        let split = plan_split(&recordings, &mapping(), &label("snap")).unwrap();
        assert_eq!((split.train.len(), split.evaluation.len()), (1, 1));
    }

    #[test]
    fn it_refuses_when_there_is_nothing_to_test_on_or_learn_the_difference_from() {
        for recordings in [
            vec![info("s1", &["snap"]), info("i1", &["idle"])],
            vec![
                info("s1", &["snap"]),
                info("s2", &["snap"]),
                info("i1", &["idle"]),
            ],
            vec![
                info("s1", &["snap"]),
                info("s2", &["snap"]),
                info("w1", &["walking"]),
            ],
            vec![info("i1", &["idle"]), info("i2", &["idle"])],
            vec![],
        ] {
            assert!(
                matches!(
                    plan_split(&recordings, &mapping(), &label("snap")),
                    Err(TrainingError::NotEnoughRecordings { .. })
                ),
                "{recordings:?}"
            );
        }
    }

    #[test]
    fn the_features_follow_the_streams() {
        let motion = canonical_features_for(&[StreamSource::WatchAcceleration], false, false);
        assert!(!motion.is_empty() && motion.iter().all(|f| f.starts_with("accel_")));
        let all = canonical_features_for(
            &[
                StreamSource::WatchOrientation,
                StreamSource::WatchAcceleration,
                StreamSource::WatchGyroscope,
                StreamSource::WatchPpg,
            ],
            false,
            false,
        );
        assert_eq!(all.len(), FEATURE_NAMES.len() - 24); // the spike features are opt-in
        let with_spikes = canonical_features_for(
            &[
                StreamSource::WatchOrientation,
                StreamSource::WatchAcceleration,
                StreamSource::WatchGyroscope,
                StreamSource::WatchPpg,
            ],
            false,
            true,
        );
        assert_eq!(with_spikes.len(), FEATURE_NAMES.len());
        // Without the pulse sensor there is nothing for them to read.
        assert_eq!(
            canonical_features_for(&[StreamSource::WatchAcceleration], false, true),
            canonical_features_for(&[StreamSource::WatchAcceleration], false, false)
        );
        assert!(canonical_features_for(&[StreamSource::HeadPose], false, true).is_empty());
    }

    #[test]
    fn a_convolutional_model_reads_channels_not_statistics() {
        use StreamSource::*;
        let all = ["green", "red", "ir"];
        assert_eq!(
            grid_channels_for(&[WatchAcceleration], &all),
            ["accel_x", "accel_y", "accel_z"]
        );
        assert_eq!(
            grid_channels_for(&[WatchPpg], &["ir", "green"]),
            ["ppg_green", "ppg_ir"]
        );
        assert_eq!(
            grid_channels_for(&[WatchPpg, WatchOrientation], &["red"]),
            ["ppg_red", "quat_w", "quat_x", "quat_y", "quat_z"]
        );
        assert_eq!(
            grid_channels_for(
                &[
                    WatchPpg,
                    WatchGyroscope,
                    WatchAcceleration,
                    WatchOrientation
                ],
                &all
            )
            .len(),
            13
        );
        assert!(grid_channels_for(&[HeadPose], &all).is_empty());
        assert_eq!(trainer_backend("cnn1d"), Some(TrainerBackend::PyTorch));
    }

    #[test]
    fn beginning_a_run_seals_the_decisions_and_records_it_as_started() {
        let mut store = store();
        let begun = begin_run(&mut store, &plan(sessions()), &known(), NOW).unwrap();
        let registry = store.registry();
        let run = &registry.runs[&begun.run_id];
        assert_eq!(run.status, model_lab_core::RunStatus::Running);
        let snapshot = &registry.snapshots[&begun.snapshot_id];
        assert_eq!(snapshot.split, begun.split);
        assert_eq!(snapshot.mapping, mapping());
        assert_eq!(snapshot.recordings.len(), 7);
        assert_eq!(registry.projects[&begun.project_id].target, label("snap"));
        assert!(registry.versions.is_empty());
    }

    #[test]
    fn a_refused_plan_records_nothing() {
        let mut store = store();
        let before = store.registry().clone();
        // A label with no role.
        let mut recordings = sessions();
        recordings.push(info("t1", &["typing"]));
        assert!(matches!(
            begin_run(&mut store, &plan(recordings), &known(), NOW),
            Err(TrainingError::UnmappedLabel(_))
        ));
        // Not enough recordings.
        assert!(
            begin_run(
                &mut store,
                &plan(vec![info("s1", &["snap"])]),
                &known(),
                NOW
            )
            .is_err()
        );
        // A label that is not in the catalogue.
        let unknown: BTreeSet<LabelId> = [label("snap"), label("idle")].into();
        assert!(begin_run(&mut store, &plan(sessions()), &unknown, NOW).is_err());
        // The target not marked as the target.
        let mut wrong = plan(sessions());
        wrong
            .mapping
            .entries
            .insert(label("snap"), ExampleRole::Negative);
        assert!(matches!(
            begin_run(&mut store, &wrong, &known(), NOW),
            Err(TrainingError::TargetNotPositive(_))
        ));
        assert_eq!(*store.registry(), before);
    }

    #[test]
    fn a_label_that_already_has_a_project_keeps_it_and_its_name() {
        let mut store = store();
        let first = begin_run(&mut store, &plan(sessions()), &known(), NOW).unwrap();
        let mut second_plan = plan(sessions());
        second_plan.unique = "def67890".into();
        let second = begin_run(&mut store, &second_plan, &known(), NOW).unwrap();
        assert_eq!(first.project_id, second.project_id);
        assert_eq!(store.registry().projects.len(), 1);
        assert_eq!(store.registry().runs.len(), 2);
    }

    #[test]
    fn a_failed_run_is_recorded_with_its_reason() {
        let mut store = store();
        let begun = begin_run(&mut store, &plan(sessions()), &known(), NOW).unwrap();
        fail_run(&mut store, &begun.run_id, "Python is not installed", NOW).unwrap();
        let run = &store.registry().runs[&begun.run_id];
        assert_eq!(run.outcome, Some(RunOutcome::Failed));
        assert_eq!(run.failure.as_deref(), Some("Python is not installed"));
        // A finished run is immutable.
        assert!(fail_run(&mut store, &begun.run_id, "again", NOW).is_err());
    }

    fn trained_bundle() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let from = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/trained_logreg_bundle");
        for file in ["manifest.json", "model.onnx"] {
            fs::copy(from.join(file), dir.path().join(file)).unwrap();
        }
        dir
    }

    #[test]
    fn a_completed_run_publishes_its_model_as_a_draft_that_came_from_that_run() {
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let begun = begin_run(&mut store, &plan(sessions()), &known(), NOW).unwrap();
        let bundle = trained_bundle();
        let staged = stage_bundle(bundle.path(), lab.path()).unwrap();
        let sha = staged.model_sha256.clone();
        let artifacts = vec![ArtifactRef {
            kind: "model".into(),
            path: "label-models/x/model.onnx".into(),
            sha256: sha.clone(),
        }];
        let outcome = complete_run(
            &mut store,
            staged,
            lab.path(),
            &begun.run_id,
            artifacts,
            NOW,
        )
        .unwrap();
        let registry = store.registry();
        let version = &registry.versions[&outcome.version_id];
        assert_eq!(version.state, LifecycleState::Draft);
        assert_eq!(
            version.origin,
            ModelOrigin::Trained {
                run_id: begun.run_id.clone()
            }
        );
        assert_eq!(version.project_id, begun.project_id);
        assert!(!outcome.project_created);
        let run = &registry.runs[&begun.run_id];
        assert_eq!(run.outcome, Some(RunOutcome::Deployable));
        assert_eq!(run.artifacts[0].sha256, sha);
        assert!(registry.active_by_label.is_empty());
    }

    #[test]
    fn a_bundle_that_cannot_be_published_leaves_the_run_open_and_no_model() {
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let begun = begin_run(&mut store, &plan(sessions()), &known(), NOW).unwrap();
        let bundle = trained_bundle();
        let staged = stage_bundle(bundle.path(), lab.path()).unwrap();
        // A run that does not exist makes the combined change fail as a whole.
        let other = RunId::new("run-nope").unwrap();
        let result = complete_run(&mut store, staged, lab.path(), &other, Vec::new(), NOW);
        assert!(result.is_err());
        assert!(store.registry().versions.is_empty());
        assert_eq!(
            store.registry().runs[&begun.run_id].status,
            model_lab_core::RunStatus::Running
        );
        assert!(
            fs::read_dir(lab.path().join(crate::IMPORTED_MODELS_DIR))
                .map_or(true, |mut d| d.next().is_none())
        );
    }

    #[test]
    fn a_run_whose_model_was_not_worth_keeping_is_finished_without_a_model() {
        let mut store = store();
        let begun = begin_run(&mut store, &plan(sessions()), &known(), NOW).unwrap();
        evaluation_only_run(
            &mut store,
            &begun.run_id,
            "it memorised the training recordings",
            Vec::new(),
            NOW,
        )
        .unwrap();
        let run = &store.registry().runs[&begun.run_id];
        assert_eq!(run.outcome, Some(RunOutcome::EvaluationOnly));
        assert_eq!(
            run.failure.as_deref(),
            Some("it memorised the training recordings")
        );
        assert!(store.registry().versions.is_empty());
        assert!(evaluation_only_run(&mut store, &begun.run_id, "again", Vec::new(), NOW).is_err());
    }

    /// The same lists are in `tools/label-trainer/tests/test_label_train.py`: the two sides must choose the same features.
    #[test]
    fn movement_only_keeps_how_things_change_and_matches_the_trainer() {
        use StreamSource::*;
        let strs = |v: Vec<String>| {
            v.iter()
                .map(String::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            strs(canonical_features_for(
                &[WatchAcceleration, WatchGyroscope],
                true,
                false
            )),
            [
                "accel_x_std",
                "accel_y_std",
                "accel_z_std",
                "accel_magnitude_std",
                "gyro_x_std",
                "gyro_y_std",
                "gyro_z_std",
                "gyro_magnitude_std"
            ]
        );
        assert_eq!(
            strs(canonical_features_for(&[WatchOrientation], true, false)),
            [
                "quat_w_std",
                "quat_x_std",
                "quat_y_std",
                "quat_z_std",
                "quat_delta_angle_deg"
            ]
        );
        assert_eq!(
            strs(canonical_features_for(&[WatchPpg], true, false)),
            [
                "ppg_green_std",
                "ppg_red_std",
                "ppg_ir_std",
                "ppg_green_slope",
                "ppg_red_slope",
                "ppg_ir_slope"
            ]
        );
        assert!(
            canonical_features_for(&[WatchAcceleration], true, false).len()
                < canonical_features_for(&[WatchAcceleration], false, false).len()
        );
        // The spike features are all about change, so "only how things change" keeps them.
        let ppg_spikes = strs(canonical_features_for(&[WatchPpg], true, true));
        assert_eq!(ppg_spikes.len(), 6 + 24);
        assert!(ppg_spikes.iter().skip(6).all(|n| is_spike_feature(n)));
    }

    #[test]
    fn the_offered_backends_map_to_the_registry_ones() {
        assert_eq!(trainer_backend("logreg"), Some(TrainerBackend::ScikitLearn));
        assert_eq!(trainer_backend("mlp"), Some(TrainerBackend::ScikitLearn));
        assert_eq!(trainer_backend("torch-mlp"), Some(TrainerBackend::PyTorch));
        assert_eq!(trainer_backend("keras"), None);
        let _ = fixture_dir();
    }

    #[test]
    fn recordings_that_can_only_train_never_change_which_ones_test() {
        let base = sessions();
        let original = plan_split(&base, &mapping(), &label("snap")).unwrap();
        let mut more = base.clone();
        more.push(info("extra1", &["snap", "idle"]));
        more.push(info("extra2", &["snap", "idle"]));
        let keep = [
            RecordingId::new("extra1").unwrap(),
            RecordingId::new("extra2").unwrap(),
        ];
        let split = plan_split_keeping(&more, &mapping(), &label("snap"), &keep).unwrap();
        assert_eq!(split.evaluation, original.evaluation);
        assert_eq!(split.train.len(), original.train.len() + 2);
        assert!(
            keep.iter()
                .all(|id| split.train.contains(id) && !split.evaluation.contains(id))
        );
        assert_eq!(
            plan_split_keeping(&base, &mapping(), &label("snap"), &[]).unwrap(),
            original
        );
    }
}
