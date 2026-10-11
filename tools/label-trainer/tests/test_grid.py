"""The window as a grid (what a convolutional model reads), and that the desktop's Rust copy makes the same numbers.

`fixtures/grid_cases.json` holds synthetic windows (the pulse samples and the orientation samples that arrived) with the
grid this module makes of each. The crate `pinch-inference` reads the same file and must reproduce every number.
Regenerate it after an intended change with `GRID_FIXTURE_REGENERATE=1 uv run pytest tests/test_grid.py`.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import numpy as np
import pytest

from label_trainer.csv_io import Recording, _carry_forward
from label_trainer.features import SPIKE_METHODS
from label_trainer.grid import GRID_CHANNELS, build_grid, channels_for, resample, source_of_channel
from label_trainer.schema import NUMERIC_COLUMNS
from label_trainer.windowing import Window

FIXTURE = Path(__file__).parent / "fixtures" / "grid_cases.json"


def make_window(ppg: dict, orientation: list[dict]) -> tuple[Recording, Window]:
    """A recording whose rows are the pulse samples then the orientation samples, as they would interleave."""
    p, o = len(ppg["timestampsNs"]), len(orientation)
    n = p + o
    data = {column: np.full(n, np.nan) for column in NUMERIC_COLUMNS}
    timestamps = list(ppg["timestampsNs"]) + [
        (ppg["timestampsNs"][0] if p else 0) + int(i * 1e6) for i in range(o)
    ]
    for i in range(p):
        data["ppg_green"][i], data["ppg_red"][i], data["ppg_ir"][i] = ppg["green"][i], ppg["red"][i], ppg["ir"][i]
    for i, sample in enumerate(orientation):
        row = p + i
        for axis, column in enumerate(("accel_x", "accel_y", "accel_z")):
            data[column][row] = sample["accel"][axis]
        for axis, column in enumerate(("gyro_x", "gyro_y", "gyro_z")):
            data[column][row] = sample["gyro"][axis]
        for axis, column in enumerate(("quat_w", "quat_x", "quat_y", "quat_z")):
            data[column][row] = sample["quat"][axis]
    order = np.argsort(np.array(timestamps, dtype=np.int64), kind="stable")
    recording = Recording(
        session_id="s",
        source_path=Path("s.csv"),
        timestamps_ns=np.array(timestamps, dtype=np.int64)[order],
        channels={column: _carry_forward(values[order]) for column, values in data.items()},
        raw_labels=np.array(["x"] * n, dtype=object),
        ppg_observed=~np.isnan(data["ppg_green"][order]),
        orient_observed=~np.isnan(data["quat_w"][order]),
    )
    return recording, Window(session_id="s", label="x", start_ns=0, end_ns=0, row_indices=np.arange(n))


def synthetic(rng: random.Random, p: int, o: int) -> tuple[dict, list[dict]]:
    t0 = 5_000_000_000
    stamps = [t0 + (i // 3) * 105_000_000 + (i % 3) * 40 for i in range(p)]  # three samples a batch, as the watch stamps them
    level = rng.uniform(40000, 60000)
    green, red, ir = [], [], []
    for i in range(p):
        level += rng.gauss(0, 20)
        spike = 700.0 if i == p // 2 else 0.0
        green.append(round(level + spike + rng.gauss(0, 10), 3))
        red.append(round(level * 0.9 + spike * 0.5 + rng.gauss(0, 10), 3))
        ir.append(round(level * 0.8 + rng.gauss(0, 10), 3))
    samples = []
    for i in range(o):
        samples.append({
            "accel": [round(rng.gauss(0, 2), 4) for _ in range(3)],
            "gyro": [round(rng.gauss(0, 0.5), 4) for _ in range(3)],
            "quat": [round(1.0 - 0.001 * i, 5), round(0.01 * i, 5), 0.0, round(rng.gauss(0, 0.01), 5)],
        })
    return {"timestampsNs": stamps, "green": green, "red": red, "ir": ir}, samples


def test_resampling_keeps_the_ends_interpolates_between_and_handles_short_series() -> None:
    assert resample([], 4) == [0.0] * 4
    assert resample([7.0], 3) == [7.0] * 3
    assert resample([0.0, 10.0], 5) == [0.0, 2.5, 5.0, 7.5, 10.0]
    assert resample([1.0, 2.0, 4.0], 3) == [1.0, 2.0, 4.0]


def test_channels_follow_the_streams_and_the_pulse_lights_chosen() -> None:
    assert channels_for(["watchAcceleration"], ["green", "red", "ir"]) == ["accel_x", "accel_y", "accel_z"]
    assert channels_for(["watchPpg"], ["ir", "green"]) == ["ppg_green", "ppg_ir"]
    assert channels_for(["watchPpg", "watchOrientation"], ["red"]) == ["ppg_red", "quat_w", "quat_x", "quat_y", "quat_z"]
    assert [source_of_channel(c) for c in GRID_CHANNELS[:4]] == ["watchPpg"] * 3 + ["watchAcceleration"]


def test_the_grid_is_channel_after_channel_and_uses_only_real_samples() -> None:
    ppg = {"timestampsNs": [1000, 2000, 3000, 4000], "green": [1.0, 2.0, 3.0, 4.0], "red": [0.0] * 4, "ir": [0.0] * 4}
    orientation = [
        {"accel": [1.0, 0.0, 0.0], "gyro": [0.0] * 3, "quat": [1.0, 0.0, 0.0, 0.0]},
        {"accel": [3.0, 0.0, 0.0], "gyro": [0.0] * 3, "quat": [1.0, 0.0, 0.0, 0.0]},
    ]
    recording, window = make_window(ppg, orientation)
    grid = build_grid(recording, window, ["ppg_green", "accel_x"], 4)
    assert grid.shape == (8,)
    assert list(grid[:4]) == [1.0, 2.0, 3.0, 4.0]  # the pulse channel is the 4 pulse samples, not the 6 rows
    assert list(grid[4:]) == pytest.approx([1.0, 1.0 + 2 / 3, 1.0 + 4 / 3, 3.0])  # the 2 orientation samples, stretched


def test_a_window_with_no_orientation_samples_has_zero_motion_channels() -> None:
    ppg, _ = synthetic(random.Random(1), 12, 0)
    recording, window = make_window(ppg, [])
    grid = build_grid(recording, window, ["accel_x", "ppg_green"], 8)
    assert list(grid[:8]) == [0.0] * 8
    assert any(grid[8:])


def _cases() -> list[dict]:
    rng = random.Random(20261012)
    cases = []

    def add(name, ppg, orientation, channels, steps, method):
        recording, window = make_window(ppg, orientation)
        grid = build_grid(recording, window, channels, steps, method)
        cases.append({"name": name, "ppg": ppg, "orientation": orientation, "channels": channels, "steps": steps, "method": method, "expected": [float(v) for v in grid]})

    ppg, orientation = synthetic(rng, 14, 25)
    add("typical_all_channels", ppg, orientation, list(GRID_CHANNELS), 32, None)
    for method in SPIKE_METHODS:
        add(f"typical_{method}", ppg, orientation, ["ppg_green", "ppg_ir", "accel_x", "quat_w"], 16, method)
    ppg, orientation = synthetic(rng, 3, 1)
    add("too_few_samples", ppg, orientation, list(GRID_CHANNELS), 12, None)
    add("too_few_for_a_method", ppg, orientation, ["ppg_green", "gyro_x"], 12, "rolling_median_residual")
    ppg, _ = synthetic(rng, 12, 0)
    add("no_orientation", ppg, [], ["ppg_red", "accel_y"], 16, "morphological_top_hat")
    for index in range(4):
        ppg, orientation = synthetic(rng, rng.choice([5, 9, 13, 20, 31]), rng.choice([2, 7, 26, 40]))
        add(f"random_{index}", ppg, orientation, list(GRID_CHANNELS), rng.choice([8, 24, 32, 64]), rng.choice([None, *SPIKE_METHODS]))
    return cases


def test_the_shared_cases_match_what_this_module_makes() -> None:
    cases = _cases()
    if os.environ.get("GRID_FIXTURE_REGENERATE"):
        FIXTURE.write_text(json.dumps({"channelOrder": list(GRID_CHANNELS), "cases": cases}) + "\n", encoding="utf-8")
    stored = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert stored["channelOrder"] == list(GRID_CHANNELS)
    assert len(stored["cases"]) == len(cases)
    for mine, theirs in zip(cases, stored["cases"]):
        assert mine["name"] == theirs["name"] and mine["ppg"] == theirs["ppg"]
        assert mine["expected"] == pytest.approx(theirs["expected"], abs=1e-9, rel=1e-9), mine["name"]
