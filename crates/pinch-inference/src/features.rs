//! Deterministic statistical feature extraction, mirroring
//! `tools/label-trainer/src/label_trainer/features.py`'s
//! `FEATURE_NAMES`/`extract_features` exactly (same order, same values) so
//! a model trained offline sees the identical feature contract live on the
//! desktop. See `crate::fusion` for how a raw watch telemetry window becomes
//! a [`FusedWindow`].

/// The statistics every window has always had; the pulse-sensor spike features follow them.
pub const BASE_FEATURE_COUNT: usize = 55;
/// Number of features in the ordered vector every model reads its inputs from: the 55 base statistics, then 24 spike
/// features (8 for each of the three PPG channels), then 6 pulse-sensor level features relative to the recent past (2 for
/// each channel), then 10 motion-dynamics features (5 for the acceleration, 5 for the gyroscope), then 12 pulse features in
/// units of the recent past (4 for each channel), then their step through the window (1 for each channel). Matches
/// Python's `len(FEATURE_NAMES)`.
pub const FEATURE_COUNT: usize = 110;
/// Where the pulse-in-units-of-its-recent-past block starts (twelve features), and its step (three).
pub const BASELINE_Z_START: usize = 95;
pub const BASELINE_STEP_START: usize = 107;
/// The share of the window, from its start and from its end, whose samples are the "before" and "after" of the step (the
/// trainer's `STEP_EARLY_SHARE` and `STEP_LATE_SHARE`).
pub const STEP_EARLY_SHARE: f64 = 0.25;
pub const STEP_LATE_SHARE: f64 = 0.4;
// The blocks sit end to end: the pulse in units of its past right after the motion dynamics, its step last.
const _: () = assert!(BASELINE_Z_START == MOTION_FEATURE_START + 2 * MOTION_STATS);
const _: () = assert!(BASELINE_STEP_START == BASELINE_Z_START + 12 && BASELINE_STEP_START + 3 == FEATURE_COUNT);
/// Where the motion-dynamics features start in [`FEATURE_NAMES`], and how many statistics each motion sensor has.
pub const MOTION_FEATURE_START: usize = 85;
pub const MOTION_STATS: usize = 5;

/// Exact feature order, matching `features.py`'s `FEATURE_NAMES` tuple. A
/// model bundle's `metadata.json` records this same order (see `bundle.py`'s
/// `feature_contract.ordered_names`) and must match it for activation.
pub const FEATURE_NAMES: [&str; FEATURE_COUNT] = [
    "ppg_green_mean",
    "ppg_red_mean",
    "ppg_ir_mean",
    "ppg_green_std",
    "ppg_red_std",
    "ppg_ir_std",
    "ppg_green_min",
    "ppg_red_min",
    "ppg_ir_min",
    "ppg_green_max",
    "ppg_red_max",
    "ppg_ir_max",
    "ppg_green_slope",
    "ppg_red_slope",
    "ppg_ir_slope",
    "accel_x_mean",
    "accel_y_mean",
    "accel_z_mean",
    "accel_x_std",
    "accel_y_std",
    "accel_z_std",
    "accel_x_min",
    "accel_y_min",
    "accel_z_min",
    "accel_x_max",
    "accel_y_max",
    "accel_z_max",
    "accel_magnitude_mean",
    "accel_magnitude_std",
    "gyro_x_mean",
    "gyro_y_mean",
    "gyro_z_mean",
    "gyro_x_std",
    "gyro_y_std",
    "gyro_z_std",
    "gyro_x_min",
    "gyro_y_min",
    "gyro_z_min",
    "gyro_x_max",
    "gyro_y_max",
    "gyro_z_max",
    "gyro_magnitude_mean",
    "gyro_magnitude_std",
    "quat_w_mean",
    "quat_x_mean",
    "quat_y_mean",
    "quat_z_mean",
    "quat_w_std",
    "quat_x_std",
    "quat_y_std",
    "quat_z_std",
    "quat_delta_angle_deg",
    "contact_quality_mean",
    "sample_count",
    "duration_ms",
    "ppg_green_spike_height",
    "ppg_red_spike_height",
    "ppg_ir_spike_height",
    "ppg_green_spike_z",
    "ppg_red_spike_z",
    "ppg_ir_spike_z",
    "ppg_green_spike_time_frac",
    "ppg_red_spike_time_frac",
    "ppg_ir_spike_time_frac",
    "ppg_green_spike_rise_ms",
    "ppg_red_spike_rise_ms",
    "ppg_ir_spike_rise_ms",
    "ppg_green_spike_fall_ms",
    "ppg_red_spike_fall_ms",
    "ppg_ir_spike_fall_ms",
    "ppg_green_spike_count",
    "ppg_red_spike_count",
    "ppg_ir_spike_count",
    "ppg_green_deriv_max",
    "ppg_red_deriv_max",
    "ppg_ir_deriv_max",
    "ppg_green_deriv_min",
    "ppg_red_deriv_min",
    "ppg_ir_deriv_min",
    "ppg_green_rel_low",
    "ppg_red_rel_low",
    "ppg_ir_rel_low",
    "ppg_green_rel_high",
    "ppg_red_rel_high",
    "ppg_ir_rel_high",
    "accel_jerk_rms",
    "accel_jerk_max",
    "accel_magnitude_ptp",
    "accel_magnitude_kurtosis",
    "accel_crossing_rate",
    "gyro_jerk_rms",
    "gyro_jerk_max",
    "gyro_magnitude_ptp",
    "gyro_magnitude_kurtosis",
    "gyro_crossing_rate",
    "ppg_green_rel_z_mean",
    "ppg_red_rel_z_mean",
    "ppg_ir_rel_z_mean",
    "ppg_green_rel_z_max",
    "ppg_red_rel_z_max",
    "ppg_ir_rel_z_max",
    "ppg_green_rel_z_min",
    "ppg_red_rel_z_min",
    "ppg_ir_rel_z_min",
    "ppg_green_rel_z_slope",
    "ppg_red_rel_z_slope",
    "ppg_ir_rel_z_slope",
    "ppg_green_rel_z_step",
    "ppg_red_rel_z_step",
    "ppg_ir_rel_z_step",
];

/// Fewer pulse samples than this in the baseline and there is nothing to compare the window with.
pub const BASELINE_MIN_SAMPLES: usize = 16;
/// The oldest pulse sample of a baseline may be this far after the baseline's start, but no more (see the trainer's
/// `BASELINE_SLACK_MS`): a baseline that does not reach back that far is not the length the model was trained with.
pub const BASELINE_SLACK_MS: u64 = 250;
/// Which points of the baseline the window is compared with: the sample at rank `floor((n - 1) * percent / 100)` of the
/// sorted baseline, in whole numbers so it is the very sample the trainer picks.
pub const BASELINE_LOW_PERCENT: usize = 10;
pub const BASELINE_HIGH_PERCENT: usize = 90;

/// The pulse samples (per channel, oldest first) from the stretch just before a window: what its level is compared with.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PpgBaseline {
    pub green: Vec<f64>,
    pub red: Vec<f64>,
    pub ir: Vec<f64>,
}

/// The sample at rank `floor((n - 1) * percent / 100)` of `values` sorted (`values` must not be empty).
fn baseline_percentile(values: &[f64], percent: usize) -> f64 {
    let mut ordered = values.to_vec();
    ordered.sort_by(|a, b| a.total_cmp(b));
    ordered[((ordered.len() - 1) * percent) / 100]
}

