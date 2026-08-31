"""Synthetic CSV fixtures matching the Milestone 9 dataset-recorder contract.

No real user data: every row is generated from simple deterministic formulas
(sine waves plus a per-label bias) so tests are fast, reproducible, and never
touch sensor captures.
"""

from __future__ import annotations

import math
from pathlib import Path

from pinch_classifier.schema import HEADER_COLUMNS

SAMPLE_INTERVAL_NS = 20_000_000  # 20 ms => 50 Hz, matching watch orientation cadence


def make_dataset_csv(
    tmp_path: Path,
    filename: str,
    label: str,
    row_count: int,
    *,
    start_ns: int = 0,
    accel_bias: float = 0.0,
    gap_after_row: int | None = None,
    gap_ns: int = 500_000_000,
    started_at_iso: str = "2026-08-30T00:00:00.000Z",
) -> Path:
    """Writes a synthetic dataset CSV with one uniform label, mirroring generateDatasetCsv()."""
    lines = [
        "# gesture-dataset-export: 1",
        f"# label: {label}",
        f"# started_at: {started_at_iso}",
        f"# row_count: {row_count}",
        ",".join(HEADER_COLUMNS),
    ]

    timestamp_ns = start_ns
    for row_index in range(row_count):
        phase = row_index * 0.3
        ppg_green = 1000.0 + 10.0 * math.sin(phase)
        ppg_red = 900.0 + 10.0 * math.sin(phase + 0.5)
        ppg_ir = 800.0 + 10.0 * math.sin(phase + 1.0)
        accel_x = accel_bias + 0.05 * math.sin(phase)
        accel_y = 0.02 * math.cos(phase)
        accel_z = 9.8
        gyro_x = 0.01 * math.sin(phase)
        gyro_y = 0.01 * math.cos(phase)
        gyro_z = 0.0
        quat_w, quat_x, quat_y, quat_z = 1.0, 0.0, 0.0, 0.0

        fields = [
            str(timestamp_ns),
            str(row_index),
            f"{ppg_green:.4f}",
            f"{ppg_red:.4f}",
            f"{ppg_ir:.4f}",
            f"{accel_x:.4f}",
            f"{accel_y:.4f}",
            f"{accel_z:.4f}",
            f"{gyro_x:.4f}",
            f"{gyro_y:.4f}",
            f"{gyro_z:.4f}",
            f"{quat_w:.4f}",
            f"{quat_x:.4f}",
            f"{quat_y:.4f}",
            f"{quat_z:.4f}",
            "3",
            label,
        ]
        lines.append(",".join(fields))

        if gap_after_row is not None and row_index == gap_after_row:
            timestamp_ns += gap_ns
        else:
            timestamp_ns += SAMPLE_INTERVAL_NS

    path = tmp_path / filename
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
