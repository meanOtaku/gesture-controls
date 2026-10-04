use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::migrate::{MigrationError, MigrationReport, migrate_legacy_registry};
use crate::registry::{REGISTRY_SCHEMA_VERSION, Registry, RegistryError};

const REGISTRY_FILE: &str = "registry-v2.json";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("could not read or write the model registry: {0}")]
    Io(String),
    #[error(
        "the model registry {path} is corrupt ({detail}). It was left untouched. Restore it from a backup, or move it aside to start with an empty registry"
    )]
    Corrupt { path: String, detail: String },
    #[error(transparent)]
    Registry(#[from] RegistryError),
    #[error(transparent)]
    Migration(#[from] MigrationError),
}

/// Where a registry is saved. A save either happens completely or returns an error.
pub trait Persist {
    fn save(&mut self, registry: &Registry) -> Result<(), StoreError>;
}

/// The registry plus where it lives. Changes go through [`Self::mutate`]: the change is made on a copy, checked,
/// saved, and only then adopted, so a failed save never leaves memory and disk disagreeing.
pub struct RegistryStore<P: Persist> {
    registry: Registry,
    persist: P,
}

impl<P: Persist> RegistryStore<P> {
    pub fn new(registry: Registry, persist: P) -> Result<Self, StoreError> {
        registry.validate()?;
        Ok(Self { registry, persist })
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    pub fn mutate<T>(
        &mut self,
        change: impl FnOnce(&mut Registry) -> Result<T, RegistryError>,
    ) -> Result<T, StoreError> {
        let mut working = self.registry.clone();
        let outcome = change(&mut working)?;
        working.validate()?;
        self.persist.save(&working)?;
        self.registry = working;
        Ok(outcome)
    }
}

/// Saves to a file: written beside it, flushed, then renamed over it, so a crash leaves the old file or the new one.
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl Persist for FileStore {
    fn save(&mut self, registry: &Registry) -> Result<(), StoreError> {
        let io = |e: std::io::Error| StoreError::Io(format!("{}: {e}", self.path.display()));
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(io)?;
        }
        let json =
            serde_json::to_vec_pretty(registry).map_err(|e| StoreError::Io(e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        let mut file = fs::File::create(&tmp).map_err(io)?;
        file.write_all(&json).map_err(io)?;
        file.sync_all().map_err(io)?;
        fs::rename(&tmp, &self.path).map_err(io)
    }
}

/// Reads a registry file. A file that is not there is `None` (a fresh install); one that is there but cannot be read,
/// parsed or validated is an error and is never replaced by an empty registry.
pub fn load_registry_file(path: &Path) -> Result<Option<Registry>, StoreError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(StoreError::Io(format!("{}: {e}", path.display()))),
    };
    let corrupt = |detail: String| StoreError::Corrupt {
        path: path.display().to_string(),
        detail,
    };
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| corrupt(e.to_string()))?;
    match value.get("schemaVersion").and_then(|v| v.as_u64()) {
        Some(v) if v == u64::from(REGISTRY_SCHEMA_VERSION) => {}
        other => {
            return Err(corrupt(format!(
                "schema version {other:?}, expected {REGISTRY_SCHEMA_VERSION}"
            )));
        }
    }
    let registry: Registry = serde_json::from_value(value).map_err(|e| corrupt(e.to_string()))?;
    registry.validate().map_err(|e| corrupt(e.to_string()))?;
    Ok(Some(registry))
}

