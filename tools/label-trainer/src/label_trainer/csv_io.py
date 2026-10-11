"""Loads Milestone 9 dataset-recorder CSV exports into arrays ready for windowing.

Each input file is treated as one recording session: the recorder snapshots a
single label for the whole session, and rows arrive in receipt order from the
watch bridge. We validate that contract on load so a bad export fails loudly
instead of silently corrupting a training run.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np

from .schema import (
    HEADER_COLUMNS,
    IMU_FILE,
    IMU_FILE_COLUMNS,
    LABEL_COLUMN,
    METADATA_COMMENT_PREFIX,
    NUMERIC_COLUMNS,
    PPG_FILE,
    PPG_FILE_COLUMNS,
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
    # True on rows that carried a real PPG sample (the others are orientation rows, whose PPG values are carried forward).
    # None for a recording built by hand, which counts every row.
    ppg_observed: np.ndarray | None = None
    # True on rows that carried a real orientation sample (orientation, acceleration and gyroscope arrive together); the PPG
    # rows have none, and carry the last one forward. None for a recording built by hand, which counts every row.
    orient_observed: np.ndarray | None = None

    @cached_property
    def channel_matrix(self) -> np.ndarray:
        """All numeric channels stacked as a C-contiguous float64 array, one row per entry of
        `NUMERIC_COLUMNS`. Lets a window's statistics be computed with a handful of array
        reductions over a single slice instead of one numpy call per channel per statistic.
        Built once per recording; the dataclass is frozen but `cached_property` writes straight
        to the instance `__dict__`, which is allowed.
        """
        return np.ascontiguousarray(np.stack([self.channels[column] for column in NUMERIC_COLUMNS]))


def _strip_leading_comments(lines: list[str]) -> tuple[list[str], int]:
    """Returns (remaining_lines, leading_comment_count)."""
    index = 0
    while index < len(lines) and lines[index].lstrip().startswith(METADATA_COMMENT_PREFIX):
        index += 1
    return lines[index:], index


def _float_or_nan(raw_value: str) -> float:
    return float("nan") if raw_value == "" else float(raw_value)


def _parse_rows_fast(
    data_rows: list[str], header_index: dict[str, int]
) -> tuple[np.ndarray, dict[str, np.ndarray], np.ndarray] | None:
    """Parses a fully valid document in bulk, or returns None if anything is irregular.

    "Irregular" is anything the checked loop would reject: a row with the wrong number of
    fields, a non-integer timestamp, a timestamp that goes backwards, a non-numeric value,
    or an empty label. Returning None (never raising) keeps this an optimization only.
    """
    try:
        rows = list(csv.reader(data_rows))
        width = len(HEADER_COLUMNS)
        if any(len(fields) != width for fields in rows):
            return None
        columns = list(zip(*rows))
        timestamps_ns = np.array(list(map(int, columns[header_index[TIMESTAMP_COLUMN]])), dtype=np.int64)
        if timestamps_ns.shape[0] > 1 and bool((timestamps_ns[1:] < timestamps_ns[:-1]).any()):
            return None
        channel_values = {
            column: np.array(list(map(_float_or_nan, columns[header_index[column]])), dtype=np.float64)
            for column in NUMERIC_COLUMNS
        }
        labels = columns[header_index[LABEL_COLUMN]]
        if not all(labels):
            return None
        raw_labels = np.empty(len(labels), dtype=object)
        raw_labels[:] = labels
        return timestamps_ns, channel_values, raw_labels
    except (ValueError, OverflowError):
        return None


def _file_rows(path: Path, expected: tuple[str, ...]) -> list[tuple[int, int, list[str]]]:
    """The data rows of one of a folder's files as (timestamp, which file, fields), after checking its header."""
    if not path.is_file():
        raise CsvFormatError(f"{path.parent}: the folder has no {path.name}: a recording folder holds {PPG_FILE} and {IMU_FILE}")
    lines = path.read_text(encoding="utf-8").splitlines()
    body, comments = _strip_leading_comments(lines)
    if not body:
        raise CsvFormatError(f"{path}: no header found")
    header = next(csv.reader([body[0]]))
    if tuple(header) != expected:
        raise CsvFormatError(f"{path}: header is not the one this file must have.\n  expected: {','.join(expected)}\n  actual:   {body[0]}")
    which = 0 if path.name == PPG_FILE else 1
    rows = []
    for offset, fields in enumerate(csv.reader(body[1:])):
        if len(fields) != len(expected):
            raise CsvFormatError(f"{path}:{comments + 2 + offset}: expected {len(expected)} columns, got {len(fields)}")
        try:
            stamp = int(fields[0])
        except ValueError as exc:
            raise CsvFormatError(f"{path}:{comments + 2 + offset}: malformed {TIMESTAMP_COLUMN!r} value {fields[0]!r}") from exc
        rows.append((stamp, which, fields))
    return rows


