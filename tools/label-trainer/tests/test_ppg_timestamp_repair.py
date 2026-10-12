"""Recordings from watch builds that sent the pulse sensor's millisecond timestamps as nanoseconds are put right on loading
for training (`csv_io.repair_millisecond_ppg_timestamps`), and correct recordings are left exactly as they are."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from label_trainer.csv_io import load_recording, repair_millisecond_ppg_timestamps
from label_trainer.schema import IMU_FILE, IMU_FILE_COLUMNS, PPG_FILE, PPG_FILE_COLUMNS

MS = 1_000_000
PPG_PERIOD_MS = 40  # 25 Hz
FLUSH_MS = 100
ARRIVAL_DELAY_MS = 5


def _write_folder(folder: Path, ppg: list[tuple[int, float]], imu_stamps: list[int]) -> Path:
    folder.mkdir()
    ppg_lines = [",".join(PPG_FILE_COLUMNS)] + [f"{t},{i},{v},{v + 1},{v + 2},0,x" for i, (t, v) in enumerate(ppg)]
    imu_lines = [",".join(IMU_FILE_COLUMNS)] + [f"{t},{i},0,0,1,0,0,0,1,0,0,0,x" for i, t in enumerate(imu_stamps)]
    (folder / PPG_FILE).write_text("\n".join(ppg_lines) + "\n")
    (folder / IMU_FILE).write_text("\n".join(imu_lines) + "\n")
    return folder


def _pulse(seconds: float, legacy: bool) -> tuple[list[tuple[int, float]], dict[float, int]]:
    """25 Hz pulse samples delivered in 100 ms batches, each sample's value its true time in ms. With `legacy`, stamped as
    the desktop stamped them when the watch sent milliseconds: the batch's last sample at its arrival, the others before it
    by their spacing in milliseconds read as nanoseconds. Also returns each value's true time."""
    true_ms = [7 + PPG_PERIOD_MS * k for k in range(int(seconds * 1000 / PPG_PERIOD_MS))]
    rows: list[tuple[int, float]] = []
    truth: dict[float, int] = {}
    for tick in range(FLUSH_MS, int(seconds * 1000) + FLUSH_MS, FLUSH_MS):
        batch = [t for t in true_ms if tick - FLUSH_MS < t <= tick]
        if not batch:
            continue
        arrival_ns = (tick + ARRIVAL_DELAY_MS) * MS
        for t in batch:
            spacing = (batch[-1] - t) * (1 if legacy else MS)
            rows.append((arrival_ns - spacing, float(t)))
            truth[float(t)] = t * MS
    return rows, truth


def _imu(seconds: float) -> list[int]:
    return [3 * MS + 20 * MS * k for k in range(int(seconds * 1000 / 20))]


def test_a_millisecond_recording_gets_its_pulse_spacing_back(tmp_path):
    ppg, truth = _pulse(3.0, legacy=True)
    recording = repair_millisecond_ppg_timestamps(load_recording(_write_folder(tmp_path / "old", ppg, _imu(3.0))))

    rows = np.flatnonzero(recording.ppg_observed)
    stamps = recording.timestamps_ns[rows]
    values = recording.channels["ppg_green"][rows]
    # Inside a batch the samples are 40 ms apart again; each sits after its true time by only its batch's delivery delay.
    offsets = np.array([stamp - truth[value] for stamp, value in zip(stamps, values)])
    assert offsets.min() >= ARRIVAL_DELAY_MS * MS
    assert offsets.max() <= (ARRIVAL_DELAY_MS + FLUSH_MS) * MS
    assert np.diff(stamps).min() > MS, "no two pulse samples are squeezed together any more"
    assert (np.diff(recording.timestamps_ns) >= 0).all()
    # The values go with their own samples, and the motion rows are where they were.
    assert list(values) == sorted(values)
    assert list(recording.timestamps_ns[recording.orient_observed]) == _imu(3.0)


def test_carried_values_are_filled_again_in_the_new_order(tmp_path):
    ppg, _ = _pulse(1.0, legacy=True)
    recording = repair_millisecond_ppg_timestamps(load_recording(_write_folder(tmp_path / "old", ppg, _imu(1.0))))
    green = recording.channels["ppg_green"]
    last_real = None
    for i in range(green.shape[0]):
        if recording.ppg_observed[i]:
            last_real = green[i]
        elif last_real is not None:
            assert green[i] == last_real, "a motion row carries the latest pulse value taken before it"


def test_a_correct_recording_is_left_alone(tmp_path):
    ppg, _ = _pulse(3.0, legacy=False)
    loaded = load_recording(_write_folder(tmp_path / "new", ppg, _imu(3.0)))
    assert repair_millisecond_ppg_timestamps(loaded) is loaded


def test_a_recording_without_pulse_samples_is_left_alone(tmp_path):
    loaded = load_recording(_write_folder(tmp_path / "imu_only", [], _imu(1.0)))
    assert repair_millisecond_ppg_timestamps(loaded) is loaded
