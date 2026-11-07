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
                    if data == [0xEF, 0x20, 0x06, 0x00, 0x01, 0x65] {
                        let mut reply =
                            vec![0x93, 0x04, 0x20, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x65];
                        reply.extend_from_slice(b"(NOFLOW)TEST_V1");
                        let _ = video.send_to(&reply, source);
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

fn serve_part(video: &UdpSocket, frame: u32, part: u32, target: SocketAddr) {
    let mut packet = [0u8; 80];
    packet[..2].copy_from_slice(&[0x93, 0x01]);
    packet[16..20].copy_from_slice(&frame.to_le_bytes());
    packet[32..36].copy_from_slice(&part.to_le_bytes());
    packet[36..40].copy_from_slice(&VIDEO_PARTS.to_le_bytes());
    packet[40..44].copy_from_slice(&(VIDEO_PARTS * 24).to_le_bytes());
    let _ = video.send_to(&packet, target);
}

fn serve(video: &UdpSocket, frame: u32, target: SocketAddr) {
    for part in 0..VIDEO_PARTS {
        serve_part(video, frame, part, target);
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
fn the_firmware_name_is_picked_up() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    wait_until("firmware", || link.firmware().is_some());
    assert_eq!(link.firmware().as_deref(), Some("(NOFLOW)TEST_V1"));
}

#[test]
fn gyro_calibration_reaches_the_drone_on_the_ground_only() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    link.press(Button::GyroCheck).unwrap();
    wait_until("calibrate", || {
        drone.seen().iter().any(|seen| seen.flags == 0xC0)
    });
    assert!(drone.seen().iter().all(|seen| seen.sticks == [0x80; 4]));
    wait_until("release", || !link.status().armed);
    sleep(Duration::from_millis(200));
    link.arm().unwrap();
    assert!(matches!(
        link.press(Button::GyroCheck),
        Err(LinkError::Pilot(PilotError::Armed))
    ));
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

#[test]
fn a_frame_that_never_arrives_is_skipped_rather_than_stalling_the_video() {
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
    let finished = Arc::new(AtomicBool::new(false));
    let running = Arc::clone(&finished);
    let worker = std::thread::spawn(move || {
        let mut buffer = [0; 2048];
        while !running.load(Ordering::SeqCst) {
            let Ok((length, source)) = control.recv_from(&mut buffer) else {
                continue;
            };
            let data = &buffer[..length];
            if data == [0xEF, 0x00, 0x04, 0x00] {
                serve(&video, 1, source);
            } else if length == 124 {
                let wanted = u32::from_le_bytes(data[108..112].try_into().unwrap());
                // Frame 4 only ever arrives in pieces, as it does when the motors are noisy.
                if wanted == 4 {
                    serve_part(&video, wanted, 0, source);
                } else {
                    serve(&video, wanted, source);
                }
            }
        }
    });

    let link = Link::open(endpoint, quick_pilot(), LinkTiming::default()).unwrap();
    wait_until("video past the gap", || link.status().video_frames >= 8);
    assert!(link.status().video_skipped >= 1);
    drop(link);
    finished.store(true, Ordering::SeqCst);
    worker.join().unwrap();
}

/// What froze the picture on the real drone: a pause in the video, with the link counting frames that never came.
#[test]
fn video_comes_back_after_going_silent() {
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
    let finished = Arc::new(AtomicBool::new(false));
    let running = Arc::clone(&finished);
    let worker = std::thread::spawn(move || {
        let mut buffer = [0; 2048];
        let mut silent_until: Option<Instant> = None;
        while !running.load(Ordering::SeqCst) {
            let Ok((length, source)) = control.recv_from(&mut buffer) else {
                continue;
            };
            let data = &buffer[..length];
            if data == [0xEF, 0x00, 0x04, 0x00] {
                serve(&video, 1, source);
            } else if length == 124 {
                let wanted = u32::from_le_bytes(data[108..112].try_into().unwrap());
                if wanted == 6 && silent_until.is_none() {
                    silent_until = Some(Instant::now() + Duration::from_millis(1500));
                }
                if silent_until.is_none_or(|until| Instant::now() >= until) {
                    serve(&video, wanted, source);
                }
            }
        }
    });

    let link = Link::open(endpoint, quick_pilot(), LinkTiming::default()).unwrap();
    wait_until("video past the silence", || {
        link.status().video_frames >= 20
    });
    assert!(link.status().video_restarts >= 1);
    drop(link);
    finished.store(true, Ordering::SeqCst);
    worker.join().unwrap();
}

/// A frame that loses a piece is asked for again within a few milliseconds, and finished rather than given up on.
#[test]
fn a_frame_missing_a_piece_is_asked_for_again_quickly_and_finished() {
    let control = UdpSocket::bind((LOOPBACK, 0)).unwrap();
    let aux = UdpSocket::bind((LOOPBACK, 0)).unwrap();
    let video = UdpSocket::bind((LOOPBACK, 0)).unwrap();
    control
        .set_read_timeout(Some(Duration::from_millis(2)))
        .unwrap();
    let endpoint = Endpoint {
        host: LOOPBACK,
        control_port: control.local_addr().unwrap().port(),
        aux_port: aux.local_addr().unwrap().port(),
    };
    let finished = Arc::new(AtomicBool::new(false));
    let running = Arc::clone(&finished);
    let gaps = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&gaps);
    let worker = std::thread::spawn(move || {
        let mut buffer = [0; 2048];
        let mut lossy_sent_at: Option<Instant> = None;
        while !running.load(Ordering::SeqCst) {
            let Ok((length, source)) = control.recv_from(&mut buffer) else {
                continue;
            };
            let data = &buffer[..length];
            if data == [0xEF, 0x00, 0x04, 0x00] {
                serve(&video, 1, source);
            } else if length == 124 {
                let wanted = u32::from_le_bytes(data[108..112].try_into().unwrap());
                if wanted == 5 && lossy_sent_at.is_none() {
                    // The first time, one piece is lost on the way.
                    serve_part(&video, 5, 0, source);
                    serve_part(&video, 5, 2, source);
                    lossy_sent_at = Some(Instant::now());
                } else {
                    if wanted == 5
                        && let Some(at) = lossy_sent_at
                    {
                        recorded.lock().unwrap().push(at.elapsed());
                    }
                    serve(&video, wanted, source);
                }
            }
        }
    });

    let link = Link::open(endpoint, quick_pilot(), LinkTiming::default()).unwrap();
    wait_until("video past the lost piece", || {
        link.status().video_frames >= 8
    });
    let status = link.status();
    drop(link);
    finished.store(true, Ordering::SeqCst);
    worker.join().unwrap();
    assert_eq!(status.video_skipped, 0, "gave up instead of asking again");
    assert!(status.video_repeats >= 1);
    let first_retry = gaps.lock().unwrap()[0];
    assert!(
        first_retry < Duration::from_millis(45),
        "asked again only after {first_retry:?}"
    );
}

#[test]
fn a_viewer_waiting_for_a_frame_gets_it_as_soon_as_it_is_ready() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    let shown = link.next_frame(0, Duration::from_millis(500)).unwrap();
    let started = Instant::now();
    let next = link
        .next_frame(shown.number, Duration::from_millis(500))
        .unwrap();
    assert_ne!(next.number, shown.number);
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(next.jpeg.len() > 605);
}

