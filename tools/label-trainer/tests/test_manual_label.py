"""Manual labels from the desktop's Labelling page: where a row has one, it is the label the row trains on."""

from __future__ import annotations

from pathlib import Path

from label_trainer.csv_io import effective_label, load_recording
from label_trainer.schema import (
    HEADER_COLUMNS,
    HEADER_COLUMNS_V2,
    IMU_FILE_COLUMNS,
    IMU_FILE_COLUMNS_V2,
    NO_LABEL,
    PPG_FILE_COLUMNS,
    PPG_FILE_COLUMNS_V2,
)


def test_a_manual_label_wins_and_a_dash_means_nothing_here() -> None:
    assert effective_label("pinch", "") == "pinch"
    assert effective_label("pinch", "fist") == "fist"
    assert effective_label("pinch", NO_LABEL) == ""
    assert effective_label("", "fist") == "fist"


def test_a_single_file_with_manual_labels_trains_on_them(tmp_path: Path) -> None:
    path = tmp_path / "labelled.csv"
    path.write_text("\n".join([
        ",".join(HEADER_COLUMNS_V2),
        "100,1,10,20,30,,,,,,,,,,,0,pinch,fist",
        "120,2,,,,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,,pinch,-",
        "140,3,11,21,31,,,,,,,,,,,0,,pinch",
        "160,4,12,22,32,,,,,,,,,,,0,pinch,",
    ]) + "\n")
    assert load_recording(path).raw_labels.tolist() == ["fist", "", "pinch", "pinch"]


def test_a_folder_of_either_format_trains_on_the_manual_labels(tmp_path: Path) -> None:
    new = tmp_path / "new"
    new.mkdir()
    (new / "ppg.csv").write_text(",".join(PPG_FILE_COLUMNS_V2) + "\n100,1,5,6,7,0,pinch,fist\n140,3,5,6,7,0,pinch,\n")
    (new / "imu.csv").write_text(",".join(IMU_FILE_COLUMNS_V2) + "\n120,2,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,pinch,-\n")
    assert load_recording(new).raw_labels.tolist() == ["fist", "", "pinch"]
    old = tmp_path / "old"
    old.mkdir()
    (old / "ppg.csv").write_text(",".join(PPG_FILE_COLUMNS) + "\n100,1,5,6,7,0,pinch\n")
    (old / "imu.csv").write_text(",".join(IMU_FILE_COLUMNS) + "\n120,2,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,pinch\n")
    assert load_recording(old).raw_labels.tolist() == ["pinch", "pinch"]
    # A file from before manual labels is read as it always was.
    single = tmp_path / "old.csv"
    single.write_text(",".join(HEADER_COLUMNS) + "\n100,1,10,20,30,,,,,,,,,,,0,pinch\n")
    assert load_recording(single).raw_labels.tolist() == ["pinch"]
