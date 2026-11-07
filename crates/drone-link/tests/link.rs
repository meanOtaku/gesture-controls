//! Runs the link against a stand-in drone on loopback that behaves as the real one did in testing.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{JoinHandle, sleep};
use std::time::{Duration, Instant};

use drone_link::{
    Button, Endpoint, Link, LinkError, LinkPhase, LinkTiming, PilotConfig, PilotError, Sticks,
};

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const VIDEO_PARTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Seen {
    sticks: [u8; 4],
    flags: u8,
}

#[derive(Default)]
struct Log {
    control: Vec<Seen>,
    bad_checksums: usize,
}

struct FakeDrone {
    endpoint: Endpoint,
    log: Arc<Mutex<Log>>,
    finished: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl FakeDrone {
    /// `streams` false is a drone that hears nothing.
    fn start(streams: bool) -> Self {
        let control = UdpSocket::bind((LOOPBACK, 0)).unwrap();
        let aux = UdpSocket::bind((LOOPBACK, 0)).unwrap();
        let video = UdpSocket::bind((LOOPBACK, 0)).unwrap();
        control
            .set_read_timeout(Some(Duration::from_millis(5)))
            .unwrap();
        let endpoint = Endpoint {
            host: LOOPBACK,
            control_port: control.local_addr().unwrap().port(),
            aux_port: aux.local_addr().unwrap().port(),
        };
        let log = Arc::new(Mutex::new(Log::default()));
        let finished = Arc::new(AtomicBool::new(false));
        let worker = {
            let log = Arc::clone(&log);
            let finished = Arc::clone(&finished);
            std::thread::spawn(move || {
                let mut buffer = [0; 2048];
                while !finished.load(Ordering::SeqCst) {
                    let Ok((length, source)) = control.recv_from(&mut buffer) else {
                        continue;
                    };
                    let data = &buffer[..length];
                    if !streams {
                        record(&log, data);
                        continue;
                    }
                    if data == [0xEF, 0x00, 0x04, 0x00] {
                        serve(&video, 1, source);
                    }
                    record(&log, data);
                    if length == 124 {
                        let wanted = u32::from_le_bytes(data[108..112].try_into().unwrap());
                        serve(&video, wanted, source);
                    }
                }
            })
        };
        Self {
            endpoint,
            log,
            finished,
            worker: Some(worker),
        }
    }

    fn seen(&self) -> Vec<Seen> {
        self.log.lock().unwrap().control.clone()
    }

    fn bad_checksums(&self) -> usize {
        self.log.lock().unwrap().bad_checksums
    }
}

impl Drop for FakeDrone {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn record(log: &Mutex<Log>, data: &[u8]) {
    if data.len() != 124 || data[16..19] != [0x08, 0x00, 0x66] {
        return;
    }
    let mut log = log.lock().unwrap();
    let checksum = data[19..24].iter().fold(0, |sum, byte| sum ^ byte);
    if checksum != data[24] || data[25] != 0x99 {
        log.bad_checksums += 1;
    }
    log.control.push(Seen {
        sticks: data[19..23].try_into().unwrap(),
        flags: data[23],
    });
}

fn serve(video: &UdpSocket, frame: u32, target: SocketAddr) {
    for part in 0..VIDEO_PARTS {
        let mut packet = [0u8; 80];
        packet[..2].copy_from_slice(&[0x93, 0x01]);
        packet[16..20].copy_from_slice(&frame.to_le_bytes());
        packet[32..36].copy_from_slice(&part.to_le_bytes());
        packet[36..40].copy_from_slice(&VIDEO_PARTS.to_le_bytes());
        let _ = video.send_to(&packet, target);
    }
}

fn quick_pilot() -> PilotConfig {
    PilotConfig {
        press_hold: Duration::from_millis(150),
        stop_hold: Duration::from_millis(100),
        ..PilotConfig::default()
    }
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        sleep(Duration::from_millis(5));
    }
}

fn open(drone: &FakeDrone) -> Link {
    let link = Link::open(drone.endpoint, quick_pilot(), LinkTiming::default()).unwrap();
    wait_until("video", || link.status().video_frames >= 5);
    link
}

const UP: u8 = 0x41;
const DOWN: u8 = 0x42;
const STOP: u8 = 0x44;

#[test]
fn sends_idle_frames_at_the_app_rate_and_video_advances() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    assert_eq!(link.status().phase, LinkPhase::Open);