/// Anything the drone sends that is neither video nor the firmware name is kept, from either port, and written down,
/// so status or sensor data would be caught if the drone ever sent it.
#[test]
fn packets_the_link_does_not_know_are_kept_and_recorded() {
    let control = UdpSocket::bind((LOOPBACK, 0)).unwrap();
    let aux = UdpSocket::bind((LOOPBACK, 0)).unwrap();
    let video = UdpSocket::bind((LOOPBACK, 0)).unwrap();
    control
        .set_read_timeout(Some(Duration::from_millis(5)))
        .unwrap();
    aux.set_read_timeout(Some(Duration::from_millis(5)))
        .unwrap();
    let endpoint = Endpoint {
        host: LOOPBACK,
        control_port: control.local_addr().unwrap().port(),
        aux_port: aux.local_addr().unwrap().port(),
    };
    // Shaped like the phone app's status message: fly state, battery, speed and flags between 88 and 55.
    let status = [0x88, 0x01, 0x5A, 0x02, 0x00, 0x55];
    let finished = Arc::new(AtomicBool::new(false));
    let running = Arc::clone(&finished);
    let worker = std::thread::spawn(move || {
        let mut buffer = [0; 2048];
        let mut sent_status = false;
        let mut answered_aux = false;
        while !running.load(Ordering::SeqCst) {
            if !answered_aux && let Ok((_, source)) = aux.recv_from(&mut buffer) {
                let _ = aux.send_to(b"aux-hello", source);
                answered_aux = true;
            }
            let Ok((length, source)) = control.recv_from(&mut buffer) else {
                continue;
            };
            let data = &buffer[..length];
            if data == [0xEF, 0x00, 0x04, 0x00] {
                serve(&video, 1, source);
            } else if length == 124 {
                let wanted = u32::from_le_bytes(data[108..112].try_into().unwrap());
                serve(&video, wanted, source);
                if !sent_status && wanted > 3 {
                    let _ = video.send_to(&status, source);
                    sent_status = true;
                }
            }
        }
    });

    let link = Link::open(endpoint, quick_pilot(), LinkTiming::default()).unwrap();
    let folder = std::env::temp_dir().join(format!("drone-unknown-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join("unknown.txt");
    let _ = std::fs::remove_file(&file);
    link.record_unknown_packets(&file).unwrap();
    wait_until("both unknown packets", || {
        link.status().unknown_packets >= 2
    });
    wait_until("video", || link.status().video_frames >= 5);
    let kept = link.unknown_packets();
    let from_control = kept.iter().find(|packet| !packet.aux).unwrap();
    assert_eq!(from_control.bytes, status);
    assert!(
        kept.iter()
            .any(|packet| packet.aux && packet.bytes == b"aux-hello")
    );
    let written = std::fs::read_to_string(&file).unwrap();
    assert!(written.contains("control from"), "{written}");
    assert!(written.contains("len 6 88 01 5a 02 00 55"), "{written}");
    assert!(written.contains("aux from"), "{written}");
    drop(link);
    finished.store(true, Ordering::SeqCst);
    worker.join().unwrap();
    let _ = std::fs::remove_dir_all(&folder);
}

#[test]
fn headless_and_return_reach_the_drone_and_return_needs_a_takeoff() {
    let drone = FakeDrone::start(true);
    let link = open(&drone);
    link.arm().unwrap();
    link.set_headless(true);
    wait_until("headless", || {
        drone.seen().iter().any(|seen| seen.flags == 0x50)
    });
    assert!(link.status().headless);
    assert!(matches!(
        link.start_return(),
        Err(LinkError::Pilot(PilotError::NotFlying))
    ));
    link.press(Button::Up).unwrap();
    wait_until("takeoff", || {
        drone.seen().iter().any(|seen| seen.flags == 0x51)
    });
    sleep(Duration::from_millis(200));
    link.set_sticks(Sticks::CENTRED);
    link.start_return().unwrap();
    wait_until("return", || {
        drone.seen().iter().any(|seen| seen.flags == 0x70)
    });
    assert!(link.status().returning);
    link.cancel_return();
    link.set_sticks(Sticks::CENTRED);
    wait_until("return ended", || {
        drone.seen().last().is_some_and(|seen| seen.flags == 0x50) && !link.status().returning
    });
    link.stop();
    wait_until("stop", || {
        drone.seen().iter().any(|seen| seen.flags == 0x44)
    });
    assert!(!link.status().headless);
}

/// A status message, wherever the drone might put it, is read and still written down for study.
#[test]
fn a_status_message_from_the_drone_is_read() {
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
    // A text packet from the flight controller (source 0) holding fly state 3, battery 72, speed 1 and headless.
    let body = [0x00u8, 3, 72, 0x11];
    let checksum = body.iter().fold(0, |sum, byte| sum ^ byte);
    let mut packet = vec![0x93, 0x04, 0x20, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x88];
    packet.extend_from_slice(&body);
    packet.extend_from_slice(&[checksum, 0x55]);
    let finished = Arc::new(AtomicBool::new(false));
    let running = Arc::clone(&finished);
    let worker = std::thread::spawn(move || {
        let mut buffer = [0; 2048];
        while !running.load(Ordering::SeqCst) {
            let Ok((length, source)) = control.recv_from(&mut buffer) else {
                continue;
            };
            let data = &buffer[..length];
            if data == [0xEF, 0x00, 0x04, 0x00] {
                serve(&video, 1, source);
            } else if length == 124 {
                let wanted = u32::from_le_bytes(data[108..112].try_into().unwrap());
                serve(&video, wanted, source);
                if wanted % 4 == 0 {
                    let _ = video.send_to(&packet, source);
                }
            }
        }
    });

    let link = Link::open(endpoint, quick_pilot(), LinkTiming::default()).unwrap();
    wait_until("status", || link.status().status_messages >= 2);
    let status = link.status().drone_status.unwrap();
    assert_eq!((status.fly_state, status.battery, status.speed), (3, 72, 1));
    assert!(status.headless && !status.light);
    assert_eq!(link.status().unknown_packets, 0);
    let kept = link.unknown_packets();
    assert!(kept.iter().all(|packet| packet.status));
    assert!(kept[0].line().contains("status control from"), "{}", kept[0].line());
    drop(link);
    finished.store(true, Ordering::SeqCst);
    worker.join().unwrap();
}
