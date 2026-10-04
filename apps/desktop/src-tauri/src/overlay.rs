use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use interaction_engine::{VolumeSimulation, commit_visibility_after, top_right_overlay_position};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use tracing::warn;
use volume_control::{
    VolumeController, VolumeError, adjust_system_volume as adjust_native_volume,
    platform_volume_controller, set_system_volume as set_native_volume,
};
use watch_bridge::{HapticCommand, WatchBridgeServer};

use crate::latest_write::{LatestWriteSlot, PendingWrite};

pub const OVERLAY_STATE_EVENT: &str = "overlay-state";
const MAIN_WINDOW: &str = "main";
const OVERLAY_WINDOW: &str = "overlay";
const SCREEN_EDGE_MARGIN: f64 = 16.0;
const WRIST_ROTATION_HAPTIC_DURATION_MS: u32 = 20;
const WRIST_ROTATION_HAPTIC_MIN_INTERVAL: Duration = Duration::from_millis(125);
/// Minimum spacing between native volume writes driven by wrist rotation.
/// The Watch streams orientation at up to ~50Hz and every write is a blocking
/// native call (a `wpctl`/`pactl` subprocess on Linux). Targets are absolute,
/// so a skipped sample loses nothing: the next one carries the current angle.
const WRIST_ROTATION_VOLUME_WRITE_MIN_INTERVAL: Duration = Duration::from_millis(100);
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub visible: bool,
    pub grabbed: bool,
    pub volume: f32,
    pub rotation_angle: f32,
    pub screen_x: f64,
    pub screen_y: f64,
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
            last_native_volume_error: None,
        }
    }
}

pub struct OverlayRuntime {
    state: Mutex<OverlayState>,
    /// The volume a recipe-driven interaction is steering towards; see [`RecipeDrive`].
    recipe_drive: Mutex<RecipeDrive>,
    state_generation: AtomicU64,
    refresh_in_flight: AtomicBool,
    last_wrist_rotation_haptic_at: Mutex<Option<Instant>>,
    /// True while haptic sends are failing (e.g. no active watch connection),
    /// so a stream of failures logs once instead of on every sample.
    haptic_send_failing: AtomicBool,
    /// Hand-off of wrist-rotation volume targets to the writer thread; see
    /// [`crate::latest_write`] for why the write must not run on the watch event loop.
    wrist_volume_slot: Arc<LatestWriteSlot>,
    wrist_writer_started: Once,
    /// Identifies the current volume interaction. Bumped whenever one begins or ends, so a
    /// queued write from an earlier interaction is dropped instead of landing on a later one.
    interaction_epoch: AtomicU64,
    /// Orders native volume writes among themselves. Deliberately separate
    /// from `state`: a blocking native command must never be held under the
    /// lock that `hide`/`release`/`grab` need, or a hung audio adapter would
    /// stall every cancellation path (Escape, button-up, disconnect, model
    /// swap) for the adapter's whole timeout.
    native_write_lock: Mutex<()>,
}

/// How far a recipe-driven interaction has asked the volume to move, in volume points (0..=100).
///
/// `wanted` is the base volume plus every change the device has asked for; `submitted` follows it no faster
/// than the configured slew rate, so a fast wrist flick cannot change the loudness faster than that.
#[derive(Debug, Default, Clone, Copy)]
struct RecipeDrive {
    wanted: f32,
    submitted: f32,
    last_at: Option<Instant>,
}

impl RecipeDrive {
    fn begin(base_percent: f32) -> Self {
        Self {
            wanted: base_percent,
            submitted: base_percent,
            last_at: None,
        }
    }

    /// Adds a device change and returns the slew-limited target to write.
    fn advance(&mut self, delta_percent: f32, max_points_per_second: f32, now: Instant) -> f32 {
        self.wanted = (self.wanted + delta_percent).clamp(0.0, 100.0);
        let elapsed = self
            .last_at
            .map_or(0.0, |at| now.duration_since(at).as_secs_f32());
        self.last_at = Some(now);
        let max_step = max_points_per_second * elapsed.max(0.02);
        self.submitted += (self.wanted - self.submitted).clamp(-max_step, max_step);
        self.submitted
    }
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
            recipe_drive: Mutex::new(RecipeDrive::default()),
            state_generation: AtomicU64::new(0),
            refresh_in_flight: AtomicBool::new(false),
            last_wrist_rotation_haptic_at: Mutex::new(None),
            haptic_send_failing: AtomicBool::new(false),
            wrist_volume_slot: Arc::new(LatestWriteSlot::default()),
            wrist_writer_started: Once::new(),
            interaction_epoch: AtomicU64::new(0),
            native_write_lock: Mutex::new(()),
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

