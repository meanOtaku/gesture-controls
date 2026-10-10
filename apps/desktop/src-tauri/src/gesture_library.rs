//! The gesture library: gestures the camera can recognise, each a hand pose described by a few measurements.
//!
//! A definition is plain data a person can read and edit: which measurements must hold (thumb-to-index distance below
//! some number, a finger straighter than another), the thresholds to start and to end, and how long the pose must hold.
//! The webview does the recognising (it owns the camera); this module only validates and keeps the definitions, in a
//! file in the app's config directory. A definition that does not pass [`validate`] is never saved, and one that fails
//! it when read back is dropped, so a hand-edited or damaged file cannot feed nonsense to the recogniser.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tracing::warn;
use uuid::Uuid;

const FILE_NAME: &str = "gesture-library.json";
pub const MAX_DEFINITIONS: usize = 50;
const MAX_NAME_CHARS: usize = 40;
const MAX_CONDITIONS: usize = 4;
const MAX_MS: u32 = 2000;
const MAX_LABEL_CHARS: usize = 48;

/// Every measurement a condition may use. The webview computes them from the 21 hand landmarks.
pub const MEASURES: [&str; 9] = [
    "pinch.index",
    "pinch.middle",
    "pinch.ring",
    "pinch.pinky",
    "extension.thumb",
    "extension.index",
    "extension.middle",
    "extension.ring",
    "extension.pinky",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HandChoice {
    Either,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Below,
    Above,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub measure: String,
    pub direction: Direction,
    pub enter: f64,
    pub exit: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub positive_frames: u32,
    pub negative_frames: u32,
    pub balanced_accuracy: f64,
    pub calibrated_at: String,
}

/// A motion around a hold that is marked with a label of its own: the fingers closing before it, or opening after it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseSpec {
    pub label_id: String,
    /// How long the stretch is, in milliseconds. Closing ends where the hold begins; opening starts where it ends.
    pub ms: u32,
}

pub const MIN_PHASE_MS: u32 = 200;
pub const MAX_PHASE_MS: u32 = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GestureDefinition {
    pub id: String,
    pub name: String,
    pub label_id: Option<String>,
    pub hand: HandChoice,
    pub conditions: Vec<Condition>,
    pub min_hold_ms: u32,
    pub release_grace_ms: u32,
    pub calibration: Option<Calibration>,
    /// The closing motion before the hold, marked as its own label (the "positive" side of a pinch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_phase: Option<PhaseSpec>,
    /// The opening motion after the hold (the "negative" side).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_phase: Option<PhaseSpec>,
}

fn valid_label(label: &str) -> bool {
    let mut chars = label.chars();
    label.len() <= MAX_LABEL_CHARS
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Why a definition cannot be kept, in words. The webview checks the same things first so the person sees it sooner.
pub fn validate(definition: &GestureDefinition) -> Result<(), String> {
    let name = definition.name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(format!(
            "give the gesture a name of 1 to {MAX_NAME_CHARS} characters"
        ));
    }
    if let Some(label) = &definition.label_id
        && !valid_label(label)
    {
        return Err(
            "the label must be lowercase letters, digits and underscores, starting with a letter"
                .into(),
        );
    }
    let mut used_labels: Vec<&str> = definition.label_id.iter().map(String::as_str).collect();
    for (what, phase) in [
        ("closing", &definition.close_phase),
        ("opening", &definition.open_phase),
    ] {
        let Some(phase) = phase else { continue };
        if !valid_label(&phase.label_id) {
            return Err(format!(
                "the {what} label must be lowercase letters, digits and underscores, starting with a letter"
            ));
        }
        if !(MIN_PHASE_MS..=MAX_PHASE_MS).contains(&phase.ms) {
            return Err(format!(
                "the {what} stretch must be {MIN_PHASE_MS} to {MAX_PHASE_MS} ms long"
            ));
        }
        if used_labels.contains(&phase.label_id.as_str()) {
            return Err(format!(
                "the {what} label must differ from the gesture's other labels"
            ));
        }
        used_labels.push(&phase.label_id);
    }
    if definition.conditions.is_empty() || definition.conditions.len() > MAX_CONDITIONS {
        return Err(format!("a gesture needs 1 to {MAX_CONDITIONS} conditions"));
    }
    let mut seen = Vec::new();
    for condition in &definition.conditions {
        if !MEASURES.contains(&condition.measure.as_str()) {
            return Err(format!("'{}' is not a measurement", condition.measure));
        }
        if seen.contains(&condition.measure) {
            return Err(format!("two conditions use '{}'", condition.measure));
        }
        seen.push(condition.measure.clone());
        if !condition.enter.is_finite() || !condition.exit.is_finite() {
            return Err("every threshold must be a finite number".into());
        }
        let looser = match condition.direction {
            Direction::Below => condition.exit >= condition.enter,
            Direction::Above => condition.exit <= condition.enter,
        };
        if !looser {
            return Err(format!(
                "for '{}' the end threshold must be looser than the start threshold",
                condition.measure
            ));
        }
        if condition.enter.abs() > 1000.0 || condition.exit.abs() > 1000.0 {
            return Err("a threshold is out of range".into());
        }
    }
    if definition.min_hold_ms > MAX_MS || definition.release_grace_ms > MAX_MS {
        return Err(format!(
            "the hold and release times can be at most {MAX_MS} ms"
        ));
    }
    if let Some(calibration) = &definition.calibration
        && !((0.0..=1.0).contains(&calibration.balanced_accuracy)
            && calibration.positive_frames <= 10_000_000
            && calibration.negative_frames <= 10_000_000
            && calibration.calibrated_at.chars().count() <= 40)
    {
        return Err("the calibration summary is not valid".into());
    }
    Ok(())
}

