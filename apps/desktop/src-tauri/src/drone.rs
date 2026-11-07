//! Connects the watch to a Wi-Fi drone.
//!
//! Every watch orientation sample becomes a stick update, held or not: holding the button steers, and letting go
//! centres the sticks. That stream is also the drone's heartbeat, because the pilot in `drone-link` lands when updates
//! stop, so a watch that disconnects or leaves the wrist brings the drone down without anything here noticing.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use drone_link::{
    Button, Endpoint, Link, LinkPhase, LinkTiming, PilotConfig, Steering, SteeringConfig, Sticks,
};
use serde::Serialize;
use spatial_protocol::WatchOrientationSample;
use tauri::State;
use tracing::warn;

/// The watch or the page must have checked in this recently to arm, or the failsafe would land at once.
const WATCH_FRESH_TO_ARM: Duration = Duration::from_millis(500);
const NOT_CONNECTED: &str = "connect to the drone first";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DronePhase {
    Disconnected,
    Opening,
    Open,
    Failed,
    Closed,
}

/// How the picture is moving, in pixels of the 160 by 90 image the measure uses.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroneFlow {
    pub frame: u32,
    pub dx: f32,
    pub dy: f32,
    pub zoom: f32,
    pub confidence: f32,
}

/// What the hold is sending, or would send, in stick steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroneCorrection {
    pub aileron: i8,
    pub elevator: i8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroneState {
    pub phase: DronePhase,
    pub armed: bool,
    pub failsafe_tripped: bool,
    pub steering: bool,
    pub watch_streaming: bool,
    pub frames_sent: u64,
    pub video_frames: u32,
    pub video_skipped: u32,
    pub video_damaged: u32,
    pub send_errors: u64,
    pub flow: Option<DroneFlow>,
    pub drift_x: f32,
    pub drift_y: f32,
    pub holding: bool,
    pub correction: Option<DroneCorrection>,
    pub page_alive: bool,
}

fn is_fresh(at: Option<Instant>) -> bool {
    at.is_some_and(|at| at.elapsed() < WATCH_FRESH_TO_ARM)
}

#[derive(Default)]
struct Inner {
    link: Option<Link>,
    steering: Steering,
    last_orientation: Option<Instant>,
    last_heartbeat: Option<Instant>,
}

#[derive(Default)]
pub struct DroneRuntime {
    inner: Mutex<Inner>,
}

impl DroneRuntime {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes the link out to be closed. Closing can take over a second, so it must not happen under the lock.
    pub fn take_link(&self) -> Option<Link> {
        self.lock().link.take()
    }

    pub fn state(&self) -> DroneState {
        let inner = self.lock();
        let status = inner.link.as_ref().map(Link::status);
        let watch_streaming = is_fresh(inner.last_orientation);
        DroneState {
            phase: match status.map(|status| status.phase) {
                None => DronePhase::Disconnected,
                Some(LinkPhase::Opening) => DronePhase::Opening,
                Some(LinkPhase::Open) => DronePhase::Open,
                Some(LinkPhase::Failed) => DronePhase::Failed,
                Some(LinkPhase::Closed) => DronePhase::Closed,
            },
            armed: status.is_some_and(|status| status.armed),
            failsafe_tripped: status.is_some_and(|status| status.failsafe_tripped),
            steering: inner.steering.is_held(),
            watch_streaming,
            frames_sent: status.map_or(0, |status| status.frames_sent),
            video_frames: status.map_or(0, |status| status.video_frames),
            video_skipped: status.map_or(0, |status| status.video_skipped),
            video_damaged: status.map_or(0, |status| status.video_damaged),
            send_errors: status.map_or(0, |status| status.send_errors),
            flow: status
                .and_then(|status| status.flow)
                .map(|(frame, flow)| DroneFlow {
                    frame,
                    dx: flow.dx,
                    dy: flow.dy,
                    zoom: flow.zoom,
                    confidence: flow.confidence,
                }),
            drift_x: status.map_or(0.0, |status| status.drift.0),
            drift_y: status.map_or(0.0, |status| status.drift.1),
            holding: status.is_some_and(|status| status.holding),
            correction: status
                .and_then(|status| status.correction)
                .map(|correction| DroneCorrection {
                    aileron: correction.aileron,
                    elevator: correction.elevator,
                }),
            page_alive: is_fresh(inner.last_heartbeat),
        }
    }

