//! The motion half of the PPG + IMU pinch-start model's inputs: window summaries of the watch's accelerometer and gyroscope.
//!
//! An exact mirror of the trainer's `imu_onset.py`; the shared cases in `tools/label-trainer/tests/fixtures/
//! imu_onset_cases.json` keep the two equal. For a decision at time T (the PPG sample's time on the watch clock the motion
//! samples share):
//!
//! 1. A 50 Hz grid of [`GRID_TICKS`] ticks ends at T. Each tick holds the last motion sample at or before it; a tick before
//!    the first sample has none.
//! 2. The channels are the accelerometer's and gyroscope's axes and each one's magnitude ([`CHANNELS`]), and each one's
//!    change from the tick before ([`SIGNALS`]).
//! 3. Over the final 16, 32 and 64 ticks (320, 640 and 1,280 ms), each channel and signal is summarised by the 21
//!    statistics of [`STATS`], and each channel's spread is compared with the 3 s before the longest window:
//!    ln((sd of the window + 1e-6) / (sd of those 150 ticks + 1e-6)).
//!
//! 3 windows x (2 signals x 8 channels x 21 statistics + 8 spreads) = [`FEATURE_COUNT`] features, in that order. A decision
//! with a gap of more than [`MAX_GAP_MS`] between motion samples in its span, or a tick before the first sample, has none.

use std::sync::LazyLock;

use crate::ppg_onset::{STATS, summarize};

pub const TICK_NS: u64 = 20_000_000;
/// 320, 640 and 1,280 ms.
pub const WINDOWS: [usize; 3] = [16, 32, 64];
const LONGEST_WINDOW: usize = 64;
/// The 3 s before the longest window, which each window's spread is compared with.
pub const BACKGROUND: usize = 150;
pub const GRID_TICKS: usize = BACKGROUND + LONGEST_WINDOW;
/// How far back from the decision its grid reaches, in nanoseconds (4.26 s).
pub const SPAN_NS: u64 = (GRID_TICKS as u64 - 1) * TICK_NS;
pub const MAX_GAP_MS: u64 = 250;
pub const CHANNELS: [&str; 8] = [
    "accel_x",
    "accel_y",
    "accel_z",
    "gyro_x",
    "gyro_y",
    "gyro_z",
    "accel_mag",
    "gyro_mag",
];
pub const SIGNALS: [&str; 2] = ["raw", "diff"];
const SPREAD_EPSILON: f64 = 1e-6;
pub const FEATURE_COUNT: usize =
    WINDOWS.len() * (SIGNALS.len() * CHANNELS.len() * STATS.len() + CHANNELS.len());
const _: () = assert!(FEATURE_COUNT == 1032 && GRID_TICKS == 214);

/// The features' names, in order: per window, `imu_{channel}_{signal}_n{ms}ms_{statistic}` (signal, channel, statistic),
/// then `imu_{channel}_spread_vs_3s_n{ms}ms`.
pub static FEATURE_NAMES: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut names = Vec::with_capacity(FEATURE_COUNT);
    for window in WINDOWS {
        let ms = window * 20;
        for signal in SIGNALS {
            for channel in CHANNELS {
                for stat in STATS {
                    names.push(format!("imu_{channel}_{signal}_n{ms}ms_{stat}"));
                }
            }
        }
        for channel in CHANNELS {
            names.push(format!("imu_{channel}_spread_vs_3s_n{ms}ms"));
        }
    }
    names
});

/// One motion sample: its timestamp (the watch's clock) and the accelerometer's and gyroscope's axes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MotionSample {
    pub ts_ns: u64,
    pub accel: [f64; 3],
    pub gyro: [f64; 3],
}