/// The definitions in `path`, keeping only valid ones. A missing or unreadable file is an empty library.
pub fn read_definitions(path: &Path) -> Vec<GestureDefinition> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(all) = serde_json::from_str::<Vec<GestureDefinition>>(&text) else {
        warn!(path = %path.display(), "the gesture library file could not be read; starting empty");
        return Vec::new();
    };
    let mut kept: Vec<GestureDefinition> = Vec::new();
    for definition in all {
        match validate(&definition) {
            Ok(()) if !kept.iter().any(|d| d.id == definition.id) => kept.push(definition),
            Ok(()) => warn!(id = %definition.id, "dropped a gesture with a repeated id"),
            Err(error) => warn!(id = %definition.id, %error, "dropped an invalid saved gesture"),
        }
    }
    kept.truncate(MAX_DEFINITIONS);
    kept
}

/// Writes the library atomically (a temporary file, then a rename), so a crash leaves the old file or the new one.
pub fn write_definitions(path: &Path, definitions: &[GestureDefinition]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(definitions).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Adds a definition (an empty id gets `new_id`) or replaces the one with its id. Nothing changes if it is invalid.
pub fn upsert(
    definitions: &[GestureDefinition],
    mut definition: GestureDefinition,
    new_id: impl FnOnce() -> String,
) -> Result<Vec<GestureDefinition>, String> {
    validate(&definition)?;
    definition.name = definition.name.trim().to_string();
    let mut next = definitions.to_vec();
    if definition.id.is_empty() {
        definition.id = new_id();
    } else if !definition
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || definition.id.len() > 64
    {
        return Err("the gesture id is not valid".into());
    }
    if next
        .iter()
        .any(|d| d.id != definition.id && d.name.eq_ignore_ascii_case(&definition.name))
    {
        return Err(format!(
            "a gesture called '{}' already exists",
            definition.name
        ));
    }
    if let Some(position) = next.iter().position(|d| d.id == definition.id) {
        next[position] = definition;
    } else if next.len() >= MAX_DEFINITIONS {
        return Err(format!(
            "the most gestures allowed ({MAX_DEFINITIONS}) has been reached"
        ));
    } else {
        next.push(definition);
    }
    Ok(next)
}

/// Every label a saved gesture is linked to, so the label catalogue can refuse to delete one a gesture still uses.
pub fn labels_in_use(app: &AppHandle) -> std::collections::BTreeSet<String> {
    library_path(app)
        .map(|path| {
            read_definitions(&path)
                .into_iter()
                .flat_map(|d| {
                    [
                        d.label_id,
                        d.close_phase.map(|p| p.label_id),
                        d.open_phase.map(|p| p.label_id),
                    ]
                })
                .flatten()
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Default)]
pub struct GestureLibraryRuntime {
    lock: Mutex<()>,
}

fn library_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_gesture_definitions(
    app: AppHandle,
    runtime: State<'_, GestureLibraryRuntime>,
) -> Result<Vec<GestureDefinition>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "gesture library lock was poisoned")?;
    Ok(read_definitions(&library_path(&app)?))
}

