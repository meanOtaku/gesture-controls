//! Deterministic statistical feature extraction, mirroring
//! `tools/label-trainer/src/label_trainer/features.py`'s
//! `FEATURE_NAMES`/`extract_features` exactly (same order, same values) so
//! a model trained offline sees the identical feature contract live on the
//! desktop. See `crate::fusion` for how a raw watch telemetry window becomes
//! a [`FusedWindow`].

/// The statistics every window has always had; the pulse-sensor spike features follow them.
pub const BASE_FEATURE_COUNT: usize = 55;
/// Number of features in the ordered vector every model reads its inputs from: the 55 base statistics, then 24 spike
/// features (8 for each of the three PPG channels). Matches Python's `len(FEATURE_NAMES)`.
pub const FEATURE_COUNT: usize = 79;

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
];

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
    pub contact_quality_mean: f64,
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
fn extract_spike_series(method: SpikeMethod, x: &[f64], span_ms: f64) -> Vec<f64> {
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

    fn sample_window() -> FusedWindow {
        FusedWindow {
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
            BASE_FEATURE_COUNT + 3 * SPIKE_STATS_PER_CHANNEL
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
