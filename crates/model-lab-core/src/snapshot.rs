use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contract::{InputContract, QualityRules};
use crate::ids::{LabelId, ProjectId, RecordingId, SnapshotId};
use crate::project::{ExampleRole, LabelMapping};
use crate::{is_sha256_hex, sha256_hex};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SnapshotError {
    #[error("the snapshot's recording '{0}' is not in the recording store")]
    MissingRecording(RecordingId),
    #[error(
        "recording '{id}' has changed since it was selected: the store has {actual}, the draft recorded {expected}"
    )]
    RecordingChanged {
        id: RecordingId,
        expected: String,
        actual: String,
    },
    #[error("the label '{0}' is not in the label catalogue")]
    UnknownLabel(LabelId),
    #[error("the label mapping does not cover '{0}', which occurs in the selected recordings")]
    UncoveredLabel(LabelId),
    #[error("the target label must be marked positive")]
    TargetNotPositive,
    #[error(
        "recording '{0}' is used for both training and evaluation, which would leak what the model learned into its score"
    )]
    SessionLeak(RecordingId),
    #[error("the split uses recording '{0}', which is not part of the snapshot")]
    SplitOutsideSnapshot(RecordingId),
    #[error("the snapshot needs at least one recording to train on and one to evaluate on")]
    EmptySplit,
    #[error("a recording hash is not a SHA-256")]
    BadHash,
    #[error("the snapshot's content hash does not match its contents: it has been altered")]
    Tampered,
    #[error(transparent)]
    Contract(#[from] crate::contract::ContractError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRef {
    pub id: RecordingId,
    /// SHA-256 of the recording's contents when it was selected.
    pub sha256: String,
}

/// Which recordings train the model and which score it. They never overlap: scoring on a session the model trained
/// on says nothing about how it behaves on a new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Split {
    pub train: Vec<RecordingId>,
    pub evaluation: Vec<RecordingId>,
}

/// Everything a snapshot is made of, before it is sealed.
#[derive(Debug, Clone)]
pub struct SnapshotDraft {
    pub id: SnapshotId,
    pub project_id: ProjectId,
    pub target: LabelId,
    pub mapping: LabelMapping,
    pub input: InputContract,
    pub quality: QualityRules,
    pub recordings: Vec<RecordingRef>,
    pub split: Split,
    pub created_at: String,
}

/// An immutable record of exactly what a training run used: the mapping, the contract and the recordings, each by
/// content hash. Later edits to a label, a project or a recording cannot change what an old model's data meant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSnapshot {
    pub id: SnapshotId,
    pub project_id: ProjectId,
    pub target: LabelId,
    pub mapping: LabelMapping,
    pub input: InputContract,
    pub quality: QualityRules,
    pub recordings: Vec<RecordingRef>,
    pub split: Split,
    pub created_at: String,
    /// SHA-256 over everything above.
    pub content_hash: String,
}

// `InputContract` and `QualityRules` hold floats, so they are only `PartialEq`; compare snapshots through the hash.
impl Eq for InputContract {}
impl Eq for QualityRules {}

impl DatasetSnapshot {
    fn hash_of(parts: &DatasetSnapshotBody<'_>) -> String {
        // Serialisation order is fixed by the struct and by sorted maps, so the same snapshot always hashes the same.
        sha256_hex(&serde_json::to_vec(parts).expect("a snapshot always serialises"))
    }

    /// Checks a draft against the label catalogue and the recording store, then freezes it.
    ///
    /// * `known_labels`: every label in the catalogue.
    /// * `recordings`: the recording store, id to content hash.
    /// * `labels_in_data`: every label that occurs in the selected recordings; each needs an explicit mapping entry.
    pub fn seal(
        draft: SnapshotDraft,
        known_labels: &BTreeSet<LabelId>,
        recordings: &BTreeMap<RecordingId, String>,
        labels_in_data: &BTreeSet<LabelId>,
    ) -> Result<Self, SnapshotError> {
        if draft.mapping.entries.get(&draft.target) != Some(&ExampleRole::Positive) {
            return Err(SnapshotError::TargetNotPositive);
        }
        for label in draft.mapping.entries.keys() {
            if !known_labels.contains(label) {
                return Err(SnapshotError::UnknownLabel(label.clone()));
            }
        }
        for label in labels_in_data {
            if !draft.mapping.entries.contains_key(label) {
                return Err(SnapshotError::UncoveredLabel(label.clone()));
            }
        }
        for reference in &draft.recordings {
            if !is_sha256_hex(&reference.sha256) {
                return Err(SnapshotError::BadHash);
            }
            let actual = recordings
                .get(&reference.id)
                .ok_or_else(|| SnapshotError::MissingRecording(reference.id.clone()))?;
            if *actual != reference.sha256 {
                return Err(SnapshotError::RecordingChanged {
                    id: reference.id.clone(),
                    expected: reference.sha256.clone(),
                    actual: actual.clone(),
                });
            }
        }
        draft.input.validate()?;
        draft.quality.validate()?;
        Self::check_split(&draft.recordings, &draft.split)?;

        let mut sealed = Self {
            id: draft.id,
            project_id: draft.project_id,
            target: draft.target,
            mapping: draft.mapping,
            input: draft.input,
            quality: draft.quality,
            recordings: draft.recordings,
            split: draft.split,
            created_at: draft.created_at,
            content_hash: String::new(),
        };
        sealed.content_hash = Self::hash_of(&sealed.body());
        Ok(sealed)
    }