impl MotionSample {
    /// The eight channels, in [`CHANNELS`] order.
    fn channels(&self) -> [f64; 8] {
        let norm = |v: &[f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        let [ax, ay, az] = self.accel;
        let [gx, gy, gz] = self.gyro;
        [ax, ay, az, gx, gy, gz, norm(&self.accel), norm(&self.gyro)]
    }
}

/// Whether no two consecutive samples are further apart than [`MAX_GAP_MS`] where the later one is in `(T - span, T]`.
fn gap_free(samples: &[MotionSample], decision_ns: u64) -> bool {
    let from = decision_ns.saturating_sub(SPAN_NS);
    let limit = MAX_GAP_MS * 1_000_000;
    samples
        .windows(2)
        .filter(|pair| pair[1].ts_ns > from && pair[1].ts_ns <= decision_ns)
        .all(|pair| pair[1].ts_ns - pair[0].ts_ns <= limit)
}

/// The zero-order-held grid ending at `decision_ns`: `[tick][channel]`, or `None` if a tick comes before the first sample.
fn grid(samples: &[MotionSample], decision_ns: u64) -> Option<Vec<[f64; 8]>> {
    (0..GRID_TICKS)
        .map(|k| {
            let tick = decision_ns.checked_sub((GRID_TICKS - 1 - k) as u64 * TICK_NS)?;
            let after = samples.partition_point(|s| s.ts_ns <= tick);
            after.checked_sub(1).map(|i| samples[i].channels())
        })
        .collect()
}

/// numpy's `std`: the population standard deviation, from the mean.
fn std(values: impl Iterator<Item = f64> + Clone) -> f64 {
    let n = values.clone().count() as f64;
    let mean = values.clone().sum::<f64>() / n;
    (values.map(|v| (v - mean).powi(2)).sum::<f64>() / n).sqrt()
}

/// The features for a decision at `decision_ns` from `samples` (sorted by time, on the same clock as the decision), or
/// `None` when it has none (a gap in its span, or a tick before the first sample).
pub fn features(samples: &[MotionSample], decision_ns: u64) -> Option<Vec<f64>> {
    if samples.is_empty() || !gap_free(samples, decision_ns) {
        return None;
    }
    let g = grid(samples, decision_ns)?;
    let dt = TICK_NS as f64 / 1e9;
    let background: Vec<f64> = (0..CHANNELS.len())
        .map(|c| std(g[..BACKGROUND].iter().map(move |row| row[c])))
        .collect();
    let mut out = Vec::with_capacity(FEATURE_COUNT);
    for window in WINDOWS {
        let first = GRID_TICKS - window;
        for signal in SIGNALS {
            #[allow(clippy::needless_range_loop)] // each value reads two ticks of the channel
            for c in 0..CHANNELS.len() {
                let series: Vec<f64> = (first..GRID_TICKS)
                    .map(|k| {
                        if signal == "raw" {
                            g[k][c]
                        } else {
                            g[k][c] - g[k - 1][c]
                        }
                    })
                    .collect();
                out.extend(summarize(&series, dt));
            }
        }
        for (c, quiet) in background.iter().enumerate() {
            let spread = std(g[first..].iter().map(|row| row[c]));
            out.push(((spread + SPREAD_EPSILON) / (quiet + SPREAD_EPSILON)).ln());
        }
    }
    out.iter().all(|v| v.is_finite()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        samples: Vec<(u64, f64, f64, f64, f64, f64, f64)>,
        decisions: Vec<u64>,
        /// One row per decision; `None` where the trainer gives no features.
        expected: Vec<Option<Vec<f64>>>,
    }

    #[derive(serde::Deserialize)]
    struct Cases {
        feature_names: Vec<String>,
        cases: Vec<Case>,
    }

    fn cases() -> Cases {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tools/label-trainer/tests/fixtures/imu_onset_cases.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("the shared cases")).unwrap()
    }

    /// As for the PPG features: relative to the value, or to 1 for small values; a tree split is decided in f32.
    const TOLERANCE: f64 = 1e-7;

    fn error(a: f64, b: f64) -> f64 {
        (a - b).abs() / a.abs().max(b.abs()).max(1.0)
    }

    fn samples(case: &Case) -> Vec<MotionSample> {
        case.samples
            .iter()
            .map(|&(ts_ns, ax, ay, az, gx, gy, gz)| MotionSample {
                ts_ns,
                accel: [ax, ay, az],
                gyro: [gx, gy, gz],
            })
            .collect()
    }

    #[test]
    fn the_names_are_the_trainers() {
        assert_eq!(*FEATURE_NAMES, cases().feature_names);
    }

    #[test]
    fn features_match_the_trainer_on_the_shared_cases() {
        let mut worst = 0.0f64;
        let mut compared = 0;
        for case in cases().cases {
            let trace = samples(&case);
            for (decision, expected) in case.decisions.iter().zip(&case.expected) {
                match (features(&trace, *decision), expected) {
                    (None, None) => {}
                    (Some(got), Some(expected)) => {
                        assert_eq!(got.len(), expected.len());
                        for (i, (a, b)) in got.iter().zip(expected).enumerate() {
                            worst = worst.max(error(*a, *b));
                            assert!(
                                error(*a, *b) <= TOLERANCE,
                                "{}: {} at {decision}: {a} vs {b}",
                                case.name,
                                FEATURE_NAMES[i]
                            );
                        }
                        compared += 1;
                    }
                    (got, expected) => panic!(
                        "{}: at {decision} the runtime has features: {}, the trainer: {}",
                        case.name,
                        got.is_some(),
                        expected.is_some()
                    ),
                }
            }
        }
        assert!(compared >= 6);
        println!("largest relative difference from the trainer: {worst:e}");
    }

    #[test]
    fn a_gap_in_the_span_or_too_little_history_means_no_features() {
        let mut trace: Vec<MotionSample> = (0..300u64)
            .map(|i| MotionSample {
                ts_ns: 1_000_000_000_000 + i * TICK_NS,
                accel: [(i as f64).sin(), 0.1, 0.0],
                gyro: [0.0, (i as f64 * 0.3).cos(), 0.2],
            })
            .collect();
        let decision = trace.last().unwrap().ts_ns;
        assert!(features(&trace, decision).is_some());
        assert!(
            features(&trace, trace[150].ts_ns).is_none(),
            "3 s of history, less than the 4.26 s it reads"
        );
        trace.retain(|s| !(200..214).contains(&((s.ts_ns - 1_000_000_000_000) / TICK_NS)));
        assert!(features(&trace, decision).is_none());
    }
}
