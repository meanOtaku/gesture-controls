//! Persistent Model Lab label catalogue.
//!
//! Labels are immutable ids with editable presentation metadata. Archiving never
//! deletes an entry, so an imported historical recording remains interpretable.
//!
//! Gestures are the user's own labels. A few labels mean the same for every model and are the app's: the standard labels
//! ([`STANDARD_LABELS`]), always listed, never changed or removed, and always "not the gesture" in training.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const LABELS_FILE_NAME: &str = "labels.json";

/// The app's own labels, the same for every model: (id, display name, description, colour). Never written to the
/// catalogue file; listed with it. Training always gives them the role "not the gesture" (`label_training`).
/// One word each where it can be: training joins a gesture's parts by the name before the first "_" (`pinch_in`,
/// `pinch_hold`), so a standard label must not share that name with a gesture (`hand_…` would join `hand_open`).
pub const STANDARD_LABELS: [(&str, &str, &str, &str); 3] = [
    (
        "everyday_noise",
        "Everyday noise",
        "Ordinary use of the hand (typing, the phone, walking, …) with no gesture.",
        "#8a9bb0",
    ),
    (
        "still",
        "Hand still",
        "The hand held as still as you can, in the air, with no gesture.",
        "#5f6f7f",
    ),
    (
        "supported",
        "Hand on a support",
        "The hand resting on a support (a desk, an armrest, your lap), flat or angled, with no gesture.",
        "#6f7f6a",
    ),
];

/// Whether `id` is one of the [`STANDARD_LABELS`].
pub fn is_standard(id: &str) -> bool {
    STANDARD_LABELS.iter().any(|(standard, ..)| *standard == id)
}
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

/// Which part of a held gesture a label is: the moment it starts (`pinch_in`), while it is held (`pinch_hold`), or the
/// moment it ends (`pinch_out`). A gesture with phases is held; one without is momentary (a tap, a flick), its own label
/// its start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Start,
    Hold,
    End,
}

impl Phase {
    pub const ALL: [Phase; 3] = [Phase::Start, Phase::Hold, Phase::End];

    /// The id suffix of this phase's label (`<gesture>_in`, `_hold`, `_out`), as pinch's were named.
    pub fn suffix(self) -> &'static str {
        match self {
            Phase::Start => "in",
            Phase::Hold => "hold",
            Phase::End => "out",
        }
    }
}

