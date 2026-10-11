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
FEATURE_NAMES: tuple[str, ...] = (*BASE_FEATURE_NAMES, *SPIKE_FEATURE_NAMES, *BASELINE_FEATURE_NAMES)
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


def extract_base_features(recording: Recording, window: Window) -> np.ndarray:
    """The 55-feature vector for one window, in `FEATURE_NAMES` order.

    The per-channel statistics are computed over one (channels x samples) slice instead of one
    numpy call per channel per statistic, and the result is bit-identical to the per-channel
    computation (population variance, `ddof=0`; same left-to-right order for the magnitude
    sums); `tests/test_optimized_equivalence.py` pins that against the original implementation.
    """
    indices = window.row_indices
    timestamps_ns = recording.timestamps_ns[indices]
    block = recording.channel_matrix[:, indices]

    means, stds = _mean_and_std_by_row(block)
    # min and max do not depend on summation order, so one reduction over the whole block is
    # exact (unlike mean/std; see `_mean_and_std_by_row`).
    mins = block.min(axis=1)
    maxs = block.max(axis=1)

    duration_ms = (timestamps_ns[-1] - timestamps_ns[0]) / 1_000_000.0
    ppg = block[_PPG_ROWS]
    if duration_ms <= 0:
        slopes = np.zeros(ppg.shape[0])
    else:
        slopes = (ppg[:, -1] - ppg[:, 0]) / duration_ms

    def magnitude_stats(rows: slice) -> tuple[float, float]:
        x, y, z = block[rows]
        magnitude = np.sqrt(x**2 + y**2 + z**2)
        return float(np.mean(magnitude)), float(np.std(magnitude))

    accel_magnitude_mean, accel_magnitude_std = magnitude_stats(_ACCEL_ROWS)
    gyro_magnitude_mean, gyro_magnitude_std = magnitude_stats(_GYRO_ROWS)

    quat = block[_QUAT_ROWS]
    quat_delta = _quat_delta_angle_deg(quat[:, 0], quat[:, -1])

    vector = np.concatenate(
        (
            means[_PPG_ROWS],
            stds[_PPG_ROWS],
            mins[_PPG_ROWS],
            maxs[_PPG_ROWS],
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
            (means[_CONTACT_ROW],),
            (float(indices.shape[0]),),
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
    if baseline_ms is not None:
        rows = baseline_rows(recording, window, baseline_ms)
        if rows is not None:
            in_window = window.row_indices
            if recording.ppg_observed is not None:
                in_window = in_window[recording.ppg_observed[in_window]]
            relative[:] = baseline_features(
                [recording.channels[column][in_window] for column in PPG_COLUMNS],
                [recording.channels[column][rows] for column in PPG_COLUMNS],
            )
    return np.concatenate((extract_base_features(recording, window), spikes, relative))


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
