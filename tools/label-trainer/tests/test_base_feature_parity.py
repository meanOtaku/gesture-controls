"""The 55 window statistics, and that the desktop's Rust copy makes the same numbers.

`fixtures/base_feature_cases.json` holds synthetic windows (the pulse samples and the orientation samples that arrived) with
the features this package makes of each. The crate `pinch-inference` reads the same file and must reproduce every number, or a
model trained here would see different inputs live. Regenerate it after an intended change with
`BASE_FIXTURE_REGENERATE=1 uv run pytest tests/test_base_feature_parity.py`.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import numpy as np
import pytest

from label_trainer.csv_io import Recording, _carry_forward
from label_trainer.features import (
    BASE_FEATURE_COUNT,
    BASE_FEATURE_NAMES,
    FEATURE_NAMES,
    MOTION_FEATURE_NAMES,
    extract_base_features,
    extract_features,
)

MOTION_START = FEATURE_NAMES.index(MOTION_FEATURE_NAMES[0])
from label_trainer.schema import NUMERIC_COLUMNS
from label_trainer.windowing import Window

FIXTURE = Path(__file__).parent / "fixtures" / "base_feature_cases.json"
MS = 1_000_000


def make_window(ppg: dict, orientation: list[dict]) -> tuple[Recording, Window]:
    """A recording of exactly these pulse and orientation samples, interleaved by time, as one window."""
    p, o = len(ppg["timestampsNs"]), len(orientation)
    n = p + o
    data = {column: np.full(n, np.nan) for column in NUMERIC_COLUMNS}
    stamps = list(ppg["timestampsNs"]) + [sample["timestampNs"] for sample in orientation]
    for i in range(p):
        for column, key in (("ppg_green", "green"), ("ppg_red", "red"), ("ppg_ir", "ir"), ("contact_quality", "quality")):
            data[column][i] = ppg[key][i]
    for i, sample in enumerate(orientation):
        for prefix, key, axes in (("accel", "accel", "xyz"), ("gyro", "gyro", "xyz"), ("quat", "quat", "wxyz")):
            for axis, letter in enumerate(axes):
                data[f"{prefix}_{letter}"][p + i] = sample[key][axis]
    order = np.argsort(np.array(stamps, dtype=np.int64), kind="stable")
    recording = Recording(
        session_id="s",
        source_path=Path("s.csv"),
        timestamps_ns=np.array(stamps, dtype=np.int64)[order],
        channels={column: _carry_forward(values[order]) for column, values in data.items()},
        raw_labels=np.array(["x"] * n, dtype=object),
        ppg_observed=~np.isnan(data["ppg_green"][order]),
        orient_observed=~np.isnan(data["quat_w"][order]),
    )
    return recording, Window(session_id="s", label="x", start_ns=0, end_ns=0, row_indices=np.arange(n))


def synthetic(rng: random.Random, p: int, o: int, rest: bool = False) -> tuple[dict, list[dict]]:
    """`p` pulse samples at 25 Hz and `o` orientation samples at 50 Hz over the same span."""
    t0 = 5_000 * MS
    level = rng.uniform(40000, 60000)
    ppg = {"timestampsNs": [], "green": [], "red": [], "ir": [], "quality": []}
    for i in range(p):
        level += rng.gauss(0, 20)
        ppg["timestampsNs"].append(t0 + 7 * MS + i * 40 * MS)
        ppg["green"].append(round(level + rng.gauss(0, 10), 3))
        ppg["red"].append(round(level * 0.9 + rng.gauss(0, 10), 3))
        ppg["ir"].append(round(level * 0.8 + rng.gauss(0, 10), 3))
        ppg["quality"].append(float(rng.choice([0, 0, 0, 1])))
    orientation = []
    for i in range(o):
        scale = 0.0 if rest else 1.0
        orientation.append({
            "timestampNs": t0 + i * 20 * MS,
            "accel": [round(scale * rng.gauss(0, 2), 4) for _ in range(3)],
            "gyro": [round(scale * rng.gauss(0, 0.5), 4) for _ in range(3)],
            "quat": [round(1.0 - 0.001 * i, 5), round(0.01 * i, 5), 0.0, round(rng.gauss(0, 0.01), 5)],
        })
    return ppg, orientation


def _cases() -> list[dict]:
    rng = random.Random(20261011)
    cases = []

    def add(name: str, ppg: dict, orientation: list[dict]) -> None:
        recording, window = make_window(ppg, orientation)
        features = extract_base_features(recording, window)
        motion = extract_features(recording, window)[MOTION_START : MOTION_START + len(MOTION_FEATURE_NAMES)]
        cases.append({
            "name": name, "ppg": ppg, "orientation": orientation,
            "expected": [float(v) for v in features], "expectedMotion": [float(v) for v in motion],
        })

    add("typical", *synthetic(rng, 13, 25))
    add("still_wrist", *synthetic(rng, 13, 25, rest=True))
    add("no_orientation", *synthetic(rng, 12, 0))
    add("no_pulse", *synthetic(rng, 0, 25))
    add("one_pulse_sample", *synthetic(rng, 1, 25))
    for index in range(4):
        add(f"random_{index}", *synthetic(rng, rng.choice([2, 5, 13, 26]), rng.choice([1, 7, 25, 50])))
    ppg, orientation = synthetic(rng, 13, 25, rest=True)
    orientation[12]["accel"] = [6.0, -3.0, 2.5]  # one sharp tap in a still window
    orientation[12]["gyro"] = [1.5, 0.4, -0.8]
    add("a_tap_in_stillness", ppg, orientation)
    ppg, orientation = synthetic(rng, 13, 25)
    add("samples_missing", ppg, [sample for i, sample in enumerate(orientation) if i % 4 != 1])
    return cases


def test_statistics_are_each_sensors_own_samples() -> None:
    ppg = {"timestampsNs": [0, 40 * MS], "green": [10.0, 20.0], "red": [0.0, 0.0], "ir": [0.0, 0.0], "quality": [0.0, 1.0]}
    orientation = [
        {"timestampNs": t * MS, "accel": [a, 0.0, 0.0], "gyro": [0.0] * 3, "quat": [1.0, 0.0, 0.0, 0.0]}
        for t, a in ((5, 1.0), (15, 1.0), (25, 1.0), (35, 5.0))
    ]
    recording, window = make_window(ppg, orientation)
    features = dict(zip(BASE_FEATURE_NAMES, extract_base_features(recording, window)))
    assert features["ppg_green_mean"] == 15.0  # the 2 pulse samples, not the 6 rows (where 10 would count 4 times)
    assert features["ppg_green_slope"] == 10.0 / 40.0
    assert features["accel_x_mean"] == 2.0  # the 4 orientation samples only
    assert features["contact_quality_mean"] == 0.5
    assert features["sample_count"] == 6.0
    assert features["duration_ms"] == 40.0


def test_the_shared_cases_still_hold() -> None:
    cases = _cases()
    if os.environ.get("BASE_FIXTURE_REGENERATE"):
        FIXTURE.write_text(json.dumps({"featureNames": list(BASE_FEATURE_NAMES), "cases": cases}, indent=1) + "\n")
    stored = json.loads(FIXTURE.read_text())
    assert stored["featureNames"] == list(BASE_FEATURE_NAMES)
    assert len(stored["cases"]) == len(cases)
    for case, kept in zip(cases, stored["cases"]):
        assert case["name"] == kept["name"]
        assert len(kept["expected"]) == BASE_FEATURE_COUNT
        assert case["expected"] == pytest.approx(kept["expected"], rel=1e-12, abs=1e-12)
        assert case["expectedMotion"] == pytest.approx(kept["expectedMotion"], rel=1e-12, abs=1e-12)


def test_a_tap_stands_out_in_the_motion_dynamics() -> None:
    names = list(MOTION_FEATURE_NAMES)
    by_name = {case["name"]: dict(zip(names, case["expectedMotion"])) for case in _cases()}
    tap, still = by_name["a_tap_in_stillness"], by_name["still_wrist"]
    assert tap["accel_jerk_max"] > 100 and still["accel_jerk_max"] == 0.0
    assert tap["accel_magnitude_kurtosis"] > 10  # one burst in a quiet window is very peaked
    assert still["accel_magnitude_ptp"] == 0.0 and tap["accel_magnitude_ptp"] > 5
