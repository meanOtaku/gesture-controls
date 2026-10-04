//! Persistent Model Lab label catalogue.
//!
//! Labels are immutable ids with editable presentation metadata. Archiving never
//! deletes an entry, so an imported historical recording remains interpretable.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const LABELS_FILE_NAME: &str = "labels.json";
pub const LABEL_REGISTRY_EVENT: &str = "model-lab-labels-changed";

/// Presentation-only classification of a collection label, chosen at creation time to help someone browsing
/// Model Lab understand what a label is *for* (e.g. showing a coverage badge). This is never authoritative
/// for training: it carries no target/negative/exclude semantics and is not read anywhere in the training
/// pipeline. Whether a label is trained as a target, folded into negative, or excluded is decided per
/// training run by an explicit mapping (see `training_label_mapping.rs`), never implied by this role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelRole {
    PositiveGesture,
    NegativeBackground,
    CalibrationOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRecord {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub color: String,
    pub role: LabelRole,
    /// Only read from files written when labels were shipped with the app; never written. See [`prune_legacy_builtins`].
    #[serde(default, skip_serializing)]
    built_in: bool,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLabelInput {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub color: String,
    pub role: LabelRole,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelIndex {
    labels: Vec<LabelRecord>,
}

#[derive(Default)]
pub struct LabelRegistryRuntime {
    lock: Mutex<()>,
}

fn labels_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(crate::model_lab::MODEL_LAB_DIR_NAME)
        .join(LABELS_FILE_NAME))
}

/// The saved labels. A missing or unreadable file is an empty catalogue: labels are the user's own.
fn load_index(app: &AppHandle) -> LabelIndex {
    let Ok(path) = labels_path(app) else {
        return LabelIndex::default();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return LabelIndex::default();
    };
    let Ok(mut index) = serde_json::from_str::<LabelIndex>(&contents) else {
        return LabelIndex::default();
    };
    index.labels.sort_by(|a, b| a.id.cmp(&b.id));
    index
}

/// Labels this app used to ship with are not special any more. Drops the ones nothing refers to and keeps (as
/// ordinary labels) the ones a recording or model still uses. Returns how many were dropped.
fn prune_builtins(index: &mut LabelIndex, in_use: &BTreeSet<String>) -> usize {
    let before = index.labels.len();
    index
        .labels
        .retain(|label| !label.built_in || in_use.contains(&label.id));
    for label in &mut index.labels {
        label.built_in = false;
    }
    before - index.labels.len()
}

fn write_index_atomic(app: &AppHandle, index: &LabelIndex) -> Result<(), String> {
    let path = labels_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "label registry path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_string_pretty(index).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn validate_input(input: &CreateLabelInput) -> Result<(), String> {
    if !matches!(input.id.as_bytes().first(), Some(b'a'..=b'z'))
        || input.id.len() > 48
        || !input
            .id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("label id must be 1-48 lowercase letters, digits, or underscores and begin with a letter".to_string());
    }
    if input.display_name.trim().is_empty() || input.display_name.chars().count() > 80 {
        return Err("display name must be 1-80 characters".to_string());
    }
    if input.description.chars().count() > 500 {
        return Err("description must be at most 500 characters".to_string());
    }
    if input.color.len() != 7
        || !input.color.starts_with('#')
        || !input.color[1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("color must be a #RRGGBB value".to_string());
    }
    Ok(())
}

fn emit(app: &AppHandle, index: &LabelIndex) {
    let _ = app.emit(LABEL_REGISTRY_EVENT, &index.labels);
}

#[tauri::command]
pub fn list_model_labels(
    app: AppHandle,
    runtime: State<'_, LabelRegistryRuntime>,
) -> Result<Vec<LabelRecord>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "label registry lock was poisoned".to_string())?;
    Ok(load_index(&app).labels)
}

#[tauri::command]
pub fn create_model_label(
    input: CreateLabelInput,
    app: AppHandle,
    runtime: State<'_, LabelRegistryRuntime>,
) -> Result<Vec<LabelRecord>, String> {
    validate_input(&input)?;
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "label registry lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    if index.labels.iter().any(|label| label.id == input.id) {
        return Err(format!("label '{}' already exists", input.id));
    }
    index.labels.push(LabelRecord {
        id: input.id,
        display_name: input.display_name.trim().to_string(),
        description: input.description.trim().to_string(),
        color: input.color.to_lowercase(),
        role: input.role,
        built_in: false,
        archived_at: None,
    });
    index.labels.sort_by(|a, b| a.id.cmp(&b.id));
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(index.labels)
}

#[tauri::command]
pub fn set_model_label_archived(
    id: String,
    archived: bool,
    app: AppHandle,
    runtime: State<'_, LabelRegistryRuntime>,
) -> Result<Vec<LabelRecord>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "label registry lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    let label = index
        .labels
        .iter_mut()
        .find(|label| label.id == id)
        .ok_or_else(|| format!("no label with id '{id}'"))?;
    label.archived_at = archived.then(|| Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(index.labels)
}

