use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use interaction_engine::{
    CalibrationTarget, VolumeSimulation, WristRotation, WristRotationConfig,
    commit_visibility_after, top_right_overlay_position,
};
use serde::Serialize;
use spatial_protocol::WatchOrientationSample;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use tracing::warn;
use volume_control::{
    VolumeController, VolumeError, adjust_system_volume as adjust_native_volume,
    platform_volume_controller, set_system_volume as set_native_volume,
};
use watch_bridge::{HapticCommand, WatchBridgeServer};

use crate::calibration::CalibrationRuntime;
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

/// Which producer started the current grab. The overlay has a single
/// `grabbed` flag, so without an owner a model-driven release (or a Watch
/// button-up) would tear down a grab some other producer started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GrabOwner {
    WatchButton,
    GestureModel,
    CornerDemo,
}

/// A producer may begin a volume interaction when nothing is grabbed, or
/// when it already owns the grab (a re-begin). It never takes over a grab
/// another producer owns.
fn may_begin_grab(current: Option<GrabOwner>, requester: GrabOwner) -> bool {
    current.is_none_or(|owner| owner == requester)
}

/// `only_owner: None` is an unconditional release (Escape, force release,
/// disconnect, target exit); `Some(owner)` is a producer ending its own
/// grab, which must not end one it does not own.
fn may_release_grab(current: Option<GrabOwner>, only_owner: Option<GrabOwner>) -> bool {
    only_owner.is_none_or(|owner| current == Some(owner))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub visible: bool,
    pub grabbed: bool,
    #[serde(skip)]
    grab_owner: Option<GrabOwner>,
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

impl OverlayState {
    pub(crate) fn grabbed_by(&self, owner: GrabOwner) -> bool {
        self.grabbed && self.grab_owner == Some(owner)
    }
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            visible: false,
            grabbed: false,
            grab_owner: None,
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
            haptic_send_failing: AtomicBool::new(false),
            wrist_volume_slot: Arc::new(LatestWriteSlot::default()),
            wrist_writer_started: Once::new(),
            interaction_epoch: AtomicU64::new(0),
            native_write_lock: Mutex::new(()),
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
        state.grab_owner = None;
        state.corner_demo_phase = None;
        state.last_relative_roll_degrees = None;
        self.end_interaction();
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

    /// Ends the current volume interaction as far as queued writes are concerned: any write
    /// waiting for the writer thread belongs to it and must not be applied.
    fn end_interaction(&self) {
        self.interaction_epoch.fetch_add(1, Ordering::AcqRel);
        self.wrist_volume_slot.clear();
    }

    /// Marks the overlay grabbed by a held watch button. A no-op unless the
    /// overlay is currently shown (dwelling on the calibrated top-right target).
    pub(crate) fn grab(&self, app: &AppHandle, owner: GrabOwner) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !state.visible || state.grabbed {
            return Ok(state.clone());
        }
        state.grabbed = true;
        state.grab_owner = Some(owner);
        self.state_generation.fetch_add(1, Ordering::AcqRel);
        let snapshot = state.clone();
        let _ = app.emit(OVERLAY_STATE_EVENT, &snapshot);
        Ok(snapshot)
    }

    /// Releases the grab unconditionally and hides the overlay, so a
    /// disconnect, Escape, target exit or forced release can never leave the
    /// overlay stuck grabbed/visible.
    pub(crate) fn release(&self, app: &AppHandle) -> Result<OverlayState, String> {
        self.release_matching(app, None)
    }

    /// A producer ending its own interaction (Watch button-up, a model's
    /// `pinch_release`). A no-op when the current grab belongs to someone
    /// else, so one producer's normal end cannot tear down another's.
    pub(crate) fn release_if_owner(
        &self,
        app: &AppHandle,
        owner: GrabOwner,
    ) -> Result<OverlayState, String> {
        self.release_matching(app, Some(owner))
    }

    fn release_matching(
        &self,
        app: &AppHandle,
        only_owner: Option<GrabOwner>,
    ) -> Result<OverlayState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "overlay state lock was poisoned")?;
        if !may_release_grab(state.grab_owner, only_owner) {
            return Ok(state.clone());
        }
        if !state.grabbed && !state.visible && state.corner_demo_phase.is_none() {
            return Ok(state.clone());
        }
        let window = app
            .get_webview_window(OVERLAY_WINDOW)
            .ok_or("overlay window is not configured")?;
        state.grabbed = false;
        state.grab_owner = None;
        state.corner_demo_phase = None;
        state.last_relative_roll_degrees = None;
        self.end_interaction();
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
    /// `wrist_config` from `orientation`, capturing the desktop's current
    /// volume as the activation baseline every absolute target this
    /// interaction computes is anchored to, as one transaction. This is the
    /// single seam both the Watch-button and the approved desktop-model
    /// paths call, so neither can leave the overlay visually grabbed with a
    /// stale or missing reference pose. Fails closed: a missing orientation
    /// sample, an unreadable/unsupported native volume, or an invalid
    /// configuration rolls the grab back via [`Self::release`] instead of
    /// leaving a partial interaction active.
    pub(crate) fn begin_volume_interaction(
        &self,
        app: &AppHandle,
        owner: GrabOwner,
        wrist_config: WristRotationConfig,
        orientation: Option<&WatchOrientationSample>,
        volume_runtime: &VolumeRuntime,
    ) -> Result<OverlayState, String> {
        let grabbed = self.grab(app, owner)?;
        if !grabbed.grabbed {
            // Overlay was not visible/dwelling: grab() correctly no-op'd.
            return Ok(grabbed);
        }
        if !may_begin_grab(grabbed.grab_owner, owner) {
            // Someone else owns the active grab; never take over its
            // reference pose or tear it down.
            warn!(?owner, current = ?grabbed.grab_owner, "volume interaction already owned by another producer; not starting");
            return Ok(grabbed);
        }
        let Some(orientation) = orientation else {
            warn!("volume interaction grabbed with no orientation sample available; releasing");
            return self.release(app);
        };
        let activation_volume_percent = match volume_runtime.available_volume() {
            Ok(Some(volume)) => volume * 100.0,
            Ok(None) => {
                warn!(
                    "volume interaction grabbed with no controllable native volume backend; releasing"
                );
                return self.release(app);
            }
            Err(error) => {
                warn!(%error, "failed to read activation volume for wrist rotation; releasing");
                return self.release(app);
            }
        };
        let began = self
            .wrist_rotation
            .lock()
            .map_err(|_| "wrist rotation lock was poisoned")?
            .begin_with_config(
                wrist_config,
                orientation.quaternion,
                orientation.timestamp_ns,
                activation_volume_percent,
            );
        if let Err(error) = began {
            warn!(%error, "failed to begin wrist rotation reference; releasing grab");
            return self.release(app);
        }
        // A new interaction: anything still queued for the previous one is stale.
        self.end_interaction();
        self.state()
    }

    /// Feeds one orientation sample to the wrist mapper and, if it asks for a different
    /// volume, hands the new target to the writer thread.
    ///
    /// This runs on the watch event loop, so it must stay cheap: every sample is still passed
    /// through [`WristRotation::observe`] (so its monotonicity and velocity-outlier checks see
    /// every sample, exactly as before), but the native volume call, which can take 130-190 ms,
    /// is done by [`Self::ensure_wrist_writer`]'s thread instead. A target is skipped, not queued,
    /// when a newer one arrives first; see [`crate::latest_write`].
    pub(crate) fn apply_wrist_rotation(
        &self,
        app: &AppHandle,
        sample: &WatchOrientationSample,
    ) -> Result<OverlayState, String> {
        let (target_volume, relative_degrees, mapper_active) = {
            let mut wrist_rotation = self
                .wrist_rotation
                .lock()
                .map_err(|_| "wrist rotation lock was poisoned")?;
            let target_volume = wrist_rotation
                .observe(sample.quaternion, sample.timestamp_ns)
                .map_err(|error| error.to_string())? as f32;
            (
                target_volume,
                wrist_rotation.last_relative_degrees(),
                wrist_rotation.is_active(),
            )
        };
        self.update_relative_roll_diagnostic(app, relative_degrees.map(|degrees| degrees as f32));
        let state = self.state()?;
        // An inactive mapper reports a placeholder target of 0.0, which is not a volume to
        // apply; the overlay can read as grabbed for a moment before the mapper has its
        // reference pose.
        if !state.grabbed || !mapper_active || (target_volume - state.volume).abs() < f32::EPSILON {
            // Nothing to write. If the wrist came back to the applied volume, a target still
            // waiting for the writer is now wrong and must not go out.
            self.wrist_volume_slot.clear();
            let next_phase = corner_demo_phase_after_sample(state.corner_demo_phase, false);
            if next_phase != state.corner_demo_phase {
                return self.set_corner_demo_phase(app, next_phase);
            }
            return Ok(state);
        }
        self.ensure_wrist_writer(app);
        self.wrist_volume_slot.submit(PendingWrite {
            target_percent: target_volume,
            epoch: self.interaction_epoch.load(Ordering::Acquire),
        });
        Ok(state)
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
                let next_phase = corner_demo_phase_after_sample(state.corner_demo_phase, true);
                if next_phase != state.corner_demo_phase
                    && let Err(error) = self.set_corner_demo_phase(app, next_phase)
                {
                    warn!(%error, "failed to update the corner demo phase after a wrist volume write");
                }
            }
            Err(error) => warn!(%error, "failed to apply wrist rotation to volume"),
        }
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

