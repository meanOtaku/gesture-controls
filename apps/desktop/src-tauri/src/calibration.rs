use std::sync::Mutex;
use std::time::Instant;

use interaction_engine::{CalibrationEvent, CalibrationState, CalibrationTarget, HeadCalibration};
use tauri::{AppHandle, Emitter, State};

pub const CALIBRATION_STATE_EVENT: &str = "head-calibration-state";
pub const TARGET_ENTERED_EVENT: &str = "head-target-entered";
pub const TARGET_EXITED_EVENT: &str = "head-target-exited";

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
        emit_calibration_events(app, events);
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
        emit_calibration_events(app, events);
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
        emit_calibration_events(app, events);
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
                .capture(target, quaternion)
                .map_err(|error| error.to_string())?;
            (events, engine.state())
        };
        emit_calibration_events(app, events);
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
        Ok(self
            .engine
            .lock()
            .map_err(|_| "calibration state lock was poisoned")?
            .state())
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
pub fn update_calibration_config(
    activation_threshold_degrees: f64,
    dwell_ms: u64,
    runtime: State<'_, CalibrationRuntime>,
    app: AppHandle,
) -> Result<CalibrationState, String> {
    runtime.update_config(&app, activation_threshold_degrees, dwell_ms)
}

fn emit_calibration_events(app: &AppHandle, events: Vec<CalibrationEvent>) {
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
