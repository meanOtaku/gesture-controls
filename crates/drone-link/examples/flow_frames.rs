//! Runs the image-motion measure over a folder of captured video frame bodies, in name order, and reports its noise.
//!
//! `cargo run --release -p drone-link --example flow_frames -- <folder>`

use std::process::ExitCode;
use std::time::Instant;

use drone_link::vision::{Luma, measure, to_jpeg};

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
        if let Some(before) = &previous {
            let started = Instant::now();
            let flow = measure(before, &luma);
            flow_time += started.elapsed().as_secs_f64();
            measured += 1;
            flows.push(flow);
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
    ExitCode::SUCCESS
}
