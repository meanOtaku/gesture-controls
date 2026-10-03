"""Derives a fixed, deterministic feature vector for one window.

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

FEATURE_NAMES: tuple[str, ...] = (
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


def extract_features(recording: Recording, window: Window) -> np.ndarray:
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
    assert vector.shape[0] == len(FEATURE_NAMES)
    return vector
