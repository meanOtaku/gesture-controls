//! Replays recordings through the rule-based wrist gestures and counts what each one recognises.
//!
//! `cargo run -p automation --example replay -- <recording folder>...`
//!
//! Each folder holds an `imu.csv` as the Recorder writes it. On recordings with none of these gestures in them
//! (everyday noise, pinch sessions) every recognition is a false one, so the count per hour is each gesture's false
//! activation rate at its default settings: the same measure the models are judged by.

use std::collections::BTreeMap;
use std::path::Path;

use automation::{
    HammerDetector, PitchDetector, RollDetector, ShakeDetector, SwipeDetector, TapDetector,
    TapKind, WiggleDetector,
};

fn replay(folder: &Path, counts: &mut BTreeMap<String, usize>) -> Result<f64, String> {
    let text = std::fs::read_to_string(folder.join("imu.csv")).map_err(|e| e.to_string())?;
    let (mut shake, mut swipe, mut tap) = (
        ShakeDetector::default(),
        SwipeDetector::default(),
        TapDetector::default(),
    );
    let (mut roll, mut pitch, mut wiggle, mut hammer) = (
        RollDetector::default(),
        PitchDetector::default(),
        WiggleDetector::default(),
        HammerDetector::default(),
    );
    let mut count = |name: String| *counts.entry(name).or_default() += 1;
    let (mut first, mut last) = (None, 0u64);
    for line in text.lines() {
        let fields: Vec<&str> = line.split(',').collect();
        let Some(at) = fields.first().and_then(|f| f.parse::<u64>().ok()) else {
            continue;
        };
        let number = |i: usize| fields.get(i).and_then(|f| f.parse::<f64>().ok());
        let (Some(ax), Some(ay), Some(az)) = (number(2), number(3), number(4)) else {
            continue;
        };
        let (Some(w), Some(x), Some(y), Some(z)) = (number(8), number(9), number(10), number(11))
        else {
            continue;
        };
        let (accel, quat) = ([ax, ay, az], [w, x, y, z]);
        first.get_or_insert(at);
        last = at;
        if let Some(found) = shake.observe_oriented(at, accel, Some(quat)) {
            count("shake".into());
            if let Some(axis) = found.axis {
                count(format!("shake {axis:?}"));
            }
        }
        if let Some(direction) = swipe.observe(at, accel, quat) {
            count(format!("swipe {direction:?}"));
        }
        match tap.observe(at, accel) {
            Some(TapKind::Single) => count("tap".into()),
            Some(TapKind::Double) => count("double tap".into()),
            None => {}
        }
        if let Some(direction) = roll.observe(at, quat) {
            count(format!("roll {direction:?}"));
        }
        if let Some(direction) = pitch.observe(at, quat) {
            count(format!("pitch {direction:?}"));
        }
        if wiggle.observe(at, quat) {
            count("wiggle".into());
        }
        if hammer.observe(at, accel) {
            count("hammer".into());
        }
    }
    Ok(first.map_or(0.0, |first| (last - first) as f64 / 1e9))
}

fn main() {
    let mut counts = BTreeMap::new();
    let mut seconds = 0.0;
    let mut folders = 0;
    for folder in std::env::args().skip(1) {
        match replay(Path::new(&folder), &mut counts) {
            Ok(length) => {
                seconds += length;
                folders += 1;
            }
            Err(error) => eprintln!("{folder}: {error}"),
        }
    }
    let hours = seconds / 3600.0;
    println!("{folders} recordings, {:.1} minutes", seconds / 60.0);
    for (name, count) in &counts {
        println!(
            "{name:<28} {count:>5}   {:>7.1} an hour",
            *count as f64 / hours.max(1e-9)
        );
    }
}