/// What archiving a label everywhere switched off, so restoring it can switch the same things back.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveLog {
    /// Recipes that were switched off because they used the label.
    pub disabled_recipes: Vec<String>,
    /// Models that were archived with the label.
    pub archived_models: Vec<String>,
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
    /// One of the app's [`STANDARD_LABELS`]: listed, never stored.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub standard: bool,
    pub archived_at: Option<String>,
    /// Set when the label was archived together with what uses it; cleared when it is restored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_log: Option<ArchiveLog>,
    /// For a phase of a gesture: the gesture's label (`pinch` for `pinch_in`). Only the hierarchy: the label's id, and
    /// so every recording, model and recipe using it, stays as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Which phase of `parent` it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<Phase>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLabelInput {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub color: String,
    pub role: LabelRole,
    /// For a phase: its gesture and which phase it is (both or neither).
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub phase: Option<Phase>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLabelInput {
    pub id: String,
    pub display_name: String,
    pub description: String,
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

/// The catalogue as the app shows it: the user's labels and the standard ones, sorted by id. A user's label with a
/// standard id (made before they were standard) is shown as the standard one.
fn listed(index: &LabelIndex) -> Vec<LabelRecord> {
    let mut labels: Vec<LabelRecord> = index
        .labels
        .iter()
        .filter(|label| !is_standard(&label.id))
        .cloned()
        .collect();
    labels.extend(
        STANDARD_LABELS
            .iter()
            .map(|(id, name, description, color)| LabelRecord {
                id: (*id).to_string(),
                display_name: (*name).to_string(),
                description: (*description).to_string(),
                color: (*color).to_string(),
                role: LabelRole::NegativeBackground,
                built_in: false,
                standard: true,
                archived_at: None,
                archive_log: None,
                parent: None,
                phase: None,
            }),
    );
    link_phases(&mut labels);
    labels.sort_by(|a, b| a.id.cmp(&b.id));
    labels
}

/// Links labels named as a gesture's phases (`<gesture>_in`, `_hold`, `_out`) to that gesture when they say nothing
/// themselves, so the labels made before phases existed (pinch's) are shown as one gesture. Nothing is written.
fn link_phases(labels: &mut [LabelRecord]) {
    let gestures: BTreeSet<String> = labels
        .iter()
        .filter(|label| !label.standard && label.parent.is_none())
        .map(|label| label.id.clone())
        .collect();
    for label in labels.iter_mut() {
        if label.parent.is_some() || label.standard {
            continue;
        }
        for phase in Phase::ALL {
            if let Some(base) = label.id.strip_suffix(&format!("_{}", phase.suffix()))
                && gestures.contains(base)
            {
                label.parent = Some(base.to_string());
                label.phase = Some(phase);
                break;
            }
        }
    }
}

/// A new label's place among the gestures, checked: a phase names a gesture that is a label and not itself a phase, and
/// the gesture has no other label for that phase.
fn check_phase(labels: &[LabelRecord], input: &CreateLabelInput) -> Result<(), String> {
    match (&input.parent, input.phase) {
        (None, None) => Ok(()),
        (Some(parent), Some(phase)) => {
            let gesture = labels
                .iter()
                .find(|label| &label.id == parent)
                .ok_or_else(|| format!("there is no gesture '{parent}' to add a phase to"))?;
            if gesture.parent.is_some() || gesture.standard {
                return Err(format!("'{parent}' is not a gesture that can have phases"));
            }
            if labels
                .iter()
                .any(|label| label.parent.as_deref() == Some(parent) && label.phase == Some(phase))
            {
                return Err(format!("'{parent}' already has a {phase:?} phase").to_lowercase());
            }
            Ok(())
        }
        _ => Err("a phase needs both its gesture and which phase it is".into()),
    }
}

/// The labels for `gesture`'s phases it does not have yet: `<gesture>_in`, `_hold`, `_out`, named after it ("Fist in")
/// and in its colour. Refused for a label that is a phase or standard, or one whose phase ids are taken by other labels.
fn phases_to_add(labels: &[LabelRecord], gesture: &str) -> Result<Vec<LabelRecord>, String> {
    let parent = labels
        .iter()
        .find(|label| label.id == gesture)
        .ok_or_else(|| format!("there is no label '{gesture}'"))?;
    if parent.parent.is_some() || parent.standard {
        return Err(format!("'{gesture}' is not a gesture that can have phases"));
    }
    let mut added = Vec::new();
    for phase in Phase::ALL {
        if labels
            .iter()
            .any(|label| label.parent.as_deref() == Some(gesture) && label.phase == Some(phase))
        {
            continue;
        }
        let id = format!("{gesture}_{}", phase.suffix());
        if labels.iter().any(|label| label.id == id) {
            return Err(format!(
                "'{id}' is already a label of its own: rename the gesture or that label first"
            ));
        }
        if id.len() > 48 {
            return Err(format!("'{gesture}' is too long to name its phases after"));
        }
        added.push(LabelRecord {
            id,
            display_name: format!("{} {}", parent.display_name, phase.suffix()),
            description: match phase {
                Phase::Start => {
                    format!("The moment {} starts.", parent.display_name.to_lowercase())
                }
                Phase::Hold => format!(
                    "{} held, between its start and its end.",
                    parent.display_name
                ),
                Phase::End => format!("The moment {} ends.", parent.display_name.to_lowercase()),
            },
            color: parent.color.clone(),
            role: LabelRole::PositiveGesture,
            built_in: false,
            standard: false,
            archived_at: None,
            archive_log: None,
            parent: Some(gesture.to_string()),
            phase: Some(phase),
        });
    }
    Ok(added)
}

fn refuse_standard(id: &str) -> Result<(), String> {
    if is_standard(id) {
        return Err(format!(
            "'{id}' is a standard label: the app keeps it the same for every model"
        ));
    }
    Ok(())
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

/// Changes what a label is called, its notes and its role. The id never changes: recordings, models, recipes and
/// gestures refer to it.
fn apply_update(index: &mut LabelIndex, input: &UpdateLabelInput) -> Result<(), String> {
    refuse_standard(&input.id)?;
    validate_input(&CreateLabelInput {
        id: "placeholder".to_string(),
        display_name: input.display_name.clone(),
        description: input.description.clone(),
        color: "#000000".to_string(),
        role: input.role,
        parent: None,
        phase: None,
    })?;
    let label = index
        .labels
        .iter_mut()
        .find(|label| label.id == input.id)
        .ok_or_else(|| format!("no label with id '{}'", input.id))?;
    label.display_name = input.display_name.trim().to_string();
    label.description = input.description.trim().to_string();
    label.role = input.role;
    Ok(())
}

fn emit(app: &AppHandle, index: &LabelIndex) {
    let _ = app.emit(LABEL_REGISTRY_EVENT, &listed(index));
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
    Ok(listed(&load_index(&app)))
}

#[tauri::command]
pub fn create_model_label(
    input: CreateLabelInput,
    app: AppHandle,
    runtime: State<'_, LabelRegistryRuntime>,
) -> Result<Vec<LabelRecord>, String> {
    validate_input(&input)?;
    refuse_standard(&input.id)?;
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "label registry lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    if index.labels.iter().any(|label| label.id == input.id) {
        return Err(format!("label '{}' already exists", input.id));
    }
    check_phase(&listed(&index), &input)?;
    index.labels.push(LabelRecord {
        id: input.id.clone(),
        display_name: input.display_name.trim().to_string(),
        description: input.description.trim().to_string(),
        color: input.color.to_lowercase(),
        role: input.role,
        built_in: false,
        standard: false,
        archived_at: None,
        archive_log: None,
        parent: input.parent.clone(),
        phase: input.phase,
    });
    index.labels.sort_by(|a, b| a.id.cmp(&b.id));
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(listed(&index))
}

#[tauri::command]
pub fn update_model_label(
    input: UpdateLabelInput,
    app: AppHandle,
    runtime: State<'_, LabelRegistryRuntime>,
) -> Result<Vec<LabelRecord>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "label registry lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    apply_update(&mut index, &input)?;
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(listed(&index))
}

