//! Brings an external model bundle into the registry as a **Draft**.
//!
//! Import is two phases so the slow part never holds the registry:
//!
//! 1. [`stage_bundle`] copies only the two files a bundle may have (its manifest and the one model file the manifest
//!    names) into a private staging directory, refusing symlinks and oversized files, then runs the full bundle
//!    validation **on the staged copy**. What is validated is exactly what will be stored.
//! 2. [`publish_staged`] (with the registry in hand) refuses a duplicate, moves the staged directory into place with a
//!    single rename, and records a Draft version, creating the label's project if it has none. If saving the registry
//!    fails the moved directory is removed again, so disk and registry agree.
//!
//! Nothing here approves or activates anything: an imported model is a Draft until a person moves it forward. Files
//! other than the manifest and the model are never copied.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use model_lab_core::{
    ExampleRole, LabelId, LabelMapping, LabelProject, ModelOrigin, ModelVersion, ModelVersionId,
    Persist, ProjectId, RegistryError, RegistryStore, StoreError, TrainerBackend, TrainerConfig,
};
use thiserror::Error;

use crate::bundle::{
    BundleError, MANIFEST_FILE, MAX_MANIFEST_BYTES, MAX_MODEL_BYTES, Manifest, validate_bundle,
};

pub const STAGING_DIR: &str = "staging";
pub const IMPORTED_MODELS_DIR: &str = "label-models";

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("{0} is not a folder")]
    NotAFolder(String),
    #[error(
        "{0} is a link or shortcut. Choose the real file or folder: a link could point anywhere"
    )]
    Link(String),
    #[error("the bundle has no {0}")]
    MissingFile(String),
    #[error("{what} is too large ({actual} bytes; the limit is {limit})")]
    TooLarge {
        what: &'static str,
        actual: u64,
        limit: u64,
    },
    #[error("the manifest names an unsafe model file '{0}'")]
    UnsafeModelName(String),
    #[error("the manifest could not be read: {0}")]
    BadManifest(String),
    #[error(transparent)]
    Bundle(#[from] BundleError),
    #[error(
        "this exact model file was already imported for '{label}' as {existing}. Nothing was changed"
    )]
    Duplicate { label: LabelId, existing: String },
    #[error("could not copy the bundle: {0}")]
    Io(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Id(#[from] model_lab_core::IdError),
    #[error(transparent)]
    Version(#[from] model_lab_core::VersionError),
}

/// A copy of a bundle that has passed validation, waiting to be published. Dropping it deletes the copy.
#[derive(Debug)]
pub struct StagedBundle {
    dir: PathBuf,
    pub manifest: Manifest,
    pub model_sha256: String,
    published: bool,
}

impl StagedBundle {
    pub fn label(&self) -> &LabelId {
        &self.manifest.target_label
    }
}

impl Drop for StagedBundle {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOutcome {
    pub version_id: ModelVersionId,
    pub label: LabelId,
    pub model_sha256: String,
    /// True when the label had no project and one was created for it.
    pub project_created: bool,
}

static STAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        STAGE_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Deletes anything a crash left in staging. Call at startup. Published models are never touched.
pub fn clean_staging(model_lab_dir: &Path) {
    let _ = fs::remove_dir_all(model_lab_dir.join(STAGING_DIR));
}

/// A regular file (not a link) no larger than `limit`, read whole.
fn read_plain_file(path: &Path, what: &'static str, limit: u64) -> Result<Vec<u8>, ImportError> {
    let shown = path.display().to_string();
    let meta = fs::symlink_metadata(path).map_err(|_| ImportError::MissingFile(shown.clone()))?;
    if meta.file_type().is_symlink() {
        return Err(ImportError::Link(shown));
    }
    if !meta.is_file() {
        return Err(ImportError::MissingFile(shown));
    }
    if meta.len() > limit {
        return Err(ImportError::TooLarge {
            what,
            actual: meta.len(),
            limit,
        });
    }
    fs::read(path).map_err(|e| ImportError::Io(format!("{shown}: {e}")))
}

/// Copies the bundle at `source` into staging under `model_lab_dir` and validates the copy.
pub fn stage_bundle(source: &Path, model_lab_dir: &Path) -> Result<StagedBundle, ImportError> {
    let shown = source.display().to_string();
    let meta = fs::symlink_metadata(source).map_err(|_| ImportError::NotAFolder(shown.clone()))?;
    if meta.file_type().is_symlink() {
        return Err(ImportError::Link(shown));
    }
    if !meta.is_dir() {
        return Err(ImportError::NotAFolder(shown));
    }
    let manifest_bytes = read_plain_file(
        &source.join(MANIFEST_FILE),
        "the manifest",
        MAX_MANIFEST_BYTES,
    )?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| ImportError::BadManifest(e.to_string()))?;
    let name = &manifest.model.file;
    if name.is_empty()
        || name.contains(['/', '\\', '\0'])
        || name == "."
        || name == ".."
        || name.starts_with('.')
    {
        return Err(ImportError::UnsafeModelName(name.clone()));
    }
    let model_bytes = read_plain_file(&source.join(name), "the model", MAX_MODEL_BYTES)?;

    let staging_root = model_lab_dir.join(STAGING_DIR);
    let dir = staging_root.join(unique_name());
    let io = |e: std::io::Error| ImportError::Io(e.to_string());
    fs::create_dir_all(&dir).map_err(io)?;
    // From here the guard owns the directory and removes it on any early return.
    let mut guard = StagedBundle {
        dir: dir.clone(),
        manifest: manifest.clone(),
        model_sha256: String::new(),
        published: false,
    };
    fs::write(dir.join(MANIFEST_FILE), &manifest_bytes).map_err(io)?;
    fs::write(dir.join(name), &model_bytes).map_err(io)?;
    let validated = validate_bundle(&dir, None)?;
    guard.model_sha256 = validated.model_sha256;
    Ok(guard)
}

fn short(hash: &str) -> &str {
    &hash[..12.min(hash.len())]
}

/// Records the staged bundle as an imported Draft model and moves its files into place.
pub fn publish_staged<P: Persist>(
    staged: StagedBundle,
    model_lab_dir: &Path,
    store: &mut RegistryStore<P>,
    now: &str,
) -> Result<ImportOutcome, ImportError> {
    publish_staged_with(
        staged,
        model_lab_dir,
        store,
        now,
        ModelOrigin::Imported,
        |_| Ok(()),
    )
}

/// As [`publish_staged`], for a model that came from somewhere else: `origin` says where, and `with_version` makes any
/// further registry change in the same saved step as the new Draft (a training run being marked finished, say), so the
/// run and the model it produced are recorded together or not at all.
pub fn publish_staged_with<P: Persist>(
    mut staged: StagedBundle,
    model_lab_dir: &Path,
    store: &mut RegistryStore<P>,
    now: &str,
    origin: ModelOrigin,
    with_version: impl FnOnce(&mut model_lab_core::Registry) -> Result<(), RegistryError>,
) -> Result<ImportOutcome, ImportError> {
    let label = staged.manifest.target_label.clone();
    let sha = staged.model_sha256.clone();
    let version_id = ModelVersionId::new(format!("{label}-{}", short(&sha)))?;

    if let Some(existing) = store
        .registry()
        .versions
        .values()
        .find(|v| v.label == label && v.model_sha256.as_deref() == Some(sha.as_str()))
    {
        return Err(ImportError::Duplicate {
            label,
            existing: existing.id.to_string(),
        });
    }

    let relative = format!("{IMPORTED_MODELS_DIR}/{version_id}");
    let final_dir = model_lab_dir.join(&relative);
    if final_dir.exists() {
        // Leftovers from an earlier crash: the registry does not know this directory, so it is not trusted.
        return Err(ImportError::Io(format!(
            "{} already exists but is not in the registry; move it aside and import again",
            final_dir.display()
        )));
    }
    if let Some(parent) = final_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| ImportError::Io(e.to_string()))?;
    }

    let contract = staged.manifest.input_contract();
    let version = ModelVersion::new(
        version_id.clone(),
        ProjectId::new(format!("import-{label}"))?,
        label.clone(),
        origin,
        true,
        Some(sha.clone()),
        relative,
        contract.clone(),
        staged.manifest.threshold_config(),
        staged.manifest.quality,
        now,
    )?;

    // The project the version belongs to: the label's own if it has one, else a minimal one for imported models.
    let existing_project = store
        .registry()
        .projects
        .values()
        .find(|p| p.target == label)
        .map(|p| p.id.clone());
    let project_created = existing_project.is_none();
    let project_id = existing_project.unwrap_or_else(|| version.project_id.clone());
    let version = ModelVersion {
        project_id: project_id.clone(),
        ..version
    };

    // Move the files first: a crash after this leaves an unreferenced directory (reported on the next import
    // of the same bytes), never a registry entry without files.
    fs::rename(&staged.dir, &final_dir).map_err(|e| ImportError::Io(e.to_string()))?;
    staged.published = true;

    let manifest = &staged.manifest;
    let saved = store.mutate(|registry| {
        if project_created {
            registry.create_project(LabelProject {
                id: project_id.clone(),
                name: format!("{label} (imported)"),
                target: label.clone(),
                sessions: Vec::new(),
                mapping: LabelMapping {
                    entries: [(label.clone(), ExampleRole::Positive)].into(),
                },
                input: contract.clone(),
                quality: manifest.quality,
                trainer: TrainerConfig {
                    backend: TrainerBackend::ExternalImport,
                    params: Default::default(),
                },
                thresholds: manifest.threshold_config(),
                created_at: now.to_string(),
                updated_at: now.to_string(),
            })?;
        }
        with_version(registry)?;
        registry.register_version(version.clone())
    });
    if let Err(error) = saved {
        // The registry did not take it, so the files must not stay behind.
        let _ = fs::remove_dir_all(&final_dir);
        return Err(error.into());
    }
    Ok(ImportOutcome {
        version_id,
        label,
        model_sha256: sha,
        project_created,
    })
}