/// Opens the registry in `dir`. If it does not exist yet but an old single-model registry does, that is migrated,
/// the result is saved, and the old file is left exactly as it was. A fresh install starts empty (nothing is written
/// until the first change).
pub fn open_registry(
    dir: &Path,
    legacy_registry: Option<&Path>,
) -> Result<(RegistryStore<FileStore>, Option<MigrationReport>), StoreError> {
    let path = dir.join(REGISTRY_FILE);
    if let Some(existing) = load_registry_file(&path)? {
        return Ok((RegistryStore::new(existing, FileStore::new(path))?, None));
    }
    if let Some(legacy) = legacy_registry {
        match fs::read_to_string(legacy) {
            Ok(text) => {
                let (registry, report) = migrate_legacy_registry(&text)?;
                let mut store = FileStore::new(path);
                registry.validate()?;
                store.save(&registry)?;
                return Ok((RegistryStore::new(registry, store)?, Some(report)));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(StoreError::Io(format!("{}: {e}", legacy.display()))),
        }
    }
    Ok((
        RegistryStore::new(Registry::default(), FileStore::new(path))?,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::ModelVersionId;
    use crate::registry::tests::{T, two_label_registry};

    /// A store that fails on demand, to check nothing is half-applied.
    struct Flaky {
        fail: bool,
        saved: Vec<Registry>,
    }

    impl Persist for Flaky {
        fn save(&mut self, registry: &Registry) -> Result<(), StoreError> {
            if self.fail {
                return Err(StoreError::Io("disk full".into()));
            }
            self.saved.push(registry.clone());
            Ok(())
        }
    }

    fn mid(id: &str) -> ModelVersionId {
        ModelVersionId::new(id).unwrap()
    }

    #[test]
    fn a_failed_save_is_reported_and_leaves_the_in_memory_registry_unchanged() {
        let mut store = RegistryStore::new(
            two_label_registry(),
            Flaky {
                fail: true,
                saved: vec![],
            },
        )
        .unwrap();
        let before = store.registry().clone();
        let result = store.mutate(|r| r.activate(&mid("a1"), T));
        assert!(matches!(result, Err(StoreError::Io(_))));
        assert_eq!(
            *store.registry(),
            before,
            "memory must not run ahead of disk"
        );
        assert!(store.registry().active_by_label.is_empty());
    }

    #[test]
    fn a_rejected_change_saves_nothing_and_a_good_one_saves_the_whole_result() {
        let mut store = RegistryStore::new(
            two_label_registry(),
            Flaky {
                fail: false,
                saved: vec![],
            },
        )
        .unwrap();
        // Activating something that is not approved is refused before anything is saved.
        let missing = mid("nope");
        assert!(store.mutate(|r| r.activate(&missing, T)).is_err());
        assert!(store.persist.saved.is_empty());
        store.mutate(|r| r.activate(&mid("a1"), T)).unwrap();
        store.mutate(|r| r.activate(&mid("b1"), T)).unwrap();
        assert_eq!(store.persist.saved.len(), 2);
        assert_eq!(store.persist.saved[1], *store.registry());
        assert_eq!(store.registry().active_by_label.len(), 2);
    }

    #[test]
    fn a_registry_that_breaks_a_rule_cannot_be_adopted() {
        let mut store = RegistryStore::new(
            two_label_registry(),
            Flaky {
                fail: false,
                saved: vec![],
            },
        )
        .unwrap();
        let result = store.mutate(|r| {
            // A change that leaves two models Active for one label.
            r.activate(&mid("a1"), T)?;
            r.versions.get_mut(&mid("a2")).unwrap().state = crate::LifecycleState::Active;
            Ok(())
        });
        assert!(matches!(
            result,
            Err(StoreError::Registry(RegistryError::Corrupt(_)))
        ));
        assert!(store.registry().active_by_label.is_empty());
    }

    #[test]
    fn the_file_store_writes_atomically_and_reads_back_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("registry-v2.json");
        let mut files = FileStore::new(&path);
        let registry = two_label_registry();
        files.save(&registry).unwrap();
        assert!(
            !path.with_extension("json.tmp").exists(),
            "no temporary file is left behind"
        );
        assert_eq!(load_registry_file(&path).unwrap().unwrap(), registry);
    }

    #[test]
    fn a_missing_file_is_a_fresh_install_but_a_corrupt_one_is_an_error_and_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry-v2.json");
        assert!(load_registry_file(&path).unwrap().is_none());

        fs::write(&path, "{ definitely not json").unwrap();
        assert!(matches!(
            load_registry_file(&path),
            Err(StoreError::Corrupt { .. })
        ));
        assert!(matches!(
            open_registry(dir.path(), None),
            Err(StoreError::Corrupt { .. })
        ));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{ definitely not json",
            "the corrupt file is left as it was"
        );

        // A file from an unknown schema is refused rather than guessed at.
        fs::write(&path, r#"{"schemaVersion": 99}"#).unwrap();
        assert!(matches!(
            load_registry_file(&path),
            Err(StoreError::Corrupt { .. })
        ));

        // A well-formed file that breaks a rule is refused too.
        let mut registry = two_label_registry();
        registry
            .active_by_label
            .insert(crate::LabelId::new("pinch_start").unwrap(), mid("ghost"));
        fs::write(&path, serde_json::to_string(&registry).unwrap()).unwrap();
        assert!(matches!(
            load_registry_file(&path),
            Err(StoreError::Corrupt { .. })
        ));
    }

    #[test]
    fn opening_with_an_old_registry_migrates_it_once_saves_the_result_and_leaves_the_old_file_alone()
     {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("registry.json");
        let old = r#"{"models":[{"id":"model-a","state":"active"}],"activeModelId":"model-a","inferenceMode":"monitor"}"#;
        fs::write(&legacy, old).unwrap();

        let (store, report) = open_registry(dir.path(), Some(&legacy)).unwrap();
        let report = report.expect("a migration ran");
        assert_eq!((report.legacy_models, report.quarantined), (1, 1));
        assert_eq!(store.registry().quarantined[0].id, "model-a");
        assert_eq!(
            fs::read_to_string(&legacy).unwrap(),
            old,
            "the old registry is never modified"
        );
        assert!(dir.path().join("registry-v2.json").exists());

        // The second open reads the saved registry and does not migrate again.
        let (again, report) = open_registry(dir.path(), Some(&legacy)).unwrap();
        assert!(report.is_none());
        assert_eq!(again.registry(), store.registry());
    }

    #[test]
    fn opening_with_a_corrupt_old_registry_fails_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("registry.json");
        fs::write(&legacy, "garbage").unwrap();
        assert!(matches!(
            open_registry(dir.path(), Some(&legacy)),
            Err(StoreError::Migration(_))
        ));
        assert!(!dir.path().join("registry-v2.json").exists());
        assert_eq!(fs::read_to_string(&legacy).unwrap(), "garbage");
    }

    #[test]
    fn a_fresh_install_opens_empty_and_writes_nothing_until_the_first_change() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, report) =
            open_registry(dir.path(), Some(&dir.path().join("registry.json"))).unwrap();
        assert!(report.is_none());
        assert!(store.registry().projects.is_empty());
        assert!(!dir.path().join("registry-v2.json").exists());
        store
            .mutate(|r| {
                r.set_inference_mode(crate::InferenceMode::Monitor);
                Ok(())
            })
            .unwrap();
        assert!(dir.path().join("registry-v2.json").exists());
        let (reopened, _) = open_registry(dir.path(), None).unwrap();
        assert_eq!(
            reopened.registry().inference_mode,
            crate::InferenceMode::Monitor
        );
    }
}
