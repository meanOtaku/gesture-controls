//! The PPG pinch-start model's inputs: multi-scale causal z-score, cubic derivatives and their window summaries.
//!
//! An exact mirror of the trainer's `ppg_onset.py`; the shared cases in `tools/label-trainer/tests/fixtures/
//! ppg_onset_cases.json` keep the two equal. For a decision at time T (the newest PPG sample's timestamp):
//!
//! 1. A 25 Hz grid of [`GRID_TICKS`] ticks ends at T. Each tick holds the last PPG sample at or before it; a tick before
//!    the first sample has none.
//! 2. Each channel is z-scored at each tick against each of [`HISTORIES`] previous ticks (the tick itself excluded):
//!    population mean and standard deviation of those holding a sample, at least [`MIN_HISTORY`]; no spread gives 0.
//! 3. Each z-series is differentiated by a least-squares cubic over its previous nine ticks, evaluated at the tick.
//! 4. The final 8, 16 and 32 ticks of each derivative are summarised by the 21 statistics in [`STATS`].
//!
//! 3 histories x 3 orders x 3 windows x 21 statistics x 3 channels = [`FEATURE_COUNT`] features, in that order. A
//! decision with a gap of more than [`MAX_GAP_MS`] between PPG samples in its span, or without enough history, has none.

use std::sync::LazyLock;

pub const TICK_NS: u64 = 40_000_000;
/// 1, 2 and 4 s of previous ticks.
pub const HISTORIES: [usize; 3] = [25, 50, 100];
pub const MIN_HISTORY: usize = 20;
pub const DIFF_TAPS: usize = 9;
pub const WINDOWS: [usize; 3] = [8, 16, 32];
const LONGEST_WINDOW: usize = 32;
const LONGEST_HISTORY: usize = 100;
/// Every value a decision uses has its full history inside this many ticks.
pub const GRID_TICKS: usize = LONGEST_HISTORY + DIFF_TAPS + LONGEST_WINDOW;
/// How far back from the decision its grid reaches, in nanoseconds (5.6 s).
pub const SPAN_NS: u64 = (GRID_TICKS as u64 - 1) * TICK_NS;
pub const MAX_GAP_MS: u64 = 250;
pub const CHANNELS: [&str; 3] = ["green", "red", "ir"];
pub const STATS: [&str; 21] = [
    "q10",
    "q25",
    "median",
    "q75",
    "q90",
    "mad",
    "mean",
    "std",
    "energy",
    "min",
    "max",
    "positive_peak",
    "negative_peak",
    "absolute_peak",
    "zero_crossings",
    "max_age_seconds",
    "min_age_seconds",
    "absolute_peak_age_seconds",
    "end_minus_start",
    "late_minus_early_mean",
    "mean_absolute_change",
];
pub const FEATURE_COUNT: usize = HISTORIES.len() * 3 * WINDOWS.len() * STATS.len() * CHANNELS.len();
const _: () = assert!(FEATURE_COUNT == 1701 && GRID_TICKS == 141);

/// The features' names, in order: `ppg_z{history ms}ms_d{order}_{channel}_n{window}_{statistic}`.
pub static FEATURE_NAMES: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut names = Vec::with_capacity(FEATURE_COUNT);
    for history in HISTORIES {
        for order in 1..=3 {
            for window in WINDOWS {
                for stat in STATS {
                    for channel in CHANNELS {
                        names.push(format!(
                            "ppg_z{}ms_d{order}_{channel}_n{window}_{stat}",
                            history * 40
                        ));
                    }
                }
            }
        }
    }
    names
});

/// One PPG sample: its raw timestamp and the three channels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PpgSample {
    pub ts_ns: u64,
    pub green: f64,
    pub red: f64,
    pub ir: f64,
}

