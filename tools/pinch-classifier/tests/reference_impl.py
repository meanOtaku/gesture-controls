"""The pre-optimization implementations, kept verbatim as references.

`tests/test_optimized_equivalence.py` requires the vectorized production code to produce
exactly (bit-for-bit) what these straightforward loops produce. Do not "improve" this file:
its only job is to be obviously correct.
"""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np

from pinch_classifier.csv_io import CsvFormatError, Recording, _strip_leading_comments
from pinch_classifier.features import FEATURE_NAMES
from pinch_classifier.schema import (
    ACCEL_COLUMNS,
    CONTACT_QUALITY_COLUMN,
    GYRO_COLUMNS,
    HEADER_COLUMNS,
    LABEL_COLUMN,
    NUMERIC_COLUMNS,
    PPG_COLUMNS,
    QUAT_COLUMNS,
    TIMESTAMP_COLUMN,
)
from pinch_classifier.windowing import MS_TO_NS, Window, WindowConfig


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

def reference_extract_features(recording: Recording, window: Window) -> np.ndarray:
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

def reference_carry_forward(values: np.ndarray) -> np.ndarray:
    """Forward-fills NaNs from the last known (past) sample only — never from the future.

    Leading NaNs (no prior sample yet) fall back to 0.0. This is a documented
    limitation: the first stretch of a session before any real sample arrives
    is treated as zero rather than dropped.
    """
    filled = values.copy()
    last_known = 0.0
    for index in range(filled.shape[0]):
        if np.isnan(filled[index]):
            filled[index] = last_known
        else:
            last_known = filled[index]
    return filled

def reference_segments(recording: Recording, max_gap_ns: int) -> list[np.ndarray]:
    timestamps = recording.timestamps_ns
    labels = recording.raw_labels
    row_count = timestamps.shape[0]

    boundaries = [0]
    for index in range(1, row_count):
        gap = timestamps[index] - timestamps[index - 1]
        if gap > max_gap_ns or labels[index] != labels[index - 1]:
            boundaries.append(index)
    boundaries.append(row_count)

    return [np.arange(boundaries[i], boundaries[i + 1]) for i in range(len(boundaries) - 1)]

def reference_build_windows(recording: Recording, config: WindowConfig) -> list[Window]:
    window_ns = int(round(config.window_ms * MS_TO_NS))
    stride_ns = int(round(config.stride_ms * MS_TO_NS))
    max_gap_ns = int(round(config.max_gap_ms * MS_TO_NS))

    windows: list[Window] = []
    for segment in reference_segments(recording, max_gap_ns):
        if segment.shape[0] < config.min_samples_per_window:
            continue
        segment_timestamps = recording.timestamps_ns[segment]
        label = str(recording.raw_labels[segment[0]])
        segment_start_ns = int(segment_timestamps[0])
        segment_end_ns = int(segment_timestamps[-1])

        window_start_ns = segment_start_ns
        while window_start_ns + window_ns <= segment_end_ns:
            window_end_ns = window_start_ns + window_ns
            in_window = segment[
                (segment_timestamps >= window_start_ns) & (segment_timestamps <= window_end_ns)
            ]
            if in_window.shape[0] >= config.min_samples_per_window:
                windows.append(
                    Window(
                        session_id=recording.session_id,
                        label=label,
                        start_ns=window_start_ns,
                        end_ns=window_end_ns,
                        row_indices=in_window,
                    )
                )
            window_start_ns += stride_ns

    return windows

def reference_load_recording(path: str | Path) -> Recording:
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    all_lines = text.splitlines()
    if not all_lines:
        raise CsvFormatError(f"{path}: empty file")

    body_lines, comment_count = _strip_leading_comments(all_lines)
    if not body_lines:
        raise CsvFormatError(f"{path}: no header found after {comment_count} leading comment line(s)")

    header_line = body_lines[0]
    header = next(csv.reader([header_line]))
    if tuple(header) != HEADER_COLUMNS:
        raise CsvFormatError(
            f"{path}: header does not match the Milestone 9 dataset export contract.\n"
            f"  expected: {','.join(HEADER_COLUMNS)}\n"
            f"  actual:   {header_line}"
        )

    data_rows = body_lines[1:]
    row_count = len(data_rows)
    if row_count == 0:
        raise CsvFormatError(f"{path}: header present but no data rows")

    timestamps_ns = np.empty(row_count, dtype=np.int64)
    channels: dict[str, list[float]] = {column: [] for column in NUMERIC_COLUMNS}
    raw_labels = np.empty(row_count, dtype=object)

    header_index = {name: index for index, name in enumerate(header)}
    previous_timestamp_ns: int | None = None

    reader = csv.reader(data_rows)
    for row_offset, fields in enumerate(reader):
        line_number = comment_count + 2 + row_offset  # +1 header, +1 for 1-indexing
        if len(fields) != len(HEADER_COLUMNS):
            raise CsvFormatError(
                f"{path}:{line_number}: expected {len(HEADER_COLUMNS)} columns, got {len(fields)}"
            )

        timestamp_field = fields[header_index[TIMESTAMP_COLUMN]]
        try:
            timestamp_ns = int(timestamp_field)
        except ValueError as exc:
            raise CsvFormatError(
                f"{path}:{line_number}: malformed {TIMESTAMP_COLUMN!r} value {timestamp_field!r}"
            ) from exc

        if previous_timestamp_ns is not None and timestamp_ns < previous_timestamp_ns:
            raise CsvFormatError(
                f"{path}:{line_number}: out-of-order timestamp {timestamp_ns} follows {previous_timestamp_ns}; "
                "dataset exports must preserve recording order"
            )
        previous_timestamp_ns = timestamp_ns
        timestamps_ns[row_offset] = timestamp_ns

        for column in NUMERIC_COLUMNS:
            raw_value = fields[header_index[column]]
            if raw_value == "":
                channels[column].append(float("nan"))
                continue
            try:
                channels[column].append(float(raw_value))
            except ValueError as exc:
                raise CsvFormatError(
                    f"{path}:{line_number}: malformed {column!r} value {raw_value!r}"
                ) from exc

        label = fields[header_index[LABEL_COLUMN]]
        if not label:
            raise CsvFormatError(f"{path}:{line_number}: missing {LABEL_COLUMN!r} value")
        raw_labels[row_offset] = label

    # Sequence numbers come from independent per-channel counters on the
    # recorder side (orientation vs. PPG batches), so they are not globally
    # monotonic; this loader does not use them.

    filled_channels = {column: reference_carry_forward(np.array(values, dtype=np.float64)) for column, values in channels.items()}

    return Recording(
        session_id=path.stem,
        source_path=path,
        timestamps_ns=timestamps_ns,
        channels=filled_channels,
        raw_labels=raw_labels,
    )
