"""Mirrors the Milestone 9 desktop dataset recorder's CSV contract.

Source of truth: apps/desktop/src/features/telemetry/store/telemetryStore.ts
(`DATASET_CSV_COLUMNS`, `GESTURE_DATASET_LABELS`, `generateDatasetCsv`). Keep
this file in sync if that contract changes.
"""

from __future__ import annotations

# Exact column order written by generateDatasetCsv(). A header line must match
# this exactly (case-sensitive, same order) or the file is rejected.
HEADER_COLUMNS: tuple[str, ...] = (
    "timestamp_ns",
    "sequence",
    "ppg_green",
    "ppg_red",
    "ppg_ir",
    "accel_x",
    "accel_y",
    "accel_z",
    "gyro_x",
    "gyro_y",
    "gyro_z",
    "quat_w",
    "quat_x",
    "quat_y",
    "quat_z",
    "contact_quality",
    "label",
)

TIMESTAMP_COLUMN = "timestamp_ns"
SEQUENCE_COLUMN = "sequence"
LABEL_COLUMN = "label"

# Numeric columns that carry sensor values and may be blank (missing) in any
# given row. Excludes timestamp_ns/sequence (always required) and label.
NUMERIC_COLUMNS: tuple[str, ...] = tuple(
    column for column in HEADER_COLUMNS if column not in (TIMESTAMP_COLUMN, SEQUENCE_COLUMN, LABEL_COLUMN)
)

PPG_COLUMNS: tuple[str, ...] = ("ppg_green", "ppg_red", "ppg_ir")
ACCEL_COLUMNS: tuple[str, ...] = ("accel_x", "accel_y", "accel_z")
GYRO_COLUMNS: tuple[str, ...] = ("gyro_x", "gyro_y", "gyro_z")
QUAT_COLUMNS: tuple[str, ...] = ("quat_w", "quat_x", "quat_y", "quat_z")
CONTACT_QUALITY_COLUMN = "contact_quality"

# Full label set the recorder can emit (GESTURE_DATASET_LABELS). Any label
# outside this set fails validation, since it likely means a hand-edited or
# out-of-contract CSV.
GESTURE_DATASET_LABELS: tuple[str, ...] = (
    "idle",
    "pinch_start",
    "pinch_hold",
    "pinch_release",
    "walking",
    "typing",
    "using_mouse",
    "touching_face",
    "adjusting_headphones",
    "picking_up_cup",
    "scratching",
    "normal_wrist_rotation",
    "standing",
    "sitting",
)

PINCH_START_LABEL = "pinch_start"
PINCH_HOLD_LABEL = "pinch_hold"
PINCH_RELEASE_LABEL = "pinch_release"

METADATA_COMMENT_PREFIX = "#"