/// Slope, curvature and jerk at the current tick from the previous nine, by a least-squares cubic: `[order][tap]`.
pub static COEFFICIENTS: LazyLock<[[f64; DIFF_TAPS]; 3]> = LazyLock::new(|| {
    // Normal equations of the cubic through times -9..-1 ticks (seconds); invert the 4x4 Gram matrix exactly.
    let dt = TICK_NS as f64 / 1e9;
    let t: Vec<f64> = (0..DIFF_TAPS).map(|i| (i as f64 - DIFF_TAPS as f64) * dt).collect();
    let mut gram = [[0.0f64; 4]; 4];
    for &x in &t {
        for (r, row) in gram.iter_mut().enumerate() {
            for (c, cell) in row.iter_mut().enumerate() {
                *cell += x.powi((r + c) as i32);
            }
        }
    }
    let inverse = invert4(gram);
    let mut out = [[0.0; DIFF_TAPS]; 3];
    let factorial = [1.0, 2.0, 6.0];
    for (order, row) in out.iter_mut().enumerate() {
        for (tap, cell) in row.iter_mut().enumerate() {
            let coefficient: f64 = (0..4)
                .map(|k| inverse[order + 1][k] * t[tap].powi(k as i32))
                .sum();
            *cell = coefficient * factorial[order];
        }
    }
    out
});

fn invert4(m: [[f64; 4]; 4]) -> [[f64; 4]; 4] {
    let mut a = m;
    let mut inv = [[0.0; 4]; 4];
    for (i, row) in inv.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for col in 0..4 {
        let pivot = (col..4)
            .max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))
            .unwrap_or(col);
        a.swap(col, pivot);
        inv.swap(col, pivot);
        let p = a[col][col];
        for k in 0..4 {
            a[col][k] /= p;
            inv[col][k] /= p;
        }
        for r in 0..4 {
            if r != col {
                let f = a[r][col];
                for k in 0..4 {
                    a[r][k] -= f * a[col][k];
                    inv[r][k] -= f * inv[col][k];
                }
            }
        }
    }
    inv
}

/// Whether no two consecutive samples are further apart than [`MAX_GAP_MS`] where the later one is in `(T - span, T]`.
fn gap_free(samples: &[PpgSample], decision_ns: u64) -> bool {
    let from = decision_ns.saturating_sub(SPAN_NS);
    let limit = MAX_GAP_MS * 1_000_000;
    samples
        .windows(2)
        .filter(|pair| pair[1].ts_ns > from && pair[1].ts_ns <= decision_ns)
        .all(|pair| pair[1].ts_ns - pair[0].ts_ns <= limit)
}

/// The zero-order-held grid ending at `decision_ns`: `[tick][channel]`, NaN before the first sample.
fn grid(samples: &[PpgSample], decision_ns: u64) -> Vec<[f64; 3]> {
    (0..GRID_TICKS)
        .map(|k| {
            let back = (GRID_TICKS - 1 - k) as u64 * TICK_NS;
            let Some(tick) = decision_ns.checked_sub(back) else {
                return [f64::NAN; 3];
            };
            let after = samples.partition_point(|s| s.ts_ns <= tick);
            match after.checked_sub(1) {
                Some(i) => [samples[i].green, samples[i].red, samples[i].ir],
                None => [f64::NAN; 3],
            }
        })
        .collect()
}

/// numpy's `quantile(..., method="linear")` of sorted values.
fn quantile(sorted: &[f64], q: f64) -> f64 {
    let n = sorted.len();
    let position = q * (n - 1) as f64;
    let lo = position.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    let t = position - lo as f64;
    let (a, b) = (sorted[lo], sorted[hi]);
    let diff = b - a;
    // numpy's lerp: from the nearer end, so t = 1 gives b exactly.
    if t >= 0.5 { b - diff * (1.0 - t) } else { a + diff * t }
}

/// numpy's `median`: the middle value, or the mean of the two middle ones.
fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

fn sorted(values: &[f64]) -> Vec<f64> {
    let mut out = values.to_vec();
    out.sort_by(|a, b| a.total_cmp(b));
    out
}