/// The six level-against-the-past features of one window, in the order of the last six names of [`FEATURE_NAMES`]: for each
/// channel (green, red, ir) the window's average minus the low end (10th percentile) of its baseline, then minus the high
/// end (90th percentile). With rest and a held pinch both in the past, those two ends are the rest level and the pinch level
/// whatever the mix; with only rest in it, both are the rest level. A channel with no window samples or too few baseline
/// samples is 0. Mirrors `baseline_features` in the trainer; `tests/fixtures/baseline_cases.json` there holds the shared cases.
pub fn baseline_features(window: [&[f64]; 3], baseline: [&[f64]; 3]) -> [f64; 6] {
    let mut out = [0.0; 6];
    for channel in 0..3 {
        let (values, past) = (window[channel], baseline[channel]);
        if values.is_empty() || past.len() < BASELINE_MIN_SAMPLES {
            continue;
        }
        let level = values.iter().sum::<f64>() / values.len() as f64;
        out[channel] = level - baseline_percentile(past, BASELINE_LOW_PERCENT);
        out[3 + channel] = level - baseline_percentile(past, BASELINE_HIGH_PERCENT);
    }
    out
}

/// Below this a baseline's level is taken to be zero, and a share of it is 0 rather than a division by nothing.
const RATIO_FLOOR: f64 = 1e-9;

/// The smallest spread a pulse channel's recent past is taken to have, in counts (see [`pulse_z`]).
pub const Z_SCALE_FLOOR: f64 = 1.0;
/// How far, in spreads of the recent past, a pulse value may be counted.
pub const Z_CLIP: f64 = 20.0;
const MAD_TO_SD: f64 = 1.4826;

/// The middle value of `values` (the average of the two middle ones for an even count; 0 for none).
fn true_median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut ordered = values.to_vec();
    ordered.sort_by(|a, b| a.total_cmp(b));
    let middle = ordered.len() / 2;
    if ordered.len() % 2 == 1 {
        ordered[middle]
    } else {
        (ordered[middle - 1] + ordered[middle]) / 2.0
    }
}

/// `values` of one pulse channel in units of its recent `past`: minus the past's median, over its spread (the median
/// absolute deviation scaled to a standard deviation, at least [`Z_SCALE_FLOOR`]), clipped to +/-[`Z_CLIP`]. The sensor's
/// level is arbitrary and how far it swings depends on how the watch sits; this cancels both, so what a model learns in
/// one session carries over to the next. Mirrors `pulse_z` in the trainer.
pub fn pulse_z(values: &[f64], past: &[f64]) -> Vec<f64> {
    let centre = true_median(past);
    let deviations: Vec<f64> = past.iter().map(|v| (v - centre).abs()).collect();
    let spread = (true_median(&deviations) * MAD_TO_SD).max(Z_SCALE_FLOOR);
    values
        .iter()
        .map(|v| ((v - centre) / spread).clamp(-Z_CLIP, Z_CLIP))
        .collect()
}

/// The twelve pulse features in units of the recent past, in the order of the last twelve names of [`FEATURE_NAMES`]:
/// for each channel its window samples through [`pulse_z`] against its baseline, then their mean, largest, smallest and
/// least-squares slope per second (`times_ms` are the window samples' times). A channel with no window samples or too few
/// baseline samples is all zeros; the slope is zero without two samples apart in time. Mirrors `baseline_z_features`.
pub fn baseline_z_features(
    window: [&[f64]; 3],
    times_ms: &[f64],
    baseline: [&[f64]; 3],
) -> [f64; 12] {
    let mut out = [0.0; 12];
    for channel in 0..3 {
        let (values, past) = (window[channel], baseline[channel]);
        if values.is_empty() || past.len() < BASELINE_MIN_SAMPLES {
            continue;
        }
        let z = pulse_z(values, past);
        let n = z.len() as f64;
        let mean = z.iter().sum::<f64>() / n;
        out[channel] = mean;
        out[3 + channel] = z.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        out[6 + channel] = z.iter().copied().fold(f64::INFINITY, f64::min);
        if z.len() >= 2 && times_ms.len() == z.len() {
            let seconds: Vec<f64> = times_ms.iter().map(|t| t / 1000.0).collect();
            let average = seconds.iter().sum::<f64>() / n;
            let centred: Vec<f64> = seconds.iter().map(|s| s - average).collect();
            let denominator: f64 = centred.iter().map(|c| c * c).sum();
            if denominator > 0.0 {
                let numerator: f64 = centred.iter().zip(&z).map(|(c, v)| c * (v - mean)).sum();
                out[9 + channel] = numerator / denominator;
            }
        }
    }
    out
}

/// The three step features, in the order of the last three names of [`FEATURE_NAMES`]: for each channel its window samples
/// through [`pulse_z`] against its baseline, then the mean of those in the last [`STEP_LATE_SHARE`] of the window's time
/// span less the mean of those in the first [`STEP_EARLY_SHARE`] (`times_ms` from the window's first sample). Positive when
/// the signal stepped up. A channel with no window samples, too few baseline samples, no time span or an empty part is 0.
/// A gesture's PPG deformation is a step, not a level. Mirrors `baseline_step_features` in the trainer.
pub fn baseline_step_features(
    window: [&[f64]; 3],
    times_ms: &[f64],
    baseline: [&[f64]; 3],
) -> [f64; 3] {
    let mut out = [0.0; 3];
    for channel in 0..3 {
        let (values, past) = (window[channel], baseline[channel]);
        if values.is_empty() || past.len() < BASELINE_MIN_SAMPLES || times_ms.len() != values.len()
        {
            continue;
        }
        let (start, end) = (times_ms[0], times_ms[times_ms.len() - 1]);
        let span = end - start;
        if span <= 0.0 {
            continue;
        }
        let z = pulse_z(values, past);
        let (mut early_sum, mut early_n, mut late_sum, mut late_n) = (0.0, 0usize, 0.0, 0usize);
        for (value, &at) in z.iter().zip(times_ms) {
            if at <= start + span * STEP_EARLY_SHARE {
                early_sum += value;
                early_n += 1;
            }
            if at >= end - span * STEP_LATE_SHARE {
                late_sum += value;
                late_n += 1;
            }
        }
        if early_n == 0 || late_n == 0 {
            continue;
        }
        out[channel] = late_sum / late_n as f64 - early_sum / early_n as f64;
    }
    out
}

/// The five motion-dynamics statistics of one motion sensor from its samples in the window (`values`, taken at `times_ms`):
/// how fast the vector changes per second (root mean square and largest), the largest length less the smallest, how
/// peaked the length is (excess kurtosis; 0 under 4 samples or with no spread), and how often an axis crosses its own mean
/// per second (averaged over the axes). Those needing two samples, or time between them, are 0 without. `times_ms` of
/// another length than `values` counts as no time. Mirrors `motion_features` in the trainer.
pub fn motion_features(values: &[[f64; 3]], times_ms: &[f64]) -> [f64; MOTION_STATS] {
    let mut out = [0.0; MOTION_STATS];
    let n = values.len();
    if n == 0 {
        return out;
    }
    let magnitude: Vec<f64> = values
        .iter()
        .map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
        .collect();
    let (low, high) = magnitude
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &m| {
            (l.min(m), h.max(m))
        });
    out[2] = high - low;
    if n >= 4 {
        let mean = magnitude.iter().sum::<f64>() / n as f64;
        let m2 = magnitude.iter().map(|m| (m - mean).powi(2)).sum::<f64>() / n as f64;
        if m2 > RATIO_FLOOR {
            let m4 = magnitude.iter().map(|m| (m - mean).powi(4)).sum::<f64>() / n as f64;
            out[3] = m4 / (m2 * m2) - 3.0;
        }
    }
    if n < 2 || times_ms.len() != n {
        return out;
    }
    let rates: Vec<f64> = values
        .windows(2)
        .zip(times_ms.windows(2))
        .filter_map(|(v, t)| {
            let dt_s = (t[1] - t[0]) / 1000.0;
            (dt_s > 0.0).then(|| {
                let step = ((v[1][0] - v[0][0]).powi(2)
                    + (v[1][1] - v[0][1]).powi(2)
                    + (v[1][2] - v[0][2]).powi(2))
                .sqrt();
                step / dt_s
            })
        })
        .collect();
    if !rates.is_empty() {
        out[0] = (rates.iter().map(|r| r * r).sum::<f64>() / rates.len() as f64).sqrt();
        out[1] = rates.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    }
    let duration_s = (times_ms[n - 1] - times_ms[0]) / 1000.0;
    if duration_s > 0.0 {
        let mut crossings = 0usize;
        for axis in 0..3 {
            let mean = values.iter().map(|v| v[axis]).sum::<f64>() / n as f64;
            crossings += values
                .windows(2)
                .filter(|w| (w[0][axis] - mean) * (w[1][axis] - mean) < 0.0)
                .count();
        }
        out[4] = crossings as f64 / 3.0 / duration_s;
    }
    out
}