def _merge_folder(folder: Path) -> str:
    """A recording folder (`ppg.csv` and `imu.csv`) as the text of the single-file dataset it stands for: every row of both,
    in timestamp order (a tie puts the pulse row first), each with the other sensor's columns empty."""
    ppg = _file_rows(folder / PPG_FILE, PPG_FILE_COLUMNS)
    imu = _file_rows(folder / IMU_FILE, IMU_FILE_COLUMNS)
    for rows, name in ((ppg, PPG_FILE), (imu, IMU_FILE)):
        for before, after in zip(rows, rows[1:]):
            if after[0] < before[0]:
                raise CsvFormatError(f"{folder / name}: out-of-order timestamp {after[0]} follows {before[0]}")
    merged: list[tuple[int, int, str]] = []
    for stamp, _, f in ppg:
        merged.append((stamp, 0, ",".join([f[0], f[1], f[2], f[3], f[4], *([""] * 10), f[5], f[6]])))
    for stamp, _, f in imu:
        merged.append((stamp, 1, ",".join([f[0], f[1], "", "", "", *f[2:12], "", f[12]])))
    merged.sort(key=lambda row: (row[0], row[1]))
    return "\n".join([",".join(HEADER_COLUMNS), *(line for _, _, line in merged)]) + "\n"


def load_recording(path: str | Path) -> Recording:
    path = Path(path)
    text = _merge_folder(path) if path.is_dir() else path.read_text(encoding="utf-8")
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

    header_index = {name: index for index, name in enumerate(header)}

    # Fast path: C-level csv parsing and per-column conversion. It accepts only a
    # document that satisfies the whole contract; on *any* irregularity it declines
    # and the checked row-by-row path below runs instead, so every error message
    # (with its line number) is produced by exactly the code that always produced it.
    fast = _parse_rows_fast(data_rows, header_index)
    if fast is not None:
        timestamps_ns, channel_values, raw_labels = fast
        return Recording(
            session_id=path.stem,
            source_path=path,
            timestamps_ns=timestamps_ns,
            channels={column: _carry_forward(values) for column, values in channel_values.items()},
            raw_labels=raw_labels,
            ppg_observed=~np.isnan(channel_values["ppg_green"]),
            orient_observed=~np.isnan(channel_values["quat_w"]),
        )

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

    filled_channels = {column: _carry_forward(np.array(values, dtype=np.float64)) for column, values in channels.items()}

    return Recording(
        session_id=path.stem,
        source_path=path,
        timestamps_ns=timestamps_ns,
        channels=filled_channels,
        raw_labels=raw_labels,
        ppg_observed=~np.isnan(np.array(channels["ppg_green"], dtype=np.float64)),
        orient_observed=~np.isnan(np.array(channels["quat_w"], dtype=np.float64)),
    )


def _carry_forward(values: np.ndarray) -> np.ndarray:
    """Forward-fills NaNs from the last known (past) sample only — never from the future.

    Leading NaNs (no prior sample yet) fall back to 0.0. This is a documented
    limitation: the first stretch of a session before any real sample arrives
    is treated as zero rather than dropped.

    Vectorized: each position takes the value at the most recent non-NaN index at or
    before it (found with a running maximum), which is exactly what a left-to-right
    "remember the last known value" loop produces, without a Python-level loop over rows.
    """
    filled = values.copy()
    is_nan = np.isnan(filled)
    if not is_nan.any():
        return filled
    last_known_index = np.where(is_nan, -1, np.arange(filled.shape[0]))
    np.maximum.accumulate(last_known_index, out=last_known_index)
    has_prior = last_known_index >= 0
    filled[:] = np.where(has_prior, filled[np.maximum(last_known_index, 0)], 0.0)
    return filled


def load_recordings(paths: list[str | Path]) -> list[Recording]:
    return [load_recording(path) for path in paths]