    let before = drone.seen().len();
    sleep(Duration::from_millis(500));
    let sent = drone.seen().len() - before;
    assert!((8..=12).contains(&sent), "sent {sent} frames in 500 ms");
    assert!(
        drone
            .seen()
            .iter()
            .all(|seen| seen.flags == 0x40 && seen.sticks == [0x80; 4])
    );
    assert_eq!(drone.bad_checksums(), 0);
    assert!(link.status().video_frames > 8);
}

#[test]
fn a_drone_that_never_answers_gets_no_control() {
    let drone = FakeDrone::start(false);
    let timing = LinkTiming {
        first_frame_timeout: Duration::from_millis(100),
        ..LinkTiming::default()
    };
    let link = Link::open(drone.endpoint, quick_pilot(), timing).unwrap();
    wait_until("failure", || link.status().phase == LinkPhase::Failed);
    assert!(matches!(link.arm(), Err(LinkError::NotOpen)));
    assert!(drone.seen().is_empty());
}

#[test]
fn up_is_refused_until_armed() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    assert!(matches!(
        link.press(Button::Up),
        Err(LinkError::Pilot(PilotError::NotArmed))
    ));
    sleep(Duration::from_millis(120));
    assert!(drone.seen().iter().all(|seen| seen.flags & 0x01 == 0));
}

#[test]
fn up_then_sticks_reach_the_drone_limited() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    link.arm().unwrap();
    link.press(Button::Up).unwrap();
    wait_until("up", || drone.seen().iter().any(|seen| seen.flags == UP));

    let pushed = Sticks {
        aileron: 0xFF,
        elevator: 0x00,
        throttle: 0xFF,
        rudder: 0x80,
    };
    wait_until("sticks", || {
        link.set_sticks(pushed);
        drone
            .seen()
            .iter()
            .any(|seen| seen.sticks == [0x80 + 38, 0x80 - 38, 0x80 + 64, 0x80])
    });
    assert!(
        drone
            .seen()
            .iter()
            .all(|seen| seen.sticks[0] <= 0x80 + 38 && seen.sticks[2] <= 0x80 + 64)
    );
    assert_eq!(drone.bad_checksums(), 0);
}

#[test]
fn silence_from_the_caller_lands_the_drone() {
    let drone = FakeDrone::start(true);
    let pilot = PilotConfig {
        stale_after: Duration::from_millis(80),
        land_after: Duration::from_millis(250),
        ..quick_pilot()
    };
    let link = Link::open(drone.endpoint, pilot, LinkTiming::default()).unwrap();
    wait_until("video", || link.status().video_frames >= 5);
    link.arm().unwrap();
    link.set_sticks(Sticks {
        aileron: 0xFF,
        ..Sticks::CENTRED
    });
    wait_until("failsafe", || link.status().failsafe_tripped);
    wait_until("down", || {
        drone.seen().iter().any(|seen| seen.flags == DOWN)
    });
    assert!(!link.status().armed);

    let seen = drone.seen();
    let down = seen.iter().position(|seen| seen.flags == DOWN).unwrap();
    assert!(seen[down..].iter().all(|seen| seen.sticks == [0x80; 4]));
    let centred_before_down = seen[..down]
        .iter()
        .rev()
        .take_while(|seen| seen.sticks == [0x80; 4])
        .count();
    assert!(
        centred_before_down >= 2,
        "sticks centred only {centred_before_down} frames early"
    );
}

#[test]
fn stop_reaches_the_drone_and_disarms() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    link.arm().unwrap();
    link.set_sticks(Sticks::CENTRED);
    link.stop();
    wait_until("stop", || {
        drone.seen().iter().any(|seen| seen.flags == STOP)
    });
    wait_until("disarm", || !link.status().armed);
}

#[test]
fn dropping_an_armed_link_lands_first() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    link.arm().unwrap();
    wait_until("armed", || link.status().armed);
    drop(link);
    assert!(drone.seen().iter().any(|seen| seen.flags == DOWN));
    let frames = drone.seen().len();
    sleep(Duration::from_millis(120));
    assert_eq!(drone.seen().len(), frames, "still sending after close");
}

#[test]
fn dropping_a_disarmed_link_sends_no_flight_flags() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    drop(link);
    assert!(drone.seen().iter().all(|seen| seen.flags == 0x40));
}

#[test]
fn arming_needs_video_to_be_moving() {
    let drone = FakeDrone::start(true);
    let link = Link::open(drone.endpoint, quick_pilot(), LinkTiming::default()).unwrap();
    assert!(matches!(
        link.arm(),
        Err(LinkError::NotOpen | LinkError::NoVideo)
    ));
}
