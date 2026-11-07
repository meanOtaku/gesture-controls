//! The CNN pinch-start model's inputs: the last second of motion and pulse, each channel scaled by its own recent level.
//!
//! An exact mirror of the trainer's `cnn_input.py`; the shared cases in `tools/label-trainer/tests/fixtures/
//! cnn_input_cases.json` keep the two equal. For a decision at time T (on the watch clock both streams share):
//!
//! 1. A 50 Hz grid of [`GRID_TICKS`] ticks ends at T. Each tick holds each stream's last sample at or before it.
//! 2. The channels are the accelerometer's and gyroscope's axes and the pulse sensor's green, red and infrared
//!    ([`CHANNELS`]).
//! 3. Each of the last [`WINDOW_TICKS`] ticks (1 s) is centred and scaled as [`Scaling`] says, the spread floored by
//!    [`MOTION_FLOOR`] or, for the pulse, 0.001 x (|centre| + 1). A sigmoid then puts it in (0, 1).
//!
//! 9 channels x 50 ticks = [`FEATURE_COUNT`] inputs, channel by channel, oldest tick first. A decision with a tick before
//! either stream's first sample, or a gap of more than [`MAX_GAP_MS`] between consecutive samples of either stream in its
//! span, has none.

use std::sync::LazyLock;

use crate::imu_onset::MotionSample;
use crate::ppg_onset::PpgSample;

pub const TICK_NS: u64 = 20_000_000;
/// The second the CNN sees.
pub const WINDOW_TICKS: usize = 50;
/// The 10 s each tick is scaled against.
pub const HISTORY_TICKS: usize = 500;
pub const GRID_TICKS: usize = WINDOW_TICKS + HISTORY_TICKS - 1;
/// How far back from the decision its grid reaches, in nanoseconds (10.96 s).
pub const SPAN_NS: u64 = (GRID_TICKS as u64 - 1) * TICK_NS;
pub const MAX_GAP_MS: u64 = 250;
pub const CHANNELS: [&str; 9] = [
    "accel_x",
    "accel_y",
    "accel_z",
    "gyro_x",
    "gyro_y",
    "gyro_z",
    "ppg_green",
    "ppg_red",
    "ppg_ir",
];
/// How a channel's last ticks are centred and scaled. A model is trained on one and runs on the same one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scaling {
    /// Against the median of the channel's [`GRID_TICKS`] ticks and [`MAD_TO_STD`] x their median absolute deviation. A
    /// burst of motion filling under half of the history leaves both nearly unmoved, so a pinch just after it still stands
    /// out (`docs/research/cnn-motion-hangover-2026-11.md`).
    Median,
    /// Each tick against the population mean and standard deviation of the [`HISTORY_TICKS`] ticks (10 s) ending at it.
    /// One burst of motion inflates that deviation until it leaves the history, about 10 s later. What `ppg_imu_cnn` models
    /// were trained on.
    Rolling,
}

/// A median absolute deviation times this is a standard deviation, on normal data.
pub const MAD_TO_STD: f64 = 1.4826;
/// Far enough that the sigmoid is flat; keeps its exponential finite.
const MAX_Z: f64 = 500.0;
/// The smallest spread each motion channel is scaled by: 0.02 m/s² for the accelerometer, 0.01 rad/s for the gyroscope.
pub const MOTION_FLOOR: [f64; 6] = [0.02, 0.02, 0.02, 0.01, 0.01, 0.01];
const PULSE_FLOOR_SCALE: f64 = 1e-3;
pub const FEATURE_COUNT: usize = CHANNELS.len() * WINDOW_TICKS;
const _: () = assert!(FEATURE_COUNT == 450 && GRID_TICKS == 549);

/// `cnn_{channel}_t{tick}`, channel by channel, ticks 00 (oldest) to 49 (the decision).
pub static FEATURE_NAMES: LazyLock<Vec<String>> = LazyLock::new(|| {
    CHANNELS
        .iter()
        .flat_map(|channel| (0..WINDOW_TICKS).map(move |tick| format!("cnn_{channel}_t{tick:02}")))
        .collect()
});

