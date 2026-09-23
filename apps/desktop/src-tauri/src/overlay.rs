use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use interaction_engine::{
    VolumeSimulation, WristRotation, WristRotationConfig, commit_visibility_after,
    top_right_overlay_position,
};
use serde::Serialize;
use spatial_protocol::WatchOrientationSample;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use tracing::warn;
use volume_control::{
    VolumeController, VolumeError, adjust_system_volume as adjust_native_volume,
    platform_volume_controller,
};
use watch_bridge::{HapticCommand, WatchBridgeServer};

pub const OVERLAY_STATE_EVENT: &str = "overlay-state";
const MAIN_WINDOW: &str = "main";
const OVERLAY_WINDOW: &str = "overlay";
const SCREEN_EDGE_MARGIN: f64 = 16.0;
const WRIST_ROTATION_HAPTIC_DURATION_MS: u32 = 20;
const WRIST_ROTATION_HAPTIC_MIN_INTERVAL: Duration = Duration::from_millis(125);
/// Caps how often the raw relative-roll diagnostic (below) can update and
/// emit, independent of the Watch orientation sample rate (up to ~50Hz) --
/// enough for a human to see the wrist roll changing during macOS bring-up
/// without turning this diagnostic into a raw high-rate sensor stream.
const WRIST_ROTATION_DIAGNOSTIC_MIN_INTERVAL: Duration = Duration::from_millis(200);

/// Compact status for the corner-gated wrist-volume demo, surfaced on
/// [`OverlayState`] so the operator can tell targeting from an actual
/// adjustment, and (when neither can happen yet) exactly why: missing Watch
/// orientation or an unsupported native volume backend. `None` whenever the
/// demo mode is off or no corner-demo interaction is in progress -- it never
/// appears merely because the Watch is connected or the wrist moves.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CornerWristVolumeDemoPhase {
    Targeting,
    Ready,
    Adjusting,
    UnavailableNoOrientation,
    UnavailableVolumeUnsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub visible: bool,
    pub grabbed: bool,
    pub volume: f32,
    pub rotation_angle: f32,
    pub screen_x: f64,
    pub screen_y: f64,
    pub corner_demo_phase: Option<CornerWristVolumeDemoPhase>,
    /// Raw relative roll (degrees from the wrist-rotation reference pose),
    /// throttled to [`WRIST_ROTATION_DIAGNOSTIC_MIN_INTERVAL`]. `None`
    /// whenever no wrist-rotation reference is active (corner demo not
    /// gripping, Watch-button/desktop-model grab not active either).
    pub last_relative_roll_degrees: Option<f32>,
    /// The error string from the most recent failed native volume read or
    /// write, cleared on the next successful one of either kind. `None`
    /// means the last native volume operation (if any) succeeded.
    pub last_native_volume_error: Option<String>,
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
            corner_demo_phase: None,
            last_relative_roll_degrees: None,
            last_native_volume_error: None,
        }
    }
}

pub struct OverlayRuntime {
    state: Mutex<OverlayState>,
    wrist_rotation: Mutex<WristRotation>,
    state_generation: AtomicU64,
    refresh_in_flight: AtomicBool,
    last_wrist_rotation_haptic_at: Mutex<Option<Instant>>,
    last_relative_roll_diagnostic_at: Mutex<Option<Instant>>,
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

    pub(crate) fn available_volume(&self) -> Result<Option<f32>, String> {
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
            wrist_rotation: Mutex::new(WristRotation::default()),
            state_generation: AtomicU64::new(0),
            refresh_in_flight: AtomicBool::new(false),
            last_wrist_rotation_haptic_at: Mutex::new(None),
            last_relative_roll_diagnostic_at: Mutex::new(None),
        }
    }
}

