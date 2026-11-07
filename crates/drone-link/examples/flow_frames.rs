//! Runs the image-motion measure over a folder of captured video frame bodies, in name order, and reports its noise.
//! It compares adding up frame-to-frame movement with tracking against a reference, on the stretches where the
//! drone is still, so any movement reported is error.
//!
//! `cargo run --release -p drone-link --example flow_frames -- <folder>`

use std::process::ExitCode;
use std::time::Instant;

use drone_link::vision::{Flow, Luma, MIN_CONFIDENCE, Tracker, measure, to_jpeg};

fn main() -> ExitCode {
    let Some(folder) = std::env::args().nth(1) else {
        eprintln!("give a folder of frame bodies");
        return ExitCode::FAILURE;
    };
    let Ok(entries) = std::fs::read_dir(&folder) else {
        eprintln!("cannot read {folder}");
        return ExitCode::FAILURE;
    };
    let mut paths: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();

    let mut previous: Option<Luma> = None;
    let (mut decoded, mut refused, mut measured) = (0, 0, 0);
    let mut flows = Vec::new();
    let mut tracker = Tracker::default();
    let mut tracked = Vec::new();
    let mut decode_time = 0.0;
    let mut flow_time = 0.0;
    for path in &paths {
        let Ok(body) = std::fs::read(path) else {
            continue;
        };
        let started = Instant::now();
        let Some(luma) = Luma::decode(&to_jpeg(&body)) else {
            refused += 1;
            previous = None;
            continue;
        };
        decode_time += started.elapsed().as_secs_f64();
        decoded += 1;
        let followed = tracker.observe(luma.clone());
        if let Some(before) = &previous {
            let started = Instant::now();
            let flow = measure(before, &luma);
            flow_time += started.elapsed().as_secs_f64();
            measured += 1;
            flows.push(flow);
            tracked.push(followed.unwrap_or(flow));
        }
        previous = Some(luma);
    }

    println!("decoded {decoded}, refused {refused}, pairs {measured}");
    if measured == 0 {
        return ExitCode::FAILURE;
    }
    println!(
        "average: decode {:.1} ms, measure {:.1} ms",
        decode_time * 1000.0 / f64::from(decoded),
        flow_time * 1000.0 / f64::from(measured)
    );
    let confident: Vec<_> = flows.iter().filter(|f| f.confidence >= 0.25).collect();
    println!(
        "confident {} of {} pairs, mean confidence {:.2}",
        confident.len(),
        flows.len(),
        flows.iter().map(|f| f.confidence).sum::<f32>() / flows.len() as f32
    );
    let mut sizes: Vec<f32> = confident.iter().map(|f| f.dx.hypot(f.dy)).collect();
    sizes.sort_by(f32::total_cmp);
    if !sizes.is_empty() {
        let at = |share: f32| sizes[((sizes.len() - 1) as f32 * share) as usize];
        println!(
            "movement in pixels: median {:.2}, 90% {:.2}, 99% {:.2}, largest {:.2}",
            at(0.5),
            at(0.9),
            at(0.99),
            at(1.0)
        );
    }
    report_wander(&flows, &tracked);
    ExitCode::SUCCESS
}

/// How far each method wandered, on average, across still stretches of a given length.
fn report_wander(flows: &[Flow], tracked: &[Flow]) {
    const STILL: f32 = 0.5;
    const FRAMES_PER_SECOND: usize = 15;
    let still: Vec<(Flow, Flow)> = flows
        .iter()
        .zip(tracked)
        .filter(|(flow, _)| {
            flow.confidence >= MIN_CONFIDENCE && flow.dx.abs() < STILL && flow.dy.abs() < STILL
        })
        .map(|(flow, track)| (*flow, *track))
        .collect();
    println!("{} still pairs. Average false movement:", still.len());
    println!("  span   frame-to-frame sideways, zoom   reference sideways, zoom");
    for seconds in [1, 5, 10] {
        let span = seconds * FRAMES_PER_SECOND;
        let wander = |pick: fn(&(Flow, Flow)) -> f32| {
            let chunks = still.chunks_exact(span);
            let count = chunks.len().max(1) as f32;
            chunks
                .map(|chunk| chunk.iter().map(pick).sum::<f32>().abs())
                .sum::<f32>()
                / count
        };
        println!(
            "  {seconds:2} s   {:6.2} px  {:6.4}              {:6.2} px  {:6.4}",
            wander(|pair| pair.0.dx),
            wander(|pair| pair.0.zoom),
            wander(|pair| pair.1.dx),
            wander(|pair| pair.1.zoom),
        );
    }
}