/// Both phases together, for callers that do not need to keep the registry free during staging.
pub fn import_bundle<P: Persist>(
    source: &Path,
    model_lab_dir: &Path,
    store: &mut RegistryStore<P>,
    now: &str,
) -> Result<ImportOutcome, ImportError> {
    let staged = stage_bundle(source, model_lab_dir)?;
    publish_staged(staged, model_lab_dir, store, now)
}

impl From<RegistryError> for ImportError {
    fn from(error: RegistryError) -> Self {
        Self::Store(StoreError::Registry(error))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use model_lab_core::{LifecycleState, Registry};

    use super::*;
    use crate::bundle::tests::copy_fixture;
    use crate::load_active_models;

    const NOW: &str = "2026-10-05T00:00:00Z";

    #[derive(Default)]
    struct Memory;
    impl Persist for Memory {
        fn save(&mut self, _: &Registry) -> Result<(), StoreError> {
            Ok(())
        }
    }

    struct Failing(Rc<Cell<u32>>);
    impl Persist for Failing {
        fn save(&mut self, _: &Registry) -> Result<(), StoreError> {
            self.0.set(self.0.get() + 1);
            Err(StoreError::Io("disk full".into()))
        }
    }

    fn store() -> RegistryStore<Memory> {
        RegistryStore::new(Registry::default(), Memory).unwrap()
    }

    fn staging_is_empty(lab: &Path) -> bool {
        fs::read_dir(lab.join(STAGING_DIR)).map_or(true, |mut d| d.next().is_none())
    }

    #[test]
    fn a_valid_bundle_becomes_a_draft_with_a_project_and_its_files_in_place() {
        let source = copy_fixture();
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let outcome = import_bundle(source.path(), lab.path(), &mut store, NOW).unwrap();
        assert!(outcome.project_created);
        let registry = store.registry();
        let version = &registry.versions[&outcome.version_id];
        assert_eq!(version.state, LifecycleState::Draft);
        assert_eq!(version.origin, ModelOrigin::Imported);
        assert!(version.deployable);
        assert_eq!(
            version.model_sha256.as_deref(),
            Some(outcome.model_sha256.as_str())
        );
        assert_eq!(registry.projects.len(), 1);
        assert!(registry.active_by_label.is_empty());
        let dir = lab.path().join(&version.artifact_dir);
        assert!(dir.join("manifest.json").is_file() && dir.join("model.onnx").is_file());
        assert!(staging_is_empty(lab.path()));
    }

    #[test]
    fn the_imported_draft_runs_only_after_a_person_approves_and_activates_it() {
        let source = copy_fixture();
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let outcome = import_bundle(source.path(), lab.path(), &mut store, NOW).unwrap();
        let (models, failures) = load_active_models(store.registry(), lab.path());
        assert!(
            (models.len(), failures.len()) == (0, 0),
            "a draft must not load"
        );
        let id = outcome.version_id.clone();
        store
            .mutate(|r| {
                r.transition(&id, LifecycleState::Evaluated, NOW)?;
                r.transition(&id, LifecycleState::Approved, NOW)?;
                r.activate(&id, NOW).map(|_| ())
            })
            .unwrap();
        let (models, failures) = load_active_models(store.registry(), lab.path());
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label, outcome.label);
    }