    fn check_split(recordings: &[RecordingRef], split: &Split) -> Result<(), SnapshotError> {
        if split.train.is_empty() || split.evaluation.is_empty() {
            return Err(SnapshotError::EmptySplit);
        }
        let in_snapshot: BTreeSet<&RecordingId> = recordings.iter().map(|r| &r.id).collect();
        let training: BTreeSet<&RecordingId> = split.train.iter().collect();
        for id in split.train.iter().chain(&split.evaluation) {
            if !in_snapshot.contains(id) {
                return Err(SnapshotError::SplitOutsideSnapshot(id.clone()));
            }
        }
        if let Some(leaked) = split.evaluation.iter().find(|id| training.contains(id)) {
            return Err(SnapshotError::SessionLeak(leaked.clone()));
        }
        Ok(())
    }

    fn body(&self) -> DatasetSnapshotBody<'_> {
        DatasetSnapshotBody {
            id: &self.id,
            project_id: &self.project_id,
            target: &self.target,
            mapping: &self.mapping,
            input: &self.input,
            quality: &self.quality,
            recordings: &self.recordings,
            split: &self.split,
            created_at: &self.created_at,
        }
    }

    /// Re-checks the snapshot's own integrity: its split and its content hash. Run on load and before a training run.
    pub fn verify(&self) -> Result<(), SnapshotError> {
        Self::check_split(&self.recordings, &self.split)?;
        if !is_sha256_hex(&self.content_hash) || Self::hash_of(&self.body()) != self.content_hash {
            return Err(SnapshotError::Tampered);
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatasetSnapshotBody<'a> {
    id: &'a SnapshotId,
    project_id: &'a ProjectId,
    target: &'a LabelId,
    mapping: &'a LabelMapping,
    input: &'a InputContract,
    quality: &'a QualityRules,
    recordings: &'a [RecordingRef],
    split: &'a Split,
    created_at: &'a str,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::project::tests::{input, label, project};

    pub fn hash(n: u8) -> String {
        sha256_hex(&[n])
    }

    pub struct Fixture {
        pub labels: BTreeSet<LabelId>,
        pub store: BTreeMap<RecordingId, String>,
        pub in_data: BTreeSet<LabelId>,
    }

    pub fn fixture() -> Fixture {
        Fixture {
            labels: ["pinch_start", "swipe_left", "idle", "walking"]
                .iter()
                .map(|l| label(l))
                .collect(),
            store: [("rec1", 1), ("rec2", 2), ("rec3", 3)]
                .iter()
                .map(|(id, n)| (RecordingId::new(*id).unwrap(), hash(*n)))
                .collect(),
            in_data: ["pinch_start", "idle", "walking"]
                .iter()
                .map(|l| label(l))
                .collect(),
        }
    }

    pub fn draft(target: &str) -> SnapshotDraft {
        let p = project("p1", target);
        SnapshotDraft {
            id: SnapshotId::new("snap1").unwrap(),
            project_id: p.id,
            target: p.target,
            mapping: p.mapping,
            input: input(),
            quality: QualityRules::default(),
            recordings: vec![
                RecordingRef {
                    id: RecordingId::new("rec1").unwrap(),
                    sha256: hash(1),
                },
                RecordingRef {
                    id: RecordingId::new("rec2").unwrap(),
                    sha256: hash(2),
                },
            ],
            split: Split {
                train: vec![RecordingId::new("rec1").unwrap()],
                evaluation: vec![RecordingId::new("rec2").unwrap()],
            },
            created_at: "2026-10-04T00:00:00Z".into(),
        }
    }

    pub fn sealed(target: &str) -> DatasetSnapshot {
        let f = fixture();
        DatasetSnapshot::seal(draft(target), &f.labels, &f.store, &f.in_data).unwrap()
    }

    #[test]
    fn a_valid_draft_seals_with_a_stable_hash_that_verifies() {
        let a = sealed("pinch_start");
        let b = sealed("pinch_start");
        assert_eq!(
            a.content_hash, b.content_hash,
            "the same inputs always hash the same"
        );
        a.verify().unwrap();
        assert_eq!(a.content_hash.len(), 64);
    }

    #[test]
    fn positive_negative_and_excluded_roles_are_explicit_and_cover_every_label_in_the_data() {
        let f = fixture();
        let mut in_data = f.in_data.clone();
        in_data.insert(label("swipe_left")); // present in the recordings, absent from the mapping
        assert_eq!(
            DatasetSnapshot::seal(draft("pinch_start"), &f.labels, &f.store, &in_data).unwrap_err(),
            SnapshotError::UncoveredLabel(label("swipe_left"))
        );
        let mut d = draft("pinch_start");
        d.mapping
            .entries
            .insert(label("brand_new"), ExampleRole::Negative);
        assert_eq!(
            DatasetSnapshot::seal(d, &f.labels, &f.store, &f.in_data).unwrap_err(),
            SnapshotError::UnknownLabel(label("brand_new"))
        );
        let mut d = draft("pinch_start");
        d.mapping
            .entries
            .insert(label("pinch_start"), ExampleRole::Exclude);
        assert_eq!(
            DatasetSnapshot::seal(d, &f.labels, &f.store, &f.in_data).unwrap_err(),
            SnapshotError::TargetNotPositive
        );
    }

    #[test]
    fn missing_or_changed_recordings_are_rejected() {
        let mut f = fixture();
        f.store.remove(&RecordingId::new("rec2").unwrap());
        assert!(matches!(
            DatasetSnapshot::seal(draft("pinch_start"), &f.labels, &f.store, &f.in_data),
            Err(SnapshotError::MissingRecording(_))
        ));
        let mut f = fixture();
        f.store.insert(RecordingId::new("rec2").unwrap(), hash(99));
        assert!(matches!(
            DatasetSnapshot::seal(draft("pinch_start"), &f.labels, &f.store, &f.in_data),
            Err(SnapshotError::RecordingChanged { .. })
        ));
        let mut d = draft("pinch_start");
        d.recordings[0].sha256 = "nothex".into();
        let f = fixture();
        assert_eq!(
            DatasetSnapshot::seal(d, &f.labels, &f.store, &f.in_data).unwrap_err(),
            SnapshotError::BadHash
        );
    }

    #[test]
    fn a_session_cannot_both_train_and_evaluate() {
        let f = fixture();
        let mut d = draft("pinch_start");
        d.split.evaluation = vec![
            RecordingId::new("rec1").unwrap(),
            RecordingId::new("rec2").unwrap(),
        ];
        assert_eq!(
            DatasetSnapshot::seal(d, &f.labels, &f.store, &f.in_data).unwrap_err(),
            SnapshotError::SessionLeak(RecordingId::new("rec1").unwrap())
        );
        let mut d = draft("pinch_start");
        d.split.train = vec![];
        assert_eq!(
            DatasetSnapshot::seal(d, &f.labels, &f.store, &f.in_data).unwrap_err(),
            SnapshotError::EmptySplit
        );
        let mut d = draft("pinch_start");
        d.split.evaluation = vec![RecordingId::new("rec3").unwrap()];
        assert!(matches!(
            DatasetSnapshot::seal(d, &f.labels, &f.store, &f.in_data),
            Err(SnapshotError::SplitOutsideSnapshot(_))
        ));
    }

    #[test]
    fn editing_a_sealed_snapshot_is_detected_so_its_meaning_cannot_drift() {
        let mut s = sealed("pinch_start");
        s.mapping
            .entries
            .insert(label("idle"), ExampleRole::Positive); // relabel after the fact
        assert_eq!(s.verify(), Err(SnapshotError::Tampered));
        let mut s = sealed("pinch_start");
        s.recordings[0].sha256 = hash(7);
        assert_eq!(s.verify(), Err(SnapshotError::Tampered));
        let mut s = sealed("pinch_start");
        s.split.evaluation = vec![RecordingId::new("rec1").unwrap()];
        assert!(matches!(s.verify(), Err(SnapshotError::SessionLeak(_))));
    }

    #[test]
    fn a_snapshot_survives_json_unchanged() {
        let s = sealed("pinch_start");
        let back: DatasetSnapshot =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        back.verify().unwrap();
    }
}