/// One fused, ready-to-classify window: a raw PPG batch's per-sample channel
/// arrays plus the last-known watch orientation (accel/gyro/quat), carried
/// forward exactly like `telemetryStore.ts`'s dataset recorder. Orientation
/// arrives far less often than PPG, so unlike the PPG channels it is a single
/// snapshot rather than a per-sample series -- see `crate::fusion`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrientationSnapshot {
    pub accel: [f64; 3],
    pub gyro: [f64; 3],
    /// `(w, x, y, z)`, matching `telemetryStore.ts`'s `quatW/X/Y/Z` column
    /// order and the watch protocol's `WatchOrientationSample::quaternion`.
    pub quat: [f64; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub struct FusedWindow {
    pub ppg_green: Vec<f64>,
    pub ppg_red: Vec<f64>,
    pub ppg_ir: Vec<f64>,
    pub ppg_timestamps_ns: Vec<u64>,
    /// The latest carried-forward orientation: the window's only orientation
    /// sample when nothing arrived during it.
    pub orientation: OrientationSnapshot,
    /// Every orientation sample that arrived during this window, oldest
    /// first. The accel/gyro/quaternion statistics are taken over these, so
    /// they carry the in-window motion like the training windows' do; empty
    /// means the carried snapshot stands alone and those statistics are 0.
    pub orientation_in_window: Vec<OrientationSnapshot>,
    /// When each of `orientation_in_window` was taken (on any one clock; only the differences are used), for a grid laid
    /// out in time.
    pub orientation_timestamps_ns: Vec<u64>,
    pub contact_quality_mean: f64,
    /// The pulse samples just before the window, for the features that compare its level with the recent past. `None` when
    /// the model reads none of them (they are then 0).
    pub baseline: Option<PpgBaseline>,
}

impl FusedWindow {
    /// The orientation series the statistics run over: the in-window samples,
    /// or the single carried snapshot when there are none.
    fn orientation_series(&self) -> Vec<OrientationSnapshot> {
        if self.orientation_in_window.is_empty() {
            vec![self.orientation]
        } else {
            self.orientation_in_window.clone()
        }
    }
}

/// `(mean, std, min, max)` over `values`, population variance (`ddof=0`),
/// matching numpy's default `.std()` used when the Python training pipeline
/// built the same statistics. Returns all zeros for an empty slice, which
/// only happens for a malformed/empty window that the sensor-quality gate
/// should have already rejected before features are ever extracted.
fn stat_block(values: &[f64]) -> (f64, f64, f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let count = values.len() as f64;
    let mean = values.iter().sum::<f64>() / count;
    let variance = values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / count;
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (mean, variance.sqrt(), min, max)
}

/// `(values[-1] - values[0]) / duration_ms`, or `0.0` if the window spans
/// zero or negative time -- matches `features.py`'s `_slope`.
fn slope(values: &[f64], timestamps_ns: &[u64]) -> f64 {
    let (Some(&first_ts), Some(&last_ts)) = (timestamps_ns.first(), timestamps_ns.last()) else {
        return 0.0;
    };
    let (Some(&first_value), Some(&last_value)) = (values.first(), values.last()) else {
        return 0.0;
    };
    if last_ts <= first_ts {
        return 0.0;
    }
    let duration_ms = (last_ts - first_ts) as f64 / 1_000_000.0;
    (last_value - first_value) / duration_ms
}

/// Angle in degrees between two quaternions (`(w, x, y, z)` order), via
/// `2 * arccos(|dot(normalize(a), normalize(b))|)` -- matches
/// `features.py`'s `_quat_delta_angle_deg`. Zero vectors normalize to zero
/// rather than dividing by zero.
fn quat_delta_angle_deg(a: [f64; 4], b: [f64; 4]) -> f64 {
    fn normalize(q: [f64; 4]) -> Option<[f64; 4]> {
        let magnitude = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        if magnitude <= 0.0 {
            return None;
        }
        Some([
            q[0] / magnitude,
            q[1] / magnitude,
            q[2] / magnitude,
            q[3] / magnitude,
        ])
    }
    let (Some(na), Some(nb)) = (normalize(a), normalize(b)) else {
        // A degenerate (zero) quaternion carries no orientation at all, so
        // there is no meaningful delta to report -- fail closed to 0 rather
        // than the ~180 degrees `acos(0)` would otherwise produce.
        return 0.0;
    };
    let dot = (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] + na[3] * nb[3])
        .abs()
        .clamp(0.0, 1.0);
    2.0 * dot.acos().to_degrees()
}

/// Fewer PPG samples than this in a window and there is no spike to speak of: every spike feature is 0.
const SPIKE_MIN_SAMPLES: usize = 4;
/// A peak is only counted above this many robust standard deviations of the baseline-free signal.
const SPIKE_COUNT_SIGMAS: f64 = 3.0;
/// Turns a median absolute deviation into a standard deviation for roughly normal noise.
const MAD_TO_SIGMA: f64 = 1.4826;
const SPIKE_SIGMA_FLOOR: f64 = 1e-9;
const SPIKE_Z_CAP: f64 = 50.0;
/// Spike features per PPG channel.
pub const SPIKE_STATS_PER_CHANNEL: usize = 8;

/// numpy's `np.sum` on a contiguous float64 array, operation for operation (eight running sums for blocks, halves above
/// 128 values), so the spike features come out the same as the trainer's, not merely close.
fn numpy_sum(values: &[f64]) -> f64 {
    let n = values.len();
    if n < 8 {
        let mut total = 0.0;
        for value in values {
            total += value;
        }
        total
    } else if n <= 128 {
        let mut r = [0.0f64; 8];
        r.copy_from_slice(&values[..8]);
        let mut i = 8;
        while i < n - (n % 8) {
            for (j, slot) in r.iter_mut().enumerate() {
                *slot += values[i + j];
            }
            i += 8;
        }
        let mut total = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            total += values[i];
            i += 1;
        }
        total
    } else {
        let mut half = n / 2;
        half -= half % 8;
        numpy_sum(&values[..half]) + numpy_sum(&values[half..])
    }
}

/// The middle value of `values` (the mean of the two middle ones when there is an even number).
fn median(values: &[f64]) -> f64 {
    let mut ordered = values.to_vec();
    ordered.sort_by(|a, b| a.total_cmp(b));
    let middle = ordered.len() / 2;
    if ordered.len() % 2 == 1 {
        ordered[middle]
    } else {
        (ordered[middle - 1] + ordered[middle]) / 2.0
    }
}

