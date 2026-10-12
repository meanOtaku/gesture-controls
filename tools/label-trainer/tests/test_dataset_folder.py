"""A recording as a folder of two dense files loads as exactly the single-file dataset it stands for."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from label_trainer.csv_io import CsvFormatError, load_recording
from label_trainer.schema import HEADER_COLUMNS, IMU_FILE_COLUMNS, PPG_FILE_COLUMNS


def single_file(tmp_path: Path, rows: int = 60) -> Path:
    """A session like the watch makes: a pulse row every third row, motion rows between, never both on one row."""
    rng = np.random.default_rng(1)
    lines = ["# gesture-dataset-export: 1", ",".join(HEADER_COLUMNS)]
    for i in range(rows):
        t = 1_000_000_000 + i * 20_000_000
        label = "pinch" if (i // 10) % 2 == 0 else "idle"
        if i % 3 == 0:
            ppg = [f"{v:.1f}" for v in rng.normal(100_000, 500, 3)]
            lines.append(",".join([str(t), str(i), *ppg, *([""] * 10), "0", label]))
        else:
            imu = [f"{v:.4f}" for v in rng.normal(0, 1, 10)]
            lines.append(",".join([str(t), str(i), "", "", "", *imu, "", label]))
    path = tmp_path / "single.csv"
    path.write_text("\n".join(lines) + "\n")
    return path


def split(path: Path, folder: Path) -> None:
    """The two files a single file stands for (the trainer's side of what the desktop's `split_legacy` does)."""
    folder.mkdir()
    ppg, imu = [",".join(PPG_FILE_COLUMNS)], [",".join(IMU_FILE_COLUMNS)]
    for line in path.read_text().splitlines()[2:]:
        f = line.split(",")
        if any(f[2:5]):
            ppg.append(",".join([f[0], f[1], *f[2:5], f[15], f[16]]))
        if any(f[5:15]):
            imu.append(",".join([f[0], f[1], *f[5:15], f[16]]))
    (folder / "ppg.csv").write_text("\n".join(ppg) + "\n")
    (folder / "imu.csv").write_text("\n".join(imu) + "\n")
    (folder / "dataset.json").write_text(json.dumps({"formatVersion": 1}))


def test_a_folder_loads_as_exactly_the_single_file_it_was_made_from(tmp_path: Path) -> None:
    file = single_file(tmp_path)
    folder = tmp_path / "recording"
    split(file, folder)
    a, b = load_recording(file), load_recording(folder)
    assert np.array_equal(a.timestamps_ns, b.timestamps_ns)
    assert list(a.raw_labels) == list(b.raw_labels)
    assert np.array_equal(a.ppg_observed, b.ppg_observed) and np.array_equal(a.orient_observed, b.orient_observed)
    for column in a.channels:
        assert np.array_equal(a.channels[column], b.channels[column]), column
    assert b.session_id == "recording" and b.source_path == folder


def test_a_converted_older_export_with_fused_rows_gives_the_same_features_as_the_file(tmp_path: Path) -> None:
    # Older exports put both sensors on one row; the conversion writes such a row into both files. Read back, it must be one
    # row again, or carry-forward and orientation deltas change while the recording keeps the old file's identity.
    from label_trainer.features import extract_features
    from label_trainer.windowing import WindowConfig, build_windows

    rng = np.random.default_rng(3)
    lines = ["# gesture-dataset-export: 1", ",".join(HEADER_COLUMNS)]
    for i in range(80):
        t = 1_000_000_000 + i * 20_000_000
        label = "pinch" if (i // 20) % 2 == 0 else "idle"
        ppg = [f"{v:.1f}" for v in rng.normal(100_000, 500, 3)]
        imu = [f"{v:.4f}" for v in rng.normal(0, 1, 10)]
        if i % 2 == 0:  # fused: both sensors on one row
            lines.append(",".join([str(t), str(i), *ppg, *imu, "0", label]))
        else:
            lines.append(",".join([str(t), str(i), "", "", "", *imu, "", label]))
    file = tmp_path / "fused.csv"
    file.write_text("\n".join(lines) + "\n")
    folder = tmp_path / "converted"
    split(file, folder)
    a, b = load_recording(file), load_recording(folder)
    assert len(a.timestamps_ns) == len(b.timestamps_ns) == 80
    assert np.array_equal(a.ppg_observed, b.ppg_observed) and np.array_equal(a.orient_observed, b.orient_observed)
    for column in a.channels:
        assert np.array_equal(a.channels[column], b.channels[column], equal_nan=True), column
    config = WindowConfig(window_ms=200, stride_ms=100, min_samples_per_window=4)
    windows_a, windows_b = build_windows(a, config), build_windows(b, config)
    assert windows_a and len(windows_a) == len(windows_b)
    for wa, wb in zip(windows_a, windows_b):
        assert np.array_equal(extract_features(a, wa), extract_features(b, wb), equal_nan=True)


def test_every_row_of_each_file_has_every_column_filled() -> None:
    # The point of the format: no blank cells in either file.
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        file = single_file(Path(tmp))
        split(file, Path(tmp) / "r")
        for name in ("ppg.csv", "imu.csv"):
            rows = (Path(tmp) / "r" / name).read_text().splitlines()[1:]
            assert rows and all("" not in row.split(",") for row in rows), name


def test_a_tie_puts_the_pulse_row_first_and_a_row_in_both_files_is_a_row_of_each(tmp_path: Path) -> None:
    folder = tmp_path / "tied"
    folder.mkdir()
    (folder / "ppg.csv").write_text(",".join(PPG_FILE_COLUMNS) + "\n100,1,5,6,7,0,pinch\n")
    (folder / "imu.csv").write_text(",".join(IMU_FILE_COLUMNS) + "\n100,2,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,pinch\n")
    recording = load_recording(folder)
    assert recording.timestamps_ns.tolist() == [100, 100]
    assert recording.ppg_observed.tolist() == [True, False] and recording.orient_observed.tolist() == [False, True]


def test_a_folder_with_a_missing_file_a_wrong_header_or_going_backwards_is_refused_with_the_reason(tmp_path: Path) -> None:
    file = single_file(tmp_path)
    folder = tmp_path / "r"
    split(file, folder)
    (folder / "imu.csv").rename(folder / "elsewhere.csv")
    with pytest.raises(CsvFormatError, match="has no imu.csv"):
        load_recording(folder)
    (folder / "elsewhere.csv").rename(folder / "imu.csv")
    (folder / "ppg.csv").write_text("a,b\n1,2\n")
    with pytest.raises(CsvFormatError, match="header is not the one"):
        load_recording(folder)
    split_again = tmp_path / "again"
    split(file, split_again)
    lines = (split_again / "ppg.csv").read_text().splitlines()
    (split_again / "ppg.csv").write_text("\n".join([lines[0], lines[2], lines[1], *lines[3:]]) + "\n")
    with pytest.raises(CsvFormatError, match="out-of-order timestamp"):
        load_recording(split_again)