/// The overlay visibility is the only capability gate on the native volume
/// commands, so it must be raised by a backend-observed fact rather than on
/// the webview's say-so: the frontend only calls `show_overlay` in response
/// to the head-target-entered event, and the backend's own calibration state
/// must agree that the top-right target is currently active.
fn overlay_show_permitted(active_target: Option<CalibrationTarget>) -> Result<(), String> {
    if active_target == Some(CalibrationTarget::TopRight) {
        Ok(())
    } else {
        Err(
            "the volume overlay can only be shown while the top-right head target is active"
                .to_string(),
        )
    }
}

#[tauri::command]
pub fn show_overlay(
    app: AppHandle,
    runtime: State<'_, OverlayRuntime>,
    volume_runtime: State<'_, VolumeRuntime>,
    calibration: State<'_, CalibrationRuntime>,
) -> Result<OverlayState, String> {
    overlay_show_permitted(calibration.state()?.active_target)?;
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

    /// R-M4-3: the overlay has one `grabbed` flag; ownership decides who may
    /// start and who may end an interaction.
    #[test]
    fn a_producer_never_takes_over_or_ends_a_grab_it_does_not_own() {
        use GrabOwner::*;
        assert!(may_begin_grab(None, GestureModel));
        assert!(may_begin_grab(Some(GestureModel), GestureModel));
        assert!(!may_begin_grab(Some(WatchButton), GestureModel));
        assert!(!may_begin_grab(Some(GestureModel), CornerDemo));

        // A model release must not end a Watch-button grab, or vice versa.
        assert!(!may_release_grab(Some(WatchButton), Some(GestureModel)));
        assert!(!may_release_grab(Some(GestureModel), Some(WatchButton)));
        assert!(!may_release_grab(None, Some(GestureModel)));
        assert!(may_release_grab(Some(GestureModel), Some(GestureModel)));
        // Escape / force release / disconnect end any grab.
        assert!(may_release_grab(Some(WatchButton), None));
        assert!(may_release_grab(Some(CornerDemo), None));
        assert!(may_release_grab(None, None));
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

    /// D-M4-4: the webview must not be able to raise the volume capability
    /// gate unless the backend itself sees the top-right target active.
    #[test]
    fn show_overlay_requires_the_top_right_target_to_be_active() {
        assert!(overlay_show_permitted(Some(CalibrationTarget::TopRight)).is_ok());
        assert!(overlay_show_permitted(Some(CalibrationTarget::Center)).is_err());
        assert!(overlay_show_permitted(None).is_err());
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
