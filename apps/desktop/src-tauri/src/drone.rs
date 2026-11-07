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
    Button, Calibration, Endpoint, HoldAxis, HoldFault, HoldPhase, Link, LinkPhase, LinkTiming,
    PilotConfig, Steering, SteeringConfig, Sticks,
};
use serde::{Deserialize, Serialize};
use spatial_protocol::WatchOrientationSample;
use tauri::State;
use tracing::warn;

/// How long the page's request for the next video frame waits for one.
const FRAME_WAIT: Duration = Duration::from_millis(500);
/// How often to look for the drone's Wi-Fi.
const NETWORK_CHECK_EVERY: Duration = Duration::from_secs(1);
/// A drone that did not answer is tried again this long later, as a new session.
const RETRY_CONNECT_AFTER: Duration = Duration::from_secs(5);
/// The watch or the page must have checked in this recently to arm, or the failsafe would land at once.
const WATCH_FRESH_TO_ARM: Duration = Duration::from_millis(500);
const NOT_CONNECTED: &str = "connect to the drone first";
/// The most the height buttons move the throttle.
const MAX_HEIGHT_RATE: i8 = 40;
/// The most the steering buttons move aileron or elevator, within the pilot's own limit.
const MAX_NUDGE: i8 = 30;
/// A request older than this counts as released, so a stuck page cannot keep the drone moving.
const HEIGHT_STALE_AFTER: Duration = Duration::from_millis(300);

/// The most trim can offset aileron, elevator or rudder.
const MAX_TRIM: i8 = 20;
/// Every packet the drone sends that the link does not understand, appended session by session, in case the drone
/// ever sends status or sensor data.
const UNKNOWN_PACKETS_FILE: &str = "drone-unknown-packets.txt";

/// Starts a session's section of the unknown-packets file. Failing only loses evidence, so it never stops the link.
fn record_unknown_packets(link: &Link, path: &std::path::Path) {
    use std::io::Write;
    let started = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let header = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| writeln!(file, "# session opened at unix time {started}"));
    if let Err(error) = header.and_then(|()| link.record_unknown_packets(path)) {
        warn!(%error, "could not record unknown drone packets");
    }
}

const CALIBRATION_FILE: &str = "drone-hold-calibration.txt";

/// What the page's buttons, arrow keys and trims are asking for, in stick steps from centre.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Manual {
    pub height: i8,
    pub aileron: i8,
    pub elevator: i8,
    pub trim_aileron: i8,
    pub trim_elevator: i8,
    pub trim_rudder: i8,
    /// Start hold with the saved measurement after each takeoff.
    pub auto_hold: bool,
}

impl Manual {
    fn limited(self) -> Self {
        Self {
            height: self.height.clamp(-MAX_HEIGHT_RATE, MAX_HEIGHT_RATE),
            aileron: self.aileron.clamp(-MAX_NUDGE, MAX_NUDGE),
            elevator: self.elevator.clamp(-MAX_NUDGE, MAX_NUDGE),
            trim_aileron: self.trim_aileron.clamp(-MAX_TRIM, MAX_TRIM),
            trim_elevator: self.trim_elevator.clamp(-MAX_TRIM, MAX_TRIM),
            trim_rudder: self.trim_rudder.clamp(-MAX_TRIM, MAX_TRIM),
            auto_hold: self.auto_hold,
        }
    }

    fn steers(self) -> bool {
        self.aileron != 0 || self.elevator != 0
    }
}

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
        HoldFault::PictureNotSteady => {
            "Hold did not start, because the picture had not been steady for long enough."
                .to_string()
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

/// The drone's own status message, raw: the phone app never shows these, so what the numbers mean is not known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroneReport {
    pub fly_state: u8,
    pub battery: u8,
    pub speed: u8,
    pub remote_control: bool,
    pub camera_tilt: bool,
    pub headless: bool,
    pub photo: bool,
    pub video: bool,
    pub light: bool,
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
    pub video_restarts: u32,
    pub video_repeats: u32,
    /// Packets from the drone that are neither video nor the firmware name. Always 0 so far on the DM002HW.
    pub unknown_packets: u32,
    /// The newest status message from the drone, if it has sent any. None from the DM002HW so far.
    pub report: Option<DroneReport>,
    pub status_messages: u32,
    /// Where those packets are written, once the app data folder is known.
    pub unknown_packets_file: Option<String>,
    pub send_errors: u64,
    pub flow: Option<DroneFlow>,
    pub drift_x: f32,
    pub drift_y: f32,
    pub holding: bool,
    pub hold_phase: DroneHoldPhase,
    pub hold_fault: Option<String>,
    pub correction: Option<DroneCorrection>,
    pub height_rate: i8,
    pub manual_steering: bool,
    pub took_off: bool,
    /// Headless mode is on. It reaches the drone only while armed.
    pub headless: bool,
    /// The one-key return is being sent to the drone.
    pub returning: bool,
    pub flight_log: Option<String>,
    pub page_alive: bool,
    /// True when this computer is on the drone's Wi-Fi.
    pub on_network: bool,
    /// A measurement is saved, so hold can start after takeoff without test pushes.
    pub has_hold_calibration: bool,
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
    manual: Option<(Manual, Instant)>,
    flight_log: Option<String>,
    data_folder: Option<std::path::PathBuf>,
    saved_calibration: Option<Calibration>,
}