fn first_index_of(values: &[f64], better: impl Fn(f64, f64) -> bool) -> usize {
    let mut best = 0;
    for (i, &v) in values.iter().enumerate().skip(1) {
        if better(v, values[best]) {
            best = i;
        }
    }
    best
}

/// The 21 statistics of one window of values, in [`STATS`] order; `dt` is the seconds between them (for the ages).
pub(crate) fn summarize(w: &[f64], dt: f64) -> [f64; 21] {
    let n = w.len();
    let nf = n as f64;
    let s = sorted(w);
    let q = [0.1, 0.25, 0.5, 0.75, 0.9].map(|p| quantile(&s, p));
    let deviations = sorted(&w.iter().map(|v| (v - q[2]).abs()).collect::<Vec<_>>());
    let mean = w.iter().sum::<f64>() / nf;
    let std = (w.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / nf).sqrt();
    let energy = w.iter().map(|v| v * v).sum::<f64>() / nf;
    let (min, max) = (s[0], s[n - 1]);
    let magnitude: Vec<f64> = w.iter().map(|v| v.abs()).collect();
    let mut crossings = 0.0;
    let mut last = sign(w[0]);
    for &v in &w[1..] {
        let current = sign(v);
        if current != 0.0 && last != 0.0 && current != last {
            crossings += 1.0;
        }
        if current != 0.0 {
            last = current;
        }
    }
    let age = |i: usize| (n - 1 - i) as f64 * dt;
    let half = n / 2;
    let late = w[half..].iter().sum::<f64>() / (n - half) as f64;
    let early = w[..half].iter().sum::<f64>() / half as f64;
    let change = w.windows(2).map(|p| (p[1] - p[0]).abs()).sum::<f64>() / (n - 1) as f64;
    [
        q[0],
        q[1],
        q[2],
        q[3],
        q[4],
        median(&deviations),
        mean,
        std,
        energy,
        min,
        max,
        max.max(0.0),
        min.min(0.0),
        magnitude.iter().copied().fold(f64::MIN, f64::max),
        crossings,
        age(first_index_of(w, |a, b| a > b)),
        age(first_index_of(w, |a, b| a < b)),
        age(first_index_of(&magnitude, |a, b| a > b)),
        w[n - 1] - w[0],
        late - early,
        change,
    ]
}

fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// The z-scores of the ticks the derivatives read, `GRID_TICKS - (DIFF_TAPS + LONGEST_WINDOW)` onwards: `[tick][channel]`,
/// each against its previous `history` ticks.
fn zscores(g: &[[f64; 3]], history: usize) -> Vec<[f64; 3]> {
    let first = GRID_TICKS - (DIFF_TAPS + LONGEST_WINDOW);
    (first..GRID_TICKS)
        .map(|t| {
            let mut z = [f64::NAN; 3];
            for (c, out) in z.iter_mut().enumerate() {
                let past: Vec<f64> = g[t - history..t]
                    .iter()
                    .map(|row| row[c])
                    .filter(|v| v.is_finite())
                    .collect();
                let now = g[t][c];
                if past.len() < MIN_HISTORY || !now.is_finite() {
                    continue;
                }
                let n = past.len() as f64;
                let mean = past.iter().sum::<f64>() / n;
                let sd = (past.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n).sqrt();
                *out = if sd > 0.0 { (now - mean) / sd } else { 0.0 };
            }
            z
        })
        .collect()
}

