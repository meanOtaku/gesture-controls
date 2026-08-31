"""Loads Milestone 9 dataset-recorder CSV exports into arrays ready for windowing.

Each input file is treated as one recording session: the recorder snapshots a
single label for the whole session, and rows arrive in receipt order from the
watch bridge. We validate that contract on load so a bad export fails loudly
instead of silently corrupting a training run.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .schema import (
    GESTURE_DATASET_LABELS,
    HEADER_COLUMNS,
    LABEL_COLUMN,
    METADATA_COMMENT_PREFIX,
    NUMERIC_COLUMNS,
    TIMESTAMP_COLUMN,
)


class CsvFormatError(ValueError):
    """Raised when a CSV export does not match the recorder's stable contract."""


@dataclass(frozen=True)
class Recording:
    """One parsed CSV export: a single session, timestamp-ordered, carry-forward filled.

    `session_id` is the group key used later for grouped holdout splits, so
    windows from the same file never appear in both train and test.
    """

    session_id: str
    source_path: Path
    timestamps_ns: np.ndarray  # int64, strictly non-decreasing
    channels: dict[str, np.ndarray]  # column name -> float64 array, carry-forward filled
    raw_labels: np.ndarray  # str array, one label per row (as recorded)


def _strip_leading_comments(lines: list[str]) -> tuple[list[str], int]:
    """Returns (remaining_lines, leading_comment_count)."""
    index = 0
    while index < len(lines) and lines[index].lstrip().startswith(METADATA_COMMENT_PREFIX):
        index += 1
    return lines[index:], index


def load_recording(path: str | Path) -> Recording:
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
        if label not in GESTURE_DATASET_LABELS:
            raise CsvFormatError(f"{path}:{line_number}: unknown label {label!r}")
        raw_labels[row_offset] = label

    # Sequence numbers come from independent per-channel counters on the
    # recorder side (orientation vs. PPG batches), so they are not globally
    # monotonic; this loader does not use them.

    filled_channels = {column: _carry_forward(np.array(values, dtype=np.float64)) for column, values in channels.items()}

    return Recording(
        session_id=path.stem,
        source_path=path,
        timestamps_ns=timestamps_ns,
        channels=filled_channels,
        raw_labels=raw_labels,
    )


def _carry_forward(values: np.ndarray) -> np.ndarray:
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


def load_recordings(paths: list[str | Path]) -> list[Recording]:
    return [load_recording(path) for path in paths]
