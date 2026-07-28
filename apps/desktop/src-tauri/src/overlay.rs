use std::sync::Mutex;

use interaction_engine::{VolumeSimulation, commit_visibility_after};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const OVERLAY_STATE_EVENT: &str = "overlay-state";
const OVERLAY_WINDOW: &str = "overlay";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub visible: bool,
    pub grabbed: bool,
    pub volume: f32,
    pub rotation_angle: f32,
    pub screen_x: f64,
    pub screen_y: f64,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            visible: false,
            grabbed: false,
            volume: VolumeSimulation::default().current(),
            rotation_angle: 0.0,
            screen_x: 0.0,
            screen_y: 0.0,
        }
    }
}

pub struct OverlayRuntime(Mutex<OverlayState>);

impl Default for OverlayRuntime {
    fn default() -> Self {
        Self(Mutex::new(OverlayState::default()))
    }
}

impl OverlayRuntime {
    fn state(&self) -> Result<OverlayState, String> {
        self.0
            .lock()
            .map(|state| *state)
            .map_err(|_| "overlay state lock was poisoned".to_string())
    }

    fn show(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        prepare_window(app)?;
        commit_visibility_after(&mut state.visible, true, || {
            window.show().map_err(|error| error.to_string())
        })?;
        let snapshot = *state;
        let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
        Ok(snapshot)
    }

    fn hide(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        commit_visibility_after(&mut state.visible, false, || {
            window.hide().map_err(|error| error.to_string())
        })?;
        let snapshot = *state;
        let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
        Ok(snapshot)
    }

    fn adjust(&self, app: &AppHandle, delta: f32) -> Result<OverlayState, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        let mut volume = VolumeSimulation::new(state.volume).map_err(|error| error.to_string())?;
        state.volume = volume.adjust(delta);
        let snapshot = *state;
        let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
        Ok(snapshot)
    }
}

pub fn prepare_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or("overlay window is not configured")?;
    window
        .set_focusable(false)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_overlay_state(runtime: State<'_, OverlayRuntime>) -> Result<OverlayState, String> {
    runtime.state()
}

#[tauri::command]
pub fn show_overlay(
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
) -> Result<OverlayState, String> {
    runtime.show(&app)
}

#[tauri::command]
pub fn hide_overlay(
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
) -> Result<OverlayState, String> {
    runtime.hide(&app)
}

#[tauri::command]
pub fn adjust_simulated_volume(
    delta: f32,
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
) -> Result<OverlayState, String> {
    if !delta.is_finite() {
        return Err("volume adjustment must be finite".to_string());
    }
    runtime.adjust(&app, delta)
}