/// How the spikes are pulled out of a PPG channel inside one window, before the spike features describe what is left.
/// The names are the ones in a model's manifest (`preprocessing.method`) and in the trainer (`SPIKE_METHODS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpikeMethod {
    StraightLineBaseline,
    FirstDerivative,
    RollingMedianResidual,
    MorphologicalTopHat,
    ButterworthHighPass,
    SavitzkyGolayResidual,
    HaarWaveletDetail,
}

impl SpikeMethod {
    pub const ALL: [SpikeMethod; 7] = [
        SpikeMethod::StraightLineBaseline,
        SpikeMethod::FirstDerivative,
        SpikeMethod::RollingMedianResidual,
        SpikeMethod::MorphologicalTopHat,
        SpikeMethod::ButterworthHighPass,
        SpikeMethod::SavitzkyGolayResidual,
        SpikeMethod::HaarWaveletDetail,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::StraightLineBaseline => "straight_line_baseline",
            Self::FirstDerivative => "first_derivative",
            Self::RollingMedianResidual => "rolling_median_residual",
            Self::MorphologicalTopHat => "morphological_top_hat",
            Self::ButterworthHighPass => "butterworth_high_pass",
            Self::SavitzkyGolayResidual => "savitzky_golay_residual",
            Self::HaarWaveletDetail => "haar_wavelet_detail",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|method| method.name() == name)
    }
}

// The widths used inside one window (see the trainer's `ROLLING_MEDIAN_RADIUS` and friends): a 500 ms window holds only
// about a dozen pulse samples, so they are narrower than the Recordings viewer's.
const ROLLING_MEDIAN_RADIUS: usize = 2;
const TOP_HAT_RADIUS: usize = 2;
const BUTTERWORTH_PERIOD_SAMPLES: f64 = 8.0;
const SAVITZKY_GOLAY_HALF_WIDTH: usize = 3;
const HAAR_SCALE: usize = 2;

fn sequential_sum(values: &[f64]) -> f64 {
    let mut total = 0.0;
    for value in values {
        total += value;
    }
    total
}

/// Quadratic Savitzky-Golay smoothing weights for `half_width` neighbours each side.
fn sg_smoothing_coefficients(half_width: usize) -> Vec<f64> {
    if half_width == 0 {
        return vec![1.0];
    }
    let m = half_width as i64;
    let s0 = (2 * half_width + 1) as f64;
    let s2: f64 = (-m..=m).map(|i| (i * i) as f64).sum();
    let s4: f64 = (-m..=m).map(|i| (i * i * i * i) as f64).sum();
    let denominator = s0 * s4 - s2 * s2;
    (-m..=m)
        .map(|i| (s4 - s2 * ((i * i) as f64)) / denominator)
        .collect()
}

/// Second-order Butterworth high-pass, forward then backward, on the centred signal.
fn butterworth_high_pass(x: &[f64]) -> Vec<f64> {
    let w0 = 2.0 * std::f64::consts::PI / BUTTERWORTH_PERIOD_SAMPLES;
    let q = 1.0 / 2.0f64.sqrt();
    let alpha = w0.sin() / (2.0 * q);
    let cos_w0 = w0.cos();
    let a0 = 1.0 + alpha;
    let b0 = (1.0 + cos_w0) / 2.0 / a0;
    let b1 = -(1.0 + cos_w0) / a0;
    let b2 = (1.0 + cos_w0) / 2.0 / a0;
    let a1 = -2.0 * cos_w0 / a0;
    let a2 = (1.0 - alpha) / a0;
    let apply = |signal: &[f64]| -> Vec<f64> {
        let mut out = Vec::with_capacity(signal.len());
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for &x0 in signal {
            let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            out.push(y0);
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
        }
        out
    };
    let mean = sequential_sum(x) / x.len() as f64;
    let centred: Vec<f64> = x.iter().map(|v| v - mean).collect();
    let mut forward = apply(&centred);
    forward.reverse();
    let mut backward = apply(&forward);
    backward.reverse();
    backward
}

/// What a spike method leaves of one PPG channel in one window (the spikes, with the baseline taken out). Mirrors
/// `extract_spike_series` in the trainer's `features.py`, which describes each method.
pub(crate) fn extract_spike_series(method: SpikeMethod, x: &[f64], span_ms: f64) -> Vec<f64> {
    let n = x.len();
    match method {
        SpikeMethod::StraightLineBaseline => {
            let count = n as f64;
            let t: Vec<f64> = (0..n)
                .map(|i| span_ms * (i as f64) / (count - 1.0))
                .collect();
            let t_mean = numpy_sum(&t) / count;
            let x_mean = numpy_sum(x) / count;
            let tc: Vec<f64> = t.iter().map(|v| v - t_mean).collect();
            let squares: Vec<f64> = tc.iter().map(|v| v * v).collect();
            let sxx = numpy_sum(&squares);
            let slope = if sxx > 0.0 {
                let products: Vec<f64> = tc.iter().zip(x).map(|(c, v)| c * (v - x_mean)).collect();
                numpy_sum(&products) / sxx
            } else {
                0.0
            };
            tc.iter()
                .zip(x)
                .map(|(c, v)| (v - x_mean) - slope * c)
                .collect()
        }
        SpikeMethod::FirstDerivative => (0..n - 1).map(|i| x[i + 1] - x[i]).collect(),
        SpikeMethod::RollingMedianResidual => (0..n)
            .map(|i| {
                let lo = i.saturating_sub(ROLLING_MEDIAN_RADIUS);
                let hi = (i + ROLLING_MEDIAN_RADIUS + 1).min(n);
                x[i] - median(&x[lo..hi])
            })
            .collect(),
        SpikeMethod::MorphologicalTopHat => {
            let radius = TOP_HAT_RADIUS;
            let range = |i: usize| (i.saturating_sub(radius), (i + radius + 1).min(n));
            let erosion: Vec<f64> = (0..n)
                .map(|i| {
                    let (lo, hi) = range(i);
                    x[lo..hi].iter().copied().fold(f64::INFINITY, f64::min)
                })
                .collect();
            (0..n)
                .map(|i| {
                    let (lo, hi) = range(i);
                    let opening = erosion[lo..hi]
                        .iter()
                        .copied()
                        .fold(f64::NEG_INFINITY, f64::max);
                    x[i] - opening
                })
                .collect()
        }
        SpikeMethod::ButterworthHighPass => butterworth_high_pass(x),
        SpikeMethod::SavitzkyGolayResidual => (0..n)
            .map(|i| {
                let half = SAVITZKY_GOLAY_HALF_WIDTH.min(i).min(n - 1 - i);
                let mut smoothed = 0.0;
                for (offset, coefficient) in sg_smoothing_coefficients(half).iter().enumerate() {
                    smoothed += coefficient * x[i - half + offset];
                }
                x[i] - smoothed
            })
            .collect(),
        SpikeMethod::HaarWaveletDetail => (0..n - 1)
            .map(|i| {
                let left = &x[i + 1 - HAAR_SCALE.min(i + 1)..i + 1];
                let right = &x[i + 1..(i + 1 + HAAR_SCALE).min(n)];
                (sequential_sum(left) / left.len() as f64
                    - sequential_sum(right) / right.len() as f64)
                    / 2.0f64.sqrt()
            })
            .collect(),
    }
}

