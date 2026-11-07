//! Connects the watch to a Wi-Fi drone.
//!
//! Every watch orientation sample becomes a stick update, held or not: holding the button steers, and letting go
//! centres the sticks. That stream is also the drone's heartbeat, because the pilot in `drone-link` lands when updates
//! stop, so a watch that disconnects or leaves the wrist brings the drone down without anything here noticing.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use drone_link::flight_log::FlightLog;
use drone_link::frame::NEUTRAL;
use drone_link::{
    Button, Endpoint, HoldAxis, HoldFault, HoldPhase, Link, LinkPhase, LinkTiming, PilotConfig,
    Steering, SteeringConfig, Sticks,
};
use serde::Serialize;
use spatial_protocol::WatchOrientationSample;
use tauri::State;
use tracing::warn;

/// How often to look for the drone's Wi-Fi.
const NETWORK_CHECK_EVERY: Duration = Duration::from_secs(1);
/// A drone that did not answer is tried again this long later, as a new session.
const RETRY_CONNECT_AFTER: Duration = Duration::from_secs(5);
/// The watch or the page must have checked in this recently to arm, or the failsafe would land at once.
const WATCH_FRESH_TO_ARM: Duration = Duration::from_millis(500);
const NOT_CONNECTED: &str = "connect to the drone first";
/// The most the height buttons move the throttle.
const MAX_HEIGHT_RATE: i8 = 40;
/// A height request older than this counts as released, so a stuck page cannot keep the drone climbing.
const HEIGHT_STALE_AFTER: Duration = Duration::from_millis(300);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DroneHoldPhase {
    Off,
    Calibrating,
    Holding,
    Failed,
}

fn fault_text(fault: HoldFault) -> String {
    let axis = |axis: HoldAxis| match axis {
        HoldAxis::Sideways => "sideways",
        HoldAxis::ForwardBack => "forward and back",
    };
    match fault {
        HoldFault::NoResponse(which) => format!(
            "A test push {} made no clear change in the picture. Hold needs the drone flying, and a scene with detail in front of it.",
            axis(which)
        ),
        HoldFault::Unsteady(which) => format!(
            "The drone was drifting too much to measure a test push {}. Try again when it is steadier.",
            axis(which)
        ),
        HoldFault::PictureLost => {
            "The picture could not be followed, so hold stopped and centred the sticks.".to_string()
        }
    }
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
    pub hold_phase: DroneHoldPhase,
    pub hold_fault: Option<String>,
    pub correction: Option<DroneCorrection>,
    pub height_rate: i8,
    pub flight_log: Option<String>,
    pub page_alive: bool,
    /// True when this computer is on the drone's Wi-Fi.
    pub on_network: bool,
    pub firmware: Option<String>,
}

fn is_fresh(at: Option<Instant>) -> bool {
    at.is_some_and(|at| at.elapsed() < WATCH_FRESH_TO_ARM)
}

/// What to do about the drone's Wi-Fi coming and going.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutoAction {
    Nothing,
    Connect,
    Close,
}

/// Opens a session when the drone's Wi-Fi appears. This only ever connects: arming stays a person's choice.
#[derive(Debug, Default)]
struct AutoConnect {
    /// The person chose Disconnect, which holds until they leave the network or choose Connect.
    declined: bool,
    next_try: Option<Instant>,
}

impl AutoConnect {
    fn decide(&mut self, on_network: bool, link: Option<LinkPhase>, now: Instant) -> AutoAction {
        if !on_network {
            self.declined = false;
            self.next_try = None;
            return if link.is_some() {
                AutoAction::Close
            } else {
                AutoAction::Nothing
            };
        }
        let idle = matches!(link, None | Some(LinkPhase::Failed));
        if self.declined || !idle || self.next_try.is_some_and(|at| now < at) {
            return AutoAction::Nothing;
        }
        self.next_try = Some(now + RETRY_CONNECT_AFTER);
        AutoAction::Connect
    }
}

#[derive(Default)]
struct Inner {
    link: Option<Link>,
    steering: Steering,
    last_orientation: Option<Instant>,
    last_heartbeat: Option<Instant>,
    auto: AutoConnect,
    on_network: bool,
    shut_down: bool,
    height: Option<(i8, Instant)>,
    flight_log: Option<String>,
}

impl Inner {
    fn height_rate(&self) -> i8 {
        self.height
            .filter(|(_, at)| at.elapsed() < HEIGHT_STALE_AFTER)
            .map_or(0, |(rate, _)| rate)
    }

    fn with_height(&self, sticks: Sticks) -> Sticks {
        let throttle = i16::from(NEUTRAL) + i16::from(self.height_rate());
        Sticks {
            throttle: throttle as u8,
            ..sticks
        }
    }
}

#[derive(Default)]
pub struct DroneRuntime {
    inner: Mutex<Inner>,
}

impl DroneRuntime {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes the link out because the person chose Disconnect. Closing can take over a second, so it must not
    /// happen under the lock.
    pub fn take_link(&self) -> Option<Link> {
        let mut inner = self.lock();
        inner.auto.declined = true;
        inner.link.take()
    }

