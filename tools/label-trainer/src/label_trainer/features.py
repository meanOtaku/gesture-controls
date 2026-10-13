"""Derives a fixed, deterministic feature vector for one window: 55 plain statistics plus the pulse-sensor spike features.

All features are plain statistics (mean/std/min/max/slope/magnitude) over the
carry-forward-filled channel arrays already sliced to the window's row
indices — no lookahead, no randomness, so the same window always produces the
same vector. FEATURE_NAMES is the contract: its order matches the columns of
every feature matrix this package produces, and is recorded verbatim in the
model card (see train.py) so a saved model can be matched to the pipeline
that must feed it at inference time.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from .csv_io import Recording
from .schema import (
    ACCEL_COLUMNS,
    CONTACT_QUALITY_COLUMN,
    GYRO_COLUMNS,
    NUMERIC_COLUMNS,
    PPG_COLUMNS,
    QUAT_COLUMNS,
)
from .windowing import Window

BASE_FEATURE_NAMES: tuple[str, ...] = (
    *(f"{column}_mean" for column in PPG_COLUMNS),
    *(f"{column}_std" for column in PPG_COLUMNS),
    *(f"{column}_min" for column in PPG_COLUMNS),
    *(f"{column}_max" for column in PPG_COLUMNS),
    *(f"{column}_slope" for column in PPG_COLUMNS),
    *(f"{column}_mean" for column in ACCEL_COLUMNS),
    *(f"{column}_std" for column in ACCEL_COLUMNS),
    *(f"{column}_min" for column in ACCEL_COLUMNS),
    *(f"{column}_max" for column in ACCEL_COLUMNS),
    "accel_magnitude_mean",
    "accel_magnitude_std",
    *(f"{column}_mean" for column in GYRO_COLUMNS),
    *(f"{column}_std" for column in GYRO_COLUMNS),
    *(f"{column}_min" for column in GYRO_COLUMNS),
    *(f"{column}_max" for column in GYRO_COLUMNS),
    "gyro_magnitude_mean",
    "gyro_magnitude_std",
    *(f"{column}_mean" for column in QUAT_COLUMNS),
    *(f"{column}_std" for column in QUAT_COLUMNS),
    "quat_delta_angle_deg",
    f"{CONTACT_QUALITY_COLUMN}_mean",
    "sample_count",
    "duration_ms",
)

# The pulse-sensor spike features: what is left of each PPG channel once its baseline is taken away, described by its
# biggest spike. See `spike_features` for exactly how each one is computed. They come after the 55 base features so every
# model trained before they existed still names the same features in the same places.
SPIKE_STATS: tuple[str, ...] = (
    "spike_height",
    "spike_z",
    "spike_time_frac",
    "spike_rise_ms",
    "spike_fall_ms",
    "spike_count",
    "deriv_max",
    "deriv_min",
)
SPIKE_FEATURE_NAMES: tuple[str, ...] = tuple(f"{column}_{stat}" for stat in SPIKE_STATS for column in PPG_COLUMNS)

# The pulse-sensor level relative to its recent past: how far the window's average PPG sits above the low end (10th
# percentile) and the high end (90th percentile) of the PPG in the `baseline_ms` before the window. A held pinch moves the
# sensor's level, and that level differs wildly from one session to the next, so only the change against the recent past
# generalises. Both ends are used so that it does not matter how much of the past was spent pinching: with rest and pinch
# both in it, the low end is the rest level and the high end the pinch level whatever the mix; with only rest in it, both
# are the rest level. After the spike features so every model trained before they existed still names the same features in
# the same places.
BASELINE_STATS: tuple[str, ...] = ("rel_low", "rel_high")
BASELINE_FEATURE_NAMES: tuple[str, ...] = tuple(f"{column}_{stat}" for stat in BASELINE_STATS for column in PPG_COLUMNS)
# How the motion sensors move inside the window, beyond their spread: the quick changes of a tap or a pinch. For the
# acceleration and the gyroscope each (see `motion_features`). All about change, none about posture.
MOTION_STATS: tuple[str, ...] = ("jerk_rms", "jerk_max", "magnitude_ptp", "magnitude_kurtosis", "crossing_rate")
MOTION_FEATURE_NAMES: tuple[str, ...] = tuple(f"{sensor}_{stat}" for sensor in ("accel", "gyro") for stat in MOTION_STATS)
# The pulse in units of its own recent past (see `pulse_z`): the sensor's level is arbitrary (one session sits at
# -250,000 counts, another at +310,000) and how far it swings depends on how the watch sits, so neither carries over
# between sessions; measured against the last few seconds' median and spread, both are cancelled. Only with a baseline,
# like the differences. On 18 recordings over five days this lifted pinch-against-rest from 0.61 to 0.77 AUC and
# pinch-against-fist from 0.42-0.53 to 0.72-0.81, each recording judged by a model that never saw it.
BASELINE_Z_STATS: tuple[str, ...] = ("rel_z_mean", "rel_z_max", "rel_z_min", "rel_z_slope")
BASELINE_Z_FEATURE_NAMES: tuple[str, ...] = tuple(f"{column}_{stat}" for stat in BASELINE_Z_STATS for column in PPG_COLUMNS)
# The step through the window, in the same units (see `baseline_step_features`): the mean of its last part less the mean of
# its first. A gesture's PPG deformation is a step, not a level: on 10 pinch sessions over three days, the step across a
# pinch's start told it from other moments at 0.83-0.90 AUC on sessions a model never saw, where the raw level was at
# chance. Those moments were mostly mid-hold; against clean rest it is untested (docs/research/ppg-step-findings-2026-10.md).
# Needs a window long enough to hold the step (about 1.3 s).
BASELINE_STEP_FEATURE_NAMES: tuple[str, ...] = tuple(f"{column}_rel_z_step" for column in PPG_COLUMNS)
# The share of the window, from its start and from its end, whose samples are the "before" and the "after" of the step.
STEP_EARLY_SHARE = 0.25
STEP_LATE_SHARE = 0.4
# The later blocks come after the earlier ones so every model trained before them still names the same features in the
# same places.
FEATURE_NAMES: tuple[str, ...] = (
    *BASE_FEATURE_NAMES, *SPIKE_FEATURE_NAMES, *BASELINE_FEATURE_NAMES, *MOTION_FEATURE_NAMES, *BASELINE_Z_FEATURE_NAMES,
    *BASELINE_STEP_FEATURE_NAMES,
)
# Every feature that compares the pulse with the recent past, so needs a baseline.
ALL_BASELINE_FEATURE_NAMES: tuple[str, ...] = (*BASELINE_FEATURE_NAMES, *BASELINE_Z_FEATURE_NAMES, *BASELINE_STEP_FEATURE_NAMES)
BASE_FEATURE_COUNT = len(BASE_FEATURE_NAMES)

# Fewer PPG samples than this in a window and there is no spike to speak of: every spike feature is 0.
SPIKE_MIN_SAMPLES = 4
# A spike is only counted above this many robust standard deviations of the (baseline-free) signal.
SPIKE_COUNT_SIGMAS = 3.0
# Scale that turns a median absolute deviation into a standard deviation for noise that is roughly normal.
MAD_TO_SIGMA = 1.4826
SPIKE_SIGMA_FLOOR = 1e-9
SPIKE_Z_CAP = 50.0
# How much of the past a model may be asked to compare the window with, in milliseconds.
BASELINE_CHOICES_MS: tuple[int, ...] = (2000, 4000, 8000)
# Fewer PPG samples than this in the baseline and there is nothing to compare with: the window is not scored (live) or not
# used (training), never given a made-up baseline.
BASELINE_MIN_SAMPLES = 16
# The oldest pulse sample of the baseline may be this far after the baseline's start (a gap or a slow first sample), but no
# more: a baseline that does not reach back that far is not the length the model was trained with, so it is not used.
BASELINE_SLACK_MS = 250
# Which points of the baseline the window is compared with (by nearest rank below: see `baseline_percentile`).
BASELINE_LOW_PERCENT = 10
BASELINE_HIGH_PERCENT = 90


def resolve_feature_subset(names: Sequence[str]) -> tuple[str, ...]:
    """Validates a candidate ordered list of feature names against the
    canonical `FEATURE_NAMES` registry -- the single source of truth for a
    custom TFLite bundle's declared feature contract (see `bundle.py`).

    Every name must be one of `FEATURE_NAMES` (unknown names are rejected),
    none may repeat (duplicates are rejected), and `names` must already be in
    the same relative order as `FEATURE_NAMES` (reordering is rejected) --
    live desktop inference always computes the full canonical vector and then
    selects a subset by canonical position, so a declared order that doesn't
    match canonical position would silently mean a different feature than the
    one intended. A subset is accepted; nothing is ever inferred, padded, or
    fabricated for a name that isn't listed.
    """
    if not names:
        raise ValueError("feature subset must not be empty")
    seen: set[str] = set()
    indices: list[int] = []
    for name in names:
        if name in seen:
            raise ValueError(f"duplicate feature name '{name}'")
        seen.add(name)
        try:
            indices.append(FEATURE_NAMES.index(name))
        except ValueError:
            raise ValueError(
                f"unknown feature name '{name}'; every feature must be one of the canonical FEATURE_NAMES"
            ) from None
    if indices != sorted(indices):
        raise ValueError(
            "feature subset must preserve the canonical FEATURE_NAMES order; reordering is not supported"
        )
    return tuple(names)


def _median(values: np.ndarray) -> float:
    ordered = np.sort(values)
    middle = ordered.shape[0] // 2
    if ordered.shape[0] % 2 == 1:
        return float(ordered[middle])
    return float((ordered[middle - 1] + ordered[middle]) / 2.0)


SPIKE_METHODS: tuple[str, ...] = (
    "straight_line_baseline",
    "first_derivative",
    "rolling_median_residual",
    "morphological_top_hat",
    "butterworth_high_pass",
    "savitzky_golay_residual",
    "haar_wavelet_detail",
)
# The widths used inside one window. The Recordings tab's viewer runs the same methods over a whole recording with wider
# windows (9, 9, 20, 11 and 8 samples); a 500 ms window holds only about a dozen pulse samples, so these are narrower.
ROLLING_MEDIAN_RADIUS = 2
TOP_HAT_RADIUS = 2
BUTTERWORTH_PERIOD_SAMPLES = 8.0
SAVITZKY_GOLAY_HALF_WIDTH = 3
HAAR_SCALE = 2


def _median_list(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _sequential_sum(values: list[float]) -> float:
    total = 0.0
    for value in values:
        total += value
    return total


def _sg_smoothing_coefficients(half_width: int) -> list[float]:
    """Quadratic Savitzky-Golay smoothing weights for `half_width` neighbours each side (as the Recordings viewer uses)."""
    if half_width == 0:
        return [1.0]
    offsets = range(-half_width, half_width + 1)
    s0 = float(2 * half_width + 1)
    s2 = float(sum(i * i for i in offsets))
    s4 = float(sum(i * i * i * i for i in offsets))
    denominator = s0 * s4 - s2 * s2
    return [(s4 - s2 * float(i * i)) / denominator for i in offsets]


def _butterworth_high_pass(x: list[float]) -> list[float]:
    """Second-order Butterworth high-pass, forward then backward (as the Recordings viewer does), on the centred signal."""
    period = BUTTERWORTH_PERIOD_SAMPLES
    w0 = 2.0 * math.pi / period
    q = 1.0 / math.sqrt(2.0)
    alpha = math.sin(w0) / (2.0 * q)
    cos_w0 = math.cos(w0)
    a0 = 1.0 + alpha
    b0 = (1.0 + cos_w0) / 2.0 / a0
    b1 = -(1.0 + cos_w0) / a0
    b2 = (1.0 + cos_w0) / 2.0 / a0
    a1 = -2.0 * cos_w0 / a0
    a2 = (1.0 - alpha) / a0

    def apply(signal: list[float]) -> list[float]:
        out = []
        x1 = x2 = y1 = y2 = 0.0
        for x0 in signal:
            y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            out.append(y0)
            x2, x1, y2, y1 = x1, x0, y1, y0
        return out

    mean = _sequential_sum(x) / len(x)
    centred = [value - mean for value in x]
    forward = apply(centred)
    forward.reverse()
    backward = apply(forward)
    backward.reverse()
    return backward


def extract_spike_series(method: str, values: np.ndarray, span_ms: float) -> list[float]:
    """The signal a spike method leaves of one PPG channel in one window (the spikes, with the baseline taken out).

    `straight_line_baseline`: the least-squares straight line through the window taken away. `first_derivative`: the change
    from each sample to the next (one fewer value). `rolling_median_residual`, `morphological_top_hat`,
    `savitzky_golay_residual`: each value minus a rolling median, a morphological opening or a quadratic smooth of its
    neighbours, the neighbourhood shrinking near the window's ends. `butterworth_high_pass`: a second-order high-pass,
    forward then backward. `haar_wavelet_detail`: the difference between the mean of the samples up to and including
    each one and of those just after it (one fewer value). The same definitions, in the same order of operations, are in
    `crates/pinch-inference/src/features.rs`.
    """
    x = [float(v) for v in values]
    n = len(x)
    if method == "straight_line_baseline":
        t = span_ms * np.arange(n, dtype=np.float64) / (n - 1)
        t_mean = float(np.sum(t) / n)
        x_mean = float(np.sum(values) / n)
        tc = t - t_mean
        sxx = float(np.sum(tc * tc))
        slope = float(np.sum(tc * (values - x_mean)) / sxx) if sxx > 0.0 else 0.0
        return [float(v) for v in (values - x_mean) - slope * tc]
    if method == "first_derivative":
        return [x[i + 1] - x[i] for i in range(n - 1)]
    if method == "rolling_median_residual":
        out = []
        for i in range(n):
            lo, hi = max(0, i - ROLLING_MEDIAN_RADIUS), min(n, i + ROLLING_MEDIAN_RADIUS + 1)
            out.append(x[i] - _median_list(x[lo:hi]))
        return out
    if method == "morphological_top_hat":
        radius = TOP_HAT_RADIUS
        erosion = [min(x[max(0, i - radius) : min(n, i + radius + 1)]) for i in range(n)]
        return [x[i] - max(erosion[max(0, i - radius) : min(n, i + radius + 1)]) for i in range(n)]
    if method == "butterworth_high_pass":
        return _butterworth_high_pass(x)
    if method == "savitzky_golay_residual":
        out = []
        for i in range(n):
            half = min(SAVITZKY_GOLAY_HALF_WIDTH, i, n - 1 - i)
            smoothed = 0.0
            for offset, coefficient in enumerate(_sg_smoothing_coefficients(half)):
                smoothed += coefficient * x[i - half + offset]
            out.append(x[i] - smoothed)
        return out
    if method == "haar_wavelet_detail":
        out = []
        for i in range(n - 1):
            left = x[i + 1 - min(HAAR_SCALE, i + 1) : i + 1]
            right = x[i + 1 : min(i + 1 + HAAR_SCALE, n)]
            out.append((_sequential_sum(left) / len(left) - _sequential_sum(right) / len(right)) / math.sqrt(2.0))
        return out
    raise ValueError(f"unknown spike extraction method {method!r}; choose from {list(SPIKE_METHODS)}")


def spike_features(values: np.ndarray, timestamps_ms: np.ndarray, method: str = "straight_line_baseline") -> list[float]:
    """The eight spike features of one PPG channel in one window, in `SPIKE_STATS` order.

    0. Time: the samples are taken as evenly spaced across the window (first to last PPG timestamp).
    1. Extraction: `extract_spike_series(method, ...)` leaves the spikes with the baseline taken out, so slow drift and how
       well the watch touches the skin leave nothing behind but the changes. It is done inside the window on purpose: a
       live window and a training window then see exactly the same thing.
    2. Derivative: the change between neighbouring values of that signal per millisecond; `deriv_max` is the steepest rise
       and `deriv_min` the steepest fall.
    3. Spike: the value furthest from the median of that signal. `spike_height` is how far (signed),
       `spike_z` how many robust standard deviations (median absolute deviation x 1.4826, at most 50), `spike_time_frac`
       where in the window it is (0 to 1), `spike_rise_ms` / `spike_fall_ms` how long the signal stays above half the
       height before / after the peak, and `spike_count` how many separate peaks reach 3 robust standard deviations.

    A window with fewer than `SPIKE_MIN_SAMPLES` samples has no spike: all zeros. The crate `pinch-inference` computes
    the same numbers in the same order of operations, and the shared cases in `tests/fixtures/spike_cases.json` keep them
    equal.
    """
    n = int(values.shape[0])
    if n < SPIKE_MIN_SAMPLES:
        return [0.0] * len(SPIKE_STATS)
    # The samples are spaced evenly over the window's span, not by their own timestamps: the watch stamps a batch of
    # samples a few nanoseconds apart and the next batch about 100 ms later, which would make every rate wild.
    span = float(timestamps_ms[-1] - timestamps_ms[0])
    residual = np.array(extract_spike_series(method, values, span), dtype=np.float64)
    m = int(residual.shape[0])
    t = span * np.arange(m, dtype=np.float64) / (m - 1)

    deltas = np.diff(t)
    steps = np.diff(residual)
    deriv = np.where(deltas > 0.0, steps / np.where(deltas > 0.0, deltas, 1.0), 0.0)

    deviation = residual - _median(residual)
    magnitude = np.abs(deviation)
    sigma = MAD_TO_SIGMA * _median(magnitude)
    peak_index = int(np.argmax(magnitude))
    peak = float(deviation[peak_index])
    z = min(abs(peak) / max(sigma, SPIKE_SIGMA_FLOOR), SPIKE_Z_CAP)
    time_frac = float(t[peak_index]) / span if span > 0.0 else 0.0

    rise = fall = 0.0
    if peak != 0.0:
        sign = 1.0 if peak >= 0.0 else -1.0
        signed = sign * deviation
        half = abs(peak) / 2.0
        left = peak_index
        while left > 0 and signed[left - 1] >= half:
            left -= 1
        right = peak_index
        while right < m - 1 and signed[right + 1] >= half:
            right += 1
        rise = float(t[peak_index] - t[left])
        fall = float(t[right] - t[peak_index])

    threshold = SPIKE_COUNT_SIGMAS * max(sigma, SPIKE_SIGMA_FLOOR)
    count = 0
    for i in range(m):
        if magnitude[i] < threshold:
            continue
        if (i == 0 or magnitude[i] >= magnitude[i - 1]) and (i == m - 1 or magnitude[i] > magnitude[i + 1]):
            count += 1
    return [peak, z, time_frac, rise, fall, float(count), float(np.max(deriv)), float(np.min(deriv))]


def _stat_block(values: np.ndarray) -> tuple[float, float, float, float]:
    return float(np.mean(values)), float(np.std(values)), float(np.min(values)), float(np.max(values))


def _slope(values: np.ndarray, timestamps_ns: np.ndarray) -> float:
    duration_ms = (timestamps_ns[-1] - timestamps_ns[0]) / 1_000_000.0
    if duration_ms <= 0:
        return 0.0
    return float((values[-1] - values[0]) / duration_ms)


def _quat_delta_angle_deg(quat_first: np.ndarray, quat_last: np.ndarray) -> float:
    """Angle in degrees between the window's first and last orientation quaternion."""
    first = quat_first / max(np.linalg.norm(quat_first), 1e-9)
    last = quat_last / max(np.linalg.norm(quat_last), 1e-9)
    dot = float(np.clip(abs(np.dot(first, last)), -1.0, 1.0))
    return float(np.degrees(2.0 * np.arccos(dot)))


