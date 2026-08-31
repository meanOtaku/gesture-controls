from __future__ import annotations

import pytest

from pinch_classifier.csv_io import CsvFormatError, load_recording

from .conftest import make_dataset_csv


def test_loads_valid_export(tmp_path):
    path = make_dataset_csv(tmp_path, "session_a.csv", "idle", row_count=20)
    recording = load_recording(path)

    assert recording.session_id == "session_a"
    assert recording.timestamps_ns.shape[0] == 20
    assert (recording.raw_labels == "idle").all()
    assert list(recording.channels.keys())


def test_skips_leading_comment_lines(tmp_path):
    path = make_dataset_csv(tmp_path, "session_b.csv", "pinch_start", row_count=5)
    text = path.read_text(encoding="utf-8")
    assert text.startswith("# gesture-dataset-export: 1")
    recording = load_recording(path)
    assert recording.timestamps_ns.shape[0] == 5


def test_rejects_bad_header(tmp_path):
    path = tmp_path / "bad_header.csv"
    path.write_text("# gesture-dataset-export: 1\ntimestamp_ns,label\n1,idle\n", encoding="utf-8")
    with pytest.raises(CsvFormatError, match="header does not match"):
        load_recording(path)


def test_rejects_out_of_order_timestamps(tmp_path):
    path = make_dataset_csv(tmp_path, "session_c.csv", "idle", row_count=5)
    lines = path.read_text(encoding="utf-8").splitlines()
    # Swap two data rows to break strict ordering.
    header_end = next(i for i, line in enumerate(lines) if line.startswith("timestamp_ns")) + 1
    lines[header_end], lines[header_end + 1] = lines[header_end + 1], lines[header_end]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(CsvFormatError, match="out-of-order timestamp"):
        load_recording(path)


def test_rejects_unknown_label(tmp_path):
    path = make_dataset_csv(tmp_path, "session_d.csv", "idle", row_count=3)
    text = path.read_text(encoding="utf-8").replace(",idle", ",not_a_real_label")
    path.write_text(text, encoding="utf-8")
    with pytest.raises(CsvFormatError, match="unknown label"):
        load_recording(path)


def test_carry_forward_fills_missing_values_causally(tmp_path):
    path = make_dataset_csv(tmp_path, "session_e.csv", "idle", row_count=5)
    lines = path.read_text(encoding="utf-8").splitlines()
    header_end = next(i for i, line in enumerate(lines) if line.startswith("timestamp_ns")) + 1
    fields = lines[header_end + 2].split(",")
    fields[2] = ""  # blank ppg_green on row index 2
    lines[header_end + 2] = ",".join(fields)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    recording = load_recording(path)
    assert recording.channels["ppg_green"][2] == recording.channels["ppg_green"][1]