/// Removes a label nothing uses. A label that a recording, a project or a model refers to cannot be removed (archive
/// it instead): deleting it would leave those without a meaning.
#[tauri::command]
pub fn delete_model_label(
    id: String,
    app: AppHandle,
    runtime: State<'_, LabelRegistryRuntime>,
    labels: State<'_, crate::label_runtime::LabelRuntimeHost>,
) -> Result<Vec<LabelRecord>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "label registry lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    if !index.labels.iter().any(|label| label.id == id) {
        return Err(format!("no label with id '{id}'"));
    }
    let in_use = labels_in_use(&app, &labels).ok_or(
        "the model registry is not available, so it cannot be checked whether this label is used",
    )?;
    if in_use.contains(&id) {
        return Err(format!(
            "'{id}' is used by a recording or a model. Archive it instead; deleting it would leave them without a meaning"
        ));
    }
    index.labels.retain(|label| label.id != id);
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(index.labels)
}

/// Every label a recording, a project or a model refers to; `None` when the model registry cannot be read.
fn labels_in_use(
    app: &AppHandle,
    models: &crate::label_runtime::LabelRuntimeHost,
) -> Option<BTreeSet<String>> {
    let mut used = crate::model_lab::dataset_labels_in_use(app);
    used.extend(models.labels_in_registry()?);
    Some(used)
}

/// Run once at startup, after the model registry is open. See [`prune_builtins`].
pub fn prune_legacy_builtins(app: &AppHandle) {
    let models = app.state::<crate::label_runtime::LabelRuntimeHost>();
    let Some(in_use) = labels_in_use(app, &models) else {
        return;
    };
    let runtime = app.state::<LabelRegistryRuntime>();
    let Ok(_guard) = runtime.lock.lock() else {
        return;
    };
    let Ok(path) = labels_path(app) else { return };
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    let Ok(mut index) = serde_json::from_str::<LabelIndex>(&contents) else {
        return;
    };
    if !index.labels.iter().any(|label| label.built_in) {
        return;
    }
    let removed = prune_builtins(&mut index, &in_use);
    if write_index_atomic(app, &index).is_ok() {
        tracing::info!(
            removed,
            "removed labels this app used to ship with that nothing uses"
        );
    }
}

/// Used by Model Lab import validation. Archived labels remain valid because
/// they describe historical data; only unknown ids are rejected.
pub(crate) fn contains_label(app: &AppHandle, id: &str) -> bool {
    load_index(app).labels.iter().any(|label| label.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_stable_custom_metadata() {
        let input = CreateLabelInput {
            id: "double_tap".to_string(),
            display_name: "Double tap".to_string(),
            description: "User-defined gesture".to_string(),
            color: "#12aBcD".to_string(),
            role: LabelRole::PositiveGesture,
        };
        assert!(validate_input(&input).is_ok());
    }
    #[test]
    fn rejects_unsafe_label_identifiers_and_colors() {
        let mut input = CreateLabelInput {
            id: "Bad id".to_string(),
            display_name: "x".to_string(),
            description: String::new(),
            color: "#000000".to_string(),
            role: LabelRole::NegativeBackground,
        };
        assert!(validate_input(&input).is_err());
        input.id = "safe".to_string();
        input.color = "red".to_string();
        assert!(validate_input(&input).is_err());
    }

    fn record(id: &str, built_in: bool) -> LabelRecord {
        LabelRecord {
            id: id.into(),
            display_name: id.into(),
            description: String::new(),
            color: "#65e6ff".into(),
            role: LabelRole::PositiveGesture,
            built_in,
            archived_at: None,
        }
    }

    #[test]
    fn old_shipped_labels_are_dropped_unless_something_uses_them_and_nobody_elses_are() {
        let mut index = LabelIndex {
            labels: vec![
                record("idle", true),
                record("walking", true),
                record("mine", false),
                record("snap", false),
            ],
        };
        let in_use: BTreeSet<String> = ["walking".to_string()].into();
        assert_eq!(prune_builtins(&mut index, &in_use), 1);
        let ids: Vec<&str> = index.labels.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, ["walking", "mine", "snap"]);
        // What is kept becomes an ordinary label, so a second run changes nothing.
        assert!(index.labels.iter().all(|l| !l.built_in));
        assert_eq!(prune_builtins(&mut index, &BTreeSet::new()), 0);
    }

    #[test]
    fn the_old_flag_is_read_from_a_saved_file_but_never_written() {
        let old = r##"{"labels":[{"id":"idle","displayName":"Idle","description":"","color":"#65e6ff","role":"negativeBackground","builtIn":true,"archivedAt":null}]}"##;
        let index: LabelIndex = serde_json::from_str(old).unwrap();
        assert!(index.labels[0].built_in);
        let written = serde_json::to_string(&index).unwrap();
        assert!(!written.contains("builtIn"), "{written}");
    }

    #[test]
    fn a_label_id_is_no_longer_than_a_model_label_may_be() {
        let mut input = CreateLabelInput {
            id: "a".repeat(48),
            display_name: "x".into(),
            description: String::new(),
            color: "#000000".into(),
            role: LabelRole::PositiveGesture,
        };
        assert!(validate_input(&input).is_ok());
        input.id = "a".repeat(49);
        assert!(validate_input(&input).is_err());
    }
}
