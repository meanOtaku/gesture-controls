use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use interaction_engine::{CalibrationEvent, CalibrationState, CalibrationTarget, HeadCalibration};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::automation::AutomationRuntime;

pub const CALIBRATION_STATE_EVENT: &str = "head-calibration-state";
pub const TARGET_ENTERED_EVENT: &str = "head-target-entered";
pub const TARGET_EXITED_EVENT: &str = "head-target-exited";
const LOCATIONS_FILE_NAME: &str = "calibration-locations.json";

/// The locations worth keeping between runs. Captured poses are not: a head pose only means something
/// for the tracker session it was captured in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedLocations {
    locations: Vec<SavedLocation>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SavedLocation {
    id: CalibrationTarget,
    name: String,
}

fn locations_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(LOCATIONS_FILE_NAME))
        .map_err(|error| error.to_string())
}

pub struct CalibrationRuntime {
    operations: Mutex<()>,
    engine: Mutex<HeadCalibration>,
    latest_quaternion: Mutex<Option<[f64; 4]>>,
    started_at: Instant,
}

impl Default for CalibrationRuntime {
    fn default() -> Self {
        Self {
            operations: Mutex::new(()),
            engine: Mutex::new(HeadCalibration::default()),
            latest_quaternion: Mutex::new(None),
            started_at: Instant::now(),
        }
    }
}

impl CalibrationRuntime {
    /// Restores the locations saved last time. A missing or unreadable file keeps the defaults.
    pub fn load(&self, app: &AppHandle) {
        let saved = locations_path(app)
            .and_then(|path| fs::read_to_string(path).map_err(|error| error.to_string()))
            .and_then(|text| {
                serde_json::from_str::<SavedLocations>(&text).map_err(|e| e.to_string())
            });
        let Ok(saved) = saved else { return };
        let Ok(mut engine) = self.engine.lock() else {
            return;
        };
        if !saved
            .locations
            .iter()
            .any(|l| l.id == CalibrationTarget::top_right())
        {
            let _ = engine.remove_location(&CalibrationTarget::top_right());
        }
        for location in saved.locations {
            if let Err(error) = engine.add_location(location.id, &location.name) {
                // The built-ins are already there, so "already exists" is expected.
                tracing::debug!(%error, "skipped a saved calibration location");
            }
        }
    }