    pub fn connect(&self) -> Result<(), String> {
        let mut inner = self.lock();
        if inner
            .link
            .as_ref()
            .is_some_and(|link| link.status().phase != LinkPhase::Failed)
        {
            return Ok(());
        }
        let link = Link::open(
            Endpoint::default(),
            PilotConfig::default(),
            LinkTiming::default(),
        )
        .map_err(|error| error.to_string())?;
        inner.link = Some(link);
        Ok(())
    }

    pub fn arm(&self) -> Result<(), String> {
        let mut inner = self.lock();
        if !is_fresh(inner.last_orientation) && !is_fresh(inner.last_heartbeat) {
            return Err("neither the watch nor this page is keeping the link alive".into());
        }
        inner.steering = Steering::new(SteeringConfig::default());
        let link = inner.link.as_ref().ok_or(NOT_CONNECTED)?;
        link.arm().map_err(|error| error.to_string())
    }

    pub fn take_off(&self) -> Result<(), String> {
        let inner = self.lock();
        let link = inner.link.as_ref().ok_or(NOT_CONNECTED)?;
        link.press(Button::Up).map_err(|error| error.to_string())
    }

    /// Lands, and needs arming again afterwards. Does nothing without a link, so Esc is always safe to press.
    pub fn land(&self) {
        let mut inner = self.lock();
        inner.steering.set_held(false);
        if let Some(link) = &inner.link {
            let _ = link.press(Button::Down);
            link.disarm();
        }
    }

    pub fn stop(&self) {
        let mut inner = self.lock();
        inner.steering.set_held(false);
        if let Some(link) = &inner.link {
            link.stop();
        }
    }

    /// The newest video frame after `after`, as its number in four little-endian bytes and then the JPEG.
    pub fn frame_after(&self, after: u32) -> Vec<u8> {
        let frame = self.lock().link.as_ref().and_then(Link::latest_frame);
        let Some(frame) = frame.filter(|frame| frame.number != after) else {
            return Vec::new();
        };
        let mut bytes = Vec::with_capacity(4 + frame.jpeg.len());
        bytes.extend_from_slice(&frame.number.to_le_bytes());
        bytes.extend_from_slice(&frame.jpeg);
        bytes
    }

    pub fn reset_drift(&self) {
        if let Some(link) = &self.lock().link {
            link.reset_drift();
        }
    }

    /// The Drone page saying it is still open. Without this or the watch, the pilot lands.
    pub fn heartbeat(&self) {
        let mut inner = self.lock();
        inner.last_heartbeat = Some(Instant::now());
        if !inner.steering.is_held()
            && let Some(link) = &inner.link
        {
            link.set_sticks(Sticks::CENTRED);
        }
    }

    pub fn set_hold(&self, enabled: bool) -> Result<(), String> {
        let inner = self.lock();
        let link = inner.link.as_ref().ok_or(NOT_CONNECTED)?;
        link.set_hold(enabled).map_err(|error| error.to_string())
    }

    pub fn set_button(&self, held: bool) {
        self.lock().steering.set_held(held);
    }

    pub fn observe_orientation(&self, sample: &WatchOrientationSample) {
        let mut inner = self.lock();
        inner.last_orientation = Some(Instant::now());
        let sticks = inner.steering.observe(sample.quaternion);
        if let Some(link) = &inner.link {
            link.set_sticks(sticks);
        }
    }

    /// Something else went wrong with the watch's data: stop steering, but keep the hover.
    pub fn release(&self) {
        let mut inner = self.lock();
        inner.steering.set_held(false);
        if let Some(link) = &inner.link {
            link.set_sticks(Sticks::CENTRED);
        }
    }

    /// The watch is gone, so it can no longer steer. Lands now, unless the page is flying the drone by itself.
    pub fn watch_lost(&self) {
        let mut inner = self.lock();
        inner.last_orientation = None;
        let page_alive = is_fresh(inner.last_heartbeat);
        let connected = inner.link.is_some();
        drop(inner);
        if page_alive {
            self.release();
        } else {
            if connected {
                warn!("watch lost while connected to the drone; landing");
            }
            self.land();
        }
    }
}

