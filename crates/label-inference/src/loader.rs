//! Loads the models the registry says are active.
//!
//! Only labels with an active slot are loaded, each from its version's own directory, and each through the full bundle
//! validation. A model that cannot be loaded (a missing or altered file, an unsafe path) is reported by name and that
//! label simply has no model: it never falls back to anything else.

use std::path::{Component, Path, PathBuf};

use model_lab_core::{LabelId, ModelVersionId, Registry};

use crate::bundle::validate_bundle;
use crate::model::LoadedModel;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelLoadFailure {
    pub label: LabelId,
    pub version: ModelVersionId,
    pub detail: String,
}

/// `dir` joined under `root`, if it is a plain relative path with no `..`, root or prefix parts.
fn contained(root: &Path, dir: &str) -> Option<PathBuf> {
    let relative = Path::new(dir);
    let plain = !dir.is_empty()
        && relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    plain.then(|| root.join(relative))
}

pub fn load_active_models(
    registry: &Registry,
    model_lab_dir: &Path,
) -> (Vec<LoadedModel>, Vec<ModelLoadFailure>) {
    let mut loaded = Vec::new();
    let mut failures = Vec::new();
    for (label, version_id) in &registry.active_by_label {
        let fail = |detail: String| ModelLoadFailure {
            label: label.clone(),
            version: version_id.clone(),
            detail,
        };
        let Some(version) = registry.versions.get(version_id) else {
            failures.push(fail(
                "the registry's active slot points at a model that does not exist".into(),
            ));
            continue;
        };
        let Some(dir) = contained(model_lab_dir, &version.artifact_dir) else {
            failures.push(fail(format!(
                "the model directory '{}' is not a safe relative path",
                version.artifact_dir
            )));
            continue;
        };
        let result = validate_bundle(&dir, Some(label))
            .map_err(|e| e.to_string())
            .and_then(|bundle| LoadedModel::load(bundle, version).map_err(|e| e.to_string()));
        match result {
            Ok(model) => loaded.push(model),
            Err(detail) => failures.push(fail(detail)),
        }
    }
    (loaded, failures)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;

    use model_lab_core::{
        DatasetSnapshot, ExampleRole, InputContract, LabelMapping, LabelProject, LifecycleState,
        ModelOrigin, ModelVersion, ProjectId, QualityRules, RecordingId, RecordingRef,
        SnapshotDraft, SnapshotId, Split, Thresholds, TrainerBackend, TrainerConfig,
    };

    use super::*;
    use crate::bundle::tests::fixture_dir;

    const T: &str = "2026-10-04T00:00:00Z";

    fn label(id: &str) -> LabelId {
        LabelId::new(id).unwrap()
    }

    /// A registry with one project for the fixture's label and its model approved and active, as the model
    /// directory `models/shake-v1`.
    fn registry_with_active_fixture() -> (Registry, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let model_dir = root.path().join("models/shake-v1");
        fs::create_dir_all(&model_dir).unwrap();
        for file in ["manifest.json", "model.onnx"] {
            fs::copy(fixture_dir().join(file), model_dir.join(file)).unwrap();
        }
        let bundle = validate_bundle(&model_dir, None).unwrap();
        let contract: InputContract = bundle.manifest.input_contract();

        let mut registry = Registry::default();
        let target = label("shake_fixture");
        let project_id = ProjectId::new("p-shake").unwrap();
        registry
            .create_project(LabelProject {
                id: project_id.clone(),
                name: "shake fixture".into(),
                target: target.clone(),
                sessions: vec![],
                mapping: LabelMapping {
                    entries: [
                        (target.clone(), ExampleRole::Positive),
                        (label("idle"), ExampleRole::Negative),
                    ]
                    .into(),
                },
                input: contract.clone(),
                quality: QualityRules::default(),
                trainer: TrainerConfig {
                    backend: TrainerBackend::ExternalImport,
                    params: BTreeMap::new(),
                },
                thresholds: Thresholds::default(),
                created_at: T.into(),
                updated_at: T.into(),
            })
            .unwrap();
        let sha = |n: u8| model_lab_core_sha(&[n]);
        let known: BTreeSet<LabelId> = [target.clone(), label("idle")].into();
        let store: BTreeMap<RecordingId, String> = [("r1", 1u8), ("r2", 2u8)]
            .iter()
            .map(|(id, n)| (RecordingId::new(*id).unwrap(), sha(*n)))
            .collect();
        let snapshot = DatasetSnapshot::seal(
            SnapshotDraft {
                id: SnapshotId::new("s1").unwrap(),
                project_id: project_id.clone(),
                target: target.clone(),
                mapping: registry.projects[&project_id].mapping.clone(),
                input: contract.clone(),
                quality: QualityRules::default(),
                recordings: vec![
                    RecordingRef {
                        id: RecordingId::new("r1").unwrap(),
                        sha256: sha(1),
                    },
                    RecordingRef {
                        id: RecordingId::new("r2").unwrap(),
                        sha256: sha(2),
                    },
                ],
                split: Split {
                    train: vec![RecordingId::new("r1").unwrap()],
                    evaluation: vec![RecordingId::new("r2").unwrap()],
                },
                created_at: T.into(),
            },
            &known,
            &store,
            &known,
        )
        .unwrap();
        registry.add_snapshot(snapshot).unwrap();
        let version = ModelVersion::new(
            ModelVersionId::new("shake-v1").unwrap(),
            project_id,
            target,
            ModelOrigin::Imported,
            true,
            Some(bundle.model_sha256.clone()),
            "models/shake-v1".into(),
            contract,
            bundle.manifest.threshold_config(),
            bundle.manifest.quality,
            T,
        )
        .unwrap();
        let id = version.id.clone();
        registry.register_version(version).unwrap();
        registry
            .transition(&id, LifecycleState::Evaluated, T)
            .unwrap();
        registry
            .transition(&id, LifecycleState::Approved, T)
            .unwrap();
        registry.activate(&id, T).unwrap();
        registry.validate().unwrap();
        (registry, root)
    }

    fn model_lab_core_sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn the_active_model_is_loaded_from_its_directory_through_full_validation() {
        let (registry, root) = registry_with_active_fixture();
        let (models, failures) = load_active_models(&registry, root.path());
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label.as_str(), "shake_fixture");
        assert_eq!(models[0].version_id.as_str(), "shake-v1");
    }

    #[test]
    fn a_registry_with_nothing_active_loads_nothing() {
        let (mut registry, root) = registry_with_active_fixture();
        registry.deactivate(&label("shake_fixture"), T).unwrap();
        let (models, failures) = load_active_models(&registry, root.path());
        assert!(models.is_empty() && failures.is_empty());
    }

    #[test]
    fn an_altered_or_missing_model_is_reported_by_name_and_that_label_gets_no_model() {
        let (registry, root) = registry_with_active_fixture();
        // Alter the model file after it was approved.
        let model = root.path().join("models/shake-v1/model.onnx");
        let mut bytes = fs::read(&model).unwrap();
        bytes[5] ^= 0xff;
        fs::write(&model, bytes).unwrap();
        let (models, failures) = load_active_models(&registry, root.path());
        assert!(models.is_empty());
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].version.as_str(), "shake-v1");
        assert!(
            failures[0].detail.contains("changed"),
            "{}",
            failures[0].detail
        );

        fs::remove_dir_all(root.path().join("models/shake-v1")).unwrap();
        let (models, failures) = load_active_models(&registry, root.path());
        assert!(models.is_empty() && failures.len() == 1);
    }

    #[test]
    fn an_unsafe_artifact_directory_is_refused() {
        for bad in ["../outside", "/etc", "a/../../b", ""] {
            let (mut registry, root) = registry_with_active_fixture();
            registry
                .versions
                .get_mut(&ModelVersionId::new("shake-v1").unwrap())
                .unwrap()
                .artifact_dir = bad.into();
            let (models, failures) = load_active_models(&registry, root.path());
            assert!(models.is_empty(), "{bad}");
            assert!(
                failures[0].detail.contains("safe relative path"),
                "{bad}: {}",
                failures[0].detail
            );
        }
    }

    #[test]
    fn loaded_models_run_end_to_end_from_the_registry() {
        use crate::pipeline::tests::orientation;
        use crate::runtime::{LabelRuntime, RuntimeMode};

        let (registry, root) = registry_with_active_fixture();
        let (models, _) = load_active_models(&registry, root.path());
        let mut runtime = LabelRuntime::default();
        runtime.set_models(models);
        runtime.set_mode(RuntimeMode::Live);
        let rose = (0..80u64).any(|n| {
            runtime
                .observe_orientation(&orientation(n, 5.0), n * 20_000_000)
                .actionable
                .iter()
                .any(|e| matches!(e, crate::DetectionEvent::Rising { .. }))
        });
        assert!(
            rose,
            "a registry-approved model detects shaking in live mode"
        );
    }
}