/// Reads a saved measurement, ignoring anything that is not two finite numbers.
fn parse_calibration(text: &str) -> Option<Calibration> {
    let mut numbers = text.split_whitespace().map(str::parse::<f32>);
    let slide = numbers.next()?.ok()?;
    let zoom = numbers.next()?.ok()?;
    (slide.is_finite() && zoom.is_finite()).then_some(Calibration { slide, zoom })
}

impl Inner {
    fn manual(&self) -> Manual {
        self.manual
            .filter(|(_, at)| at.elapsed() < HEIGHT_STALE_AFTER)
            .map_or_else(Manual::default, |(manual, _)| manual)
    }

    fn height_rate(&self) -> i8 {
        self.manual().height
    }

    /// Adds the page's buttons to `sticks`. The pilot limits the result.
    /// Adds trim and the page's buttons to `sticks`. The pilot limits the result.
    fn with_manual(&self, sticks: Sticks) -> Sticks {
        let manual = self.manual();
        let push = |value: u8, by: i16| (i16::from(value) + by).clamp(0, 255) as u8;
        let both = |a: i8, b: i8| i16::from(a) + i16::from(b);
        Sticks {
            throttle: push(NEUTRAL, i16::from(manual.height)),
            aileron: push(sticks.aileron, both(manual.aileron, manual.trim_aileron)),
            elevator: push(sticks.elevator, both(manual.elevator, manual.trim_elevator)),
            rudder: push(sticks.rudder, i16::from(manual.trim_rudder)),
        }
    }

    fn unknown_packets_file(&self) -> Option<std::path::PathBuf> {
        self.data_folder
            .as_ref()
            .map(|folder| folder.join(UNKNOWN_PACKETS_FILE))
    }

    fn calibration_file(&self) -> Option<std::path::PathBuf> {
        self.data_folder
            .as_ref()
            .map(|folder| folder.join(CALIBRATION_FILE))
    }