/// Whether no two consecutive timestamps are further apart than [`MAX_GAP_MS`] where the later one is in `(T - span, T]`.
fn gap_free(ts: impl Iterator<Item = u64>, decision_ns: u64) -> bool {
    let from = decision_ns.saturating_sub(SPAN_NS);
    let limit = MAX_GAP_MS * 1_000_000;
    let mut previous: Option<u64> = None;
    for at in ts {
        if let Some(before) = previous
            && at > from
            && at <= decision_ns
            && at - before > limit
        {
            return false;
        }
        previous = Some(at);
    }
    true
}

/// The zero-order-held stream at each tick, or `None` if a tick comes before its first sample.
fn held<S, const N: usize>(
    samples: &[S],
    ts: impl Fn(&S) -> u64,
    values: impl Fn(&S) -> [f64; N],
    decision_ns: u64,
) -> Option<Vec<[f64; N]>> {
    (0..GRID_TICKS)
        .map(|k| {
            let tick = decision_ns.checked_sub((GRID_TICKS - 1 - k) as u64 * TICK_NS)?;
            let after = samples.partition_point(|s| ts(s) <= tick);
            after.checked_sub(1).map(|i| values(&samples[i]))
        })
        .collect()
}

/// Puts one channel's scaled last ticks on the output, given the floor for a centre.
type Scaler = fn(&[f64], &dyn Fn(f64) -> f64, &mut Vec<f64>);

/// One channel's last ticks, z-scored against the ticks ending at each and through the sigmoid (as the trainer computes
/// it: sums of the values less the first tick).
fn rolling(series: &[f64], floor: &dyn Fn(f64) -> f64, out: &mut Vec<f64>) {
    let first = series[0];
    let mut total = vec![0.0; GRID_TICKS + 1];
    let mut squares = vec![0.0; GRID_TICKS + 1];
    for (k, v) in series.iter().enumerate() {
        let shifted = v - first;
        total[k + 1] = total[k] + shifted;
        squares[k + 1] = squares[k] + shifted * shifted;
    }
    let n = HISTORY_TICKS as f64;
    for last in HISTORY_TICKS - 1..GRID_TICKS {
        let mean = (total[last + 1] - total[last + 1 - HISTORY_TICKS]) / n;
        let variance = (squares[last + 1] - squares[last + 1 - HISTORY_TICKS]) / n - mean * mean;
        let std = variance.max(0.0).sqrt();
        let z = (series[last] - first - mean) / (std + floor(mean + first));
        out.push(1.0 / (1.0 + (-z).exp()));
    }
}

/// The middle value of `values`, an odd number of them (as [`GRID_TICKS`] is), so it is one of them.
fn middle(values: &mut [f64]) -> f64 {
    let at = values.len() / 2;
    *values.select_nth_unstable_by(at, f64::total_cmp).1
}

/// One channel's last ticks against its median and median absolute deviation over all of `series`, through the sigmoid.
fn median(series: &[f64], floor: &dyn Fn(f64) -> f64, out: &mut Vec<f64>) {
    let mut scratch = series.to_vec();
    let centre = middle(&mut scratch);
    for (slot, v) in scratch.iter_mut().zip(series) {
        *slot = (v - centre).abs();
    }
    let spread = MAD_TO_STD * middle(&mut scratch);
    let bottom = spread + floor(centre);
    for v in &series[series.len() - WINDOW_TICKS..] {
        let z = ((v - centre) / bottom).clamp(-MAX_Z, MAX_Z);
        out.push(1.0 / (1.0 + (-z).exp()));
    }
}