/// Gives `gesture` the labels of its phases it does not have yet (start, hold, end: `<gesture>_in`, `_hold`, `_out`), so
/// it is recorded, marked and trained as a held gesture. The links found by name are written down with them.
#[tauri::command]
pub fn add_gesture_phases(
    gesture: String,
    app: AppHandle,
    runtime: State<'_, LabelRegistryRuntime>,
) -> Result<Vec<LabelRecord>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "label registry lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    let shown = listed(&index);
    let added = phases_to_add(&shown, &gesture)?;
    // Keep the links found by name, so they hold even if the gesture is renamed later.
    for label in &mut index.labels {
        if let Some(linked) = shown.iter().find(|l| l.id == label.id) {
            label.parent = linked.parent.clone();
            label.phase = linked.phase;
        }
    }
    index.labels.extend(added);
    index.labels.sort_by(|a, b| a.id.cmp(&b.id));
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(listed(&index))
}

/// Remembers what archiving a label everywhere switched off, so restoring it can switch it back on.
#[tauri::command]
pub fn save_label_archive_log(
    id: String,
    log: ArchiveLog,
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
    label.archive_log = Some(log);
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(listed(&index))
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
    refuse_standard(&id)?;
    let mut index = load_index(&app);
    let label = index
        .labels
        .iter_mut()
        .find(|label| label.id == id)
        .ok_or_else(|| format!("no label with id '{id}'"))?;
    label.archived_at = archived.then(|| Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
    if !archived {
        label.archive_log = None;
    }
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(listed(&index))
}

/// Removes a label nothing uses. A label that a recording, a project, a model or a gesture refers to cannot be removed (archive
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
    refuse_standard(&id)?;
    let mut index = load_index(&app);
    if !index.labels.iter().any(|label| label.id == id) {
        return Err(format!("no label with id '{id}'"));
    }
    let in_use = labels_in_use(&app, &labels).ok_or(
        "the model registry is not available, so it cannot be checked whether this label is used",
    )?;
    if in_use.contains(&id) {
        return Err(format!(
            "'{id}' is used by a recording, a model or a gesture. Archive it instead; deleting it would leave them without a meaning"
        ));
    }
    index.labels.retain(|label| label.id != id);
    write_index_atomic(&app, &index)?;
    emit(&app, &index);
    Ok(listed(&index))
}

