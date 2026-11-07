//! Talks to the drone over UDP: opens the session as the app does, then sends one control frame per period.
//!
//! All sending happens on one thread, so a slow caller cannot delay frames, and a caller that disappears is caught by
//! the pilot rather than leaving the last sticks in place. Video is decoded on a second thread for the same reason,
//! and frames are dropped rather than queued when it falls behind.
//!
//! Video follows the phone app, measured from captures of it: one control frame every 50 ms, each acknowledging the
//! newest whole frame and asking for the next. When a frame stops arriving partway, the app asks again about 15 ms
//! later, and keeps asking until the frame is whole, rather than giving up. The drone resends a frame it is asked for
//! again, and answers a request in about 6 ms.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::flight_log::FlightLog;
use crate::frame::{
    Button, Control, DroneStatus, Sticks, VERSION_QUERY, VIDEO_START, VideoFrame, VideoTracker,
    control_frame, empty_frame, is_video_packet, opening_request_frame, parse_firmware,
    parse_status, setup_frame,
};
use crate::hold::{Autopilot, Calibration, Correction, HoldPhase};
use crate::pilot::{Pilot, PilotConfig, PilotError};
use crate::vision::{Flow, Luma, Tracker, to_jpeg};

const MAX_DATAGRAM: usize = 2048;
const SHORTEST_READ_TIMEOUT: Duration = Duration::from_millis(1);
/// Video has to be moving before the drone can be armed, since that shows it is reading our frames.
const MIN_VIDEO_FRAMES_TO_ARM: u32 = 5;
/// The gap between the app's opening frames.
const OPENING_GAP: Duration = Duration::from_millis(27);
/// With a frame stuck partway for this long, the request is sent again, as the phone app does.
const REPEAT_REQUEST_AFTER: Duration = Duration::from_millis(15);
/// A frame still not whole after this long is given up on. The phone app keeps asking, and this is only a backstop.
const SKIP_FRAME_AFTER: Duration = Duration::from_millis(500);
/// Hold starts this long after Up, once the drone's own takeoff climb has settled.
const AUTO_HOLD_AFTER: Duration = Duration::from_secs(3);
/// If the picture is never steady enough, auto-hold stops trying this long after Up.
const AUTO_HOLD_GIVE_UP: Duration = Duration::from_secs(10);
/// With no video at all for this long, the start packets are sent again.
const RESTART_VIDEO_AFTER: Duration = Duration::from_secs(1);
/// The firmware query can be lost like any packet, so it is repeated a few times, this many frames apart.
const FIRMWARE_RETRY_FRAMES: u16 = 40;
const FIRMWARE_RETRIES: u16 = 5;

/// Where the drone is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Endpoint {
    pub host: IpAddr,
    pub control_port: u16,
    pub aux_port: u16,
}

impl Default for Endpoint {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::new(192, 168, 169, 1)),
            control_port: 8800,
            aux_port: 8801,
        }
    }
}

impl Endpoint {
    /// True when this machine sits on the drone's network. Asks the system for a route, so nothing is sent.
    pub fn is_reachable(&self) -> bool {
        let Ok(socket) = unbound_socket(self.host) else {
            return false;
        };
        socket.connect((self.host, self.control_port)).is_ok()
            && socket
                .local_addr()
                .is_ok_and(|local| same_network(local.ip(), self.host))
    }
}

/// Loopback, or the same /24. A default route would "reach" the drone without being on its Wi-Fi at all.
fn same_network(local: IpAddr, host: IpAddr) -> bool {
    if host.is_loopback() {
        return true;
    }
    match (local, host) {
        (IpAddr::V4(local), IpAddr::V4(host)) => local.octets()[..3] == host.octets()[..3],
        _ => false,
    }
}

/// How fast to talk to the drone. The defaults are the app's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkTiming {
    pub period: Duration,
    pub first_frame_timeout: Duration,
}

