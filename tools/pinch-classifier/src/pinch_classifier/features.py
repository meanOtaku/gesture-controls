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

import numpy as np

from .csv_io import Recording
from .schema import ACCEL_COLUMNS, CONTACT_QUALITY_COLUMN, GYRO_COLUMNS, PPG_COLUMNS, QUAT_COLUMNS
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


def extract_features(recording: Recording, window: Window) -> np.ndarray:
    indices = window.row_indices
    timestamps_ns = recording.timestamps_ns[indices]

    values: list[float] = []

    ppg_arrays = [recording.channels[column][indices] for column in PPG_COLUMNS]
    for array in ppg_arrays:
        values.append(float(np.mean(array)))
    for array in ppg_arrays:
        values.append(float(np.std(array)))
    for array in ppg_arrays:
        values.append(float(np.min(array)))
    for array in ppg_arrays:
        values.append(float(np.max(array)))
    for array in ppg_arrays:
        values.append(_slope(array, timestamps_ns))

    accel_arrays = [recording.channels[column][indices] for column in ACCEL_COLUMNS]
    for array in accel_arrays:
        values.append(float(np.mean(array)))
    for array in accel_arrays:
        values.append(float(np.std(array)))
    for array in accel_arrays:
        values.append(float(np.min(array)))
    for array in accel_arrays:
        values.append(float(np.max(array)))
    accel_magnitude = np.sqrt(sum(array**2 for array in accel_arrays))
    values.append(float(np.mean(accel_magnitude)))
    values.append(float(np.std(accel_magnitude)))

    gyro_arrays = [recording.channels[column][indices] for column in GYRO_COLUMNS]
    for array in gyro_arrays:
        values.append(float(np.mean(array)))
    for array in gyro_arrays:
        values.append(float(np.std(array)))
    for array in gyro_arrays:
        values.append(float(np.min(array)))
    for array in gyro_arrays:
        values.append(float(np.max(array)))
    gyro_magnitude = np.sqrt(sum(array**2 for array in gyro_arrays))
    values.append(float(np.mean(gyro_magnitude)))
    values.append(float(np.std(gyro_magnitude)))

    quat_arrays = [recording.channels[column][indices] for column in QUAT_COLUMNS]
    for array in quat_arrays:
        values.append(float(np.mean(array)))
    for array in quat_arrays:
        values.append(float(np.std(array)))
    quat_first = np.array([recording.channels[column][indices[0]] for column in QUAT_COLUMNS])
    quat_last = np.array([recording.channels[column][indices[-1]] for column in QUAT_COLUMNS])
    values.append(_quat_delta_angle_deg(quat_first, quat_last))

    values.append(float(np.mean(recording.channels[CONTACT_QUALITY_COLUMN][indices])))
    values.append(float(indices.shape[0]))
    values.append(float((timestamps_ns[-1] - timestamps_ns[0]) / 1_000_000.0))

    vector = np.array(values, dtype=np.float64)
    assert vector.shape[0] == len(FEATURE_NAMES)
    return vector
