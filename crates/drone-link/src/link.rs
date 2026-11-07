//! Talks to the drone over UDP: opens the session as the app does, then sends one control frame per period.
//!
//! All sending happens on one thread, so a slow caller cannot delay frames, and a caller that disappears is caught by
//! the pilot rather than leaving the last sticks in place. Video is decoded on a second thread for the same reason,
//! and frames are dropped rather than queued when it falls behind. The drone sends video only when asked, so a frame
//! that never completes is skipped: waiting for it would stall the picture.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::flight_log::FlightLog;
use crate::frame::{
    Button, Sticks, VERSION_QUERY, VIDEO_START, VideoFrame, VideoTracker, control_frame,
    empty_frame, opening_request_frame, setup_frame,
};
use crate::hold::{Autopilot, Correction, HoldPhase};
use crate::pilot::{Pilot, PilotConfig, PilotError};
use crate::vision::{Flow, Luma, measure, to_jpeg};

const MAX_DATAGRAM: usize = 2048;
const SHORTEST_READ_TIMEOUT: Duration = Duration::from_millis(1);
/// Video has to be moving before the drone can be armed, since that shows it is reading our frames.
const MIN_VIDEO_FRAMES_TO_ARM: u32 = 5;
/// The gap between the app's opening frames.
const OPENING_GAP: Duration = Duration::from_millis(27);
/// A frame not finished by now is given up on. The phone app gets about 15 a second, so this is a few frames' time.
const SKIP_FRAME_AFTER: Duration = Duration::from_millis(200);

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
    pub frames_sent: u64,
    /// Whole video frames received.
    pub video_frames: u32,
    /// Video frames given up on.
    pub video_skipped: u32,
    /// Frames that arrived whole but would not decode.
    pub video_damaged: u32,
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
    #[error(transparent)]
    Pilot(#[from] PilotError),
}

struct Shared {
    pilot: Mutex<Pilot>,
    status: Mutex<LinkStatus>,
    latest_frame: Mutex<Option<Arc<LiveFrame>>>,
    autopilot: Mutex<Autopilot>,
    flight_log: Mutex<Option<FlightLog>>,
    closing: AtomicBool,
}

impl Shared {
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
                frames_sent: 0,
                video_frames: 0,
                video_skipped: 0,
                video_damaged: 0,
                send_errors: 0,
                flow: None,
                drift: (0.0, 0.0),
                zoom_total: 0.0,
                hold: HoldPhase::Off,
                correction: None,
            }),
            latest_frame: Mutex::new(None),
            autopilot: Mutex::new(Autopilot::default()),
            flight_log: Mutex::new(None),
            closing: AtomicBool::new(false),
        });
        // Room for one frame: the picture should be the newest, not a queue of old ones.
        let (frames, decoding) = sync_channel(1);
        let worker = Worker {
            control: unbound_socket(endpoint.host)?,
            aux: unbound_socket(endpoint.host)?,
            control_address: SocketAddr::new(endpoint.host, endpoint.control_port),
            aux_address: SocketAddr::new(endpoint.host, endpoint.aux_port),
            timing,
            shared: Arc::clone(&shared),
            video: VideoTracker::default(),
            frames,
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
            autopilot.start(Instant::now());
        } else {
            autopilot.stop();
        }
        lock(&self.shared.status).hold = autopilot.phase();
        pilot.set_hold(enabled);
        Ok(())
    }

    /// Records every control frame from now on, until the link closes.
    pub fn record_flight(&self, log: FlightLog) {
        *lock(&self.shared.flight_log) = Some(log);
    }

    pub fn latest_frame(&self) -> Option<Arc<LiveFrame>> {
        lock(&self.shared.latest_frame).clone()
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
    let mut previous: Option<(u32, Luma)> = None;
    for frame in frames {
        let jpeg = to_jpeg(&frame.body);
        let Some(luma) = Luma::decode(&jpeg) else {
            let mut status = lock(&shared.status);
            status.video_damaged += 1;
            status.flow = None;
            drop(status);
            previous = None;
            continue;
        };
        let flow = previous
            .as_ref()
            .map(|(_, before)| (frame.number, measure(before, &luma)));
        shared.add_flow(flow);
        *lock(&shared.latest_frame) = Some(Arc::new(LiveFrame {
            number: frame.number,
            jpeg,
        }));
        previous = Some((frame.number, luma));
    }
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
            } else if now.duration_since(waiting_since) >= SKIP_FRAME_AFTER {
                self.video.skip();
                lock(&self.shared.status).video_skipped += 1;
            }
            let (control, armed, failsafe) = {
                let mut pilot = lock(&self.shared.pilot);
                let closing = self.shared.closing.load(Ordering::SeqCst);
                if closing {
                    pilot.disarm(now);
                }
                let control = pilot.tick(now);
                if closing && !pilot.is_busy() {
                    return;
                }
                (control, pilot.is_armed(), pilot.failsafe_tripped())
            };
            self.send(&control_frame(sequence, control, self.video.completed()));
            if let Some(log) = &*lock(&self.shared.flight_log) {
                log.record(control, &lock(&self.shared.status));
            }
            sequence = sequence.wrapping_add(1);
            {
                let mut status = lock(&self.shared.status);
                status.frames_sent += 1;
                status.armed = armed;
                status.failsafe_tripped = failsafe;
            }
            next = (next + self.timing.period).max(Instant::now());
            self.pump(next.saturating_duration_since(Instant::now()));
        }
    }

    /// Listens for the drone for this long.
    fn pump(&mut self, duration: Duration) {
        let deadline = Instant::now() + duration;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            let timeout = left.max(SHORTEST_READ_TIMEOUT);
            if self.control.set_read_timeout(Some(timeout)).is_err() {
                std::thread::sleep(left);
                return;
            }
            let Ok((length, source)) = self.control.recv_from(&mut self.buffer) else {
                continue;
            };
            if source.ip() != self.control_address.ip() {
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