impl Default for LinkTiming {
    fn default() -> Self {
        Self {
            period: Duration::from_millis(50),
            first_frame_timeout: Duration::from_secs(1),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkPhase {
    Opening,
    Open,
    /// The drone never sent its first video frame, so no control was ever sent.
    Failed,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinkStatus {
    pub phase: LinkPhase,
    pub armed: bool,
    pub failsafe_tripped: bool,
    /// Up has been sent since the last landing.
    pub took_off: bool,
    /// Headless mode is on. It reaches the drone only while armed.
    pub headless: bool,
    /// The one-key return is being sent.
    pub returning: bool,
    pub frames_sent: u64,
    /// Whole video frames received.
    pub video_frames: u32,
    /// Video frames given up on.
    pub video_skipped: u32,
    /// Frames that arrived whole but would not decode.
    pub video_damaged: u32,
    /// How often video went silent and the start packets were sent again.
    pub video_restarts: u32,
    /// How often a frame stuck partway was asked for again.
    pub video_repeats: u32,
    pub send_errors: u64,
    /// How the picture moved between the last two good frames, and which frame that was.
    pub flow: Option<(u32, Flow)>,
    /// Confident movement added up since the last reset, in pixels of the shrunken image.
    pub drift: (f32, f32),
    /// Confident zoom added up since the last reset.
    pub zoom_total: f32,
    /// What the autopilot is doing.
    pub hold: HoldPhase,
    /// What the hold would send, whether or not it is on. `None` when the picture cannot be trusted.
    pub correction: Option<Correction>,
    /// Packets from the drone that are neither video, the firmware name nor status, on either port.
    pub unknown_packets: u32,
    /// The newest status message from the drone's flight controller, if it has ever sent one.
    pub drone_status: Option<DroneStatus>,
    /// How many status messages have arrived.
    pub status_messages: u32,
}

/// How many unknown packets are kept, and written to the record file, per session. Enough to study, too few to flood.
pub const MAX_KEPT_UNKNOWN: usize = 200;

/// A packet from the drone this link does not understand, kept in case the drone sends status or sensor data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownPacket {
    /// Since the link opened.
    pub at: Duration,
    /// Which of our sockets it arrived on: the control port's or the aux port's.
    pub aux: bool,
    /// The drone port it came from.
    pub source_port: u16,
    pub bytes: Vec<u8>,
    /// It held a status message. Kept anyway, as what its numbers mean is still to be learned.
    pub status: bool,
}

impl UnknownPacket {
    /// One line of the record file: seconds, our port, the drone's port, length, then the bytes in hex.
    pub fn line(&self) -> String {
        let hex: Vec<String> = self
            .bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!(
            "{:.3} {}{} from {} len {} {}",
            self.at.as_secs_f32(),
            if self.status { "status " } else { "" },
            if self.aux { "aux" } else { "control" },
            self.source_port,
            self.bytes.len(),
            hex.join(" ")
        )
    }
}

/// The newest good video frame, as a complete JPEG.
#[derive(Debug, PartialEq, Eq)]
pub struct LiveFrame {
    pub number: u32,
    pub jpeg: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum LinkError {
    #[error("could not open the drone link: {0}")]
    Socket(#[from] std::io::Error),
    #[error("the drone link is not open")]
    NotOpen,
    #[error("video has not started moving, so the drone may not be hearing us")]
    NoVideo,
    #[error(
        "the picture has not been steady for long enough to measure the drone; try again in good light, facing detail"
    )]
    PictureNotSteady,
    #[error(transparent)]
    Pilot(#[from] PilotError),
}

struct Shared {
    pilot: Mutex<Pilot>,
    status: Mutex<LinkStatus>,
    latest_frame: Mutex<Option<Arc<LiveFrame>>>,
    new_frame: Condvar,
    autopilot: Mutex<Autopilot>,
    /// A saved measurement to start hold with after takeoff, or `None` to leave it to the person.
    auto_hold: Mutex<Option<Calibration>>,
    flight_log: Mutex<Option<FlightLog>>,
    firmware: Mutex<Option<String>>,
    unknown: Mutex<Vec<UnknownPacket>>,
    /// Where unknown packets are also written, one line each, as they arrive.
    unknown_file: Mutex<Option<std::fs::File>>,
    opened_at: Instant,
    closing: AtomicBool,
}

impl Shared {
    /// Notices a picture that has stopped, which `add_flow` cannot, as it only runs when a frame arrives.
    fn check_picture(&self, now: Instant) {
        let mut autopilot = lock(&self.autopilot);
        autopilot.check_picture(now);
        let phase = autopilot.phase();
        drop(autopilot);
        if matches!(phase, HoldPhase::Failed(_)) {
            lock(&self.status).hold = phase;
            lock(&self.pilot).set_hold(false);
        }
    }

    /// Starts hold with the saved measurement once the drone's own takeoff has settled. Tries once per takeoff, until
    /// the picture is steady or it is too late, and only if hold is not already running.
    fn maybe_auto_hold(&self, now: Instant, tried: &mut Option<Duration>) {
        let Some(calibration) = *lock(&self.auto_hold) else {
            return;
        };
        let mut pilot = lock(&self.pilot);
        let Some(airborne) = pilot.airborne_for(now) else {
            *tried = None;
            return;
        };
        if !auto_hold_due(
            airborne,
            pilot.is_holding(),
            pilot.is_busy() || pilot.is_returning(now),
            tried.is_some(),
        ) {
            return;
        }
        let mut autopilot = lock(&self.autopilot);
        if autopilot.start_calibrated(now, calibration).is_ok() {
            pilot.set_hold(true);
            lock(&self.status).hold = autopilot.phase();
            *tried = Some(airborne);
        } else if airborne >= AUTO_HOLD_GIVE_UP {
            *tried = Some(airborne);
        }
    }

    /// Reads a packet that is neither video nor the firmware name: status if it holds one, otherwise unknown.
    /// Either way the first ones are kept and written down.
    fn keep_other(&self, aux: bool, source_port: u16, bytes: &[u8]) {
        use std::io::Write;
        let found = parse_status(bytes);
        let count = {
            let mut status = lock(&self.status);
            if let Some(found) = found {
                status.drone_status = Some(found);
                status.status_messages = status.status_messages.saturating_add(1);
            } else {
                status.unknown_packets = status.unknown_packets.saturating_add(1);
            }
            status.status_messages as usize + status.unknown_packets as usize
        };
        if count > MAX_KEPT_UNKNOWN {
            return;
        }
        let packet = UnknownPacket {
            at: self.opened_at.elapsed(),
            aux,
            source_port,
            bytes: bytes.to_vec(),
            status: found.is_some(),
        };
        if let Some(file) = lock(&self.unknown_file).as_mut() {
            // Losing a line only loses evidence, so a write error never stops the link.
            let _ = writeln!(file, "{}", packet.line());
        }
        lock(&self.unknown).push(packet);
    }

    fn add_flow(&self, flow: Option<(u32, Flow)>) {
        let now = Instant::now();
        let hold_allowed = lock(&self.pilot).is_holding();
        let mut autopilot = lock(&self.autopilot);
        // A landing or a stop ends hold in the pilot, which the autopilot learns of here.
        let active = matches!(
            autopilot.phase(),
            HoldPhase::Calibrating | HoldPhase::Holding
        );
        if active && !hold_allowed {
            autopilot.stop();
        }
        let correction = autopilot.on_frame(flow.map(|(_, flow)| flow), now);
        let phase = autopilot.phase();
        {
            let mut status = lock(&self.status);
            status.flow = flow;
            status.drift = autopilot.drift();
            status.zoom_total = autopilot.zoom_total();
            status.correction = autopilot.preview();
            status.hold = phase;
        }
        drop(autopilot);
        let mut pilot = lock(&self.pilot);
        pilot.set_correction(correction, now);
        if matches!(phase, HoldPhase::Failed(_)) {
            pilot.set_hold(false);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// An open session with the drone. Dropping it lands first if armed, then closes.
pub struct Link {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl Link {
    pub fn open(
        endpoint: Endpoint,
        pilot: PilotConfig,
        timing: LinkTiming,
    ) -> Result<Self, LinkError> {
        let shared = Arc::new(Shared {
            pilot: Mutex::new(Pilot::new(pilot, Instant::now())),
            status: Mutex::new(LinkStatus {
                phase: LinkPhase::Opening,
                armed: false,
                failsafe_tripped: false,
                took_off: false,
                headless: false,
                returning: false,
                frames_sent: 0,
                video_frames: 0,
                video_skipped: 0,
                video_damaged: 0,
                video_restarts: 0,
                video_repeats: 0,
                send_errors: 0,
                flow: None,
                drift: (0.0, 0.0),
                zoom_total: 0.0,
                hold: HoldPhase::Off,
                correction: None,
                unknown_packets: 0,
                drone_status: None,
                status_messages: 0,
            }),
            latest_frame: Mutex::new(None),
            new_frame: Condvar::new(),
            autopilot: Mutex::new(Autopilot::default()),
            auto_hold: Mutex::new(None),
            flight_log: Mutex::new(None),
            firmware: Mutex::new(None),
            unknown: Mutex::new(Vec::new()),
            unknown_file: Mutex::new(None),
            opened_at: Instant::now(),
            closing: AtomicBool::new(false),
        });
        // Room for one frame: the picture should be the newest, not a queue of old ones.
        let (frames, decoding) = sync_channel(1);
        let worker = Worker {
            control: unbound_socket(endpoint.host)?,
            aux: {
                let aux = unbound_socket(endpoint.host)?;
                // Read only in passing, between control reads.
                aux.set_nonblocking(true)?;
                aux
            },
            control_address: SocketAddr::new(endpoint.host, endpoint.control_port),
            aux_address: SocketAddr::new(endpoint.host, endpoint.aux_port),
            timing,
            shared: Arc::clone(&shared),
            video: VideoTracker::default(),
            frames,
            last_video: Instant::now(),
            last_request: None,
            last_sent: Instant::now(),
            auto_hold_tried: None,
            buffer: vec![0; MAX_DATAGRAM],
        };
        let vision = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("drone-vision".into())
            .spawn(move || decode_video(&decoding, &vision))?;
        let worker = std::thread::Builder::new()
            .name("drone-link".into())
            .spawn(move || worker.run())?;
        Ok(Self {
            shared,
            worker: Some(worker),
        })
    }

    pub fn status(&self) -> LinkStatus {
        *lock(&self.shared.status)
    }

    /// Makes the current view the point drift is measured from.
    pub fn reset_drift(&self) {
        let mut autopilot = lock(&self.shared.autopilot);
        autopilot.reset();
        let mut status = lock(&self.shared.status);
        status.drift = autopilot.drift();
        status.zoom_total = autopilot.zoom_total();
        status.correction = autopilot.preview();
    }

    /// Measures the drone, then holds the current view. Or stops. Starting is refused unless armed.
    pub fn set_hold(&self, enabled: bool) -> Result<(), LinkError> {
        let mut pilot = lock(&self.shared.pilot);
        if enabled && !pilot.is_armed() {
            return Err(PilotError::NotArmed.into());
        }
        let mut autopilot = lock(&self.shared.autopilot);
        if enabled {
            autopilot
                .start(Instant::now())
                .map_err(|_| LinkError::PictureNotSteady)?;
        } else {
            autopilot.stop();
        }
        lock(&self.shared.status).hold = autopilot.phase();
        pilot.set_hold(enabled);
        Ok(())
    }

    /// Turns headless mode on or off. It is only sent while armed, and Stop turns it off.
    pub fn set_headless(&self, enabled: bool) {
        lock(&self.shared.pilot).set_headless(enabled);
    }

    /// Starts the one-key return while flying, for at most `PilotConfig::return_limit`. Ends hold first.
    pub fn start_return(&self) -> Result<(), LinkError> {
        let mut pilot = lock(&self.shared.pilot);
        pilot.start_return(Instant::now())?;
        let mut autopilot = lock(&self.shared.autopilot);
        autopilot.stop();
        lock(&self.shared.status).hold = autopilot.phase();
        Ok(())
    }

    pub fn cancel_return(&self) {
        lock(&self.shared.pilot).cancel_return();
    }

    /// After each takeoff, holds the view with this saved measurement once the drone has settled. `None` turns it off.
    pub fn set_auto_hold(&self, calibration: Option<Calibration>) {
        *lock(&self.shared.auto_hold) = calibration;
    }

    /// The measurement hold is using, once it has one.
    pub fn calibration(&self) -> Option<Calibration> {
        lock(&self.shared.autopilot).calibration()
    }

    /// Records every control frame from now on, until the link closes.
    pub fn record_flight(&self, log: FlightLog) {
        *lock(&self.shared.flight_log) = Some(log);
    }

    /// The first unknown packets of this session, oldest first.
    pub fn unknown_packets(&self) -> Vec<UnknownPacket> {
        lock(&self.shared.unknown).clone()
    }

    /// Also appends unknown packets to this file as they arrive, starting with any already kept.
    pub fn record_unknown_packets(&self, path: &std::path::Path) -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        for packet in lock(&self.shared.unknown).iter() {
            writeln!(file, "{}", packet.line())?;
        }
        *lock(&self.shared.unknown_file) = Some(file);
        Ok(())
    }

    /// The name the drone gives for its firmware, once it has answered.
    pub fn firmware(&self) -> Option<String> {
        lock(&self.shared.firmware).clone()
    }

    pub fn latest_frame(&self) -> Option<Arc<LiveFrame>> {
        lock(&self.shared.latest_frame).clone()
    }

    /// A handle for watching the video, which can wait for frames without holding up anything else.
    pub fn viewer(&self) -> Viewer {
        Viewer {
            shared: Arc::clone(&self.shared),
        }
    }

    /// The newest frame other than `after`, waiting up to `wait` for one, so a viewer gets it as soon as it is ready.
    pub fn next_frame(&self, after: u32, wait: Duration) -> Option<Arc<LiveFrame>> {
        self.viewer().next_frame(after, wait)
    }

    /// Allows flight. Refused until the drone is visibly answering us. The caller must then keep calling
    /// [`Link::set_sticks`], or the drone is told to land.
    pub fn arm(&self) -> Result<(), LinkError> {
        let status = self.status();
        if status.phase != LinkPhase::Open {
            return Err(LinkError::NotOpen);
        }
        if status.video_frames < MIN_VIDEO_FRAMES_TO_ARM {
            return Err(LinkError::NoVideo);
        }
        lock(&self.shared.pilot).arm(Instant::now());
        Ok(())
    }

    pub fn disarm(&self) {
        lock(&self.shared.pilot).disarm(Instant::now());
    }

    pub fn stop(&self) {
        lock(&self.shared.pilot).stop(Instant::now());
    }

    pub fn press(&self, button: Button) -> Result<(), LinkError> {
        lock(&self.shared.pilot).press(button, Instant::now())?;
        Ok(())
    }

    pub fn set_sticks(&self, sticks: Sticks) {
        lock(&self.shared.pilot).set_sticks(sticks, Instant::now());
    }
}

/// Watches the video from another thread.
pub struct Viewer {
    shared: Arc<Shared>,
}

impl Viewer {
    pub fn next_frame(&self, after: u32, wait: Duration) -> Option<Arc<LiveFrame>> {
        let mut latest = lock(&self.shared.latest_frame);
        let deadline = Instant::now() + wait;
        loop {
            if let Some(frame) = latest.as_ref().filter(|frame| frame.number != after) {
                return Some(Arc::clone(frame));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            latest = self
                .shared
                .new_frame
                .wait_timeout(latest, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.shared.closing.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Decodes frames until the link closes. Runs apart from sending, so a slow frame cannot delay a command.
fn decode_video(frames: &Receiver<VideoFrame>, shared: &Shared) {
    let mut tracker = Tracker::default();
    for frame in frames {
        let jpeg = to_jpeg(&frame.body);
        let Some(luma) = Luma::decode(&jpeg) else {
            let mut status = lock(&shared.status);
            status.video_damaged += 1;
            status.flow = None;
            drop(status);
            continue;
        };
        let flow = tracker.observe(luma).map(|flow| (frame.number, flow));
        shared.add_flow(flow);
        *lock(&shared.latest_frame) = Some(Arc::new(LiveFrame {
            number: frame.number,
            jpeg,
        }));
        shared.new_frame.notify_all();
    }
}

/// Whether to start hold now: settled after takeoff, not too late, and nothing else going on.
fn auto_hold_due(airborne: Duration, holding: bool, pressing: bool, tried: bool) -> bool {
    !tried && !holding && !pressing && airborne >= AUTO_HOLD_AFTER && airborne < AUTO_HOLD_GIVE_UP
}

fn unbound_socket(host: IpAddr) -> std::io::Result<UdpSocket> {
    let any: IpAddr = match host {
        IpAddr::V4(_) => Ipv4Addr::UNSPECIFIED.into(),
        IpAddr::V6(_) => Ipv6Addr::UNSPECIFIED.into(),
    };
    UdpSocket::bind(SocketAddr::new(any, 0))
}

struct Worker {
    /// Left unconnected: the drone answers from its video port, which a connected socket would discard.
    control: UdpSocket,
    aux: UdpSocket,
    control_address: SocketAddr,
    aux_address: SocketAddr,
    timing: LinkTiming,
    shared: Arc<Shared>,
    video: VideoTracker,
    frames: SyncSender<VideoFrame>,
    last_video: Instant,
    /// The newest control frame, sent again to repeat a request between ticks.
    last_request: Option<(u16, Control)>,
    last_sent: Instant,
    /// Set once auto-hold has started, or given up, for the current takeoff.
    auto_hold_tried: Option<Duration>,
    buffer: Vec<u8>,
}

impl Worker {
    fn run(mut self) {
        let opened = self.open_session();
        lock(&self.shared.status).phase = if opened {
            LinkPhase::Open
        } else {
            LinkPhase::Failed
        };
        if opened {
            self.fly();
            lock(&self.shared.status).phase = LinkPhase::Closed;
        }
    }

    fn send(&self, payload: &[u8]) {
        if self.control.send_to(payload, self.control_address).is_err() {
            lock(&self.shared.status).send_errors += 1;
        }
    }

    fn send_aux(&self, payload: &[u8]) {
        if self.aux.send_to(payload, self.aux_address).is_err() {
            lock(&self.shared.status).send_errors += 1;
        }
    }

    /// Replays the app's opening. False if the drone never sends a first frame, and no control is sent then.
    fn open_session(&mut self) -> bool {
        self.send(&VIDEO_START);
        self.pump(Duration::from_millis(7));
        self.send_aux(&VIDEO_START);
        self.pump(Duration::from_millis(94));
        self.send(&VIDEO_START);

        let deadline = Instant::now() + self.timing.first_frame_timeout;
        while self.video.completed() < 1 {
            if Instant::now() >= deadline {
                return false;
            }
            self.pump(Duration::from_millis(10));
        }

        self.send(&empty_frame());
        self.pump(OPENING_GAP);
        self.send(&setup_frame());
        self.pump(OPENING_GAP);
        self.send(&empty_frame());
        self.pump(Duration::from_millis(5));
        self.send_aux(&VIDEO_START);
        self.pump(Duration::from_millis(21));
        self.send(&opening_request_frame(self.video.completed()));
        self.send(&VERSION_QUERY);
        self.pump(OPENING_GAP);
        true
    }

    /// Sends a frame every period until closed. Closing lands first, and waits for that press to finish.
    fn fly(&mut self) {
        let mut sequence: u16 = 1;
        let mut next = Instant::now();
        let mut waiting_for = self.video.completed();
        let mut waiting_since = next;
        loop {
            let now = Instant::now();
            if self.video.completed() != waiting_for {
                waiting_for = self.video.completed();
                waiting_since = now;
            } else if now.duration_since(waiting_since) >= SKIP_FRAME_AFTER && self.video.skip() {
                lock(&self.shared.status).video_skipped += 1;
            }
            if now.duration_since(self.last_video) >= RESTART_VIDEO_AFTER {
                self.send(&VIDEO_START);
                self.send_aux(&VIDEO_START);
                self.last_video = now;
                lock(&self.shared.status).video_restarts += 1;
            }
            self.shared.check_picture(now);
            self.shared.maybe_auto_hold(now, &mut self.auto_hold_tried);
            let (control, armed, failsafe, took_off, headless, returning) = {
                let mut pilot = lock(&self.shared.pilot);
                let closing = self.shared.closing.load(Ordering::SeqCst);
                if closing {
                    pilot.disarm(now);
                }
                let control = pilot.tick(now);
                if closing && !pilot.is_busy() {
                    return;
                }
                (
                    control,
                    pilot.is_armed(),
                    pilot.failsafe_tripped(),
                    pilot.has_taken_off(),
                    pilot.is_headless(),
                    pilot.is_returning(now),
                )
            };
            self.send(&control_frame(sequence, control, self.video.completed()));
            self.last_request = Some((sequence, control));
            self.last_sent = Instant::now();
            if let Some(log) = &*lock(&self.shared.flight_log) {
                log.record(control, &lock(&self.shared.status));
            }
            let retry = sequence.is_multiple_of(FIRMWARE_RETRY_FRAMES)
                && sequence <= FIRMWARE_RETRY_FRAMES * FIRMWARE_RETRIES;
            if retry && lock(&self.shared.firmware).is_none() {
                self.send(&VERSION_QUERY);
            }
            sequence = sequence.wrapping_add(1);
            {
                let mut status = lock(&self.shared.status);
                status.frames_sent += 1;
                status.armed = armed;
                status.failsafe_tripped = failsafe;
                status.took_off = took_off;
                status.headless = headless;
                status.returning = returning;
            }
            next = (next + self.timing.period).max(Instant::now());
            self.pump(next.saturating_duration_since(Instant::now()));
        }
    }

    /// Asks again for a frame that has stopped arriving partway, as the phone app does between its ticks.
    fn repeat_if_stuck(&mut self) {
        let now = Instant::now();
        let quiet = now.duration_since(self.last_video) >= REPEAT_REQUEST_AFTER
            && now.duration_since(self.last_sent) >= REPEAT_REQUEST_AFTER;
        let Some((sequence, control)) = self.last_request else {
            return;
        };
        if quiet && self.video.is_incomplete() {
            self.send(&control_frame(sequence, control, self.video.completed()));
            self.last_sent = now;
            lock(&self.shared.status).video_repeats += 1;
        }
    }

    /// Nothing the drone is known to send arrives on the aux port, so all of it is kept as unknown.
    fn drain_aux(&mut self) {
        while let Ok((length, source)) = self.aux.recv_from(&mut self.buffer) {
            if source.ip() == self.aux_address.ip() {
                self.shared
                    .keep_other(true, source.port(), &self.buffer[..length]);
            }
        }
    }

    /// Listens for the drone for this long.
    fn pump(&mut self, duration: Duration) {
        let deadline = Instant::now() + duration;
        loop {
            self.repeat_if_stuck();
            self.drain_aux();
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            // Wake in time to repeat a request, if one is due.
            let timeout = left.min(REPEAT_REQUEST_AFTER).max(SHORTEST_READ_TIMEOUT);
            if self.control.set_read_timeout(Some(timeout)).is_err() {
                std::thread::sleep(timeout);
                continue;
            }
            let Ok((length, source)) = self.control.recv_from(&mut self.buffer) else {
                continue;
            };
            if source.ip() != self.control_address.ip() {
                continue;
            }
            self.last_video = Instant::now();
            if let Some(name) = parse_firmware(&self.buffer[..length]) {
                *lock(&self.shared.firmware) = Some(name);
                continue;
            }
            if !is_video_packet(&self.buffer[..length]) {
                self.shared
                    .keep_other(false, source.port(), &self.buffer[..length]);
                continue;
            }
            if let Some(frame) = self.video.observe(&self.buffer[..length]) {
                lock(&self.shared.status).video_frames = self.video.received();
                // Busy decoding the last one: this frame is dropped, not queued.
                let _ = self.frames.try_send(frame);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn auto_hold_waits_for_takeoff_to_settle_and_tries_once() {
        let at = Duration::from_millis;
        assert!(!auto_hold_due(at(2900), false, false, false));
        assert!(auto_hold_due(at(3000), false, false, false));
        assert!(!auto_hold_due(at(3000), true, false, false));
        assert!(!auto_hold_due(at(3000), false, true, false));
        assert!(!auto_hold_due(at(3000), false, false, true));
        assert!(!auto_hold_due(at(10_000), false, false, false));
    }

    #[test]
    fn only_the_same_subnet_counts_as_the_drones_network() {
        let drone = address("192.168.169.1");
        assert!(same_network(address("192.168.169.3"), drone));
        assert!(!same_network(address("192.168.1.3"), drone));
        assert!(!same_network(address("172.22.64.43"), drone));
        assert!(!same_network(address("0.0.0.0"), drone));
        assert!(!same_network(address("fe80::1"), drone));
    }

    #[test]
    fn loopback_always_counts_so_a_stand_in_drone_can_be_used() {
        assert!(same_network(address("127.0.0.1"), address("127.0.0.1")));
        let endpoint = Endpoint {
            host: address("127.0.0.1"),
            ..Endpoint::default()
        };
        assert!(endpoint.is_reachable());
    }
}
