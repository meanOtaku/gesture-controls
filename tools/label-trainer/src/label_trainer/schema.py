"""Mirrors the Milestone 9 desktop dataset recorder's CSV contract.

Source of truth: apps/desktop/src/features/telemetry/store/telemetryStore.ts
(`DATASET_CSV_COLUMNS`, `GESTURE_DATASET_LABELS`, `generateDatasetCsv`). Keep
this file in sync if that contract changes.
"""

from __future__ import annotations

# The single file's columns before manual labels existed. Still read: a header line must match this or
# `HEADER_COLUMNS_V2` exactly (case-sensitive, same order) or the file is rejected.
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

# A label given by hand on the desktop's Labelling page. Where a row has one, it is the row's label whatever `label` (from
# the recorder or the camera) says, and `NO_LABEL` there means the row has no label (see `csv_io.effective_label`).
MANUAL_LABEL_COLUMN = "manual_label"
NO_LABEL = "-"
# Exact column order the desktop writes now (`generateDatasetCsv()`, the Labelling page's export): the above, then the manual
# label.
HEADER_COLUMNS_V2: tuple[str, ...] = (*HEADER_COLUMNS, MANUAL_LABEL_COLUMN)

# A recording can also be a folder of two dense files, one for each sensor, with a row only where that sensor had a sample
# (see `csv_io.load_recording`). The columns are the single file's, without the other sensor's.
PPG_FILE = "ppg.csv"
IMU_FILE = "imu.csv"
META_FILE = "dataset.json"
PPG_FILE_COLUMNS: tuple[str, ...] = ("timestamp_ns", "sequence", "ppg_green", "ppg_red", "ppg_ir", "contact_quality", "label")
IMU_FILE_COLUMNS: tuple[str, ...] = (
    "timestamp_ns", "sequence", "accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z",
    "quat_w", "quat_x", "quat_y", "quat_z", "label",
)
# The same with the manual label, as the desktop writes them now.
PPG_FILE_COLUMNS_V2: tuple[str, ...] = (*PPG_FILE_COLUMNS, MANUAL_LABEL_COLUMN)
IMU_FILE_COLUMNS_V2: tuple[str, ...] = (*IMU_FILE_COLUMNS, MANUAL_LABEL_COLUMN)

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

# The legacy fixed label vocabulary the recorder used to emit before per-label
# training roles existed (M1-B). This is no longer an authoritative allowlist
# for CSV loading (see csv_io.load_recording): collection labels are now
# user-defined, so any non-empty label is structurally valid here. This tuple
# now only backs `labels.legacy_compatibility_mapping()`, the explicit
# compatibility mapping for CSVs recorded against this original vocabulary.
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