    /// Shows the overlay window. Idempotent, so every recipe update can ask for it without checking first.
    pub(crate) fn show(
        &self,
        app: &AppHandle,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        // Serialize the native volume read with volume writes (they hold the
        // same lock for the whole of theirs), so a write cannot land between
        // this read and the commit below and leave a stale volume on screen.
        // This is deliberately *not* the state lock: `hide`/`release` take only
        // that one, so a slow or hung audio adapter cannot stall them.
        let _write_order = self
            .native_write_lock
            .lock()
            .map_err(|_| "native volume write lock was poisoned")?;
        let available_volume = volume_runtime.available_volume();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        let available_volume = match available_volume {
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

    /// Hides the overlay (Escape, leaving the target, tracker disconnect, or unmount). Unconditionally drops
    /// `grabbed`, the same as [`Self::release`], so Escape ends an interaction like every other exit path.
    fn hide(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        state.grabbed = false;
        self.end_interaction();
        commit_visibility_after(&mut state.visible, false, || {
            window.hide().map_err(|error| error.to_string())
        })?;
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Ends the current volume interaction as far as queued writes are concerned: any write
    /// waiting for the writer thread belongs to it and must not be applied.
    fn end_interaction(&self) {
        self.interaction_epoch.fetch_add(1, Ordering::AcqRel);
        self.wrist_volume_slot.clear();
    }

    /// Releases any grab and hides the overlay, so a disconnect, Escape, a recipe ending or a forced release
    /// can never leave the overlay stuck grabbed or visible.
    pub(crate) fn release(&self, app: &AppHandle) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.grabbed && !state.visible {
            return Ok(state.clone());
        }
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        state.grabbed = false;
        self.end_interaction();
        commit_visibility_after(&mut state.visible, false, || {
            window.hide().map_err(|error| error.to_string())
        })?;
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Shows the knob without grabbing it: the user is looking at its location but has not yet started
    /// turning. Ends a grab if one was in progress.
    pub(crate) fn show_armed(
        &self,
        app: &AppHandle,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let snapshot = self.show(app, volume_runtime)?;
        if !snapshot.grabbed {
            return Ok(snapshot);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        state.grabbed = false;
        self.end_interaction();
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Begins a recipe-driven volume interaction: shows the knob, grabs it, and anchors every change the
    /// device asks for to the volume as it is now. Fails closed: if the native volume cannot be read the
    /// grab is rolled back instead of leaving the knob grabbed with nothing to steer.
    pub(crate) fn begin_recipe_interaction(
        &self,
        app: &AppHandle,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        self.show(app, volume_runtime)?;
        let base_percent = match volume_runtime.available_volume() {
            Ok(Some(volume)) => volume * 100.0,
            Ok(None) => {
                warn!(
                    "recipe volume interaction has no controllable native volume backend; releasing"
                );
                return self.release(app);
            }
            Err(error) => {
                warn!(%error, "failed to read the starting volume for a recipe; releasing");
                return self.release(app);
            }
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible {
            return Ok(state.clone());
        }
        state.grabbed = true;
        self.end_interaction();
        *self
            .recipe_drive
            .lock()
            .map_err(|_| "recipe drive lock was poisoned")? = RecipeDrive::begin(base_percent);
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Hands one device change (a fraction of the full range) to the writer thread.
    ///
    /// This runs on the watch event loop, so it must stay cheap: the native volume call, which can take
    /// 130-190 ms, is done by [`Self::ensure_wrist_writer`]'s thread instead. A target is skipped, not
    /// queued, when a newer one arrives first; see [`crate::latest_write`].
    pub(crate) fn apply_recipe_delta(
        &self,
        app: &AppHandle,
        delta_fraction: f64,
        max_points_per_second: f64,
    ) -> Result<(), String> {
        if !self.state()?.grabbed {
            return Ok(());
        }
        let target = self
            .recipe_drive
            .lock()
            .map_err(|_| "recipe drive lock was poisoned")?
            .advance(
                (delta_fraction * 100.0) as f32,
                max_points_per_second as f32,
                Instant::now(),
            );
        self.ensure_wrist_writer(app);
        self.wrist_volume_slot.submit(PendingWrite {
            target_percent: target,
            epoch: self.interaction_epoch.load(Ordering::Acquire),
        });
        Ok(())
    }

    /// Starts the writer thread on first use. It lives for the rest of the process, blocking
    /// on the mailbox while idle, so a quiet period costs nothing.
    fn ensure_wrist_writer(&self, app: &AppHandle) {
        self.wrist_writer_started.call_once(|| {
            let slot = Arc::clone(&self.wrist_volume_slot);
            let app = app.clone();
            let spawned = std::thread::Builder::new()
                .name("wrist-volume-writer".to_string())
                .spawn(move || {
                    let mut last_write_at: Option<Instant> = None;
                    while let Some(mut job) = slot.take_blocking() {
                        // Pace the writes, then send the freshest target rather than the one
                        // that woke us.
                        let wait = write_pacing_wait(last_write_at, Instant::now());
                        if !wait.is_zero() {
                            std::thread::sleep(wait);
                            job = slot.refresh(job);
                        }
                        let overlay = app.state::<OverlayRuntime>();
                        let volume_runtime = app.state::<VolumeRuntime>();
                        overlay.write_wrist_volume(&app, job, &volume_runtime);
                        last_write_at = Some(Instant::now());
                    }
                });
            if let Err(error) = spawned {
                warn!(%error, "failed to start the wrist volume writer; wrist volume control is unavailable");
            }
        });
    }

    /// Applies one queued wrist target, on the writer thread. Checks again, at the moment of
    /// the write, that the interaction it was queued for is still the current one and still
    /// grabbed: a release or a new grab while it waited makes it stale.
    fn write_wrist_volume(
        &self,
        app: &AppHandle,
        job: PendingWrite,
        volume_runtime: &VolumeRuntime,
    ) {
        if job.epoch != self.interaction_epoch.load(Ordering::Acquire) {
            return;
        }
        let Ok(state) = self.state() else {
            return;
        };
        if !state.grabbed || (job.target_percent - state.volume).abs() < f32::EPSILON {
            return;
        }
        match self.set_absolute_system_volume(app, job.target_percent, volume_runtime) {
            Ok(applied) => {
                if (applied.volume - state.volume).abs() >= f32::EPSILON {
                    self.notify_wrist_rotation_haptic(app);
                }
            }
            Err(error) => warn!(%error, "failed to apply wrist rotation to volume"),
        }
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
        // The rate-limit slot is only consumed by a pulse that was actually
        // sent: a failed send (watch disconnected) must not also silence the
        // first pulse after it reconnects.
        match server.send_haptic_command(HapticCommand {
            duration_ms: WRIST_ROTATION_HAPTIC_DURATION_MS,
        }) {
            Ok(()) => {
                *last_sent = Some(now);
                self.haptic_send_failing.store(false, Ordering::Release);
            }
            Err(error) => {
                if first_failure(&self.haptic_send_failing) {
                    warn!(%error, "failed to send wrist rotation haptic pulse");
                }
            }
        }
    }

    fn adjust_system_volume(
        &self,
        app: &AppHandle,
        delta: f32,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let _write = self
            .native_write_lock
            .lock()
            .map_err(|_| "native volume write lock was poisoned")?;
        self.require_visible_for_write()?;
        if !delta.is_finite() {
            return Err(VolumeError::InvalidAdjustment.to_string());
        }
        // The native command runs without the state lock held (see
        // `native_write_lock`).
        let result = adjust_native_volume(volume_runtime.controller(), true, delta);
        self.publish_native_write(app, result.map(|normalized| normalized * 100.0))
    }

    /// Checks the capability gate (overlay visible) under the state lock and
    /// bumps the generation, then releases the lock before the caller talks
    /// to the native backend. Called while holding `native_write_lock`, so a
    /// write queued behind a slow one is dropped here if the overlay was
    /// hidden (Escape, release, disconnect) in the meantime.
    fn require_visible_for_write(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible {
            return Err(VolumeError::OverlayInactive.to_string());
        }
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    /// Records the outcome of a native volume write in the overlay state and
    /// emits it. `volume_percent` is the applied volume on a 0..=100 scale.
    fn publish_native_write(
        &self,
        app: &AppHandle,
        result: Result<f32, VolumeError>,
    ) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        match result {
            Ok(volume_percent) => {
                state.last_native_volume_error = None;
                state.volume = volume_percent;
                let snapshot = state.clone();
                let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
                Ok(snapshot)
            }
            Err(error) => {
                let message = error.to_string();
                state.last_native_volume_error = Some(message.clone());
                let snapshot = state.clone();
                let _ = app.emit(OVERLAY_STATE_EVENT, snapshot);
                Err(message)
            }
        }
    }

    /// Sets the system volume to `target_percent` outright, unlike
    /// [`Self::adjust_system_volume`] which reads the current volume and
    /// nudges it by a delta. Wrist rotation computes each target as an
    /// absolute value already anchored to the activation baseline, so
    /// applying it must never re-read the current volume -- doing so would
    /// let an external volume change (or read latency) silently shift the
    /// mapping and drift the target away from what the wrist angle implies.
    fn set_absolute_system_volume(
        &self,
        app: &AppHandle,
        target_percent: f32,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let _write = self
            .native_write_lock
            .lock()
            .map_err(|_| "native volume write lock was poisoned")?;
        self.require_visible_for_write()?;
        let result = set_native_volume(volume_runtime.controller(), true, target_percent);
        self.publish_native_write(app, result)
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

/// Marks a failure streak as started and reports whether this was its first
/// failure, so a persistent failure is logged once rather than per sample.
fn first_failure(failing: &AtomicBool) -> bool {
    !failing.swap(true, Ordering::AcqRel)
}

/// How long the writer must still wait before its next wrist-rotation volume write: nothing
/// before the first write, then whatever remains of
/// [`WRIST_ROTATION_VOLUME_WRITE_MIN_INTERVAL`] since the previous one finished.
fn write_pacing_wait(last_write: Option<Instant>, now: Instant) -> Duration {
    last_write.map_or(Duration::ZERO, |previous| {
        WRIST_ROTATION_VOLUME_WRITE_MIN_INTERVAL.saturating_sub(now.duration_since(previous))
    })
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
pub fn hide_overlay(
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
    automation: State<'_, crate::automation::AutomationRuntime>,
) -> Result<OverlayState, String> {
    // Escape: end the recipe that has the knob up, or it would put it straight back.
    automation.cancel(&app);
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

    /// R-M4-2: a persistent haptic failure is reported once, then again only
    /// after a success has reset the streak.
    #[test]
    fn a_haptic_failure_streak_logs_only_its_first_failure() {
        let failing = AtomicBool::new(false);
        assert!(first_failure(&failing));
        assert!(!first_failure(&failing));
        assert!(!first_failure(&failing));
        failing.store(false, Ordering::Release); // a pulse succeeded
        assert!(first_failure(&failing));
    }

    /// D-M4-3: a native volume write used to hold the overlay state lock for
    /// the adapter's whole timeout, stalling every cancellation path. The
    /// write now serializes on its own lock, so while one is in flight (here:
    /// simulated by holding that lock) state reads and the visibility gate
    /// stay immediately available.
    #[test]
    fn an_in_flight_native_write_does_not_block_the_overlay_state_lock() {
        let runtime = OverlayRuntime::default();
        let in_flight_write = runtime.native_write_lock.lock().unwrap();

        std::thread::scope(|scope| {
            let reader = scope.spawn(|| {
                runtime.state().expect("state must be readable");
                runtime.require_visible_for_write()
            });
            let gate = reader.join().unwrap();
            assert_eq!(gate, Err(VolumeError::OverlayInactive.to_string()));
        });
        drop(in_flight_write);

        runtime.state.lock().unwrap().visible = true;
        assert!(runtime.require_visible_for_write().is_ok());
    }

    #[test]
    fn the_writer_waits_only_for_what_remains_of_the_minimum_interval() {
        let now = Instant::now();
        assert_eq!(write_pacing_wait(None, now), Duration::ZERO);
        assert_eq!(
            write_pacing_wait(Some(now), now),
            WRIST_ROTATION_VOLUME_WRITE_MIN_INTERVAL
        );
        assert_eq!(
            write_pacing_wait(Some(now), now + Duration::from_millis(40)),
            WRIST_ROTATION_VOLUME_WRITE_MIN_INTERVAL - Duration::from_millis(40)
        );
        assert_eq!(
            write_pacing_wait(Some(now), now + WRIST_ROTATION_VOLUME_WRITE_MIN_INTERVAL),
            Duration::ZERO
        );
        // A slow native call (an osascript write takes 130-190 ms) already exceeds the
        // interval, so it adds no extra delay on top.
        assert_eq!(
            write_pacing_wait(Some(now), now + Duration::from_millis(150)),
            Duration::ZERO
        );
    }

    #[test]
    fn a_recipe_drive_follows_the_device_but_no_faster_than_the_slew_limit() {
        let start = Instant::now();
        let mut drive = RecipeDrive::begin(50.0);
        // The first change has no elapsed time to measure, so it is bounded by the minimum step window.
        let first = drive.advance(40.0, 30.0, start);
        assert!((first - 50.6).abs() < 1e-3, "got {first}");
        // Half a second later it may have moved 15 points further, toward the 90 the wrist asked for.
        let later = drive.advance(0.0, 30.0, start + Duration::from_millis(500));
        assert!((later - 65.6).abs() < 1e-3, "got {later}");
        // The wanted volume never leaves 0..=100, however far the device is turned.
        let mut drive = RecipeDrive::begin(95.0);
        drive.advance(500.0, 1000.0, start);
        assert_eq!(drive.wanted, 100.0);
        drive.advance(-500.0, 1000.0, start);
        assert_eq!(drive.wanted, 0.0);
    }
}