#[tauri::command]
pub fn get_drone_state(runtime: State<'_, DroneRuntime>) -> DroneState {
    runtime.state()
}

#[tauri::command]
pub fn drone_frame(after: u32, runtime: State<'_, DroneRuntime>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(runtime.frame_after(after))
}

#[tauri::command]
pub fn drone_heartbeat(runtime: State<'_, DroneRuntime>) {
    runtime.heartbeat();
}

#[tauri::command]
pub fn drone_set_hold(
    enabled: bool,
    runtime: State<'_, DroneRuntime>,
) -> Result<DroneState, String> {
    runtime.set_hold(enabled)?;
    Ok(runtime.state())
}

#[tauri::command]
pub fn drone_reset_drift(runtime: State<'_, DroneRuntime>) -> DroneState {
    runtime.reset_drift();
    runtime.state()
}

#[tauri::command]
pub fn drone_connect(runtime: State<'_, DroneRuntime>) -> Result<DroneState, String> {
    runtime.connect()?;
    Ok(runtime.state())
}

#[tauri::command]
pub async fn drone_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let link = app.state::<DroneRuntime>().take_link();
    tauri::async_runtime::spawn_blocking(move || drop(link))
        .await
        .map_err(|error| format!("closing the drone link failed: {error}"))
}

#[tauri::command]
pub fn drone_arm(runtime: State<'_, DroneRuntime>) -> Result<DroneState, String> {
    runtime.arm()?;
    Ok(runtime.state())
}

#[tauri::command]
pub fn drone_take_off(runtime: State<'_, DroneRuntime>) -> Result<DroneState, String> {
    runtime.take_off()?;
    Ok(runtime.state())
}

#[tauri::command]
pub fn drone_land(runtime: State<'_, DroneRuntime>) -> DroneState {
    runtime.land();
    runtime.state()
}

#[tauri::command]
pub fn drone_stop(runtime: State<'_, DroneRuntime>) -> DroneState {
    runtime.stop();
    runtime.state()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(quaternion: [f64; 4]) -> WatchOrientationSample {
        WatchOrientationSample {
            device_id: "watch".into(),
            sequence: 1,
            timestamp_ns: 1,
            quaternion,
            accelerometer: None,
            gyroscope: None,
        }
    }

    #[test]
    fn starts_disconnected_and_refuses_flight() {
        let runtime = DroneRuntime::default();
        assert_eq!(runtime.state().phase, DronePhase::Disconnected);
        assert_eq!(runtime.take_off(), Err(NOT_CONNECTED.to_string()));
    }

    #[test]
    fn arming_needs_something_keeping_the_link_alive() {
        let runtime = DroneRuntime::default();
        let refused = runtime.arm().unwrap_err();
        assert!(refused.contains("keeping the link alive"), "{refused}");
        runtime.heartbeat();
        assert_eq!(runtime.arm(), Err(NOT_CONNECTED.to_string()));
    }

    #[test]
    fn hold_needs_a_link() {
        let runtime = DroneRuntime::default();
        assert_eq!(runtime.set_hold(true), Err(NOT_CONNECTED.to_string()));
        assert!(!runtime.state().holding);
    }

    #[test]
    fn losing_the_watch_ends_a_hold_of_the_button_either_way() {
        let runtime = DroneRuntime::default();
        runtime.heartbeat();
        runtime.set_button(true);
        runtime.watch_lost();
        assert!(!runtime.state().steering);
        assert!(runtime.state().page_alive);
    }

    #[test]
    fn watch_stream_is_noticed_and_forgotten_when_lost() {
        let runtime = DroneRuntime::default();
        runtime.observe_orientation(&sample([1.0, 0.0, 0.0, 0.0]));
        assert!(runtime.state().watch_streaming);
        runtime.watch_lost();
        assert!(!runtime.state().watch_streaming);
    }

    #[test]
    fn landing_with_no_link_is_harmless_and_ends_a_hold() {
        let runtime = DroneRuntime::default();
        runtime.set_button(true);
        assert!(runtime.state().steering);
        runtime.land();
        assert!(!runtime.state().steering);
    }
}