    /// Takes the link out for good, as the app closes.
    pub fn shut_down(&self) -> Option<Link> {
        let mut inner = self.lock();
        inner.shut_down = true;
        inner.link.take()
    }

    /// Looks at the network once, and connects or closes to match.
    fn check_network(&self, on_network: bool) {
        let mut inner = self.lock();
        inner.on_network = on_network;
        if inner.shut_down {
            return;
        }
        let phase = inner.link.as_ref().map(|link| link.status().phase);
        let action = inner.auto.decide(on_network, phase, Instant::now());
        match action {
            AutoAction::Nothing => {}
            AutoAction::Connect => {
                drop(inner);
                if let Err(error) = self.open_link() {
                    warn!(%error, "could not connect to the drone");
                }
            }
            AutoAction::Close => {
                let link = inner.link.take();
                drop(inner);
                warn!("left the drone's network; closing the link");
                drop(link);
            }
        }
    }

    pub fn state(&self) -> DroneState {
        let inner = self.lock();
        let status = inner.link.as_ref().map(Link::status);
        let watch_streaming = is_fresh(inner.last_orientation);
        let hold = status.map(|status| status.hold);
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
            holding: hold
                .is_some_and(|hold| matches!(hold, HoldPhase::Calibrating | HoldPhase::Holding)),
            hold_phase: match hold {
                None | Some(HoldPhase::Off) => DroneHoldPhase::Off,
                Some(HoldPhase::Calibrating) => DroneHoldPhase::Calibrating,
                Some(HoldPhase::Holding) => DroneHoldPhase::Holding,
                Some(HoldPhase::Failed(_)) => DroneHoldPhase::Failed,
            },
            hold_fault: match hold {
                Some(HoldPhase::Failed(fault)) => Some(fault_text(fault)),
                _ => None,
            },
            height_rate: inner.height_rate(),
            flight_log: inner.flight_log.clone(),
            correction: status
                .and_then(|status| status.correction)
                .map(|correction| DroneCorrection {
                    aileron: correction.aileron,
                    elevator: correction.elevator,
                }),
            page_alive: is_fresh(inner.last_heartbeat),
            on_network: inner.on_network,
            firmware: inner.link.as_ref().and_then(Link::firmware),
        }
    }

    /// The person chose Connect, which also undoes an earlier Disconnect.
    pub fn connect(&self) -> Result<(), String> {
        self.lock().auto.declined = false;
        self.open_link()
    }

    fn open_link(&self) -> Result<(), String> {
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

    /// Calibrates the gyro. The pilot refuses while armed, because it must be still on the ground.
    pub fn calibrate_gyro(&self) -> Result<(), String> {
        let inner = self.lock();
        let link = inner.link.as_ref().ok_or(NOT_CONNECTED)?;
        link.press(Button::GyroCheck)
            .map_err(|error| error.to_string())
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
    /// `height` is how hard the Climb or Descend button is held, sent with every beat, so it cannot get stuck.
    pub fn heartbeat(&self, height: i8) {
        let mut inner = self.lock();
        let now = Instant::now();
        inner.last_heartbeat = Some(now);
        inner.height = Some((height.clamp(-MAX_HEIGHT_RATE, MAX_HEIGHT_RATE), now));
        if !inner.steering.is_held()
            && let Some(link) = &inner.link
        {
            link.set_sticks(inner.with_height(Sticks::CENTRED));
        }
    }

    /// Starts recording this flight. A recording that cannot start does not stop the flight.
    fn record_flight(&self, folder: &std::path::Path) {
        let name = chrono::Local::now()
            .format("flight-%Y%m%d-%H%M%S.csv")
            .to_string();
        let path = folder.join(name);
        let mut inner = self.lock();
        let Some(link) = &inner.link else { return };
        match FlightLog::create(&path) {
            Ok(log) => {
                link.record_flight(log);
                inner.flight_log = Some(path.display().to_string());
            }
            Err(error) => warn!(%error, "could not start the flight recording"),
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
        let sticks = inner.with_height(sticks);
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

/// Watches for the drone's Wi-Fi for as long as the app runs. The check sends nothing.
pub fn spawn_auto_connect(app: tauri::AppHandle) {
    use tauri::Manager;
    let check = move || {
        let endpoint = Endpoint::default();
        loop {
            app.state::<DroneRuntime>()
                .check_network(endpoint.is_reachable());
            std::thread::sleep(NETWORK_CHECK_EVERY);
        }
    };
    if let Err(error) = std::thread::Builder::new()
        .name("drone-network".into())
        .spawn(check)
    {
        warn!(%error, "could not start watching for the drone's Wi-Fi");
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
pub fn drone_heartbeat(height: i8, runtime: State<'_, DroneRuntime>) {
    runtime.heartbeat(height);
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
pub fn drone_arm(app: tauri::AppHandle) -> Result<DroneState, String> {
    use tauri::Manager;
    let runtime = app.state::<DroneRuntime>();
    runtime.arm()?;
    match app.path().app_data_dir() {
        Ok(folder) => runtime.record_flight(&folder.join("drone-flights")),
        Err(error) => warn!(%error, "no folder for the flight recording"),
    }
    Ok(runtime.state())
}

#[tauri::command]
pub fn drone_take_off(runtime: State<'_, DroneRuntime>) -> Result<DroneState, String> {
    runtime.take_off()?;
    Ok(runtime.state())
}

#[tauri::command]
pub fn drone_calibrate_gyro(runtime: State<'_, DroneRuntime>) -> Result<DroneState, String> {
    runtime.calibrate_gyro()?;
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
    fn connects_when_the_network_appears() {
        let mut auto = AutoConnect::default();
        let now = Instant::now();
        assert_eq!(auto.decide(false, None, now), AutoAction::Nothing);
        assert_eq!(auto.decide(true, None, now), AutoAction::Connect);
    }

    #[test]
    fn leaves_a_working_link_alone() {
        let mut auto = AutoConnect::default();
        let now = Instant::now();
        for phase in [LinkPhase::Opening, LinkPhase::Open, LinkPhase::Closed] {
            assert_eq!(
                auto.decide(true, Some(phase), now),
                AutoAction::Nothing,
                "{phase:?}"
            );
        }
    }

    #[test]
    fn retries_a_silent_drone_but_not_constantly() {
        let mut auto = AutoConnect::default();
        let now = Instant::now();
        assert_eq!(auto.decide(true, None, now), AutoAction::Connect);
        let soon = now + RETRY_CONNECT_AFTER - Duration::from_millis(1);
        assert_eq!(
            auto.decide(true, Some(LinkPhase::Failed), soon),
            AutoAction::Nothing
        );
        assert_eq!(
            auto.decide(true, Some(LinkPhase::Failed), now + RETRY_CONNECT_AFTER),
            AutoAction::Connect
        );
    }

    #[test]
    fn disconnect_is_respected_until_the_network_goes_away() {
        let mut auto = AutoConnect {
            declined: true,
            next_try: None,
        };
        let now = Instant::now();
        assert_eq!(auto.decide(true, None, now), AutoAction::Nothing);
        assert_eq!(auto.decide(false, None, now), AutoAction::Nothing);
        assert_eq!(auto.decide(true, None, now), AutoAction::Connect);
    }

    #[test]
    fn leaving_the_network_closes_the_link_and_clears_the_wait() {
        let mut auto = AutoConnect::default();
        let now = Instant::now();
        auto.decide(true, None, now);
        assert_eq!(
            auto.decide(false, Some(LinkPhase::Open), now),
            AutoAction::Close
        );
        assert_eq!(auto.decide(true, None, now), AutoAction::Connect);
    }

    #[test]
    fn disconnect_stops_the_next_network_check_from_reconnecting() {
        let runtime = DroneRuntime::default();
        assert!(runtime.take_link().is_none());
        runtime.check_network(true);
        assert_eq!(runtime.state().phase, DronePhase::Disconnected);
        assert!(runtime.state().on_network);
    }

    #[test]
    fn nothing_reconnects_once_the_app_is_closing() {
        let runtime = DroneRuntime::default();
        assert!(runtime.shut_down().is_none());
        runtime.check_network(true);
        assert_eq!(runtime.state().phase, DronePhase::Disconnected);
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
        runtime.heartbeat(0);
        assert_eq!(runtime.arm(), Err(NOT_CONNECTED.to_string()));
    }

    #[test]
    fn height_comes_from_the_page_within_limits() {
        let runtime = DroneRuntime::default();
        runtime.heartbeat(25);
        assert_eq!(runtime.state().height_rate, 25);
        runtime.heartbeat(127);
        assert_eq!(runtime.state().height_rate, MAX_HEIGHT_RATE);
        runtime.heartbeat(-127);
        assert_eq!(runtime.state().height_rate, -MAX_HEIGHT_RATE);
    }

    #[test]
    fn a_height_request_lapses_if_the_page_stops_sending() {
        let inner = Inner {
            height: Instant::now()
                .checked_sub(HEIGHT_STALE_AFTER)
                .map(|at| (30, at)),
            ..Inner::default()
        };
        assert_eq!(inner.height_rate(), 0);
        assert_eq!(inner.with_height(Sticks::CENTRED).throttle, NEUTRAL);
    }

    #[test]
    fn height_only_moves_the_throttle() {
        let inner = Inner {
            height: Some((-20, Instant::now())),
            ..Inner::default()
        };
        let sticks = inner.with_height(Sticks::CENTRED);
        assert_eq!(sticks.throttle, NEUTRAL - 20);
        assert_eq!(sticks.aileron, NEUTRAL);
    }

    #[test]
    fn every_fault_explains_itself() {
        for fault in [
            HoldFault::NoResponse(HoldAxis::Sideways),
            HoldFault::Unsteady(HoldAxis::ForwardBack),
            HoldFault::PictureLost,
        ] {
            assert!(!fault_text(fault).is_empty());
        }
    }

    #[test]
    fn gyro_calibration_needs_a_link() {
        let runtime = DroneRuntime::default();
        assert_eq!(runtime.calibrate_gyro(), Err(NOT_CONNECTED.to_string()));
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
        runtime.heartbeat(0);
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