    /// Keeps a new measurement for the next flight. A failed write only loses that.
    fn remember_calibration(&mut self, calibration: Calibration) {
        if self.saved_calibration == Some(calibration) {
            return;
        }
        self.saved_calibration = Some(calibration);
        if let Some(path) = self.calibration_file() {
            let text = format!("{} {}\n", calibration.slide, calibration.zoom);
            if let Err(error) = std::fs::write(&path, text) {
                warn!(%error, "could not save the hold measurement");
            }
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

    /// Where to keep the hold measurement, loading any saved there before.
    pub fn use_data_folder(&self, folder: std::path::PathBuf) {
        let mut inner = self.lock();
        let saved = std::fs::read_to_string(folder.join(CALIBRATION_FILE)).ok();
        inner.saved_calibration = saved.as_deref().and_then(parse_calibration);
        inner.data_folder = Some(folder);
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
            video_restarts: status.map_or(0, |status| status.video_restarts),
            video_repeats: status.map_or(0, |status| status.video_repeats),
            unknown_packets: status.map_or(0, |status| status.unknown_packets),
            report: status
                .and_then(|status| status.drone_status)
                .map(|report| DroneReport {
                    fly_state: report.fly_state,
                    battery: report.battery,
                    speed: report.speed,
                    remote_control: report.remote_control,
                    camera_tilt: report.camera_tilt,
                    headless: report.headless,
                    photo: report.photo,
                    video: report.video,
                    light: report.light,
                }),
            status_messages: status.map_or(0, |status| status.status_messages),
            unknown_packets_file: inner
                .unknown_packets_file()
                .map(|path| path.display().to_string()),
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
            manual_steering: inner.manual().steers(),
            took_off: status.is_some_and(|status| status.took_off),
            headless: status.is_some_and(|status| status.headless),
            returning: status.is_some_and(|status| status.returning),
            flight_log: inner.flight_log.clone(),
            correction: status
                .and_then(|status| status.correction)
                .map(|correction| DroneCorrection {
                    aileron: correction.aileron,
                    elevator: correction.elevator,
                }),
            page_alive: is_fresh(inner.last_heartbeat),
            on_network: inner.on_network,
            has_hold_calibration: inner.saved_calibration.is_some(),
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
        if let Some(path) = inner.unknown_packets_file() {
            record_unknown_packets(&link, &path);
        }
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

    /// The newest video frame other than `after`, waiting briefly for one, as its number in four little-endian bytes
    /// and then the JPEG. Empty if none came. The lock is not held while waiting.
    pub fn frame_after(&self, after: u32) -> Vec<u8> {
        let link = self.lock().link.as_ref().map(Link::viewer);
        let frame = link.and_then(|viewer| viewer.next_frame(after, FRAME_WAIT));
        let Some(frame) = frame else {
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

    /// The Drone page saying it is still open, with only height asked for.
    #[cfg(test)]
    fn heartbeat(&self, height: i8) {
        self.page(Manual {
            height,
            ..Manual::default()
        });
    }

    /// The Drone page saying it is still open. Without this or the watch, the pilot lands. `manual` is what its
    /// buttons and keys ask for, sent with every beat so a stuck button cannot keep the drone moving. Steering by
    /// hand ends hold at once, so a person always wins over the autopilot.
    pub fn page(&self, manual: Manual) {
        let mut inner = self.lock();
        let now = Instant::now();
        let manual = manual.limited();
        inner.last_heartbeat = Some(now);
        inner.manual = Some((manual, now));
        let measured = inner.link.as_ref().and_then(Link::calibration);
        if let Some(calibration) = measured {
            inner.remember_calibration(calibration);
        }
        let Some(link) = &inner.link else { return };
        link.set_auto_hold(inner.saved_calibration.filter(|_| manual.auto_hold));
        if manual.steers() {
            let _ = link.set_hold(false);
        }
        if !inner.steering.is_held() {
            link.set_sticks(inner.with_manual(Sticks::CENTRED));
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

    pub fn set_headless(&self, enabled: bool) -> Result<(), String> {
        let inner = self.lock();
        let link = inner.link.as_ref().ok_or(NOT_CONNECTED)?;
        link.set_headless(enabled);
        Ok(())
    }

    /// Starts or cancels the one-key return.
    pub fn set_return(&self, enabled: bool) -> Result<(), String> {
        let inner = self.lock();
        let link = inner.link.as_ref().ok_or(NOT_CONNECTED)?;
        if enabled {
            link.start_return().map_err(|error| error.to_string())
        } else {
            link.cancel_return();
            Ok(())
        }
    }

    pub fn set_button(&self, held: bool) {
        self.lock().steering.set_held(held);
    }

    pub fn observe_orientation(&self, sample: &WatchOrientationSample) {
        let mut inner = self.lock();
        inner.last_orientation = Some(Instant::now());
        let sticks = inner.steering.observe(sample.quaternion);
        let sticks = inner.with_manual(sticks);
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
    match app.path().app_data_dir() {
        Ok(folder) => app.state::<DroneRuntime>().use_data_folder(folder),
        Err(error) => warn!(%error, "no folder for the drone's saved hold measurement"),
    }
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

/// Waits for the next frame off the main thread, so the page can show each one as soon as it is ready.
#[tauri::command]
pub async fn drone_frame(after: u32, app: tauri::AppHandle) -> tauri::ipc::Response {
    use tauri::Manager;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        app.state::<DroneRuntime>().frame_after(after)
    })
    .await
    .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
pub fn drone_heartbeat(input: Manual, runtime: State<'_, DroneRuntime>) {
    runtime.page(input);
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
pub fn drone_set_headless(
    enabled: bool,
    runtime: State<'_, DroneRuntime>,
) -> Result<DroneState, String> {
    runtime.set_headless(enabled)?;
    Ok(runtime.state())
}

#[tauri::command]
pub fn drone_set_return(
    enabled: bool,
    runtime: State<'_, DroneRuntime>,
) -> Result<DroneState, String> {
    runtime.set_return(enabled)?;
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
        let stale = Manual {
            height: 30,
            aileron: 20,
            elevator: -20,
            trim_rudder: 5,
            ..Manual::default()
        };
        let inner = Inner {
            manual: Instant::now()
                .checked_sub(HEIGHT_STALE_AFTER)
                .map(|at| (stale, at)),
            ..Inner::default()
        };
        assert_eq!(inner.height_rate(), 0);
        assert_eq!(inner.with_manual(Sticks::CENTRED), Sticks::CENTRED);
    }

    #[test]
    fn height_only_moves_the_throttle() {
        let inner = Inner {
            manual: Some((
                Manual {
                    height: -20,
                    ..Manual::default()
                },
                Instant::now(),
            )),
            ..Inner::default()
        };
        let sticks = inner.with_manual(Sticks::CENTRED);
        assert_eq!(sticks.throttle, NEUTRAL - 20);
        assert_eq!(sticks.aileron, NEUTRAL);
    }

    #[test]
    fn steering_buttons_move_aileron_and_elevator_within_limits() {
        let runtime = DroneRuntime::default();
        runtime.page(Manual {
            aileron: 100,
            elevator: -100,
            ..Manual::default()
        });
        let inner = runtime.lock();
        let sticks = inner.with_manual(Sticks::CENTRED);
        assert_eq!(sticks.aileron, NEUTRAL + MAX_NUDGE as u8);
        assert_eq!(sticks.elevator, NEUTRAL - MAX_NUDGE as u8);
        assert_eq!(sticks.throttle, NEUTRAL);
        drop(inner);
        assert!(runtime.state().manual_steering);
    }

    #[test]
    fn trim_offsets_the_sticks_within_its_limit_and_adds_to_steering() {
        let runtime = DroneRuntime::default();
        runtime.page(Manual {
            aileron: 25,
            trim_aileron: 50,
            trim_elevator: -4,
            trim_rudder: 3,
            ..Manual::default()
        });
        let inner = runtime.lock();
        let sticks = inner.with_manual(Sticks::CENTRED);
        assert_eq!(sticks.aileron, NEUTRAL + 25 + MAX_TRIM as u8);
        assert_eq!(sticks.elevator, NEUTRAL - 4);
        assert_eq!(sticks.rudder, NEUTRAL + 3);
        assert_eq!(sticks.throttle, NEUTRAL);
    }

    #[test]
    fn the_page_sends_its_input_as_one_object() {
        let input: Manual = serde_json::from_str(
            r#"{"height":5,"aileron":-3,"elevator":0,"trimAileron":2,"trimElevator":-1,"trimRudder":0,"autoHold":true}"#,
        )
        .unwrap();
        assert_eq!(input.trim_aileron, 2);
        assert!(input.auto_hold);
        let partial: Manual = serde_json::from_str(r#"{"height":5}"#).unwrap();
        assert!(!partial.auto_hold);
    }

    #[test]
    fn a_saved_measurement_survives_a_restart_and_a_damaged_one_is_ignored() {
        let folder = std::env::temp_dir().join(format!("drone-hold-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let runtime = DroneRuntime::default();
        runtime.use_data_folder(folder.clone());
        assert!(!runtime.state().has_hold_calibration);
        runtime.lock().remember_calibration(Calibration {
            slide: -21.5,
            zoom: 0.04,
        });
        let restarted = DroneRuntime::default();
        restarted.use_data_folder(folder.clone());
        assert!(restarted.state().has_hold_calibration);
        assert_eq!(
            restarted.lock().saved_calibration,
            Some(Calibration {
                slide: -21.5,
                zoom: 0.04
            })
        );
        std::fs::write(folder.join(CALIBRATION_FILE), "nonsense").unwrap();
        let damaged = DroneRuntime::default();
        damaged.use_data_folder(folder.clone());
        assert!(!damaged.state().has_hold_calibration);
        std::fs::remove_dir_all(&folder).ok();
        assert_eq!(parse_calibration("NaN 1"), None);
        assert_eq!(parse_calibration("1"), None);
    }

    #[test]
    fn every_fault_explains_itself() {
        for fault in [
            HoldFault::NoResponse(HoldAxis::Sideways),
            HoldFault::Unsteady(HoldAxis::ForwardBack),
            HoldFault::PictureLost,
            HoldFault::PictureNotSteady,
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
        assert_eq!(runtime.set_headless(true), Err(NOT_CONNECTED.to_string()));
        assert_eq!(runtime.set_return(true), Err(NOT_CONNECTED.to_string()));
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
