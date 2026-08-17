use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use interaction_engine::{VolumeSimulation, commit_visibility_after, top_right_overlay_position};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use volume_control::{
    VolumeController, VolumeError, adjust_system_volume as adjust_native_volume,
    platform_volume_controller,
};

pub const OVERLAY_STATE_EVENT: &str = "overlay-state";
const MAIN_WINDOW: &str = "main";
const OVERLAY_WINDOW: &str = "overlay";
const SCREEN_EDGE_MARGIN: f64 = 16.0;

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

pub struct OverlayRuntime {
    state: Mutex<OverlayState>,
    state_generation: AtomicU64,
    refresh_in_flight: AtomicBool,
}

struct RefreshGuard<'a>(&'a AtomicBool);

impl Drop for RefreshGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub struct VolumeRuntime(Box<dyn VolumeController>);

impl Default for VolumeRuntime {
    fn default() -> Self {
        Self(platform_volume_controller())
    }
}

impl VolumeRuntime {
    fn controller(&self) -> &dyn VolumeController {
        self.0.as_ref()
    }

    fn available_volume(&self) -> Result<Option<f32>, String> {
        match self.controller().get_volume() {
            Ok(volume) => Ok(Some(volume)),
            Err(VolumeError::UnsupportedPlatform) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
}

impl Default for OverlayRuntime {
    fn default() -> Self {
        Self {
            state: Mutex::new(OverlayState::default()),
            state_generation: AtomicU64::new(0),
            refresh_in_flight: AtomicBool::new(false),
        }
    }
}

impl OverlayRuntime {
    fn state(&self) -> Result<OverlayState, String> {
        self.state
            .lock()
            .map(|state| *state)
            .map_err(|_| "overlay state lock was poisoned".to_string())
    }

    fn show(
        &self,
        app: &AppHandle,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        let available_volume = volume_runtime.available_volume()?;
        prepare_window(app)?;
        position_window_at_top_right(app, &window)?;
        commit_visibility_after(&mut state.visible, true, || {
            window.show().map_err(|error| error.to_string())
        })?;
        if let Some(volume) = available_volume {
            state.volume = volume * 100.0;
        }
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = *state;
        let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
        Ok(snapshot)
    }

    fn hide(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        commit_visibility_after(&mut state.visible, false, || {
            window.hide().map_err(|error| error.to_string())
        })?;
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = *state;
        let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
        Ok(snapshot)
    }

    fn adjust_system_volume(
        &self,
        app: &AppHandle,
        delta: f32,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible {
            return Err(VolumeError::OverlayInactive.to_string());
        }
        if !delta.is_finite() {
            return Err(VolumeError::InvalidAdjustment.to_string());
        }
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let normalized = adjust_native_volume(volume_runtime.controller(), true, delta)
            .map_err(|error| error.to_string())?;
        state.volume = normalized * 100.0;
        let snapshot = *state;
        let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
        Ok(snapshot)
    }

    fn refresh_system_volume(
        &self,
        app: &AppHandle,
        volume_runtime: &VolumeRuntime,
        refresh_generation: u64,
    ) -> Result<OverlayState, String> {
        let available_volume = volume_runtime.available_volume()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible || self.state_generation.load(Ordering::Acquire) != refresh_generation {
            return Ok(*state);
        }
        if let Some(volume) = available_volume {
            let refreshed_volume = (volume * 100.0).round();
            if state.volume != refreshed_volume {
                state.volume = refreshed_volume;
                self.state_generation.fetch_add(1, Ordering::AcqRel);
                let _ = app.emit(OVERLAY_STATE_EVENT, *state);
            }
        }
        Ok(*state)
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

fn position_window_at_top_right(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let main_monitor = app
        .get_webview_window(MAIN_WINDOW)
        .map(|main| main.current_monitor())
        .transpose()
        .map_err(|error| error.to_string())?
        .flatten();
    let monitor = match main_monitor {
        Some(monitor) => Some(monitor),
        None => window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .or(window
                .primary_monitor()
                .map_err(|error| error.to_string())?),
    }
    .ok_or("no monitor is available for the volume overlay")?;

    let work_area = monitor.work_area();
    let current_scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let logical_window_size = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(current_scale_factor);
    let (x, y) = top_right_overlay_position(
        (work_area.position.x, work_area.position.y),
        (work_area.size.width, work_area.size.height),
        (logical_window_size.width, logical_window_size.height),
        monitor.scale_factor(),
        SCREEN_EDGE_MARGIN,
    )
    .ok_or("invalid monitor or overlay geometry")?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_overlay_state(runtime: State<'_, OverlayRuntime>) -> Result<OverlayState, String> {
    runtime.state()
}

#[tauri::command]
pub fn show_overlay(
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
    volume_runtime: State<'_, VolumeRuntime>,
) -> Result<OverlayState, String> {
    runtime.show(&app, &volume_runtime)
}

#[tauri::command]
pub fn hide_overlay(
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
) -> Result<OverlayState, String> {
    runtime.hide(&app)
}

#[tauri::command]
pub fn adjust_system_volume(
    delta: f32,
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
    volume_runtime: State<'_, VolumeRuntime>,
) -> Result<OverlayState, String> {
    runtime.adjust_system_volume(&app, delta, &volume_runtime)
}

#[tauri::command]
pub async fn refresh_system_volume(app: AppHandle) -> Result<OverlayState, String> {
    let runtime = app.state::<OverlayRuntime>();
    let refresh_generation = {
        let state = runtime
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible
            || runtime
                .refresh_in_flight
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Ok(*state);
        }
        runtime.state_generation.load(Ordering::Acquire)
    };
    let _refresh_guard = RefreshGuard(&runtime.refresh_in_flight);

    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = worker_app.state::<OverlayRuntime>();
        let volume_runtime = worker_app.state::<VolumeRuntime>();
        runtime.refresh_system_volume(&worker_app, &volume_runtime, refresh_generation)
    })
    .await
    .map_err(|error| format!("system volume refresh task failed: {error}"))?
}
