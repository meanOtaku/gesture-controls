"""Offline, time-based first-derivative feature block for the M5 baseline-vs-derivative
experiment harness (see experiment.py). Research-only: nothing here is wired into
`features.py`/`FEATURE_NAMES`, live desktop inference, or any deployment bundle.

Derivative math mirrors the accel/gyro/PPG channel groups already used by the baseline
`extract_features`, but adds a mean/std of the *time-based* first derivative (numpy's
central-difference gradient against the window's own timestamps) per channel. A window's
raw timestamp stream can be irregular or mixed-scale (see the M2 plan), which would make a
derivative misleading; `check_timestamp_regularity` is the explicit precondition callers
must pass before trusting this block for a given window.
"""

from __future__ import annotations

import numpy as np

from .csv_io import Recording
from .schema import ACCEL_COLUMNS, GYRO_COLUMNS, PPG_COLUMNS
from .windowing import Window

# Deviation of any single sample interval from the window's median interval, as a fraction
# of that median, above which the timestamp stream is rejected as irregular for derivative
# purposes. 0.5 tolerates normal jitter while still catching the discontinuities/mixed-scale
# gaps the M2 plan calls out.
DEFAULT_TIMESTAMP_TOLERANCE = 0.5

DERIVATIVE_FEATURE_NAMES: tuple[str, ...] = (
    *(f"{column}_deriv_mean" for column in PPG_COLUMNS),
    *(f"{column}_deriv_std" for column in PPG_COLUMNS),
    *(f"{column}_deriv_mean" for column in ACCEL_COLUMNS),
    *(f"{column}_deriv_std" for column in ACCEL_COLUMNS),
    *(f"{column}_deriv_mean" for column in GYRO_COLUMNS),
    *(f"{column}_deriv_std" for column in GYRO_COLUMNS),
)


def check_timestamp_regularity(
    timestamps_ns: np.ndarray, tolerance: float = DEFAULT_TIMESTAMP_TOLERANCE
) -> tuple[bool, str]:
    """Returns (ok, reason). ok is False, with an explicit reason, whenever a time-based
    derivative over this timestamp stream would be misleading rather than merely noisy.
    """
    if timestamps_ns.shape[0] < 3:
        return False, "fewer than 3 samples in window"
    diffs = np.diff(timestamps_ns.astype(np.float64))
    if np.any(diffs <= 0):
        return False, "non-positive or duplicate timestamp interval"
    median = float(np.median(diffs))
    if median <= 0:
        return False, "degenerate median sample interval"
    max_deviation = float(np.max(np.abs(diffs - median)) / median)
    if max_deviation > tolerance:
        return False, f"timestamp interval deviates {max_deviation:.0%} from median cadence (tolerance {tolerance:.0%})"
    return True, ""


def _derivative_stats(values: np.ndarray, timestamps_ns: np.ndarray) -> tuple[float, float]:
    seconds = timestamps_ns.astype(np.float64) / 1_000_000_000.0
    derivative = np.gradient(values, seconds)
    return float(np.mean(derivative)), float(np.std(derivative))


def extract_derivative_features(recording: Recording, window: Window) -> np.ndarray:
    """Assumes the caller already confirmed `check_timestamp_regularity` for this window's
    timestamps; raises if not (this module never silently computes a misleading derivative).
    """
    indices = window.row_indices
    timestamps_ns = recording.timestamps_ns[indices]
    ok, reason = check_timestamp_regularity(timestamps_ns)
    if not ok:
        raise ValueError(f"timestamp stream fails the derivative-feature precondition: {reason}")

    values: list[float] = []
    for columns in (PPG_COLUMNS, ACCEL_COLUMNS, GYRO_COLUMNS):
        arrays = [recording.channels[column][indices] for column in columns]
        stats = [_derivative_stats(array, timestamps_ns) for array in arrays]
        values.extend(mean for mean, _ in stats)
        values.extend(std for _, std in stats)

    vector = np.array(values, dtype=np.float64)
    assert vector.shape[0] == len(DERIVATIVE_FEATURE_NAMES)
    return vector
