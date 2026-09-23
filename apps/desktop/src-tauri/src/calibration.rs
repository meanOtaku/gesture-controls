use std::sync::Mutex;
use std::time::Instant;

use interaction_engine::{CalibrationEvent, CalibrationState, CalibrationTarget, HeadCalibration};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::overlay::{CornerWristVolumeDemoPhase, OverlayRuntime, VolumeRuntime};
use crate::settings::SettingsRuntime;
use crate::watch::WatchRuntime;

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
                .capture(target, quaternion)
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

/// Emits calibration transitions to the frontend and, for the top-right
/// target specifically, drives the opt-in corner-gated wrist-volume demo
/// through the same `OverlayRuntime` seam the Watch-button and desktop-model
/// paths use. Both `TargetEntered`/`TargetExited(TopRight)` route through
/// here regardless of which `CalibrationRuntime` method produced them, so
/// dwell success, tracker disconnect, and recalibration invalidation can
/// never diverge on when the demo interaction starts or ends.
fn handle_calibration_events(app: &AppHandle, events: Vec<CalibrationEvent>) {
    for event in &events {
        match event {
            CalibrationEvent::TargetEntered(CalibrationTarget::TopRight) => {
                start_corner_wrist_volume_demo(app);
            }
            CalibrationEvent::TargetExited(CalibrationTarget::TopRight) => {
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
                settings.corner_wrist_volume_config(),
                orientation.as_ref(),
                &volume_runtime,
            ) {
                Ok(state) if state.grabbed => {
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
