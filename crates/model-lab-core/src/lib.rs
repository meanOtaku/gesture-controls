//! The domain model behind Model Lab: one binary model per label.
//!
//! A *Label Project* owns the work of building a model for one target label. A *Dataset Snapshot* freezes exactly
//! what data and label mapping a training attempt used. A *Training Run* is one immutable attempt by one trainer
//! against one snapshot. A *Model Version* is one candidate binary model (output 0 = label absent, 1 = present), and
//! the registry holds at most one *active* version per label, so several labels can have live models at once.
//!
//! This crate has no UI, file-format or runtime dependencies: it is pure state and rules, so every invariant is
//! tested without a desktop. Persistence is a small trait; a fault in it leaves the in-memory registry untouched.

mod contract;
mod ids;
mod migrate;
mod project;
mod registry;
mod run;
mod snapshot;
mod store;
mod version;

pub use contract::{
    ContractError, InputContract, QualityRules, StreamSource, Thresholds, TrainerBackend,
    TrainerConfig,
};
pub use ids::{IdError, LabelId, ModelVersionId, ProjectId, RecordingId, RunId, SnapshotId};
pub use migrate::{
    LegacyModelSummary, MigrationError, MigrationReport, QuarantineReason, QuarantinedModel,
    migrate_legacy_registry,
};
pub use project::{ExampleRole, LabelMapping, LabelProject, ProjectError};
pub use registry::{
    Activation, InferenceMode, REGISTRY_SCHEMA_VERSION, Registry, RegistryError, Rollback,
};
pub use run::{ArtifactRef, RunError, RunOutcome, RunStatus, TrainingRun};
pub use snapshot::{DatasetSnapshot, RecordingRef, SnapshotDraft, SnapshotError, Split};
pub use store::{FileStore, Persist, RegistryStore, StoreError, load_registry_file, open_registry};
pub use version::{
    LifecycleState, ModelOrigin, ModelVersion, StateTransition, VersionError, legal_transition,
};

/// Lower-case hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether `value` is a lower-case hex SHA-256.
pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