def _channel_rows(columns: tuple[str, ...]) -> slice:
    """The contiguous `NUMERIC_COLUMNS` rows (of `Recording.channel_matrix`) holding `columns`."""
    first = NUMERIC_COLUMNS.index(columns[0])
    rows = slice(first, first + len(columns))
    if NUMERIC_COLUMNS[rows] != columns:
        raise AssertionError(f"{columns} are not contiguous in NUMERIC_COLUMNS")
    return rows


_PPG_ROWS = _channel_rows(PPG_COLUMNS)
_ACCEL_ROWS = _channel_rows(ACCEL_COLUMNS)
_GYRO_ROWS = _channel_rows(GYRO_COLUMNS)
_QUAT_ROWS = _channel_rows(QUAT_COLUMNS)
_CONTACT_ROW = NUMERIC_COLUMNS.index(CONTACT_QUALITY_COLUMN)


def _mean_and_std_by_row(block: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-row population mean and standard deviation, bit-identical to `np.mean`/`np.std`.

    `block.mean(axis=1)` is *not* a substitute: reducing a 2-D array along its last axis sums in
    a different order from the 1-D pairwise sum `np.mean` uses on a single channel, which moves
    27 of the 55 features by up to thousands of ulps and so would change every trained model
    for no reason. This replays exactly the operations numpy performs for one 1-D array (one
    `add.reduce`, the centered squares, another `add.reduce`, a divide, a square root) per row,
    skipping only the Python-level wrapper overhead that dominated the original cost.
    """
    sample_count = block.shape[1]
    add_reduce = np.add.reduce
    rows = block.shape[0]
    means = np.empty(rows)
    stds = np.empty(rows)
    for index in range(rows):
        row = block[index]
        mean = add_reduce(row) / sample_count
        centered = row - mean
        means[index] = mean
        stds[index] = np.sqrt(add_reduce(centered * centered) / sample_count)
    return means, stds


_IDENTITY_QUATERNION = np.array([1.0, 0.0, 0.0, 0.0])


def stream_rows(recording: Recording, window: Window) -> tuple[np.ndarray, np.ndarray]:
    """The window's rows that carried a real pulse sample, and those that carried a real orientation sample. A recording
    built by hand (no `*_observed`) counts every row as both."""
    rows = window.row_indices
    ppg = rows if recording.ppg_observed is None else rows[recording.ppg_observed[rows]]
    orient = rows if recording.orient_observed is None else rows[recording.orient_observed[rows]]
    return ppg, orient


def extract_base_features(recording: Recording, window: Window) -> np.ndarray:
    """The 55-feature vector for one window, in `FEATURE_NAMES` order.

    Each sensor's statistics are taken over that sensor's own samples in the window, as the live runtime takes them
    (`pinch_inference::extract_features_with`): the pulse statistics, slope, contact quality and duration over the pulse
    samples, the motion and orientation statistics over the orientation samples, and `sample_count` the two counts added.
    They used to be taken over every row of the merged recording, where the gaps were filled with the last value, so a
    pulse value counted once for each motion row that followed it and a motion sensor's spread was diluted by repeats:
    numbers the live runtime never produces. A window with no orientation sample uses the motion values carried into it
    and no rotation (the runtime's last snapshot); one with no pulse sample has zero pulse statistics.

    The per-channel statistics are computed over one (channels x samples) slice instead of one numpy call per channel per
    statistic, bit-identical to the per-channel computation (population variance, `ddof=0`; same left-to-right order for
    the magnitude sums); `tests/test_optimized_equivalence.py` pins that against the straightforward implementation.
    """
    ppg_rows, orient_rows = stream_rows(recording, window)
    matrix = recording.channel_matrix

    if ppg_rows.shape[0] > 0:
        ppg = matrix[_PPG_ROWS][:, ppg_rows]
        ppg_means, ppg_stds = _mean_and_std_by_row(ppg)
        ppg_mins, ppg_maxs = ppg.min(axis=1), ppg.max(axis=1)
        ppg_stamps = recording.timestamps_ns[ppg_rows]
        duration_ms = (ppg_stamps[-1] - ppg_stamps[0]) / 1_000_000.0
        slopes = (ppg[:, -1] - ppg[:, 0]) / duration_ms if duration_ms > 0 else np.zeros(ppg.shape[0])
        if duration_ms <= 0:
            duration_ms = 0.0
        contact = float(np.mean(matrix[_CONTACT_ROW, ppg_rows]))
    else:
        ppg_means = ppg_stds = ppg_mins = ppg_maxs = slopes = np.zeros(len(PPG_COLUMNS))
        duration_ms, contact = 0.0, 0.0

    if orient_rows.shape[0] > 0:
        motion = matrix[:, orient_rows]
    else:
        motion = matrix[:, window.row_indices[:1]].copy()
        motion[_QUAT_ROWS, 0] = _IDENTITY_QUATERNION
    means, stds = _mean_and_std_by_row(motion)
    # min and max do not depend on summation order, so one reduction over the whole block is
    # exact (unlike mean/std; see `_mean_and_std_by_row`).
    mins = motion.min(axis=1)
    maxs = motion.max(axis=1)

    def magnitude_stats(rows: slice) -> tuple[float, float]:
        x, y, z = motion[rows]
        magnitude = np.sqrt(x**2 + y**2 + z**2)
        return float(np.mean(magnitude)), float(np.std(magnitude))

    accel_magnitude_mean, accel_magnitude_std = magnitude_stats(_ACCEL_ROWS)
    gyro_magnitude_mean, gyro_magnitude_std = magnitude_stats(_GYRO_ROWS)

    quat = motion[_QUAT_ROWS]
    quat_delta = _quat_delta_angle_deg(quat[:, 0], quat[:, -1])

    vector = np.concatenate(
        (
            ppg_means,
            ppg_stds,
            ppg_mins,
            ppg_maxs,
            slopes,
            means[_ACCEL_ROWS],
            stds[_ACCEL_ROWS],
            mins[_ACCEL_ROWS],
            maxs[_ACCEL_ROWS],
            (accel_magnitude_mean, accel_magnitude_std),
            means[_GYRO_ROWS],
            stds[_GYRO_ROWS],
            mins[_GYRO_ROWS],
            maxs[_GYRO_ROWS],
            (gyro_magnitude_mean, gyro_magnitude_std),
            means[_QUAT_ROWS],
            stds[_QUAT_ROWS],
            (quat_delta,),
            (contact,),
            (float(ppg_rows.shape[0] + orient_rows.shape[0]),),
            (float(duration_ms),),
        )
    ).astype(np.float64, copy=False)
    assert vector.shape[0] == BASE_FEATURE_COUNT
    return vector


def extract_features(recording: Recording, window: Window, spike_method: str | None = None, baseline_ms: int | None = None) -> np.ndarray:
    """The full canonical vector for one window: the 55 base features, the pulse-sensor spike features, then the relative-level ones.

    The spike features are computed with `spike_method` (one of `SPIKE_METHODS`); with none they are 0 and no model reads them.
    The relative-level features are computed against the `baseline_ms` before the window; with none (or too little past) they
    are 0 and no model reads them.
    """
    spikes = np.zeros(len(SPIKE_FEATURE_NAMES), dtype=np.float64)
    indices = window.row_indices
    if spike_method is not None and recording.ppg_observed is not None:
        indices = indices[recording.ppg_observed[indices]]  # only rows that carried a real PPG sample, as live windows do
    if spike_method is not None and indices.shape[0] >= SPIKE_MIN_SAMPLES:
        t_ms = recording.timestamps_ns[indices].astype(np.float64) / 1_000_000.0
        for channel, column in enumerate(PPG_COLUMNS):
            values = recording.channels[column][indices]
            for stat, value in enumerate(spike_features(values, t_ms, spike_method)):
                spikes[stat * len(PPG_COLUMNS) + channel] = value
    relative = np.zeros(len(BASELINE_FEATURE_NAMES), dtype=np.float64)
    zs = np.zeros(len(BASELINE_Z_FEATURE_NAMES), dtype=np.float64)
    steps = np.zeros(len(BASELINE_STEP_FEATURE_NAMES), dtype=np.float64)
    if baseline_ms is not None:
        rows = baseline_rows(recording, window, baseline_ms)
        if rows is not None:
            in_window = window.row_indices
            if recording.ppg_observed is not None:
                in_window = in_window[recording.ppg_observed[in_window]]
            window_ppg = [recording.channels[column][in_window] for column in PPG_COLUMNS]
            past_ppg = [recording.channels[column][rows] for column in PPG_COLUMNS]
            relative[:] = baseline_features(window_ppg, past_ppg)
            stamps = recording.timestamps_ns[in_window]
            times_ms = (stamps - (stamps[0] if stamps.shape[0] else 0)).astype(np.float64) / 1_000_000.0
            zs[:] = baseline_z_features(window_ppg, times_ms, past_ppg)
            steps[:] = baseline_step_features(window_ppg, times_ms, past_ppg)
    _, orient_rows = stream_rows(recording, window)
    stamps = recording.timestamps_ns[orient_rows]
    times_ms = (stamps - (stamps[0] if stamps.shape[0] else 0)).astype(np.float64) / 1_000_000.0
    motion = [
        value
        for columns in (ACCEL_COLUMNS, GYRO_COLUMNS)
        for value in motion_features(np.stack([recording.channels[c][orient_rows] for c in columns], axis=1), times_ms)
    ]
    return np.concatenate((extract_base_features(recording, window), spikes, relative, motion, zs, steps))


def baseline_rows(recording: Recording, window: Window, baseline_ms: int) -> np.ndarray | None:
    """The rows (in order) that carried a real PPG sample in the `baseline_ms` before the window starts, or None when fewer
    than `BASELINE_MIN_SAMPLES` did or the first of them is more than `BASELINE_SLACK_MS` after the baseline's start (the
    recording does not reach back that far). The window's own rows are never part of it."""
    first = int(window.row_indices[0])
    stamps = recording.timestamps_ns
    start_ns = int(stamps[first]) - int(baseline_ms) * 1_000_000
    begin = int(np.searchsorted(stamps, start_ns, side="left"))
    rows = np.arange(begin, first)
    if recording.ppg_observed is not None:
        rows = rows[recording.ppg_observed[rows]]
    if rows.shape[0] < BASELINE_MIN_SAMPLES or int(stamps[rows[0]]) > start_ns + BASELINE_SLACK_MS * 1_000_000:
        return None
    return rows


def baseline_percentile(values: np.ndarray, percent: int) -> float:
    """The value at rank `floor((n - 1) * percent / 100)` of the sorted values, in whole-number arithmetic so the desktop's
    copy picks the very same sample."""
    ordered = np.sort(values)
    return float(ordered[((ordered.shape[0] - 1) * percent) // 100])


# Below this the variance of a motion sensor's strength is taken to be zero (no spread to measure peakedness against).
RATIO_FLOOR = 1e-9
# The smallest spread a pulse channel's recent past is taken to have, in the sensor's counts: a flat past (a spread of
# less than one count) would otherwise make any change look enormous.
Z_SCALE_FLOOR = 1.0
# How far, in spreads of the recent past, a pulse value may be counted: a sudden jump of the sensor saturates there.
Z_CLIP = 20.0
MAD_TO_SD = 1.4826


def _true_median(values: np.ndarray) -> float:
    """The middle value (the average of the two middle ones for an even count), as the runtime computes it."""
    ordered = np.sort(np.asarray(values, dtype=np.float64))
    middle = ordered.shape[0] // 2
    return float(ordered[middle]) if ordered.shape[0] % 2 else float((ordered[middle - 1] + ordered[middle]) / 2.0)


def pulse_z(values: np.ndarray, past: np.ndarray) -> np.ndarray:
    """`values` of one pulse channel in units of its recent `past`: minus the past's median, over its spread (the median
    absolute deviation, scaled to a standard deviation, at least `Z_SCALE_FLOOR`), clipped to +/-`Z_CLIP`. Cancels the
    session's arbitrary level and how far the signal swings in it. The same, in the same order of operations, is
    `pulse_z` in `crates/pinch-inference/src/features.rs`."""
    centre = _true_median(past)
    spread = max(_true_median(np.abs(np.asarray(past, dtype=np.float64) - centre)) * MAD_TO_SD, Z_SCALE_FLOOR)
    return np.clip((np.asarray(values, dtype=np.float64) - centre) / spread, -Z_CLIP, Z_CLIP)


def baseline_z_features(window_ppg: Sequence[np.ndarray], times_ms: np.ndarray, baseline_ppg: Sequence[np.ndarray]) -> list[float]:
    """The twelve pulse features in units of the recent past (`BASELINE_Z_FEATURE_NAMES` order): for each channel, its
    window samples through `pulse_z` against its baseline, then their mean, largest, smallest and least-squares slope per
    second (`times_ms` are the samples' times). A channel with no window samples or too few baseline samples is all
    zeros; the slope is zero without two samples apart in time."""
    out = np.zeros((len(BASELINE_Z_STATS), len(PPG_COLUMNS)))
    for channel, (window_values, baseline_values) in enumerate(zip(window_ppg, baseline_ppg, strict=True)):
        if window_values.shape[0] == 0 or baseline_values.shape[0] < BASELINE_MIN_SAMPLES:
            continue
        z = pulse_z(window_values, baseline_values)
        out[0, channel], out[1, channel], out[2, channel] = float(np.mean(z)), float(z.max()), float(z.min())
        if z.shape[0] >= 2:
            seconds = np.asarray(times_ms, dtype=np.float64) / 1000.0
            centred = seconds - float(np.mean(seconds))
            denominator = float(np.sum(centred * centred))
            if denominator > 0:
                out[3, channel] = float(np.sum(centred * (z - float(np.mean(z))))) / denominator
    return out.ravel().tolist()


def baseline_step_features(window_ppg: Sequence[np.ndarray], times_ms: np.ndarray, baseline_ppg: Sequence[np.ndarray]) -> list[float]:
    """The three step features (`BASELINE_STEP_FEATURE_NAMES` order): for each channel, its window samples through `pulse_z`
    against its baseline, then the mean of those in the last `STEP_LATE_SHARE` of the window's time span less the mean of
    those in the first `STEP_EARLY_SHARE` (`times_ms` are the samples' times, from the window's first sample). Positive
    when the signal stepped up through the window. A channel with no window samples, too few baseline samples, no time
    span or an empty part is 0. The same, in the same order of operations, is `baseline_step_features` in
    `crates/pinch-inference/src/features.rs`."""
    out = [0.0] * len(PPG_COLUMNS)
    times = np.asarray(times_ms, dtype=np.float64)
    for channel, (window_values, baseline_values) in enumerate(zip(window_ppg, baseline_ppg, strict=True)):
        if window_values.shape[0] == 0 or baseline_values.shape[0] < BASELINE_MIN_SAMPLES or times.shape[0] != window_values.shape[0]:
            continue
        start, end = float(times[0]), float(times[-1])
        span = end - start
        if span <= 0:
            continue
        z = pulse_z(window_values, baseline_values)
        early = z[times <= start + span * STEP_EARLY_SHARE]
        late = z[times >= end - span * STEP_LATE_SHARE]
        if early.shape[0] == 0 or late.shape[0] == 0:
            continue
        out[channel] = float(np.sum(late)) / late.shape[0] - float(np.sum(early)) / early.shape[0]
    return out


def motion_features(values: np.ndarray, times_ms: np.ndarray) -> list[float]:
    """The five `MOTION_STATS` of one motion sensor from its samples in the window (`values` n x 3, taken at `times_ms`):

    * `jerk_rms`, `jerk_max`: how fast the vector changes, per second (the length of each step from one sample to the
      next over the time between them), as a root mean square and at its largest;
    * `magnitude_ptp`: the largest length of the vector less the smallest;
    * `magnitude_kurtosis`: how peaked the length is (excess kurtosis: 0 for a normal spread, high when a brief burst
      stands out of a quiet window); 0 with fewer than 4 samples or no spread;
    * `crossing_rate`: how often an axis crosses its own mean, per second, averaged over the three axes.

    With fewer than two samples (or no time between the first and the last) the ones that need them are 0. The same, in
    the same order of operations, is `motion_features` in `crates/pinch-inference/src/features.rs`."""
    n = values.shape[0]
    out = [0.0] * len(MOTION_STATS)
    if n == 0:
        return out
    magnitude = np.sqrt(values[:, 0] ** 2 + values[:, 1] ** 2 + values[:, 2] ** 2)
    out[2] = float(magnitude.max() - magnitude.min())
    if n >= 4:
        centred = magnitude - float(np.mean(magnitude))
        m2 = float(np.mean(centred**2))
        if m2 > RATIO_FLOOR:
            out[3] = float(np.mean(centred**4)) / (m2 * m2) - 3.0
    if n < 2:
        return out
    steps = np.sqrt(np.sum(np.diff(values, axis=0) ** 2, axis=1))
    dt_s = np.diff(times_ms) / 1000.0
    rates = steps[dt_s > 0] / dt_s[dt_s > 0]
    if rates.shape[0] > 0:
        out[0] = float(np.sqrt(np.mean(rates**2)))
        out[1] = float(rates.max())
    duration_s = float(times_ms[-1] - times_ms[0]) / 1000.0
    if duration_s > 0:
        crossings = 0
        for axis in range(3):
            centred = values[:, axis] - float(np.mean(values[:, axis]))
            crossings += int(np.sum(centred[:-1] * centred[1:] < 0))
        out[4] = crossings / 3.0 / duration_s
    return out


def baseline_features(window_ppg: Sequence[np.ndarray], baseline_ppg: Sequence[np.ndarray]) -> list[float]:
    """The six relative-level features (`BASELINE_FEATURE_NAMES` order) from each PPG channel's window samples and baseline
    samples: the window's average minus the baseline's low end, for each channel, then minus its high end. A channel with no
    window samples, or too few baseline samples, is all zeros."""
    lows: list[float] = []
    highs: list[float] = []
    for window_values, baseline_values in zip(window_ppg, baseline_ppg, strict=True):
        if window_values.shape[0] == 0 or baseline_values.shape[0] < BASELINE_MIN_SAMPLES:
            lows.append(0.0)
            highs.append(0.0)
            continue
        level = float(np.mean(window_values))
        lows.append(level - baseline_percentile(baseline_values, BASELINE_LOW_PERCENT))
        highs.append(level - baseline_percentile(baseline_values, BASELINE_HIGH_PERCENT))
    return [*lows, *highs]
