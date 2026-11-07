//! Talks to the drone over UDP: opens the session as the app does, then sends one control frame per period.
//!
//! All sending happens on one thread, so a slow caller cannot delay frames, and a caller that disappears is caught by
//! the pilot rather than leaving the last sticks in place. Video is requested only because the drone expects it. It
//! is not a sign of the link's health: it almost stopped while the motors ran on the bench.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::frame::{
    Button, Sticks, VERSION_QUERY, VIDEO_START, VideoTracker, control_frame, empty_frame,
    opening_request_frame, setup_frame,
};
use crate::pilot::{Pilot, PilotConfig, PilotError};

const MAX_DATAGRAM: usize = 2048;
const SHORTEST_READ_TIMEOUT: Duration = Duration::from_millis(1);
/// Video has to be moving before the drone can be armed, since that shows it is reading our frames.
const MIN_VIDEO_FRAMES_TO_ARM: u32 = 5;
/// The gap between the app's opening frames.
const OPENING_GAP: Duration = Duration::from_millis(27);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkStatus {
    pub phase: LinkPhase,
    pub armed: bool,
    pub failsafe_tripped: bool,
    pub frames_sent: u64,
    pub video_frames: u32,
    pub send_errors: u64,
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
    closing: AtomicBool,
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
                send_errors: 0,
            }),
            closing: AtomicBool::new(false),
        });
        let worker = Worker {
            control: unbound_socket(endpoint.host)?,
            aux: unbound_socket(endpoint.host)?,
            control_address: SocketAddr::new(endpoint.host, endpoint.control_port),
            aux_address: SocketAddr::new(endpoint.host, endpoint.aux_port),
            timing,
            shared: Arc::clone(&shared),
            video: VideoTracker::default(),
            buffer: vec![0; MAX_DATAGRAM],
        };
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
        loop {
            let now = Instant::now();
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
            if source.ip() == self.control_address.ip()
                && self.video.observe(&self.buffer[..length])
            {
                lock(&self.shared.status).video_frames = self.video.completed();
            }
        }
    }
}
