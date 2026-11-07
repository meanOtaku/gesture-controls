//! Checks the link against a real drone without flying it: opens a session, sends idle frames, and reports.
//!
//! This never arms, so the pilot refuses Up and ignores sticks, and every frame has centred sticks and idle flags.
//! Join the drone's Wi-Fi first, then: `cargo run -p drone-link --example drone_check`
//!
//! Arguments, all optional, are for a stand-in drone: host, control port, aux port.

use std::net::{IpAddr, UdpSocket};
use std::process::ExitCode;
use std::thread::sleep;
use std::time::{Duration, Instant};

use drone_link::{Endpoint, Link, LinkPhase, LinkTiming, PilotConfig};

const RUN_FOR: Duration = Duration::from_secs(6);
const REPORT_EVERY: Duration = Duration::from_secs(1);
const OPENING_LIMIT: Duration = Duration::from_secs(3);
/// Fewer frames than this over the run means the drone stopped answering.
const MIN_VIDEO_FRAMES: u32 = 40;

/// The address we would reach the host from, to catch not being on the drone's Wi-Fi.
fn local_address(host: IpAddr) -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect((host, 9)).ok()?;
    socket.local_addr().ok().map(|address| address.ip())
}

fn on_same_network(local: IpAddr, host: IpAddr) -> bool {
    match (local, host) {
        (_, IpAddr::V4(host)) if host.is_loopback() => true,
        (IpAddr::V4(local), IpAddr::V4(host)) => local.octets()[..3] == host.octets()[..3],
        _ => false,
    }
}

fn endpoint() -> Result<Endpoint, String> {
    let mut endpoint = Endpoint::default();
    let mut arguments = std::env::args().skip(1);
    if let Some(host) = arguments.next() {
        endpoint.host = host.parse().map_err(|_| format!("bad host {host}"))?;
    }
    if let Some(port) = arguments.next() {
        endpoint.control_port = port.parse().map_err(|_| format!("bad port {port}"))?;
    }
    if let Some(port) = arguments.next() {
        endpoint.aux_port = port.parse().map_err(|_| format!("bad port {port}"))?;
    }
    Ok(endpoint)
}

fn run() -> Result<(), String> {
    let endpoint = endpoint()?;
    let local = local_address(endpoint.host);
    if !local.is_some_and(|local| on_same_network(local, endpoint.host)) {
        return Err(format!(
            "not on the drone's network: {} would be reached from {local:?}",
            endpoint.host
        ));
    }

    let link = Link::open(endpoint, PilotConfig::default(), LinkTiming::default())
        .map_err(|error| error.to_string())?;
    let opening = Instant::now();
    while link.status().phase == LinkPhase::Opening {
        if opening.elapsed() > OPENING_LIMIT {
            return Err("the session did not open".into());
        }
        sleep(Duration::from_millis(10));
    }
    if link.status().phase != LinkPhase::Open {
        return Err("the drone never sent a video frame, so no control was sent".into());
    }
    println!(
        "session open after {:.2} s",
        opening.elapsed().as_secs_f32()
    );

    let started = Instant::now();
    while started.elapsed() < RUN_FOR {
        sleep(REPORT_EVERY);
        let status = link.status();
        println!(
            "{:4.1} s  frames sent {:4}  video frames {:4}  send errors {}  armed {}",
            started.elapsed().as_secs_f32(),
            status.frames_sent,
            status.video_frames,
            status.send_errors,
            status.armed,
        );
    }

    let status = link.status();
    drop(link);
    if status.video_frames < MIN_VIDEO_FRAMES {
        return Err(format!(
            "video only reached frame {}, so the drone stopped answering",
            status.video_frames
        ));
    }
    println!("link check passed");
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
