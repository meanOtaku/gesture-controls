//! The hand measurements recorded when a gesture was calibrated: kept so a gesture added later can be checked against
//! the ones already in the library (a new "thumbs up" must not also fire on a "fist"), and so the library can show which
//! gestures would be mistaken for each other. Only the numbers a rule is made of are kept (never pictures), and only
//! the frames of the gesture itself, thinned to a few hundred.
//!
//! Stored in `gesture-samples.json` beside the library, keyed by gesture id. Anything that does not pass [`validate`]
//! is refused on the way in and dropped on the way out, as for the definitions.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tracing::warn;

const FILE_NAME: &str = "gesture-samples.json";
const MAX_ROWS: usize = 600;
const MAX_MEASURES: usize = 64;
const MAX_NAME_CHARS: usize = 32;
const MAX_GESTURES: usize = 100;

/// Frames of one gesture: each row has one value per named measurement, null where it could not be read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleSet {
    pub measures: Vec<String>,
    pub rows: Vec<Vec<Option<f64>>>,
}

pub fn validate(samples: &SampleSet) -> Result<(), String> {
    if samples.measures.is_empty() || samples.measures.len() > MAX_MEASURES {
        return Err(format!(
            "a sample set needs 1 to {MAX_MEASURES} measurements"
        ));
    }
    if samples.measures.iter().any(|name| {
        name.is_empty()
            || name.chars().count() > MAX_NAME_CHARS
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '.' || c == '_')
    }) {
        return Err("a measurement name is not valid".into());
    }
    if samples.rows.len() > MAX_ROWS {
        return Err(format!("at most {MAX_ROWS} frames can be kept"));
    }
    for row in &samples.rows {
        if row.len() != samples.measures.len() {
            return Err("a frame does not have one value per measurement".into());
        }
        if row
            .iter()
            .flatten()
            .any(|v| !v.is_finite() || v.abs() > 1000.0)
        {
            return Err("a measurement value is out of range".into());
        }
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn read_all(path: &Path) -> BTreeMap<String, SampleSet> {
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(all) = serde_json::from_str::<BTreeMap<String, SampleSet>>(&text) else {
        warn!("the saved gesture samples could not be read; starting empty");
        return BTreeMap::new();
    };
    all.into_iter()
        .filter(|(id, set)| valid_id(id) && validate(set).is_ok())
        .take(MAX_GESTURES)
        .collect()
}

fn write_all(path: &Path, all: &BTreeMap<String, SampleSet>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(all).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Keeps `samples` for gesture `id`, replacing any it had.
pub fn put(
    all: &mut BTreeMap<String, SampleSet>,
    id: &str,
    samples: SampleSet,
) -> Result<(), String> {
    if !valid_id(id) {
        return Err("the gesture id is not valid".into());
    }
    validate(&samples)?;
    if !all.contains_key(id) && all.len() >= MAX_GESTURES {
        return Err("too many gestures have saved samples".into());
    }
    all.insert(id.to_string(), samples);
    Ok(())
}

#[derive(Default)]
pub struct GestureSamplesRuntime {
    lock: Mutex<()>,
}

fn samples_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|e| e.to_string())
}

/// Drops the saved samples of a deleted gesture. Best effort: a failure only leaves a little unused data behind.
pub fn forget(app: &AppHandle, id: &str) {
    let Some(runtime) = app.try_state::<GestureSamplesRuntime>() else {
        return;
    };
    let Ok(_guard) = runtime.lock.lock() else {
        return;
    };
    let Ok(path) = samples_path(app) else { return };
    let mut all = read_all(&path);
    if all.remove(id).is_some()
        && let Err(error) = write_all(&path, &all)
    {
        warn!(%error, "could not drop the samples of a deleted gesture");
    }
}

#[tauri::command]
pub fn list_gesture_samples(
    app: AppHandle,
    runtime: State<'_, GestureSamplesRuntime>,
) -> Result<BTreeMap<String, SampleSet>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "gesture samples lock was poisoned")?;
    Ok(read_all(&samples_path(&app)?))
}

#[tauri::command]
pub fn save_gesture_samples(
    id: String,
    samples: SampleSet,
    app: AppHandle,
    runtime: State<'_, GestureSamplesRuntime>,
) -> Result<(), String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "gesture samples lock was poisoned")?;
    let path = samples_path(&app)?;
    let mut all = read_all(&path);
    put(&mut all, &id, samples)?;
    write_all(&path, &all)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(rows: usize) -> SampleSet {
        SampleSet {
            measures: vec!["thumb.up".into(), "thumb.out".into()],
            rows: (0..rows)
                .map(|i| vec![Some(i as f64 / 100.0), None])
                .collect(),
        }
    }

    #[test]
    fn accepts_frames_with_missing_values_and_refuses_malformed_ones() {
        assert!(validate(&set(10)).is_ok());
        let mut ragged = set(2);
        ragged.rows[1].pop();
        assert!(validate(&ragged).is_err());
        let mut nan = set(2);
        nan.rows[0][0] = Some(f64::NAN);
        assert!(validate(&nan).is_err());
        assert!(validate(&set(MAX_ROWS + 1)).is_err());
        let mut bad_name = set(1);
        bad_name.measures[0] = "Thumb Up!".into();
        assert!(validate(&bad_name).is_err());
        assert!(
            validate(&SampleSet {
                measures: vec![],
                rows: vec![]
            })
            .is_err()
        );
    }

    #[test]
    fn put_replaces_a_gestures_samples_and_refuses_a_bad_id() {
        let mut all = BTreeMap::new();
        put(&mut all, "gesture-1", set(3)).unwrap();
        put(&mut all, "gesture-1", set(5)).unwrap();
        assert_eq!(all["gesture-1"].rows.len(), 5);
        assert!(put(&mut all, "../etc", set(1)).is_err());
        assert!(put(&mut all, "", set(1)).is_err());
    }

    #[test]
    fn round_trips_through_a_file_and_drops_damaged_entries_on_the_way_back() {
        let dir =
            std::env::temp_dir().join(format!("gesture-samples-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join(FILE_NAME);
        let mut all = BTreeMap::new();
        put(&mut all, "good", set(4)).unwrap();
        write_all(&path, &all).unwrap();
        assert_eq!(read_all(&path), all);
        // A hand-edited entry with a ragged row is dropped; the good one stays.
        let text = fs::read_to_string(&path).unwrap().replace(
            "}}",
            r#"},"bad":{"measures":["thumb.up"],"rows":[[1.0,2.0]]}}"#,
        );
        fs::write(&path, text).unwrap();
        let back = read_all(&path);
        assert!(back.contains_key("good") && !back.contains_key("bad"));
        let _ = fs::remove_dir_all(&dir);
    }
}
