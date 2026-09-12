//! Persistent Model Lab label catalogue.
//!
//! Labels are immutable ids with editable presentation metadata. Archiving never
//! deletes an entry, so an imported historical recording remains interpretable.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const LABELS_FILE_NAME: &str = "labels.json";
pub const LABEL_REGISTRY_EVENT: &str = "model-lab-labels-changed";
const BUILTIN_LABELS: &[(&str, &str, LabelRole)] = &[
    ("idle", "Idle", LabelRole::NegativeBackground),
    ("pinch_start", "Pinch start", LabelRole::PositiveGesture),
    ("pinch_hold", "Pinch hold", LabelRole::PositiveGesture),
    ("pinch_release", "Pinch release", LabelRole::PositiveGesture),
    ("walking", "Walking", LabelRole::NegativeBackground),
    ("typing", "Typing", LabelRole::NegativeBackground),
    ("using_mouse", "Using mouse", LabelRole::NegativeBackground),
    (
        "touching_face",
        "Touching face",
        LabelRole::NegativeBackground,
    ),
    (
        "adjusting_headphones",
        "Adjusting headphones",
        LabelRole::NegativeBackground,
    ),
    (
        "picking_up_cup",
        "Picking up cup",
        LabelRole::NegativeBackground,
    ),
    ("scratching", "Scratching", LabelRole::NegativeBackground),
    (
        "normal_wrist_rotation",
        "Normal wrist rotation",
        LabelRole::NegativeBackground,
    ),
    ("standing", "Standing", LabelRole::NegativeBackground),
    ("sitting", "Sitting", LabelRole::NegativeBackground),
];

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
    pub built_in: bool,
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

fn default_index() -> LabelIndex {
    LabelIndex {
        labels: BUILTIN_LABELS
            .iter()
            .map(|(id, display_name, role)| LabelRecord {
                id: (*id).to_string(),
                display_name: (*display_name).to_string(),
                description: String::new(),
                color: "#65e6ff".to_string(),
                role: *role,
                built_in: true,
                archived_at: None,
            })
            .collect(),
    }
}

fn load_index(app: &AppHandle) -> LabelIndex {
    let Ok(path) = labels_path(app) else {
        return default_index();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return default_index();
    };
    let Ok(mut index) = serde_json::from_str::<LabelIndex>(&contents) else {
        return default_index();
    };
    // Forward-compatible migration: built-ins added by a later app version
    // appear without mutating or replacing a user's existing metadata.
    for (id, display_name, role) in BUILTIN_LABELS {
        if !index.labels.iter().any(|label| label.id == *id) {
            index.labels.push(LabelRecord {
                id: (*id).to_string(),
                display_name: (*display_name).to_string(),
                description: String::new(),
                color: "#65e6ff".to_string(),
                role: *role,
                built_in: true,
                archived_at: None,
            });
        }
    }
    index.labels.sort_by(|a, b| a.id.cmp(&b.id));
    index
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
        || input.id.len() > 64
        || !input
            .id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("label id must be 1-64 lowercase letters, digits, or underscores and begin with a letter".to_string());
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
    if label.built_in {
        return Err(
            "built-in labels cannot be archived; keep their historical meanings available"
                .to_string(),
        );
    }
    label.archived_at = archived.then(|| Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(index.labels)
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
}