/// The features for a decision at `decision_ns` from `samples` (sorted by time, the newest at or before the decision), or
/// `None` when it has none (a gap in its span, or not enough history for every value).
pub fn features(samples: &[PpgSample], decision_ns: u64) -> Option<Vec<f64>> {
    if samples.is_empty() || !gap_free(samples, decision_ns) {
        return None;
    }
    let g = grid(samples, decision_ns);
    let coefficients = &*COEFFICIENTS;
    let mut out = Vec::with_capacity(FEATURE_COUNT);
    for history in HISTORIES {
        let z = zscores(&g, history); // DIFF_TAPS + LONGEST_WINDOW ticks
        // derivative[order][channel][j] for the last LONGEST_WINDOW ticks.
        let mut derivative = [[[0.0f64; LONGEST_WINDOW]; 3]; 3];
        for (order, taps) in coefficients.iter().enumerate() {
            for c in 0..3 {
                for (j, out) in derivative[order][c].iter_mut().enumerate() {
                    // The tick DIFF_TAPS + j, from the nine before it.
                    *out = taps
                        .iter()
                        .zip(&z[j..j + DIFF_TAPS])
                        .map(|(w, row)| w * row[c])
                        .sum();
                }
            }
        }
        for order in &derivative {
            for window in WINDOWS {
                let per_channel: Vec<[f64; 21]> = order
                    .iter()
                    .map(|series| {
                        summarize(&series[LONGEST_WINDOW - window..], TICK_NS as f64 / 1e9)
                    })
                    .collect();
                for stat in 0..STATS.len() {
                    for channel in &per_channel {
                        out.push(channel[stat]);
                    }
                }
            }
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
        samples: Vec<(u64, f64, f64, f64)>,
        decisions: Vec<u64>,
        /// One row per decision; `None` where the trainer gives no features.
        expected: Vec<Option<Vec<f64>>>,
    }

    #[derive(serde::Deserialize)]
    struct Cases {
        coefficients: Vec<Vec<f64>>,
        feature_names: Vec<String>,
        cases: Vec<Case>,
    }

    fn cases() -> Cases {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tools/label-trainer/tests/fixtures/ppg_onset_cases.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("the shared cases")).unwrap()
    }

    /// Relative to the value, or to 1 for small values. Summation order differs between numpy and this code, and the jerk's
    /// coefficients (around 1,000) magnify that rounding to about 1e-9; a tree split is decided in f32 (about 6e-8).
    const TOLERANCE: f64 = 1e-7;

    fn error(a: f64, b: f64) -> f64 {
        (a - b).abs() / a.abs().max(b.abs()).max(1.0)
    }

    fn close(a: f64, b: f64) -> bool {
        error(a, b) <= TOLERANCE
    }

    #[test]
    fn the_names_and_coefficients_are_the_trainers() {
        let shared = cases();
        assert_eq!(*FEATURE_NAMES, shared.feature_names);
        for (row, expected) in COEFFICIENTS.iter().zip(&shared.coefficients) {
            for (a, b) in row.iter().zip(expected) {
                assert!(close(*a, *b), "{a} vs {b}");
            }
        }
    }

    #[test]
    fn features_match_the_trainer_on_the_shared_cases() {
        let mut worst = 0.0f64;
        for case in cases().cases {
            let samples: Vec<PpgSample> = case
                .samples
                .iter()
                .map(|&(ts_ns, green, red, ir)| PpgSample { ts_ns, green, red, ir })
                .collect();
            for (decision, expected) in case.decisions.iter().zip(&case.expected) {
                let got = features(&samples, *decision);
                match (got, expected) {
                    (None, None) => {}
                    (Some(got), Some(expected)) => {
                        assert_eq!(got.len(), expected.len());
                        for (i, (a, b)) in got.iter().zip(expected).enumerate() {
                            worst = worst.max(error(*a, *b));
                            assert!(close(*a, *b), "{}: {} at {decision}: {a} vs {b}", case.name, FEATURE_NAMES[i]);
                        }
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
        println!("largest relative difference from the trainer: {worst:e}");
    }

    #[test]
    fn a_gap_in_the_span_means_no_features() {
        let mut samples: Vec<PpgSample> = (0..200u64)
            .map(|i| PpgSample { ts_ns: i * TICK_NS, green: (i as f64).sin(), red: 1.0 + (i as f64 * 0.3).cos(), ir: i as f64 })
            .collect();
        let decision = samples.last().unwrap().ts_ns;
        assert!(features(&samples, decision).is_some());
        samples.retain(|s| !(150..158).contains(&(s.ts_ns / TICK_NS)));
        assert!(features(&samples, decision).is_none());
    }
}