/// Every label a recording, a project or a model refers to; `None` when the model registry cannot be read.
fn labels_in_use(
    app: &AppHandle,
    models: &crate::label_runtime::LabelRuntimeHost,
) -> Option<BTreeSet<String>> {
    let mut used = crate::model_lab::dataset_labels_in_use(app);
    used.extend(models.labels_in_registry()?);
    used.extend(crate::gesture_library::labels_in_use(app));
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

/// Every label in the catalogue, archived ones included (they still describe old recordings).
pub(crate) fn catalogue_ids(app: &AppHandle) -> BTreeSet<String> {
    listed(&load_index(app)).into_iter().map(|l| l.id).collect()
}

/// Used by Model Lab import validation. Archived labels remain valid because
/// they describe historical data; only unknown ids are rejected.
pub(crate) fn contains_label(app: &AppHandle, id: &str) -> bool {
    is_standard(id) || load_index(app).labels.iter().any(|label| label.id == id)
}

/// The ids in the catalogue file at `path` (the app's `model-lab/labels.json`), for the import tool.
#[cfg(test)]
pub(crate) fn label_ids_at(path: &std::path::Path) -> BTreeSet<String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<LabelIndex>(&text).ok())
        .map(|index| index.labels.into_iter().map(|label| label.id).collect())
        .unwrap_or_default()
}

