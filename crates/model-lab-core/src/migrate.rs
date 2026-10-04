//! Moves the old single-model registry (`registry.json`) into the per-label registry.
//!
//! Every model in the old registry is a **three-class pinch classifier** (`negative`, `pinch_start`, `pinch_release`)
//! with intent bindings. The new registry holds only binary, one-label models, so none of them can be carried over as
//! a working model. They are not dropped either: each is kept whole in `quarantined`, with its lifecycle history,
//! thresholds, bindings and whether it was the active or previous model, and a message saying what to do. The old
//! file and the model directories are never touched, so the old runtime keeps working until the new one replaces it.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::registry::{InferenceMode, Registry};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MigrationError {
    #[error(
        "the old model registry could not be read ({0}); it was left untouched, and nothing was migrated"
    )]
    Unreadable(String),
    #[error("the old model registry lists the model id '{0}' twice")]
    DuplicateId(String),
    #[error(
        "the old model registry says '{0}' is the active or previous model, but no such model is listed"
    )]
    UnknownPointer(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuarantineReason {
    /// A three-class pinch model: it detects `pinch_start` and `pinch_release` together, so it is not one label's model.
    ThreeClassModel,
}

/// What the old registry recorded about a model, kept as it was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyModelSummary {
    pub state: String,
    pub created_at: String,
    pub thresholds: serde_json::Value,
    pub quality_gate: serde_json::Value,
    pub history: Vec<serde_json::Value>,
    pub intent_bindings: Vec<serde_json::Value>,
    pub imported_tflite_bundle: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedModel {
    /// The old id, which is also the name of its directory under the model-lab directory.
    pub id: String,
    pub reason: QuarantineReason,
    pub was_active: bool,
    pub was_previous: bool,
    /// What to do about it, in words.
    pub diagnostic: String,
    pub legacy: LegacyModelSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub legacy_models: usize,
    pub migrated: usize,
    pub quarantined: usize,
    pub inference_mode: InferenceMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyIndex {
    #[serde(default)]
    models: Vec<LegacyModel>,
    #[serde(default)]
    active_model_id: Option<String>,
    #[serde(default)]
    previous_active_model_id: Option<String>,
    #[serde(default)]
    inference_mode: InferenceMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyModel {
    id: String,
    state: String,
    #[serde(default)]
    thresholds: serde_json::Value,
    #[serde(default)]
    quality_gate: serde_json::Value,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    history: Vec<serde_json::Value>,
    #[serde(default)]
    intent_bindings: Vec<serde_json::Value>,
    #[serde(default)]
    imported_tflite_bundle: bool,
}

/// Deterministic: the same old registry always produces the same new one (models are ordered by id, and nothing
/// depends on the clock). A file that cannot be parsed, repeats an id or points at a missing model is refused, never
/// treated as empty.
pub fn migrate_legacy_registry(json: &str) -> Result<(Registry, MigrationReport), MigrationError> {
    let legacy: LegacyIndex =
        serde_json::from_str(json).map_err(|e| MigrationError::Unreadable(e.to_string()))?;

    let mut seen = BTreeSet::new();
    for model in &legacy.models {
        if !seen.insert(model.id.as_str()) {
            return Err(MigrationError::DuplicateId(model.id.clone()));
        }
    }
    for pointer in [&legacy.active_model_id, &legacy.previous_active_model_id]
        .into_iter()
        .flatten()
    {
        if !seen.contains(pointer.as_str()) {
            return Err(MigrationError::UnknownPointer(pointer.clone()));
        }
    }

    let mut quarantined: Vec<QuarantinedModel> = legacy
        .models
        .into_iter()
        .map(|model| QuarantinedModel {
            was_active: legacy.active_model_id.as_deref() == Some(model.id.as_str()),
            was_previous: legacy.previous_active_model_id.as_deref() == Some(model.id.as_str()),
            diagnostic: format!(
                "'{}' is a three-class pinch model. Per-label models are binary, so it cannot be one of them. Its \
                 record and its files are kept untouched. To replace it, train a binary model for each of \
                 pinch_start and pinch_release.",
                model.id
            ),
            reason: QuarantineReason::ThreeClassModel,
            legacy: LegacyModelSummary {
                state: model.state,
                created_at: model.created_at,
                thresholds: model.thresholds,
                quality_gate: model.quality_gate,
                history: model.history,
                intent_bindings: model.intent_bindings,
                imported_tflite_bundle: model.imported_tflite_bundle,
            },
            id: model.id,
        })
        .collect();
    quarantined.sort_by(|a, b| a.id.cmp(&b.id));

    let report = MigrationReport {
        legacy_models: quarantined.len(),
        migrated: 0,
        quarantined: quarantined.len(),
        inference_mode: legacy.inference_mode,
    };
    let registry = Registry {
        inference_mode: legacy.inference_mode,
        quarantined,
        ..Registry::default()
    };
    Ok((registry, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: &str = r#"{
        "models": [
            {"id": "model-b", "state": "approved", "thresholds": {"startThreshold": 0.8, "releaseThreshold": 0.7},
             "qualityGate": {"maxContactQuality": 0.0, "minSampleCount": 3}, "createdAt": "2026-09-01T00:00:00Z",
             "history": [{"from": null, "to": "draft", "at": "2026-09-01T00:00:00Z"}],
             "intentBindings": [{"classLabel": "pinch_start", "intent": "volumeGrab"}], "importedTfliteBundle": false},
            {"id": "model-a", "state": "active", "thresholds": {"startThreshold": 0.9, "releaseThreshold": 0.9},
             "qualityGate": {"maxContactQuality": 0.0, "minSampleCount": 3}, "createdAt": "2026-08-01T00:00:00Z",
             "history": [], "importedTfliteBundle": true}
        ],
        "activeModelId": "model-a",
        "previousActiveModelId": "model-b",
        "inferenceMode": "live",
        "someFutureField": 1
    }"#;

    #[test]
    fn every_old_model_is_kept_whole_with_what_it_was_and_a_clear_next_step() {
        let (registry, report) = migrate_legacy_registry(LEGACY).unwrap();
        assert_eq!(
            (report.legacy_models, report.migrated, report.quarantined),
            (2, 0, 2)
        );
        // Ordered by id, whatever the old order was.
        let ids: Vec<_> = registry.quarantined.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(ids, ["model-a", "model-b"]);
        let a = &registry.quarantined[0];
        assert!(a.was_active && !a.was_previous && a.legacy.imported_tflite_bundle);
        assert_eq!(a.legacy.state, "active");
        let b = &registry.quarantined[1];
        assert!(!b.was_active && b.was_previous);
        assert_eq!(b.legacy.thresholds["releaseThreshold"], 0.7);
        assert_eq!(b.legacy.intent_bindings.len(), 1);
        assert_eq!(b.legacy.history.len(), 1);
        assert!(b.diagnostic.contains("pinch_start") && b.diagnostic.contains("untouched"));
        // The new registry is valid and has nothing active, so nothing runs until a binary model is approved.
        registry.validate().unwrap();
        assert!(registry.active_by_label.is_empty() && registry.versions.is_empty());
    }

    #[test]
    fn the_inference_mode_is_carried_over_and_a_remembered_live_still_restarts_as_monitor() {
        let (registry, report) = migrate_legacy_registry(LEGACY).unwrap();
        assert_eq!(report.inference_mode, InferenceMode::Live);
        assert_eq!(registry.inference_mode, InferenceMode::Live);
        assert_eq!(registry.mode_at_startup(), InferenceMode::Monitor);
    }

    #[test]
    fn migration_is_deterministic() {
        let first = migrate_legacy_registry(LEGACY).unwrap();
        let second = migrate_legacy_registry(LEGACY).unwrap();
        assert_eq!(first.0, second.0);
        assert_eq!(
            serde_json::to_string(&first.0).unwrap(),
            serde_json::to_string(&second.0).unwrap()
        );
    }

    #[test]
    fn an_empty_old_registry_migrates_to_an_empty_one() {
        let (registry, report) = migrate_legacy_registry(r#"{"models": []}"#).unwrap();
        assert_eq!(report.legacy_models, 0);
        assert!(registry.quarantined.is_empty());
        assert_eq!(registry.inference_mode, InferenceMode::Off);
    }

    #[test]
    fn a_corrupt_or_inconsistent_old_registry_fails_closed() {
        assert!(matches!(
            migrate_legacy_registry("{ not json"),
            Err(MigrationError::Unreadable(_))
        ));
        assert!(matches!(
            migrate_legacy_registry(""),
            Err(MigrationError::Unreadable(_))
        ));
        let duplicate = r#"{"models":[{"id":"m","state":"draft"},{"id":"m","state":"draft"}]}"#;
        assert_eq!(
            migrate_legacy_registry(duplicate).unwrap_err(),
            MigrationError::DuplicateId("m".into())
        );
        let dangling = r#"{"models":[{"id":"m","state":"draft"}],"activeModelId":"ghost"}"#;
        assert_eq!(
            migrate_legacy_registry(dangling).unwrap_err(),
            MigrationError::UnknownPointer("ghost".into())
        );
        let bad_mode = r#"{"models":[],"inferenceMode":"turbo"}"#;
        assert!(matches!(
            migrate_legacy_registry(bad_mode),
            Err(MigrationError::Unreadable(_))
        ));
    }
}