/// The eight spike features of one PPG channel in one window: height, z, time_frac, rise_ms, fall_ms, count, deriv_max,
/// deriv_min. Mirrors `spike_features` in `tools/label-trainer/src/label_trainer/features.py`, which documents what each
/// means: the chosen method pulls the spikes out, then the biggest spike and the steepest rise and fall of what is left
/// are described. `tests/fixtures/spike_cases.json` in the trainer holds shared cases both sides must reproduce.
pub fn spike_features(
    values: &[f64],
    timestamps_ms: &[f64],
    method: SpikeMethod,
) -> [f64; SPIKE_STATS_PER_CHANNEL] {
    let n = values.len();
    if n < SPIKE_MIN_SAMPLES || timestamps_ms.len() != n {
        return [0.0; SPIKE_STATS_PER_CHANNEL];
    }
    // Evenly spaced over the window's span: the watch stamps a batch of samples a few nanoseconds apart, which would make
    // every rate wild if the stamps were taken at face value.
    let span = timestamps_ms[n - 1] - timestamps_ms[0];
    let residual = extract_spike_series(method, values, span);
    let m = residual.len();
    let t: Vec<f64> = (0..m)
        .map(|i| span * (i as f64) / ((m - 1) as f64))
        .collect();

    let mut deriv_max = f64::NEG_INFINITY;
    let mut deriv_min = f64::INFINITY;
    for i in 0..m - 1 {
        let delta = t[i + 1] - t[i];
        let d = if delta > 0.0 {
            (residual[i + 1] - residual[i]) / delta
        } else {
            0.0
        };
        deriv_max = deriv_max.max(d);
        deriv_min = deriv_min.min(d);
    }

    let centre = median(&residual);
    let deviation: Vec<f64> = residual.iter().map(|v| v - centre).collect();
    let magnitude: Vec<f64> = deviation.iter().map(|v| v.abs()).collect();
    let sigma = MAD_TO_SIGMA * median(&magnitude);
    let mut peak_index = 0;
    for (i, value) in magnitude.iter().enumerate() {
        if *value > magnitude[peak_index] {
            peak_index = i;
        }
    }
    let peak = deviation[peak_index];
    let z = (peak.abs() / sigma.max(SPIKE_SIGMA_FLOOR)).min(SPIKE_Z_CAP);
    let time_frac = if span > 0.0 {
        t[peak_index] / span
    } else {
        0.0
    };

    let (mut rise, mut fall) = (0.0, 0.0);
    if peak != 0.0 {
        let sign = if peak >= 0.0 { 1.0 } else { -1.0 };
        let half = peak.abs() / 2.0;
        let mut left = peak_index;
        while left > 0 && sign * deviation[left - 1] >= half {
            left -= 1;
        }
        let mut right = peak_index;
        while right < m - 1 && sign * deviation[right + 1] >= half {
            right += 1;
        }
        rise = t[peak_index] - t[left];
        fall = t[right] - t[peak_index];
    }

    let threshold = SPIKE_COUNT_SIGMAS * sigma.max(SPIKE_SIGMA_FLOOR);
    let mut peaks = 0.0;
    for i in 0..m {
        if magnitude[i] < threshold {
            continue;
        }
        let rises = i == 0 || magnitude[i] >= magnitude[i - 1];
        let falls = i == m - 1 || magnitude[i] > magnitude[i + 1];
        if rises && falls {
            peaks += 1.0;
        }
    }
    [peak, z, time_frac, rise, fall, peaks, deriv_max, deriv_min]
}

/// Per-sample Euclidean norm across three equal-length channels.
fn magnitudes(channels: &[Vec<f64>; 3]) -> Vec<f64> {
    (0..channels[0].len())
        .map(|index| {
            (channels[0][index].powi(2) + channels[1][index].powi(2) + channels[2][index].powi(2))
                .sqrt()
        })
        .collect()
}

/// Builds the ordered 79-value feature vector (55 base statistics, then the spike features) for `window`, in exactly the
/// order of [`FEATURE_NAMES`]. The orientation statistics run over the
/// orientation samples that arrived during the window (see
/// [`FusedWindow::orientation_in_window`]); a window with none is a single
/// carried snapshot, whose spread and delta angle are legitimately zero.
pub fn extract_features(window: &FusedWindow) -> [f32; FEATURE_COUNT] {
    extract_features_with(window, None)
}