    #[test]
    fn only_the_manifest_and_the_model_are_copied() {
        let source = copy_fixture();
        fs::write(source.path().join("run_me.sh"), "echo hi").unwrap();
        fs::create_dir(source.path().join("nested")).unwrap();
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let outcome = import_bundle(source.path(), lab.path(), &mut store, NOW).unwrap();
        let dir = lab
            .path()
            .join(&store.registry().versions[&outcome.version_id].artifact_dir);
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["manifest.json", "model.onnx"]);
    }

    #[test]
    fn importing_the_same_model_twice_is_refused_and_changes_nothing() {
        let source = copy_fixture();
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        import_bundle(source.path(), lab.path(), &mut store, NOW).unwrap();
        let before = store.registry().clone();
        let again = import_bundle(source.path(), lab.path(), &mut store, NOW);
        assert!(
            matches!(again, Err(ImportError::Duplicate { .. })),
            "{again:?}"
        );
        assert_eq!(*store.registry(), before);
        assert!(staging_is_empty(lab.path()));
    }

    #[test]
    fn a_tampered_or_invalid_bundle_is_refused_and_leaves_no_trace() {
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let source = copy_fixture();
        let mut bytes = fs::read(source.path().join("model.onnx")).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(source.path().join("model.onnx"), bytes).unwrap();
        let result = import_bundle(source.path(), lab.path(), &mut store, NOW);
        assert!(matches!(result, Err(ImportError::Bundle(_))), "{result:?}");
        assert!(store.registry().versions.is_empty() && store.registry().projects.is_empty());
        assert!(staging_is_empty(lab.path()));
        assert!(!lab.path().join(IMPORTED_MODELS_DIR).exists());

        let missing = tempfile::tempdir().unwrap();
        assert!(matches!(
            import_bundle(missing.path(), lab.path(), &mut store, NOW),
            Err(ImportError::MissingFile(_))
        ));
        let file = source.path().join("model.onnx");
        assert!(matches!(
            import_bundle(&file, lab.path(), &mut store, NOW),
            Err(ImportError::NotAFolder(_))
        ));
    }

    #[test]
    fn a_manifest_naming_a_path_outside_the_bundle_is_refused_before_anything_is_copied() {
        let source = copy_fixture();
        let path = source.path().join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["model"]["file"] = "../../etc/passwd".into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let lab = tempfile::tempdir().unwrap();
        let result = stage_bundle(source.path(), lab.path());
        assert!(
            matches!(result, Err(ImportError::UnsafeModelName(_))),
            "{result:?}"
        );
        assert!(!lab.path().join(STAGING_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_model_file_or_folder_is_refused() {
        let source = copy_fixture();
        let real = source.path().join("model.onnx");
        let hidden = source.path().join("real.bin");
        fs::rename(&real, &hidden).unwrap();
        std::os::unix::fs::symlink(&hidden, &real).unwrap();
        let lab = tempfile::tempdir().unwrap();
        assert!(matches!(
            stage_bundle(source.path(), lab.path()),
            Err(ImportError::Link(_))
        ));
        let folder_link = lab.path().join("link");
        std::os::unix::fs::symlink(source.path(), &folder_link).unwrap();
        assert!(matches!(
            stage_bundle(&folder_link, lab.path()),
            Err(ImportError::Link(_))
        ));
    }

    #[test]
    fn a_failed_registry_save_removes_the_published_files_and_changes_nothing() {
        let source = copy_fixture();
        let lab = tempfile::tempdir().unwrap();
        let saves = Rc::new(Cell::new(0));
        let mut store = RegistryStore::new(Registry::default(), Failing(saves.clone())).unwrap();
        let result = import_bundle(source.path(), lab.path(), &mut store, NOW);
        assert!(matches!(result, Err(ImportError::Store(_))), "{result:?}");
        assert_eq!(saves.get(), 1);
        assert!(store.registry().versions.is_empty());
        let published = lab.path().join(IMPORTED_MODELS_DIR);
        assert!(fs::read_dir(published).map_or(true, |mut d| d.next().is_none()));
        assert!(staging_is_empty(lab.path()));
    }

    #[test]
    fn a_label_that_already_has_a_project_keeps_it() {
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let first = copy_fixture();
        let first = import_bundle(first.path(), lab.path(), &mut store, NOW).unwrap();
        // Forget the version but keep the project, then import the same bytes again.
        let id = first.version_id.clone();
        store
            .mutate(|r| {
                r.versions.remove(&id);
                Ok(())
            })
            .unwrap();
        fs::remove_dir_all(lab.path().join(IMPORTED_MODELS_DIR)).unwrap();
        let source = copy_fixture();
        let second = import_bundle(source.path(), lab.path(), &mut store, NOW).unwrap();
        assert!(!second.project_created);
        assert_eq!(store.registry().projects.len(), 1);
    }

    #[test]
    fn leftover_staging_is_cleaned_but_published_models_are_not() {
        let source = copy_fixture();
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let outcome = import_bundle(source.path(), lab.path(), &mut store, NOW).unwrap();
        fs::create_dir_all(lab.path().join(STAGING_DIR).join("crashed")).unwrap();
        clean_staging(lab.path());
        assert!(!lab.path().join(STAGING_DIR).exists());
        let dir = &store.registry().versions[&outcome.version_id].artifact_dir;
        assert!(lab.path().join(dir).join("model.onnx").is_file());
    }

    #[test]
    fn a_draft_can_be_checked_before_it_is_activated_and_an_altered_one_cannot() {
        let source = copy_fixture();
        let lab = tempfile::tempdir().unwrap();
        let mut store = store();
        let outcome = import_bundle(source.path(), lab.path(), &mut store, NOW).unwrap();
        let version = store.registry().versions[&outcome.version_id].clone();
        assert_eq!(crate::check_loadable(&version, lab.path()), Ok(()));
        let model = lab.path().join(&version.artifact_dir).join("model.onnx");
        let mut bytes = fs::read(&model).unwrap();
        bytes[0] ^= 0xff;
        fs::write(&model, bytes).unwrap();
        assert!(crate::check_loadable(&version, lab.path()).is_err());
    }
}
