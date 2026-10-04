use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use interaction_engine::{CalibrationEvent, CalibrationState, CalibrationTarget, HeadCalibration};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::overlay::{CornerWristVolumeDemoPhase, GrabOwner, OverlayRuntime, VolumeRuntime};
use crate::settings::SettingsRuntime;
use crate::watch::WatchRuntime;

pub const CALIBRATION_STATE_EVENT: &str = "head-calibration-state";
pub const TARGET_ENTERED_EVENT: &str = "head-target-entered";
pub const TARGET_EXITED_EVENT: &str = "head-target-exited";

const LOCATIONS_FILE_NAME: &str = "calibration-locations.json";

/// What the UI receives: the engine's state plus which location drives the volume knob.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationSnapshot {
    #[serde(flatten)]
    pub state: CalibrationState,
    pub volume_target: CalibrationTarget,
}

/// The locations worth keeping between runs. Captured poses are not: a head pose only means something
/// for the tracker session it was captured in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedLocations {
    volume_target: CalibrationTarget,
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
    /// Which location raises the volume overlay. Lock order: operations, latest pose, engine, this.
    volume_target: Mutex<CalibrationTarget>,
    latest_quaternion: Mutex<Option<[f64; 4]>>,
    started_at: Instant,
}

impl Default for CalibrationRuntime {
    fn default() -> Self {
        Self {
            operations: Mutex::new(()),
            engine: Mutex::new(HeadCalibration::default()),
            volume_target: Mutex::new(CalibrationTarget::top_right()),
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
        let (Ok(mut engine), Ok(mut volume)) = (self.engine.lock(), self.volume_target.lock())
        else {
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
        if engine
            .state()
            .targets
            .iter()
            .any(|t| t.id == saved.volume_target && !t.builtin)
        {
            *volume = saved.volume_target;
        } else if let Some(first) = engine.state().targets.iter().find(|t| !t.builtin) {
            *volume = first.id.clone();
        }
    }

    fn save(&self, app: &AppHandle, engine: &HeadCalibration, volume: &CalibrationTarget) {
        let saved = SavedLocations {
            volume_target: volume.clone(),
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

    fn snapshot(&self, engine: &HeadCalibration) -> Result<CalibrationSnapshot, String> {
        let volume_target = self
            .volume_target
            .lock()
            .map_err(|_| "volume target lock was poisoned")?
            .clone();
        Ok(CalibrationSnapshot {
            state: engine.state(),
            volume_target,
        })
    }

    /// The location that raises the volume overlay. Takes only its own lock, so it is safe to call while
    /// handling events from an operation that already holds the operation lock.
    pub fn volume_target(&self) -> CalibrationTarget {
        self.volume_target
            .lock()
            .map(|target| target.clone())
            .unwrap_or_else(|_| CalibrationTarget::top_right())
    }

    pub fn add_location(
        &self,
        app: &AppHandle,
        name: String,
    ) -> Result<CalibrationSnapshot, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let snapshot = {
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
            let snapshot = self.snapshot(&engine)?;
            self.save(app, &engine, &snapshot.volume_target);
            snapshot
        };
        let _ = app.emit(CALIBRATION_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    pub fn remove_location(
        &self,
        app: &AppHandle,
        target: CalibrationTarget,
    ) -> Result<CalibrationSnapshot, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let (events, snapshot) = {
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            if target == self.volume_target() {
                return Err(
                    "this location drives the volume knob; choose another location for it first"
                        .into(),
                );
            }
            let events = engine
                .remove_location(&target)
                .map_err(|error| error.to_string())?;
            let snapshot = self.snapshot(&engine)?;
            self.save(app, &engine, &snapshot.volume_target);
            (events, snapshot)
        };
        handle_calibration_events(app, events);
        let _ = app.emit(CALIBRATION_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    pub fn set_volume_target(
        &self,
        app: &AppHandle,
        target: CalibrationTarget,
    ) -> Result<CalibrationSnapshot, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let (events, snapshot) = {
            let mut engine = self
                .engine
                .lock()
                .map_err(|_| "calibration state lock was poisoned")?;
            let known = engine
                .state()
                .targets
                .iter()
                .any(|t| t.id == target && !t.builtin);
            if !known {
                return Err("choose a location other than Center".into());
            }
            // Moving the knob to another location ends any volume interaction the old one started.
            let was_active = engine.state().active_target.as_ref() == Some(&self.volume_target());
            let events = if was_active {
                engine.deactivate()
            } else {
                Vec::new()
            };
            *self
                .volume_target
                .lock()
                .map_err(|_| "volume target lock was poisoned")? = target;
            let snapshot = self.snapshot(&engine)?;
            self.save(app, &engine, &snapshot.volume_target);
            (events, snapshot)
        };
        handle_calibration_events(app, events);
        let _ = app.emit(CALIBRATION_STATE_EVENT, &snapshot);
        Ok(snapshot)
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

    pub fn invalidate(&self, app: &AppHandle) -> Result<CalibrationSnapshot, String> {
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
            (events, self.snapshot(&engine)?)
        };
        handle_calibration_events(app, events);
        let _ = app.emit(CALIBRATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn capture(
        &self,
        app: &AppHandle,
        target: CalibrationTarget,
    ) -> Result<CalibrationSnapshot, String> {
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
            (events, self.snapshot(&engine)?)
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
    ) -> Result<CalibrationSnapshot, String> {
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
            self.snapshot(&engine)?
        };
        let _ = app.emit(CALIBRATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn state(&self) -> Result<CalibrationSnapshot, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "calibration operation lock was poisoned")?;
        let engine = self
            .engine
            .lock()
            .map_err(|_| "calibration state lock was poisoned")?;
        self.snapshot(&engine)
    }
}

#[tauri::command]
pub fn get_calibration_state(
    runtime: State<'_, CalibrationRuntime>,
) -> Result<CalibrationSnapshot, String> {
    runtime.state()
}

#[tauri::command]
pub fn capture_calibration_target(
    target: CalibrationTarget,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationSnapshot, String> {
    runtime.capture(&app, target)
}

#[tauri::command]
pub fn add_calibration_location(
    name: String,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationSnapshot, String> {
    runtime.add_location(&app, name)
}

#[tauri::command]
pub fn remove_calibration_location(
    target: CalibrationTarget,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationSnapshot, String> {
    runtime.remove_location(&app, target)
}

#[tauri::command]
pub fn set_volume_target(
    target: CalibrationTarget,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationSnapshot, String> {
    runtime.set_volume_target(&app, target)
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

#[tauri::command]
pub fn update_calibration_config(
    activation_threshold_degrees: f64,
    dwell_ms: u64,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationSnapshot, String> {
    runtime.update_config(&app, activation_threshold_degrees, dwell_ms)
}

/// Emits calibration transitions to the frontend and, for the top-right
/// volume-knob location, drives the opt-in corner-gated wrist-volume demo
/// through the same `OverlayRuntime` seam the Watch-button and desktop-model
/// paths use. Both `TargetEntered`/`TargetExited(TopRight)` route through
/// here regardless of which `CalibrationRuntime` method produced them, so
/// dwell success, tracker disconnect, and recalibration invalidation can
/// never diverge on when the demo interaction starts or ends.
fn handle_calibration_events(app: &AppHandle, events: Vec<CalibrationEvent>) {
    let volume_target = app.state::<CalibrationRuntime>().volume_target();
    for event in &events {
        match event {
            CalibrationEvent::TargetEntered(target) if *target == volume_target => {
                start_corner_wrist_volume_demo(app);
            }
            CalibrationEvent::TargetExited(target) if *target == volume_target => {
                // Always safe: `OverlayRuntime::release` is a no-op unless a
                // corner-demo interaction (or another grab) is actually
                // active, so this can never disturb an unrelated STEM-button
                // or desktop-model interaction that happens to be in flight.
                if let Err(error) = app.state::<OverlayRuntime>().release(app) {
                    warn!(%error, "failed to release corner-gated wrist volume interaction");
                }
            }
            _ => {}
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

/// Pure gating decision for whether (and how) to start the corner-gated
/// wrist-volume demo, isolated from `AppHandle`/Tauri so it is directly unit
/// testable. `start_corner_wrist_volume_demo` is a thin dispatcher over this:
/// every precondition is evaluated here, and the caller just carries out
/// whichever single outcome comes back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CornerDemoStart {
    /// The operator has not opted in; completely inert.
    Disabled,
    /// Opted in, but the native volume backend on this platform can't
    /// actually be controlled -- never worth opening a reference pose for.
    VolumeUnsupported,
    /// Opted in and volume is controllable, but no live Watch orientation is
    /// available yet (Watch never connected, or just disconnected).
    NoOrientation,
    /// Every precondition holds: safe to grab and begin a fresh reference.
    Ready,
}

fn decide_corner_demo_start(
    demo_enabled: bool,
    available_volume: Result<Option<f32>, String>,
    has_live_orientation: bool,
) -> CornerDemoStart {
    if !demo_enabled {
        return CornerDemoStart::Disabled;
    }
    if !matches!(available_volume, Ok(Some(_))) {
        return CornerDemoStart::VolumeUnsupported;
    }
    if !has_live_orientation {
        return CornerDemoStart::NoOrientation;
    }
    CornerDemoStart::Ready
}

/// Starts the corner-gated wrist-volume demo interaction from the latest
/// valid Watch orientation, but only when the operator has opted in. Fails
/// closed on every unrecoverable precondition -- disabled demo mode, no live
/// Watch orientation, or a native volume backend that isn't actually
/// controllable -- by leaving the overlay ungrabbed and surfacing exactly
/// which precondition failed via `corner_demo_phase`, rather than opening a
/// reference pose that could never actually adjust volume. See
/// [`decide_corner_demo_start`] for the (separately unit-tested) gating logic.
fn start_corner_wrist_volume_demo(app: &AppHandle) {
    let settings = match app.state::<SettingsRuntime>().get() {
        Ok(settings) => settings,
        Err(error) => {
            warn!(%error, "failed to read settings for corner-gated wrist volume demo");
            return;
        }
    };
    let overlay = app.state::<OverlayRuntime>();
    let volume_runtime = app.state::<VolumeRuntime>();
    let orientation = app
        .state::<WatchRuntime>()
        .latest_orientation()
        .unwrap_or_default();

    let decision = decide_corner_demo_start(
        settings.corner_wrist_volume_demo_enabled,
        volume_runtime.available_volume(),
        orientation.is_some(),
    );
    if decision == CornerDemoStart::Disabled {
        return;
    }

    // Shown synchronously here rather than waiting for the frontend's own
    // `show_overlay` round trip: that round trip is triggered by the same
    // dwell-success event this function is already reacting to, so waiting
    // for it back would race `begin_volume_interaction`'s `grab()`, which
    // no-ops unless the overlay is already visible.
    if let Err(error) = overlay.show(app, &volume_runtime) {
        warn!(%error, "failed to show overlay for corner-gated wrist volume demo");
        return;
    }
    let _ = overlay.set_corner_demo_phase(app, Some(CornerWristVolumeDemoPhase::Targeting));

    match decision {
        CornerDemoStart::Disabled => unreachable!("already returned above"),
        CornerDemoStart::VolumeUnsupported => {
            let _ = overlay.set_corner_demo_phase(
                app,
                Some(CornerWristVolumeDemoPhase::UnavailableVolumeUnsupported),
            );
        }
        CornerDemoStart::NoOrientation => {
            let _ = overlay.set_corner_demo_phase(
                app,
                Some(CornerWristVolumeDemoPhase::UnavailableNoOrientation),
            );
        }
        CornerDemoStart::Ready => {
            match overlay.begin_volume_interaction(
                app,
                GrabOwner::CornerDemo,
                settings.corner_wrist_volume_config(),
                orientation.as_ref(),
                &volume_runtime,
            ) {
                Ok(state) if state.grabbed_by(GrabOwner::CornerDemo) => {
                    let _ =
                        overlay.set_corner_demo_phase(app, Some(CornerWristVolumeDemoPhase::Ready));
                }
                Ok(_) => {
                    let _ = overlay.set_corner_demo_phase(
                        app,
                        Some(CornerWristVolumeDemoPhase::UnavailableNoOrientation),
                    );
                }
                Err(error) => {
                    warn!(%error, "failed to begin corner-gated wrist volume interaction");
                    let _ = overlay.set_corner_demo_phase(
                        app,
                        Some(CornerWristVolumeDemoPhase::UnavailableNoOrientation),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod corner_demo_gating_tests {
    use super::*;

    #[test]
    fn disabled_demo_mode_is_inert_regardless_of_watch_or_volume_state() {
        assert_eq!(
            decide_corner_demo_start(false, Ok(Some(0.5)), true),
            CornerDemoStart::Disabled
        );
        assert_eq!(
            decide_corner_demo_start(false, Ok(None), false),
            CornerDemoStart::Disabled
        );
    }

    #[test]
    fn unsupported_or_errored_volume_backend_fails_closed_before_orientation_is_checked() {
        assert_eq!(
            decide_corner_demo_start(true, Ok(None), true),
            CornerDemoStart::VolumeUnsupported
        );
        assert_eq!(
            decide_corner_demo_start(true, Err("no backend".to_string()), true),
            CornerDemoStart::VolumeUnsupported
        );
    }

    #[test]
    fn missing_live_orientation_fails_closed_even_with_a_controllable_backend() {
        assert_eq!(
            decide_corner_demo_start(true, Ok(Some(0.5)), false),
            CornerDemoStart::NoOrientation
        );
    }

    #[test]
    fn every_precondition_satisfied_is_ready() {
        assert_eq!(
            decide_corner_demo_start(true, Ok(Some(0.5)), true),
            CornerDemoStart::Ready
        );
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