/// [`extract_features`] with the spike features computed by `spike_method` (they are 0 with none, and no model reads
/// them then). Each model says which method it was trained with, so each one is fed numbers made the same way.
pub fn extract_features_with(
    window: &FusedWindow,
    spike_method: Option<SpikeMethod>,
) -> [f32; FEATURE_COUNT] {
    let mut out = [0.0f32; FEATURE_COUNT];
    let mut cursor = 0usize;
    let mut push = |value: f64| {
        out[cursor] = value as f32;
        cursor += 1;
    };

    let ppg = [&window.ppg_green, &window.ppg_red, &window.ppg_ir];
    let ppg_stats: Vec<(f64, f64, f64, f64)> =
        ppg.iter().map(|channel| stat_block(channel)).collect();
    for stats in &ppg_stats {
        push(stats.0);
    }
    for stats in &ppg_stats {
        push(stats.1);
    }
    for stats in &ppg_stats {
        push(stats.2);
    }
    for stats in &ppg_stats {
        push(stats.3);
    }
    for channel in &ppg {
        push(slope(channel, &window.ppg_timestamps_ns));
    }

    // Accel/gyro/quat statistics run over the orientation samples that arrived
    // during the window (see `FusedWindow::orientation_in_window`).
    let series = window.orientation_series();
    let channel = |select: &dyn Fn(&OrientationSnapshot) -> f64| -> Vec<f64> {
        series.iter().map(select).collect()
    };

    let accel_arrays = [
        channel(&|s| s.accel[0]),
        channel(&|s| s.accel[1]),
        channel(&|s| s.accel[2]),
    ];
    let accel_stats: Vec<(f64, f64, f64, f64)> =
        accel_arrays.iter().map(|array| stat_block(array)).collect();
    for stats in &accel_stats {
        push(stats.0);
    }
    for stats in &accel_stats {
        push(stats.1);
    }
    for stats in &accel_stats {
        push(stats.2);
    }
    for stats in &accel_stats {
        push(stats.3);
    }
    let accel_magnitude = magnitudes(&accel_arrays);
    let (accel_magnitude_mean, accel_magnitude_std, _, _) = stat_block(&accel_magnitude);
    push(accel_magnitude_mean);
    push(accel_magnitude_std);

    let gyro_arrays = [
        channel(&|s| s.gyro[0]),
        channel(&|s| s.gyro[1]),
        channel(&|s| s.gyro[2]),
    ];
    let gyro_stats: Vec<(f64, f64, f64, f64)> =
        gyro_arrays.iter().map(|array| stat_block(array)).collect();
    for stats in &gyro_stats {
        push(stats.0);
    }
    for stats in &gyro_stats {
        push(stats.1);
    }
    for stats in &gyro_stats {
        push(stats.2);
    }
    for stats in &gyro_stats {
        push(stats.3);
    }
    let gyro_magnitude = magnitudes(&gyro_arrays);
    let (gyro_magnitude_mean, gyro_magnitude_std, _, _) = stat_block(&gyro_magnitude);
    push(gyro_magnitude_mean);
    push(gyro_magnitude_std);

    let quat_arrays = [
        channel(&|s| s.quat[0]),
        channel(&|s| s.quat[1]),
        channel(&|s| s.quat[2]),
        channel(&|s| s.quat[3]),
    ];
    let quat_stats: Vec<(f64, f64, f64, f64)> =
        quat_arrays.iter().map(|array| stat_block(array)).collect();
    for stats in &quat_stats {
        push(stats.0);
    }
    for stats in &quat_stats {
        push(stats.1);
    }
    // First vs last orientation in the window, like the trainer's
    // `_quat_delta_angle_deg(quat_first, quat_last)`.
    let (first, last) = (series.first(), series.last());
    push(match (first, last) {
        (Some(first), Some(last)) => quat_delta_angle_deg(first.quat, last.quat),
        _ => 0.0,
    });

    push(window.contact_quality_mean);
    // Rows in the window, like the trainer's `sample_count`: every PPG sample
    // plus every orientation sample that arrived during it.
    push((window.ppg_timestamps_ns.len() + window.orientation_in_window.len()) as f64);
    let duration_ms = match (
        window.ppg_timestamps_ns.first(),
        window.ppg_timestamps_ns.last(),
    ) {
        (Some(&first), Some(&last)) if last > first => (last - first) as f64 / 1_000_000.0,
        _ => 0.0,
    };
    push(duration_ms);

    // The pulse-sensor spike features, statistic by statistic and channel by channel like the base ones. A window with
    // too few PPG samples leaves them 0.
    let ppg_ms: Vec<f64> = window
        .ppg_timestamps_ns
        .iter()
        .map(|&ns| ns as f64 / 1_000_000.0)
        .collect();
    let spikes: Vec<[f64; SPIKE_STATS_PER_CHANNEL]> = ppg
        .iter()
        .map(|channel| match spike_method {
            Some(method) => spike_features(channel, &ppg_ms, method),
            None => [0.0; SPIKE_STATS_PER_CHANNEL],
        })
        .collect();
    for stat in 0..SPIKE_STATS_PER_CHANNEL {
        for channel in &spikes {
            push(channel[stat]);
        }
    }

    // The level against the recent past (0 when the model has no baseline).
    let relative = window.baseline.as_ref().map_or([0.0; 6], |past| {
        baseline_features(
            [&window.ppg_green, &window.ppg_red, &window.ppg_ir],
            [&past.green, &past.red, &past.ir],
        )
    });
    for value in relative {
        push(value);
    }

    // How the motion moved inside the window (0 when no orientation sample arrived in it, like the trainer's).
    let first_ms = window
        .orientation_timestamps_ns
        .first()
        .copied()
        .unwrap_or(0);
    let times_ms: Vec<f64> = window
        .orientation_timestamps_ns
        .iter()
        .map(|&t| t.saturating_sub(first_ms) as f64 / 1_000_000.0)
        .collect();
    let sensors: [fn(&OrientationSnapshot) -> [f64; 3]; 2] = [|s| s.accel, |s| s.gyro];
    for select in sensors {
        let values: Vec<[f64; 3]> = window.orientation_in_window.iter().map(select).collect();
        for value in motion_features(&values, &times_ms) {
            push(value);
        }
    }

    // The pulse in units of its recent past (0 when the model has no baseline).
    let first_ppg = window.ppg_timestamps_ns.first().copied().unwrap_or(0);
    let ppg_times_ms: Vec<f64> = window
        .ppg_timestamps_ns
        .iter()
        .map(|&t| t.saturating_sub(first_ppg) as f64 / 1_000_000.0)
        .collect();
    let zs = window.baseline.as_ref().map_or([0.0; 12], |past| {
        baseline_z_features(
            [&window.ppg_green, &window.ppg_red, &window.ppg_ir],
            &ppg_times_ms,
            [&past.green, &past.red, &past.ir],
        )
    });
    for value in zs {
        push(value);
    }
    // The pulse's step through the window, in the same units (0 when the model has no baseline).
    let steps = window.baseline.as_ref().map_or([0.0; 3], |past| {
        baseline_step_features(
            [&window.ppg_green, &window.ppg_red, &window.ppg_ir],
            &ppg_times_ms,
            [&past.green, &past.red, &past.ir],
        )
    });
    for value in steps {
        push(value);
    }

    debug_assert_eq!(cursor, FEATURE_COUNT);
    out
}