/// Adds each `(id, display name, description)` missing from the catalogue file at `path`, as a gesture to detect, and
/// returns the ids it added. The file is written atomically, as the app writes it.
#[cfg(test)]
pub(crate) fn add_gesture_labels_at(
    path: &std::path::Path,
    labels: &[(&str, &str, &str)],
) -> Result<Vec<String>, String> {
    let mut index: LabelIndex = match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?,
        Err(_) => LabelIndex::default(),
    };
    let mut added = Vec::new();
    for (id, display_name, description) in labels {
        if index.labels.iter().any(|label| label.id == *id) {
            continue;
        }
        index.labels.push(LabelRecord {
            id: id.to_string(),
            display_name: display_name.to_string(),
            description: description.to_string(),
            color: "#65e6ff".into(),
            role: LabelRole::PositiveGesture,
            built_in: false,
            standard: false,
            archived_at: None,
            archive_log: None,
            parent: None,
            phase: None,
        });
        added.push(id.to_string());
    }
    index.labels.sort_by(|a, b| a.id.cmp(&b.id));
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())?;
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_record(id: &str) -> LabelRecord {
        LabelRecord {
            id: id.to_string(),
            display_name: "Old name".to_string(),
            description: String::new(),
            color: "#65e6ff".to_string(),
            role: LabelRole::PositiveGesture,
            built_in: false,
            standard: false,
            archived_at: None,
            archive_log: None,
            parent: None,
            phase: None,
        }
    }

    #[test]
    fn the_standard_labels_are_always_listed_never_stored_and_cannot_be_changed() {
        // A user's own "still" (made before it was standard) is shown as the standard one.
        let mut index = LabelIndex {
            labels: vec![plain_record("pinch"), plain_record("still")],
        };
        let shown = listed(&index);
        assert_eq!(
            shown
                .iter()
                .map(|l| (l.id.as_str(), l.standard))
                .collect::<Vec<_>>(),
            [
                ("everyday_noise", true),
                ("pinch", false),
                ("still", true),
                ("supported", true)
            ]
        );
        assert!(
            shown
                .iter()
                .filter(|l| l.standard)
                .all(|l| l.role == LabelRole::NegativeBackground && l.archived_at.is_none())
        );
        let written = serde_json::to_string(&index).unwrap();
        assert!(
            !written.contains("everyday_noise") && !written.contains("standard"),
            "{written}"
        );
        assert!(
            serde_json::to_string(&shown)
                .unwrap()
                .contains("\"standard\":true")
        );
        let update = UpdateLabelInput {
            id: "everyday_noise".into(),
            display_name: "Mine".into(),
            description: String::new(),
            role: LabelRole::PositiveGesture,
        };
        assert!(
            apply_update(&mut index, &update)
                .unwrap_err()
                .contains("standard label")
        );
        assert!(refuse_standard("still").is_err() && refuse_standard("pinch").is_ok());
    }

    #[test]
    fn an_update_changes_the_name_notes_and_role_but_never_the_id_or_colour() {
        let mut index = LabelIndex {
            labels: vec![plain_record("pinch"), plain_record("fist")],
        };
        let update = UpdateLabelInput {
            id: "pinch".to_string(),
            display_name: "  Index pinch ".to_string(),
            description: " thumb to index ".to_string(),
            role: LabelRole::NegativeBackground,
        };
        apply_update(&mut index, &update).unwrap();
        let changed = &index.labels[0];
        assert_eq!(
            (
                changed.id.as_str(),
                changed.display_name.as_str(),
                changed.description.as_str()
            ),
            ("pinch", "Index pinch", "thumb to index")
        );
        assert_eq!(
            (changed.role, changed.color.as_str()),
            (LabelRole::NegativeBackground, "#65e6ff")
        );
        assert_eq!(index.labels[1].display_name, "Old name");
        let bad = UpdateLabelInput {
            display_name: "  ".to_string(),
            ..update.clone()
        };
        assert!(apply_update(&mut index, &bad).is_err());
        let missing = UpdateLabelInput {
            id: "nope".to_string(),
            ..update
        };
        assert!(
            apply_update(&mut index, &missing)
                .unwrap_err()
                .contains("no label")
        );
    }
    #[test]
    fn validates_stable_custom_metadata() {
        let input = CreateLabelInput {
            id: "double_tap".to_string(),
            display_name: "Double tap".to_string(),
            description: "User-defined gesture".to_string(),
            color: "#12aBcD".to_string(),
            role: LabelRole::PositiveGesture,
            parent: None,
            phase: None,
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
            parent: None,
            phase: None,
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
            standard: false,
            archived_at: None,
            archive_log: None,
            parent: None,
            phase: None,
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
            parent: None,
            phase: None,
        };
        assert!(validate_input(&input).is_ok());
        input.id = "a".repeat(49);
        assert!(validate_input(&input).is_err());
    }

    #[test]
    fn a_gesture_s_phases_are_found_by_name_and_new_ones_named_after_it() {
        let mut fist = plain_record("fist");
        fist.display_name = "Fist".into();
        fist.color = "#ff8a3d".into();
        let index = LabelIndex {
            labels: [
                "pinch",
                "pinch_in",
                "pinch_hold",
                "pinch_out",
                "fist",
                "hand_in_pocket",
            ]
            .iter()
            .map(|id| {
                if *id == "fist" {
                    fist.clone()
                } else {
                    plain_record(id)
                }
            })
            .collect(),
        };
        let shown = listed(&index);
        let of = |id: &str| {
            let label = shown.iter().find(|l| l.id == id).unwrap();
            (label.parent.as_deref(), label.phase)
        };
        assert_eq!(of("pinch_in"), (Some("pinch"), Some(Phase::Start)));
        assert_eq!(of("pinch_hold"), (Some("pinch"), Some(Phase::Hold)));
        assert_eq!(of("pinch_out"), (Some("pinch"), Some(Phase::End)));
        assert_eq!(of("pinch"), (None, None));
        // "hand_in_pocket" ends in neither suffix of a gesture that exists.
        assert_eq!(of("hand_in_pocket"), (None, None));

        let added = phases_to_add(&shown, "fist").unwrap();
        assert_eq!(
            added
                .iter()
                .map(|l| (l.id.as_str(), l.display_name.as_str(), l.phase))
                .collect::<Vec<_>>(),
            [
                ("fist_in", "Fist in", Some(Phase::Start)),
                ("fist_hold", "Fist hold", Some(Phase::Hold)),
                ("fist_out", "Fist out", Some(Phase::End)),
            ]
        );
        assert!(
            added
                .iter()
                .all(|l| l.parent.as_deref() == Some("fist") && l.color == "#ff8a3d")
        );
        assert!(phases_to_add(&shown, "pinch").unwrap().is_empty());
        assert!(phases_to_add(&shown, "pinch_in").is_err());
        assert!(phases_to_add(&shown, "everyday_noise").is_err());
    }

    #[test]
    fn a_new_phase_must_name_a_gesture_that_lacks_it() {
        let shown = listed(&LabelIndex {
            labels: vec![
                plain_record("pinch"),
                plain_record("pinch_in"),
                plain_record("wave"),
            ],
        });
        let input = |parent: Option<&str>, phase: Option<Phase>| CreateLabelInput {
            id: "x".into(),
            display_name: "X".into(),
            description: String::new(),
            color: "#000000".into(),
            role: LabelRole::PositiveGesture,
            parent: parent.map(String::from),
            phase,
        };
        assert!(check_phase(&shown, &input(None, None)).is_ok());
        assert!(check_phase(&shown, &input(Some("wave"), Some(Phase::Start))).is_ok());
        assert!(check_phase(&shown, &input(Some("pinch"), Some(Phase::Start))).is_err());
        assert!(check_phase(&shown, &input(Some("pinch_in"), Some(Phase::Hold))).is_err());
        assert!(check_phase(&shown, &input(Some("nope"), Some(Phase::Hold))).is_err());
        assert!(check_phase(&shown, &input(Some("wave"), None)).is_err());
    }
}