impl OverlayRuntime {
    fn state(&self) -> Result<OverlayState, String> {
        self.state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "overlay state lock was poisoned".to_string())
    }

    /// Shows the overlay window. `pub(crate)` (rather than only reachable via
    /// the `show_overlay` command) so the corner-gated wrist-volume demo can
    /// show it synchronously the instant dwell succeeds, instead of racing
    /// the frontend's own round trip in response to the same dwell event.
    /// Idempotent: safe to call again after the frontend's own `show_overlay`
    /// arrives moments later.
    pub(crate) fn show(
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
        let available_volume = match volume_runtime.available_volume() {
            Ok(volume) => volume,
            Err(error) => {
                state.last_native_volume_error = Some(error.clone());
                self.state_generation.fetch_add(1, Ordering::AcqRel);
                let snapshot = state.clone();
                let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
                return Err(error);
            }
        };
        state.last_native_volume_error = None;
        prepare_window(app)?;
        position_window_at_top_right(app, &window)?;
        commit_visibility_after(&mut state.visible, true, || {
            window.show().map_err(|error| error.to_string())
        })?;
        if let Some(volume) = available_volume {
            state.volume = volume * 100.0;
        }
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Hides the overlay (Escape, leaving the target, tracker disconnect, or
    /// unmount). Unconditionally drops `grabbed` and the corner-demo phase
    /// and ends any wrist-rotation reference -- same as [`Self::release`] --
    /// so Escape fails an active corner-demo interaction closed exactly like
    /// every other exit path, even though `hide_overlay` is the command the
    /// frontend actually calls for it instead of a dedicated release.
    fn hide(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        state.grabbed = false;
        state.corner_demo_phase = None;
        state.last_relative_roll_degrees = None;
        self.wrist_rotation
            .lock()
            .map_err(|_| "wrist rotation lock was poisoned")?
            .end();
        commit_visibility_after(&mut state.visible, false, || {
            window.hide().map_err(|error| error.to_string())
        })?;
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Marks the overlay grabbed by a held watch button. A no-op unless the
    /// overlay is currently shown (dwelling on the calibrated top-right target).
    pub(crate) fn grab(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible || state.grabbed {
            return Ok(state.clone());
        }
        state.grabbed = true;
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Releases a watch-button grab and hides the overlay, so a button-up or a
    /// watch disconnect can never leave the overlay stuck grabbed/visible.
    pub(crate) fn release(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.grabbed && !state.visible && state.corner_demo_phase.is_none() {
            return Ok(state.clone());
        }
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        state.grabbed = false;
        state.corner_demo_phase = None;
        state.last_relative_roll_degrees = None;
        self.wrist_rotation
            .lock()
            .map_err(|_| "wrist rotation lock was poisoned")?
            .end();
        commit_visibility_after(&mut state.visible, false, || {
            window.hide().map_err(|error| error.to_string())
        })?;
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Atomically begins a wrist-rotation volume interaction: grabs the
    /// overlay and establishes a fresh rotation reference under
    /// `wrist_config` from `orientation`, as one transaction. This is the
    /// single seam both the Watch-button and the approved desktop-model
    /// paths call, so neither can leave the overlay visually grabbed with a
    /// stale or missing reference pose. Fails closed: a missing orientation
    /// sample or an invalid configuration rolls the grab back via
    /// [`Self::release`] instead of leaving a partial interaction active.
    pub(crate) fn begin_volume_interaction(
        &self,
        app: &AppHandle,
        wrist_config: WristRotationConfig,
        orientation: Option<&WatchOrientationSample>,
    ) -> Result<OverlayState, String> {
        let grabbed = self.grab(app)?;
        if !grabbed.grabbed {
            // Overlay was not visible/dwelling: grab() correctly no-op'd.
            return Ok(grabbed);
        }
        let Some(orientation) = orientation else {
            warn!("volume interaction grabbed with no orientation sample available; releasing");
            return self.release(app);
        };
        let began = self
            .wrist_rotation
            .lock()
            .map_err(|_| "wrist rotation lock was poisoned")?
            .begin_with_config(
                wrist_config,
                orientation.quaternion,
                orientation.timestamp_ns,
            );
        if let Err(error) = began {
            warn!(%error, "failed to begin wrist rotation reference; releasing grab");
            return self.release(app);
        }
        self.state()
    }

    pub(crate) fn apply_wrist_rotation(
        &self,
        app: &AppHandle,
        sample: &WatchOrientationSample,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let (delta, relative_degrees) = {
            let mut wrist_rotation = self
                .wrist_rotation
                .lock()
                .map_err(|_| "wrist rotation lock was poisoned")?;
            let delta = wrist_rotation
                .observe(sample.quaternion, sample.timestamp_ns)
                .map_err(|error| error.to_string())? as f32;
            (delta, wrist_rotation.last_relative_degrees())
        };
        self.update_relative_roll_diagnostic(app, relative_degrees.map(|degrees| degrees as f32));
        let state = self.state()?;
        if !state.grabbed || delta.abs() < f32::EPSILON {
            let next_phase = corner_demo_phase_after_sample(state.corner_demo_phase, false);
            if next_phase != state.corner_demo_phase {
                return self.set_corner_demo_phase(app, next_phase);
            }
            return Ok(state);
        }
        let applied = self.adjust_system_volume(app, delta, volume_runtime)?;
        if (applied.volume - state.volume).abs() >= f32::EPSILON {
            self.notify_wrist_rotation_haptic(app);
        }
        let next_phase = corner_demo_phase_after_sample(state.corner_demo_phase, true);
        if next_phase != state.corner_demo_phase {
            return self.set_corner_demo_phase(app, next_phase);
        }
        Ok(applied)
    }

    /// Sets the corner-demo status shown on the overlay; a no-op (no emit, no
    /// generation bump) when the phase is already what's requested. The sole
    /// mutator of [`OverlayState::corner_demo_phase`] outside [`Self::release`],
    /// which always clears it back to `None` -- so every path that can end a
    /// corner-demo interaction (target exit, tracker loss, Watch disconnect,
    /// Escape, a malformed/stale message) already fails it closed for free.
    pub(crate) fn set_corner_demo_phase(
        &self,
        app: &AppHandle,
        phase: Option<CornerWristVolumeDemoPhase>,
    ) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if state.corner_demo_phase == phase {
            return Ok(state.clone());
        }
        state.corner_demo_phase = phase;
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Best-effort haptic pulse confirming a wrist-rotation volume adjustment
    /// was actually applied. Rate-limited so a fast orientation stream can't
    /// spam the watch with pulses; never allowed to fail volume control.
    fn notify_wrist_rotation_haptic(&self, app: &AppHandle) {
        let Some(server) = app.try_state::<Arc<WatchBridgeServer>>() else {
            return;
        };
        let Ok(mut last_sent) = self.last_wrist_rotation_haptic_at.lock() else {
            return;
        };
        let now = Instant::now();
        if last_sent.is_some_and(|previous| {
            now.duration_since(previous) < WRIST_ROTATION_HAPTIC_MIN_INTERVAL
        }) {
            return;
        }
        *last_sent = Some(now);
        drop(last_sent);
        if let Err(error) = server.send_haptic_command(HapticCommand {
            duration_ms: WRIST_ROTATION_HAPTIC_DURATION_MS,
        }) {
            warn!(%error, "failed to send wrist rotation haptic pulse");
        }
    }

    /// Updates the throttled raw-relative-roll diagnostic and emits it, but
    /// only at most every [`WRIST_ROTATION_DIAGNOSTIC_MIN_INTERVAL`] and only
    /// when the value actually changed -- so a live orientation stream (up to
    /// ~50Hz) can never turn this into a raw high-rate sensor feed on the
    /// wire, while still proving the wrist roll is moving during bring-up.
    fn update_relative_roll_diagnostic(&self, app: &AppHandle, relative_degrees: Option<f32>) {
        let Ok(mut last_emit) = self.last_relative_roll_diagnostic_at.lock() else {
            return;
        };
        let now = Instant::now();
        if last_emit.is_some_and(|previous| {
            now.duration_since(previous) < WRIST_ROTATION_DIAGNOSTIC_MIN_INTERVAL
        }) {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.last_relative_roll_degrees == relative_degrees {
            return;
        }
        *last_emit = Some(now);
        drop(last_emit);
        state.last_relative_roll_degrees = relative_degrees;
        let snapshot = state.clone();
        drop(state);
        let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
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
        let normalized = match adjust_native_volume(volume_runtime.controller(), true, delta) {
            Ok(normalized) => normalized,
            Err(error) => {
                let message = error.to_string();
                state.last_native_volume_error = Some(message.clone());
                let snapshot = state.clone();
                let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
                return Err(message);
            }
        };
        state.last_native_volume_error = None;
        state.volume = normalized * 100.0;
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    fn refresh_system_volume(
        &self,
        app: &AppHandle,
        volume_runtime: &VolumeRuntime,
        refresh_generation: u64,
    ) -> Result<OverlayState, String> {
        let available_volume = match volume_runtime.available_volume() {
            Ok(volume) => volume,
            Err(error) => {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "overlay state lock was poisoned")?;
                state.last_native_volume_error = Some(error.clone());
                self.state_generation.fetch_add(1, Ordering::AcqRel);
                let snapshot = state.clone();
                let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
                return Err(error);
            }
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible || self.state_generation.load(Ordering::Acquire) != refresh_generation {
            return Ok(state.clone());
        }
        let mut changed = false;
        if state.last_native_volume_error.is_some() {
            state.last_native_volume_error = None;
            changed = true;
        }
        if let Some(volume) = available_volume {
            let refreshed_volume = (volume * 100.0).round();
            if state.volume != refreshed_volume {
                state.volume = refreshed_volume;
                changed = true;
            }
        }
        if changed {
            self.state_generation.fetch_add(1, Ordering::AcqRel);
            let _ = app.emit(OVERLAY_STATE_EVENT, state.clone());
        }
        Ok(state.clone())
    }
}

/// Pure phase-transition rule for the corner-demo status while a sample is
/// applied: while the demo interaction is `Ready`/`Adjusting`, reflects
/// whether *this* sample actually produced a volume delta; every other
/// phase (including `None`, meaning no corner-demo interaction is active)
/// passes through untouched. Kept free of `AppHandle`/locking so it is
/// directly unit-testable and can never resurrect a phase for the
/// Watch-button or desktop-model paths, which never set one in the first
/// place.
fn corner_demo_phase_after_sample(
    current: Option<CornerWristVolumeDemoPhase>,
    delta_applied: bool,
) -> Option<CornerWristVolumeDemoPhase> {
    match current {
        Some(CornerWristVolumeDemoPhase::Ready) | Some(CornerWristVolumeDemoPhase::Adjusting) => {
            Some(if delta_applied {
                CornerWristVolumeDemoPhase::Adjusting
            } else {
                CornerWristVolumeDemoPhase::Ready
            })
        }
        other => other,
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
            return Ok(state.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corner_demo_phase_toggles_between_ready_and_adjusting_while_active() {
        assert_eq!(
            corner_demo_phase_after_sample(Some(CornerWristVolumeDemoPhase::Ready), true),
            Some(CornerWristVolumeDemoPhase::Adjusting)
        );
        assert_eq!(
            corner_demo_phase_after_sample(Some(CornerWristVolumeDemoPhase::Adjusting), false),
            Some(CornerWristVolumeDemoPhase::Ready)
        );
        assert_eq!(
            corner_demo_phase_after_sample(Some(CornerWristVolumeDemoPhase::Ready), false),
            Some(CornerWristVolumeDemoPhase::Ready)
        );
    }

    #[test]
    fn corner_demo_phase_leaves_inactive_or_unavailable_phases_untouched() {
        // No corner-demo interaction active: a wrist sample must never
        // conjure a phase out of nothing (Watch-button/desktop-model grabs
        // never set one).
        assert_eq!(corner_demo_phase_after_sample(None, true), None);
        assert_eq!(corner_demo_phase_after_sample(None, false), None);
        // An unavailable reason is a terminal display state until the next
        // explicit `set_corner_demo_phase`/`release`/`hide` call -- a stray
        // sample must not paper over it with `Ready`.
        assert_eq!(
            corner_demo_phase_after_sample(
                Some(CornerWristVolumeDemoPhase::UnavailableNoOrientation),
                true
            ),
            Some(CornerWristVolumeDemoPhase::UnavailableNoOrientation)
        );
        assert_eq!(
            corner_demo_phase_after_sample(Some(CornerWristVolumeDemoPhase::Targeting), false),
            Some(CornerWristVolumeDemoPhase::Targeting)
        );
    }
}