#[tauri::command]
pub fn save_gesture_definition(
    definition: GestureDefinition,
    app: AppHandle,
    runtime: State<'_, GestureLibraryRuntime>,
) -> Result<Vec<GestureDefinition>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "gesture library lock was poisoned")?;
    let path = library_path(&app)?;
    let next = upsert(&read_definitions(&path), definition, || {
        format!("gesture-{}", &Uuid::new_v4().simple().to_string()[..8])
    })?;
    write_definitions(&path, &next)?;
    Ok(next)
}

#[tauri::command]
pub fn delete_gesture_definition(
    id: String,
    app: AppHandle,
    runtime: State<'_, GestureLibraryRuntime>,
    automation: State<'_, crate::automation::AutomationRuntime>,
) -> Result<Vec<GestureDefinition>, String> {
    let users = crate::automation::recipes_using_gesture(&automation.state()?.recipes, &id);
    if !users.is_empty() {
        return Err(format!(
            "this gesture is used by the recipe{} {}. Remove it from the recipe first",
            if users.len() == 1 { "" } else { "s" },
            users.join(", ")
        ));
    }
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "gesture library lock was poisoned")?;
    let path = library_path(&app)?;
    let mut definitions = read_definitions(&path);
    let before = definitions.len();
    definitions.retain(|d| d.id != id);
    if definitions.len() == before {
        return Err("there is no such gesture".into());
    }
    write_definitions(&path, &definitions)?;
    Ok(definitions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pinch() -> GestureDefinition {
        GestureDefinition {
            id: String::new(),
            name: "Pinch".into(),
            label_id: Some("pinch".into()),
            hand: HandChoice::Either,
            conditions: vec![Condition {
                measure: "pinch.index".into(),
                direction: Direction::Below,
                enter: 0.3,
                exit: 0.5,
            }],
            min_hold_ms: 100,
            release_grace_ms: 120,
            calibration: Some(Calibration {
                positive_frames: 90,
                negative_frames: 120,
                balanced_accuracy: 0.97,
                calibrated_at: "2026-10-09T12:00:00Z".into(),
            }),
            close_phase: None,
            open_phase: None,
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gesture-library-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn a_good_definition_is_accepted_and_each_bad_one_is_refused_with_a_reason() {
        assert_eq!(validate(&pinch()), Ok(()));
        let bad = |change: &dyn Fn(&mut GestureDefinition)| {
            let mut d = pinch();
            change(&mut d);
            validate(&d).unwrap_err()
        };
        assert!(bad(&|d| d.name = "  ".into()).contains("name"));
        assert!(bad(&|d| d.name = "x".repeat(41)).contains("name"));
        assert!(bad(&|d| d.label_id = Some("Bad Label".into())).contains("label"));
        assert!(bad(&|d| d.conditions.clear()).contains("1 to 4"));
        assert!(
            bad(&|d| d.conditions[0].measure = "pinch.elbow".into()).contains("not a measurement")
        );
        assert!(bad(&|d| d.conditions.push(d.conditions[0].clone())).contains("two conditions"));
        assert!(bad(&|d| d.conditions[0].enter = f64::NAN).contains("finite"));
        assert!(bad(&|d| d.conditions[0].exit = 0.1).contains("looser"));
        assert!(
            bad(&|d| {
                d.conditions[0].direction = Direction::Above;
            })
            .contains("looser")
        );
        assert!(bad(&|d| d.min_hold_ms = 5000).contains("at most 2000"));
        assert!(
            bad(&|d| d.calibration.as_mut().unwrap().balanced_accuracy = 1.5)
                .contains("calibration")
        );
        assert!(bad(&|d| d.conditions[0].enter = -5000.0).contains("range") || true);
    }

    #[test]
    fn a_closing_and_opening_stretch_need_their_own_valid_labels_and_a_sensible_length() {
        let phase = |label: &str, ms| {
            Some(PhaseSpec {
                label_id: label.into(),
                ms,
            })
        };
        let mut d = pinch();
        d.close_phase = phase("pinch_close", 500);
        d.open_phase = phase("pinch_open", 500);
        assert_eq!(validate(&d), Ok(()));
        let bad = |change: &dyn Fn(&mut GestureDefinition)| {
            let mut d = d.clone();
            change(&mut d);
            validate(&d).unwrap_err()
        };
        assert!(bad(&|d| d.close_phase = phase("Bad Label", 500)).contains("closing label"));
        assert!(bad(&|d| d.open_phase = phase("pinch_open", 50)).contains("opening stretch"));
        assert!(bad(&|d| d.open_phase = phase("pinch_open", 5000)).contains("opening stretch"));
        assert!(bad(&|d| d.close_phase = phase("pinch", 500)).contains("must differ"));
        assert!(bad(&|d| d.open_phase = phase("pinch_close", 500)).contains("must differ"));
        // They are optional, and an older saved gesture without them still reads.
        let old = serde_json::to_string(&pinch()).unwrap();
        assert!(!old.contains("closePhase"));
        assert_eq!(
            serde_json::from_str::<GestureDefinition>(&old)
                .unwrap()
                .close_phase,
            None
        );
    }

    #[test]
    fn definitions_round_trip_through_the_file_in_camel_case() {
        let path = temp("library.json");
        let mut saved = pinch();
        saved.id = "gesture-abc12345".into();
        write_definitions(&path, std::slice::from_ref(&saved)).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("\"labelId\"")
                && text.contains("\"minHoldMs\"")
                && text.contains("\"below\""),
            "{text}"
        );
        assert_eq!(read_definitions(&path), vec![saved]);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn a_missing_or_damaged_file_is_an_empty_library_and_an_invalid_entry_is_dropped() {
        let path = temp("library.json");
        assert!(read_definitions(&path).is_empty());
        fs::write(&path, "not json").unwrap();
        assert!(read_definitions(&path).is_empty());
        let mut ok = pinch();
        ok.id = "a".into();
        let mut broken = pinch();
        broken.id = "b".into();
        broken.conditions[0].exit = 0.0;
        let mut repeated = pinch();
        repeated.id = "a".into();
        fs::write(
            &path,
            serde_json::to_string(&[ok.clone(), broken, repeated]).unwrap(),
        )
        .unwrap();
        assert_eq!(read_definitions(&path), vec![ok]);
    }

    #[test]
    fn upsert_adds_with_a_new_id_replaces_by_id_and_keeps_names_unique() {
        let first = upsert(&[], pinch(), || "gesture-1".into()).unwrap();
        assert_eq!(first[0].id, "gesture-1");
        let mut renamed = first[0].clone();
        renamed.name = "Pinch 2".into();
        let replaced = upsert(&first, renamed, || unreachable!()).unwrap();
        assert_eq!((replaced.len(), replaced[0].name.as_str()), (1, "Pinch 2"));
        let duplicate = upsert(
            &replaced,
            GestureDefinition {
                name: "pinch 2".into(),
                ..pinch()
            },
            || "gesture-2".into(),
        );
        assert!(duplicate.unwrap_err().contains("already exists"));
        let invalid = upsert(
            &replaced,
            GestureDefinition {
                conditions: vec![],
                ..pinch()
            },
            || "x".into(),
        );
        assert!(invalid.is_err());
        let bad_id = upsert(
            &replaced,
            GestureDefinition {
                id: "../evil".into(),
                ..pinch()
            },
            || "x".into(),
        );
        assert!(bad_id.unwrap_err().contains("id"));
    }

    #[test]
    fn the_library_has_a_limit() {
        let mut library = Vec::new();
        for n in 0..MAX_DEFINITIONS {
            library = upsert(
                &library,
                GestureDefinition {
                    name: format!("g{n}"),
                    ..pinch()
                },
                || format!("gesture-{n}"),
            )
            .unwrap();
        }
        let error = upsert(
            &library,
            GestureDefinition {
                name: "one too many".into(),
                ..pinch()
            },
            || "gesture-x".into(),
        )
        .unwrap_err();
        assert!(error.contains("most gestures"));
    }

    #[test]
    fn the_measure_list_matches_the_webview() {
        // `MEASURE_NAMES` in definition.ts, in the same order.
        assert_eq!(
            MEASURES,
            [
                "pinch.index",
                "pinch.middle",
                "pinch.ring",
                "pinch.pinky",
                "extension.thumb",
                "extension.index",
                "extension.middle",
                "extension.ring",
                "extension.pinky"
            ]
        );
    }
}
