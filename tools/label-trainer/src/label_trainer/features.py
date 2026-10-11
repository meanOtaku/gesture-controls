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
FEATURE_NAMES: tuple[str, ...] = (*BASE_FEATURE_NAMES, *SPIKE_FEATURE_NAMES)
BASE_FEATURE_COUNT = len(BASE_FEATURE_NAMES)

# Fewer PPG samples than this in a window and there is no spike to speak of: every spike feature is 0.
SPIKE_MIN_SAMPLES = 4
# A spike is only counted above this many robust standard deviations of the (baseline-free) signal.
SPIKE_COUNT_SIGMAS = 3.0
# Scale that turns a median absolute deviation into a standard deviation for noise that is roughly normal.
MAD_TO_SIGMA = 1.4826
SPIKE_SIGMA_FLOOR = 1e-9
SPIKE_Z_CAP = 50.0


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


def spike_features(values: np.ndarray, timestamps_ms: np.ndarray) -> list[float]:
    """The eight spike features of one PPG channel in one window, in `SPIKE_STATS` order.

    0. Time: the samples are taken as evenly spaced across the window (first to last PPG timestamp).
    1. Baseline removal: the least-squares straight line through the window is taken away, so slow drift and how well the
       watch touches the skin leave nothing behind but the changes. (It is fitted inside the window on purpose: a live
       window and a training window then see exactly the same thing.)
    2. Derivative: the change between neighbouring samples per millisecond; `deriv_max` is the steepest rise and
       `deriv_min` the steepest fall.
    3. Spike: the sample furthest from the median of what is left. `spike_height` is how far (signed),
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
    t = span * np.arange(n, dtype=np.float64) / (n - 1)
    t_mean = float(np.sum(t) / n)
    x_mean = float(np.sum(values) / n)
    tc = t - t_mean
    sxx = float(np.sum(tc * tc))
    slope = float(np.sum(tc * (values - x_mean)) / sxx) if sxx > 0.0 else 0.0
    residual = (values - x_mean) - slope * tc

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
        while right < n - 1 and signed[right + 1] >= half:
            right += 1
        rise = float(t[peak_index] - t[left])
        fall = float(t[right] - t[peak_index])

    threshold = SPIKE_COUNT_SIGMAS * max(sigma, SPIKE_SIGMA_FLOOR)
    count = 0
    for i in range(n):
        if magnitude[i] < threshold:
            continue
        if (i == 0 or magnitude[i] >= magnitude[i - 1]) and (i == n - 1 or magnitude[i] > magnitude[i + 1]):
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


def extract_features(recording: Recording, window: Window) -> np.ndarray:
    """The full canonical vector for one window: the 55 base features, then the pulse-sensor spike features."""
    spikes = np.zeros(len(SPIKE_FEATURE_NAMES), dtype=np.float64)
    indices = window.row_indices
    if recording.ppg_observed is not None:
        indices = indices[recording.ppg_observed[indices]]  # only rows that carried a real PPG sample, as live windows do
    if indices.shape[0] >= SPIKE_MIN_SAMPLES:
        t_ms = recording.timestamps_ns[indices].astype(np.float64) / 1_000_000.0
        for channel, column in enumerate(PPG_COLUMNS):
            values = recording.channels[column][indices]
            for stat, value in enumerate(spike_features(values, t_ms)):
                spikes[stat * len(PPG_COLUMNS) + channel] = value
    return np.concatenate((extract_base_features(recording, window), spikes))