    fn save(&self, app: &AppHandle, engine: &HeadCalibration) {
        let saved = SavedLocations {
            locations: engine
                .state()
                .targets
                .into_iter()
                .filter(|target| !target.builtin)
                .map(|target| SavedLocation {
                    id: target.id,
                    name: target.name,
                })
                .collect(),
        };
        let result = locations_path(app).and_then(|path| {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir).map_err(|error| error.to_string())?;
            }
            let json = serde_json::to_string_pretty(&saved).map_err(|error| error.to_string())?;
            let tmp = path.with_extension("json.tmp");
            fs::write(&tmp, json).map_err(|error| error.to_string())?;
            fs::rename(&tmp, &path).map_err(|error| error.to_string())
        });
        if let Err(error) = result {
            warn!(%error, "failed to save the calibration locations");
        }
    }

    pub fn add_location(&self, app: &AppHandle, name: String) -> Result<CalibrationState, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let state = {
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            let id = unused_id(&engine, &name);
            engine
                .add_location(
                    CalibrationTarget::new(id).map_err(|e| e.to_string())?,
                    &name,
                )
                .map_err(|error| error.to_string())?;
            self.save(app, &engine);
            engine.state()
        };
        let _ = app.emit(CALIBRATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn remove_location(
        &self,
        app: &AppHandle,
        target: CalibrationTarget,
    ) -> Result<CalibrationState, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let (events, state) = {
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            let events = engine
                .remove_location(&target)
                .map_err(|error| error.to_string())?;
            self.save(app, &engine);
            (events, engine.state())
        };
        handle_calibration_events(app, events);
        let _ = app.emit(CALIBRATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn observe(&self, app: &AppHandle, quaternion: [f64; 4]) -> Result<(), String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let events = {
            let mut latest = self
                .latest_quaternion
                .lock()
                .map_err(|_| "latest head pose lock was poisoned")?;
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            *latest = Some(quaternion);
            engine
                .observe(quaternion, self.started_at.elapsed())
                .map_err(|error| error.to_string())?
        };
        handle_calibration_events(app, events);
        Ok(())
    }

    pub fn disconnect(&self, app: &AppHandle) -> Result<(), String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let events = {
            let mut latest = self
                .latest_quaternion
                .lock()
                .map_err(|_| "latest head pose lock was poisoned")?;
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            *latest = None;
            engine.deactivate()
        };
        handle_calibration_events(app, events);
        Ok(())
    }

    pub fn invalidate(&self, app: &AppHandle) -> Result<CalibrationState, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let (events, state) = {
            let mut latest = self
                .latest_quaternion
                .lock()
                .map_err(|_| "latest head pose lock was poisoned")?;
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            *latest = None;
            let events = engine.invalidate();
            (events, engine.state())
        };
        handle_calibration_events(app, events);
        let _ = app.emit(CALIBRATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn capture(
        &self,
        app: &AppHandle,
        target: CalibrationTarget,
    ) -> Result<CalibrationState, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let (events, state) = {
            let latest = self
                .latest_quaternion
                .lock()
                .map_err(|_| "latest head pose lock was poisoned")?;
            let quaternion =
                (*latest).ok_or("no live head pose is available; connect the tracker first")?;
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            let events = engine
                .capture(&target, quaternion)
                .map_err(|error| error.to_string())?;
            (events, engine.state())
        };
        handle_calibration_events(app, events);
        let _ = app.emit(CALIBRATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn update_config(
        &self,
        app: &AppHandle,
        activation_threshold_degrees: f64,
        dwell_ms: u64,
    ) -> Result<CalibrationState, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let state = {
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            engine
                .update_config(activation_threshold_degrees, dwell_ms)
                .map_err(|error| error.to_string())?;
            engine.state()
        };
        let _ = app.emit(CALIBRATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn state(&self) -> Result<CalibrationState, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let engine = self
            .engine
            .lock()
            .map_err(|_| "calibration state lock was poisoned")?;
        Ok(engine.state())
    }
}

#[tauri::command]
pub fn get_calibration_state(
    runtime: State<'_, CalibrationRuntime>,
) -> Result<CalibrationState, String> {
    runtime.state()
}

#[tauri::command]
pub fn capture_calibration_target(
    target: CalibrationTarget,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationState, String> {
    runtime.capture(&app, target)
}

#[tauri::command]
pub fn add_calibration_location(
    name: String,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationState, String> {
    runtime.add_location(&app, name)
}

#[tauri::command]
pub fn remove_calibration_location(
    target: CalibrationTarget,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationState, String> {
    runtime.remove_location(&app, target)
}

#[tauri::command]
pub fn update_calibration_config(
    activation_threshold_degrees: f64,
    dwell_ms: u64,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationState, String> {
    runtime.update_config(&app, activation_threshold_degrees, dwell_ms)
}

/// A slug from the display name that no existing location uses: "Left edge" -> `leftEdge`, then `leftEdge2`.
fn unused_id(engine: &HeadCalibration, name: &str) -> String {
    let mut base = String::new();
    let mut upper = false;
    for c in name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
    {
        if c.is_whitespace() {
            upper = !base.is_empty();
        } else if base.is_empty() {
            base.extend(c.to_lowercase());
        } else if upper {
            base.extend(c.to_uppercase());
            upper = false;
        } else {
            base.push(c);
        }
    }
    if !base.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        base = format!("location{base}");
    }
    base.truncate(28);
    let taken = |id: &str| engine.state().targets.iter().any(|t| t.id.as_str() == id);
    let mut id = base.clone();
    let mut n = 2;
    while taken(&id) {
        id = format!("{base}{n}");
        n += 1;
    }
    id
}

/// Emits calibration transitions to the frontend and tells the recipe engine which head location, if any, the
/// head is now dwelling on. Every `CalibrationRuntime` method that produces events routes through here, so a dwell
/// success, a tracker disconnect and a recalibration can never disagree about when a recipe's head stage holds.
fn handle_calibration_events(app: &AppHandle, events: Vec<CalibrationEvent>) {
    for event in &events {
        match event {
            CalibrationEvent::TargetEntered(target) => {
                app.state::<AutomationRuntime>()
                    .set_head(app, Some(target.as_str().to_string()));
            }
            CalibrationEvent::TargetExited(_) => {
                app.state::<AutomationRuntime>().set_head(app, None);
            }
        }
    }
    for event in events {
        match event {
            CalibrationEvent::TargetEntered(target) => {
                let _ = app.emit(TARGET_ENTERED_EVENT, target);
            }
            CalibrationEvent::TargetExited(target) => {
                let _ = app.emit(TARGET_EXITED_EVENT, target);
            }
        }
    }
}

#[cfg(test)]
mod location_id_tests {
    use super::*;

    #[test]
    fn ids_are_camel_case_slugs_that_never_collide() {
        let mut engine = HeadCalibration::default();
        assert_eq!(unused_id(&engine, "Left edge"), "leftEdge");
        assert_eq!(unused_id(&engine, "Top right"), "topRight2");
        assert_eq!(unused_id(&engine, "3rd monitor!"), "location3rdMonitor");
        engine
            .add_location(CalibrationTarget::new("leftEdge").unwrap(), "Left edge")
            .unwrap();
        assert_eq!(unused_id(&engine, "left  edge"), "leftEdge2");
        assert!(CalibrationTarget::new(unused_id(&engine, "日本")).is_ok());
    }
}