/// Selects the values at `indices` out of the full canonical `features`
/// vector, in the given order -- the live-inference counterpart of a custom
/// bundle's `feature_contract.ordered_names`. `indices` must already be
/// resolved canonical positions (see `model_registry::validate_feature_subset`);
/// this function trusts them and never reorders, pads, or infers a value for
/// an index that isn't present.
pub fn select_features(features: &[f32; FEATURE_COUNT], indices: &[usize]) -> Vec<f32> {
    indices.iter().map(|&index| features[index]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same cases the trainer's tests check (`tools/label-trainer/tests/fixtures/base_feature_cases.json`): the 55
    /// statistics made here from the samples that arrived must equal the ones the trainer makes from a recording of the
    /// same samples, or a model trained there would see different inputs live.
    #[test]
    fn base_features_match_the_trainer_on_the_shared_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tools/label-trainer/tests/fixtures/base_feature_cases.json"
        ))
        .unwrap();
        let names: Vec<&str> = fixture["featureNames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(names, FEATURE_NAMES[..BASE_FEATURE_COUNT]);
        let numbers = |value: &serde_json::Value| -> Vec<f64> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_f64().unwrap())
                .collect()
        };
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let ppg = &case["ppg"];
            let quality = numbers(&ppg["quality"]);
            let in_window: Vec<OrientationSnapshot> = case["orientation"]
                .as_array()
                .unwrap()
                .iter()
                .map(|sample| {
                    let (a, g, q) = (
                        numbers(&sample["accel"]),
                        numbers(&sample["gyro"]),
                        numbers(&sample["quat"]),
                    );
                    OrientationSnapshot {
                        accel: [a[0], a[1], a[2]],
                        gyro: [g[0], g[1], g[2]],
                        quat: [q[0], q[1], q[2], q[3]],
                    }
                })
                .collect();
            // What the pipeline hands over when nothing arrived in the window and nothing came before it.
            let latest = in_window.last().copied().unwrap_or(OrientationSnapshot {
                accel: [0.0; 3],
                gyro: [0.0; 3],
                quat: [1.0, 0.0, 0.0, 0.0],
            });
            let window = FusedWindow {
                orientation_timestamps_ns: case["orientation"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s["timestampNs"].as_u64().unwrap())
                    .collect(),
                ppg_green: numbers(&ppg["green"]),
                ppg_red: numbers(&ppg["red"]),
                ppg_ir: numbers(&ppg["ir"]),
                ppg_timestamps_ns: ppg["timestampsNs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap())
                    .collect(),
                orientation: latest,
                orientation_in_window: in_window,
                contact_quality_mean: if quality.is_empty() {
                    0.0
                } else {
                    quality.iter().sum::<f64>() / quality.len() as f64
                },
                baseline: None,
            };
            let made = extract_features_with(&window, None);
            for (index, expected) in numbers(&case["expected"]).iter().enumerate() {
                let got = f64::from(made[index]);
                assert!(
                    (got - expected).abs() <= 1e-5 * expected.abs().max(1.0),
                    "{name}: {} is {got} here and {expected} in the trainer",
                    FEATURE_NAMES[index]
                );
            }
            for (offset, expected) in numbers(&case["expectedMotion"]).iter().enumerate() {
                let index = MOTION_FEATURE_START + offset;
                let got = f64::from(made[index]);
                assert!(
                    (got - expected).abs() <= 1e-5 * expected.abs().max(1.0),
                    "{name}: {} is {got} here and {expected} in the trainer",
                    FEATURE_NAMES[index]
                );
            }
        }
    }

    fn sample_window() -> FusedWindow {
        FusedWindow {
            orientation_timestamps_ns: Vec::new(),
            ppg_green: vec![10.0, 12.0, 14.0],
            ppg_red: vec![20.0, 21.0, 19.0],
            ppg_ir: vec![5.0, 5.0, 5.0],
            ppg_timestamps_ns: vec![0, 10_000_000, 20_000_000],
            orientation_in_window: Vec::new(),
            orientation: OrientationSnapshot {
                accel: [1.0, 0.0, 0.0],
                gyro: [0.0, 0.1, 0.0],
                quat: [1.0, 0.0, 0.0, 0.0],
            },
            contact_quality_mean: 0.0,
            baseline: None,
        }
    }

    #[test]
    fn feature_names_length_matches_feature_count() {
        assert_eq!(FEATURE_NAMES.len(), FEATURE_COUNT);
    }

    #[test]
    fn stat_block_computes_population_statistics() {
        let (mean, std, min, max) = stat_block(&[1.0, 2.0, 3.0]);
        assert_eq!(mean, 2.0);
        assert!((std - 0.816_496_580_927_726).abs() < 1e-9);
        assert_eq!(min, 1.0);
        assert_eq!(max, 3.0);
    }

    #[test]
    fn stat_block_empty_is_all_zero() {
        assert_eq!(stat_block(&[]), (0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn slope_divides_delta_by_duration_ms() {
        let value = slope(&[10.0, 30.0], &[0, 2_000_000]);
        assert!((value - 10.0).abs() < 1e-9); // (30-10) / 2ms = 10/ms
    }

    #[test]
    fn slope_zero_duration_is_zero() {
        assert_eq!(slope(&[10.0, 30.0], &[5, 5]), 0.0);
    }

    #[test]
    fn quat_delta_angle_identical_quaternions_is_zero() {
        let q = [1.0, 0.0, 0.0, 0.0];
        assert_eq!(quat_delta_angle_deg(q, q), 0.0);
    }

    #[test]
    fn quat_delta_angle_orthogonal_quaternions_is_180() {
        // Unit quaternions with zero dot product: arccos(0) = 90 deg, *2 = 180.
        let a = [1.0, 0.0, 0.0, 0.0];
        let b = [0.0, 1.0, 0.0, 0.0];
        assert!((quat_delta_angle_deg(a, b) - 180.0).abs() < 1e-9);
    }

    #[test]
    fn quat_delta_angle_handles_zero_quaternion() {
        assert_eq!(quat_delta_angle_deg([0.0; 4], [1.0, 0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn extract_features_produces_expected_length_and_order() {
        let features = extract_features(&sample_window());
        assert_eq!(features.len(), FEATURE_COUNT);
        // ppg_green_mean, ppg_red_mean, ppg_ir_mean
        assert!((features[0] - 12.0).abs() < 1e-4);
        assert!((features[1] - 20.0).abs() < 1e-4);
        assert!((features[2] - 5.0).abs() < 1e-4);
        // The base statistics end with sample_count and duration_ms (contact_quality_mean is third from last of them);
        // the spike features come after.
        assert_eq!(features[BASE_FEATURE_COUNT - 2], 3.0);
        assert_eq!(features[BASE_FEATURE_COUNT - 1], 20.0);
        assert_eq!(features[BASE_FEATURE_COUNT - 3], 0.0);
        assert_eq!(FEATURE_NAMES[BASE_FEATURE_COUNT - 1], "duration_ms");
        assert_eq!(FEATURE_NAMES[BASE_FEATURE_COUNT], "ppg_green_spike_height");
        assert_eq!(
            FEATURE_NAMES.len(),
            BASE_FEATURE_COUNT + 3 * SPIKE_STATS_PER_CHANNEL + 6 + 2 * MOTION_STATS + 12 + 3
        );
        assert_eq!(BASELINE_Z_START, MOTION_FEATURE_START + 2 * MOTION_STATS);
        assert_eq!(BASELINE_STEP_START, BASELINE_Z_START + 12);
        assert_eq!(
            MOTION_FEATURE_START,
            BASE_FEATURE_COUNT + 3 * SPIKE_STATS_PER_CHANNEL + 6
        );
        assert_eq!(FEATURE_NAMES[MOTION_FEATURE_START], "accel_jerk_rms");
    }

    /// The same cases the trainer's tests check (`tools/label-trainer/tests/fixtures/baseline_cases.json`): the level-
    /// against-the-past features here must equal the ones it computes, or a model trained there would see different
    /// numbers live.
    #[test]
    fn baseline_features_match_the_trainer_on_the_shared_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tools/label-trainer/tests/fixtures/baseline_cases.json"
        ))
        .unwrap();
        assert_eq!(fixture["minSamples"], BASELINE_MIN_SAMPLES);
        assert_eq!(fixture["slackMs"], BASELINE_SLACK_MS);
        assert_eq!(fixture["lowPercent"], BASELINE_LOW_PERCENT);
        assert_eq!(fixture["highPercent"], BASELINE_HIGH_PERCENT);
        let channels = |value: &serde_json::Value| -> Vec<Vec<f64>> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|channel| {
                    channel
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_f64().unwrap())
                        .collect()
                })
                .collect()
        };
        for case in fixture["cases"].as_array().unwrap() {
            let (window, past) = (channels(&case["window"]), channels(&case["baseline"]));
            let got = baseline_features(
                [&window[0], &window[1], &window[2]],
                [&past[0], &past[1], &past[2]],
            );
            for (index, expected) in case["expected"].as_array().unwrap().iter().enumerate() {
                let expected = expected.as_f64().unwrap();
                assert!(
                    (got[index] - expected).abs() <= 1e-9 * expected.abs().max(1.0),
                    "{}: feature {index}: {} vs {expected}",
                    case["name"],
                    got[index]
                );
            }
            let times: Vec<f64> = case["windowTimesMs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            let zs = baseline_z_features(
                [&window[0], &window[1], &window[2]],
                &times,
                [&past[0], &past[1], &past[2]],
            );
            for (index, expected) in case["expectedZ"].as_array().unwrap().iter().enumerate() {
                let expected = expected.as_f64().unwrap();
                assert!(
                    (zs[index] - expected).abs() <= 1e-9 * expected.abs().max(1.0),
                    "{}: z feature {index}: {} vs {expected}",
                    case["name"],
                    zs[index]
                );
            }
            let steps = baseline_step_features(
                [&window[0], &window[1], &window[2]],
                &times,
                [&past[0], &past[1], &past[2]],
            );
            for (index, expected) in case["expectedStep"].as_array().unwrap().iter().enumerate() {
                let expected = expected.as_f64().unwrap();
                assert!(
                    (steps[index] - expected).abs() <= 1e-9 * expected.abs().max(1.0),
                    "{}: step feature {index}: {} vs {expected}",
                    case["name"],
                    steps[index]
                );
            }
            for (channel, series) in channels(&case["zSeries"]).iter().enumerate() {
                if series.is_empty() {
                    continue;
                }
                let got = pulse_z(&window[channel], &past[channel]);
                for (g, w) in got.iter().zip(series) {
                    assert!(
                        (g - w).abs() <= 1e-9 * w.abs().max(1.0),
                        "{}: z series: {g} vs {w}",
                        case["name"]
                    );
                }
            }
        }
    }

    #[test]
    fn a_window_with_a_baseline_carries_its_level_features_and_none_without() {
        // The differences come right before the motion dynamics, the shares at the very end.
        const LEVEL: usize = MOTION_FEATURE_START - 6;
        let mut window = sample_window();
        let none = extract_features_with(&window, None);
        assert!(none[LEVEL..MOTION_FEATURE_START].iter().all(|v| *v == 0.0));
        assert!(none[FEATURE_COUNT - 12..].iter().all(|v| *v == 0.0));
        let past: Vec<f64> = (0..21).map(|i| 1.0 + f64::from(i)).collect(); // 1..21: low end 3, high end 19
        window.baseline = Some(PpgBaseline {
            green: past.clone(),
            red: past.clone(),
            ir: past,
        });
        let with = extract_features_with(&window, None);
        assert_eq!(FEATURE_NAMES[LEVEL], "ppg_green_rel_low");
        assert!((with[LEVEL] - (12.0 - 3.0)).abs() < 1e-5); // green mean 12 against the low end, 3
        assert!((with[LEVEL + 3] - (12.0 - 19.0)).abs() < 1e-5); // and against the high end, 19
        // And in units of the past: 1..21 has median 11 and median absolute deviation 5, so green (10, 12, 14) is
        // (-1, 1, 3) / (5 x 1.4826): mean 1/7.413.
        assert_eq!(FEATURE_NAMES[BASELINE_Z_START], "ppg_green_rel_z_mean");
        assert_eq!(FEATURE_NAMES[BASELINE_STEP_START], "ppg_green_rel_z_step");
        assert!((with[BASELINE_Z_START] - 1.0 / (5.0 * 1.4826)).abs() < 1e-5);
        assert_eq!(&with[..LEVEL], &none[..LEVEL]); // nothing else changes
        assert_eq!(
            &with[MOTION_FEATURE_START..BASELINE_Z_START],
            &none[MOTION_FEATURE_START..BASELINE_Z_START]
        );
    }

    /// The same cases the trainer's tests check (`tools/label-trainer/tests/fixtures/spike_cases.json`): the spike
    /// features here must equal the ones it computes for every method, or a model trained there would see different
    /// numbers live.
    #[test]
    fn spike_features_match_the_trainer_on_the_shared_cases_for_every_method() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tools/label-trainer/tests/fixtures/spike_cases.json"
        ))
        .unwrap();
        let order: Vec<&str> = fixture["statOrder"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(
            order,
            [
                "spike_height",
                "spike_z",
                "spike_time_frac",
                "spike_rise_ms",
                "spike_fall_ms",
                "spike_count",
                "deriv_max",
                "deriv_min"
            ]
        );
        let methods: Vec<&str> = fixture["methods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let known: Vec<&str> = SpikeMethod::ALL.iter().map(|m| m.name()).collect();
        assert_eq!(
            methods, known,
            "the trainer and the runtime list the same methods"
        );
        let numbers = |value: &serde_json::Value| -> Vec<f64> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_f64().unwrap())
                .collect()
        };
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            for method in SpikeMethod::ALL {
                let got = spike_features(
                    &numbers(&case["values"]),
                    &numbers(&case["timestampsMs"]),
                    method,
                );
                for (stat, key) in order.iter().enumerate() {
                    let want = case["expected"][method.name()][key].as_f64().unwrap();
                    let tolerance = 1e-9 + 1e-9 * want.abs();
                    assert!(
                        (got[stat] - want).abs() <= tolerance,
                        "{name} / {}: {key} was {} but the trainer computes {want}",
                        method.name(),
                        got[stat]
                    );
                }
            }
        }
    }

    #[test]
    fn method_names_round_trip_and_unknown_ones_are_refused() {
        for method in SpikeMethod::ALL {
            assert_eq!(SpikeMethod::from_name(method.name()), Some(method));
        }
        assert_eq!(SpikeMethod::from_name("soup"), None);
        assert_eq!(SpikeMethod::from_name("none"), None);
    }

    #[test]
    fn a_window_with_too_few_ppg_samples_has_no_spike_features() {
        let features = extract_features(&sample_window());
        assert!(features[BASE_FEATURE_COUNT..].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn extract_features_accel_magnitude_matches_euclidean_norm() {
        let features = extract_features(&sample_window());
        // accel_magnitude_mean is at index 15 (12 PPG stats... wait see layout).
        let index = FEATURE_NAMES
            .iter()
            .position(|&name| name == "accel_magnitude_mean")
            .unwrap();
        assert!((features[index] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn extract_features_quat_delta_is_zero_for_carried_snapshot() {
        let features = extract_features(&sample_window());
        let index = FEATURE_NAMES
            .iter()
            .position(|&name| name == "quat_delta_angle_deg")
            .unwrap();
        assert_eq!(features[index], 0.0);
    }

    fn feature(features: &[f32; FEATURE_COUNT], name: &str) -> f64 {
        let index = FEATURE_NAMES.iter().position(|&n| n == name).unwrap();
        f64::from(features[index])
    }

    /// R-M2-1: a window whose orientation samples moved must not report zero
    /// spread. The expected values below were computed with the trainer's own
    /// `features.py` (`_stat_block`, `_quat_delta_angle_deg`) over the same
    /// per-sample series, so this pins live/offline agreement on the 13
    /// features that used to be structurally zero live.
    #[test]
    fn orientation_statistics_run_over_the_samples_that_arrived_in_the_window() {
        let c = 15f64.to_radians().cos();
        let s = 15f64.to_radians().sin();
        let snapshot = |accel: [f64; 3], gyro: [f64; 3], quat: [f64; 4]| OrientationSnapshot {
            accel,
            gyro,
            quat,
        };
        let in_window = vec![
            snapshot([1.0, 0.0, 9.8], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]),
            snapshot([2.0, 0.0, 9.8], [0.5, 0.0, 0.0], [0.99, 0.1, 0.0, 0.0]),
            snapshot([4.0, 3.0, 9.8], [1.0, 0.0, 0.0], [c, s, 0.0, 0.0]),
        ];
        let mut window = sample_window();
        window.orientation = *in_window.last().unwrap();
        window.orientation_in_window = in_window;
        let features = extract_features(&window);

        let close = |name: &str, expected: f64| {
            let actual = feature(&features, name);
            assert!(
                (actual - expected).abs() < 1e-4,
                "{name}: got {actual}, trainer says {expected}"
            );
        };
        close("accel_x_mean", 2.3333333333333335);
        close("accel_x_std", 1.247219128924647);
        close("accel_x_min", 1.0);
        close("accel_x_max", 4.0);
        close("accel_y_std", std::f64::consts::SQRT_2);
        close("accel_magnitude_mean", 10.284902038813282);
        close("accel_magnitude_std", 0.5106760734696764);
        close("gyro_x_std", 0.408248290463863);
        close("quat_w_mean", 0.9853086087630228);
        close("quat_w_std", 0.014300797001670385);
        close("quat_x_std", 0.10656807276470816);
        close("quat_delta_angle_deg", 29.999999999999993);
        // Rows in the window: 3 PPG samples + 3 orientation samples.
        close("sample_count", 6.0);
    }

    #[test]
    fn a_window_with_no_orientation_in_it_falls_back_to_the_carried_snapshot() {
        let features = extract_features(&sample_window());
        assert_eq!(feature(&features, "accel_x_std"), 0.0);
        assert_eq!(feature(&features, "quat_delta_angle_deg"), 0.0);
        assert_eq!(feature(&features, "sample_count"), 3.0);
    }

    #[test]
    fn select_features_picks_values_at_given_indices_in_order() {
        let features = extract_features(&sample_window());
        let selected = select_features(&features, &[2, 0]);
        assert_eq!(selected, vec![features[2], features[0]]);
    }

    #[test]
    fn select_features_empty_indices_yields_empty_vec() {
        let features = extract_features(&sample_window());
        assert!(select_features(&features, &[]).is_empty());
    }
}