/// The inputs for a decision at `decision_ns` from `motion` and `pulse` (each sorted by time, on the decision's clock), or
/// `None` when it has none.
pub fn inputs(
    motion: &[MotionSample],
    pulse: &[PpgSample],
    decision_ns: u64,
    scaling: Scaling,
) -> Option<Vec<f64>> {
    let scaled: Scaler = match scaling {
        Scaling::Median => median,
        Scaling::Rolling => rolling,
    };
    if motion.is_empty()
        || pulse.is_empty()
        || !gap_free(motion.iter().map(|s| s.ts_ns), decision_ns)
        || !gap_free(pulse.iter().map(|s| s.ts_ns), decision_ns)
    {
        return None;
    }
    let m = held(
        motion,
        |s| s.ts_ns,
        |s| {
            [
                s.accel[0], s.accel[1], s.accel[2], s.gyro[0], s.gyro[1], s.gyro[2],
            ]
        },
        decision_ns,
    )?;
    let p = held(pulse, |s| s.ts_ns, |s| [s.green, s.red, s.ir], decision_ns)?;
    let mut out = Vec::with_capacity(FEATURE_COUNT);
    for (c, floor) in MOTION_FLOOR.iter().enumerate() {
        let series: Vec<f64> = m.iter().map(|row| row[c]).collect();
        scaled(&series, &|_| *floor, &mut out);
    }
    for c in 0..3 {
        let series: Vec<f64> = p.iter().map(|row| row[c]).collect();
        scaled(
            &series,
            &|centre| PULSE_FLOOR_SCALE * (centre.abs() + 1.0),
            &mut out,
        );
    }
    out.iter().all(|v| v.is_finite()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        motion: Vec<(u64, f64, f64, f64, f64, f64, f64)>,
        pulse: Vec<(u64, f64, f64, f64)>,
        decisions: Vec<u64>,
        /// One row per decision, with [`Scaling::Rolling`]; `None` where the trainer gives no inputs.
        expected: Vec<Option<Vec<f64>>>,
        /// The same with [`Scaling::Median`].
        expected_median: Vec<Option<Vec<f64>>>,
    }

    #[derive(serde::Deserialize)]
    struct Cases {
        feature_names: Vec<String>,
        cases: Vec<Case>,
    }

    fn cases() -> Cases {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tools/label-trainer/tests/fixtures/cnn_input_cases.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("the shared cases")).unwrap()
    }

    /// The inputs are in (0, 1); a CNN in f32 cannot tell differences this small.
    const TOLERANCE: f64 = 1e-9;

    fn streams(case: &Case) -> (Vec<MotionSample>, Vec<PpgSample>) {
        let motion = case
            .motion
            .iter()
            .map(|&(ts_ns, ax, ay, az, gx, gy, gz)| MotionSample {
                ts_ns,
                accel: [ax, ay, az],
                gyro: [gx, gy, gz],
            })
            .collect();
        let pulse = case
            .pulse
            .iter()
            .map(|&(ts_ns, green, red, ir)| PpgSample {
                ts_ns,
                green,
                red,
                ir,
            })
            .collect();
        (motion, pulse)
    }

    #[test]
    fn the_names_are_the_trainers() {
        assert_eq!(*FEATURE_NAMES, cases().feature_names);
    }

    #[test]
    fn inputs_match_the_trainer_on_the_shared_cases() {
        check(Scaling::Rolling);
    }

    #[test]
    fn median_inputs_match_the_trainer_on_the_shared_cases() {
        check(Scaling::Median);
    }

    fn check(scaling: Scaling) {
        let mut worst = 0.0f64;
        let mut compared = 0;
        for case in cases().cases {
            let (motion, pulse) = streams(&case);
            let rows = match scaling {
                Scaling::Rolling => &case.expected,
                Scaling::Median => &case.expected_median,
            };
            for (decision, expected) in case.decisions.iter().zip(rows) {
                match (inputs(&motion, &pulse, *decision, scaling), expected) {
                    (None, None) => {}
                    (Some(got), Some(expected)) => {
                        assert_eq!(got.len(), expected.len());
                        for (i, (a, b)) in got.iter().zip(expected).enumerate() {
                            worst = worst.max((a - b).abs());
                            assert!(
                                (a - b).abs() <= TOLERANCE,
                                "{}: {} at {decision}: {a} vs {b}",
                                case.name,
                                FEATURE_NAMES[i]
                            );
                        }
                        compared += 1;
                    }
                    (got, expected) => panic!(
                        "{}: at {decision} the runtime has inputs: {}, the trainer: {}",
                        case.name,
                        got.is_some(),
                        expected.is_some()
                    ),
                }
            }
        }
        assert!(compared >= 6);
        println!("largest difference from the trainer: {worst:e}");
    }
}
