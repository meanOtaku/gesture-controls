"""The pulse-sensor spike features: what they mean, and that the desktop's Rust copy computes the same numbers.

`fixtures/spike_cases.json` holds inputs and the numbers this module computes for them. The Rust crate `pinch-inference`
reads the same file and must reproduce every value, so a change to either side that is not made on both fails a test.
Regenerate it after an intended change with `SPIKE_FIXTURE_REGENERATE=1 uv run pytest tests/test_spike_features.py`.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import numpy as np
import pytest

from label_trainer.csv_io import Recording
from label_trainer.features import (
    BASE_FEATURE_COUNT,
    FEATURE_NAMES,
    SPIKE_FEATURE_NAMES,
    SPIKE_STATS,
    extract_features,
    spike_features,
)
from label_trainer.schema import NUMERIC_COLUMNS
from label_trainer.windowing import Window

FIXTURE = Path(__file__).parent / "fixtures" / "spike_cases.json"
STAT = {name: index for index, name in enumerate(SPIKE_STATS)}


def run(values: list[float], times: list[float]) -> dict[str, float]:
    out = spike_features(np.array(values, dtype=np.float64), np.array(times, dtype=np.float64))
    return {name: out[index] for name, index in STAT.items()}


def evenly(n: int, step: float = 40.0) -> list[float]:
    return [1000.0 + i * step for i in range(n)]


def test_names_are_appended_after_the_base_features_and_cover_every_ppg_channel() -> None:
    assert FEATURE_NAMES[BASE_FEATURE_COUNT:] == SPIKE_FEATURE_NAMES
    assert len(SPIKE_FEATURE_NAMES) == 24
    assert "ppg_ir_deriv_min" in SPIKE_FEATURE_NAMES and "ppg_green_spike_height" in SPIKE_FEATURE_NAMES
    assert all(name.startswith("ppg_") for name in SPIKE_FEATURE_NAMES)


def test_a_flat_or_too_short_window_has_no_spike() -> None:
    assert set(run([5.0] * 12, evenly(12)).values()) == {0.0}
    assert set(run([1.0, 9.0, 1.0], evenly(3)).values()) == {0.0}


def test_baseline_drift_alone_leaves_no_spike() -> None:
    drift = run([100 + 3.0 * i for i in range(12)], evenly(12))
    assert abs(drift["spike_height"]) < 1e-9


def test_one_clean_spike_is_found_with_its_height_position_and_width() -> None:
    values = [10.0] * 12
    values[7] = 40.0
    found = run(values, evenly(12))
    assert found["spike_height"] > 20  # up
    assert found["spike_z"] > 3
    assert found["spike_time_frac"] == pytest.approx(7 / 11)
    assert found["spike_count"] == 1.0
    assert found["spike_rise_ms"] == 0.0 and found["spike_fall_ms"] == 0.0  # one sample wide
    assert found["deriv_max"] > 0 > found["deriv_min"]


def test_a_downward_spike_is_negative_and_a_wider_one_has_a_width() -> None:
    values = [10.0] * 14
    for i in (6, 7, 8):
        values[i] = -30.0
    found = run(values, evenly(14))
    assert found["spike_height"] < 0
    assert found["spike_rise_ms"] + found["spike_fall_ms"] == pytest.approx(80.0)  # three samples, 40 ms apart


def test_drift_under_a_spike_does_not_hide_it() -> None:
    values = [200 - 5.0 * i for i in range(12)]
    values[5] += 60.0
    found = run(values, evenly(12))
    assert found["spike_time_frac"] == pytest.approx(5 / 11)
    assert found["spike_height"] > 30


def test_two_separate_spikes_are_counted() -> None:
    values = [10.0, 10.2, 9.9, 10.1, 30.0, 10.0, 9.8, 10.1, 30.0, 10.0, 10.2, 9.9]
    assert run(values, evenly(12))["spike_count"] == 2.0


def test_the_spike_features_ignore_how_high_the_baseline_sits() -> None:
    base = [10.0] * 12
    base[6] = 30.0
    shifted = [v + 5000.0 for v in base]
    a, b = run(base, evenly(12)), run(shifted, evenly(12))
    for name in SPIKE_STATS:
        assert a[name] == pytest.approx(b[name], abs=1e-6)


def test_batched_timestamps_do_not_make_the_rates_wild() -> None:
    """The watch stamps three samples of a batch 40 ns apart and the next batch ~105 ms later."""
    values = [10.0] * 12
    values[7] = 40.0
    batched = []
    for i in range(12):
        batched.append(1000.0 + (i // 3) * 105.0 + (i % 3) * 4e-5)
    a, b = run(values, batched), run(values, [batched[0] + i * (batched[-1] - batched[0]) / 11 for i in range(12)])
    for name in SPIKE_STATS:
        assert a[name] == pytest.approx(b[name])
    assert abs(a["deriv_max"]) < 5  # per millisecond, for a 30-unit spike: not millions


def test_equal_timestamps_do_not_divide_by_zero() -> None:
    out = run([1, 2, 3, 20, 5, 4, 3, 2], [5000.0] * 8)
    assert all(np.isfinite(v) for v in out.values())


def _recording(timestamps_ms: list[float], ppg: list[float | None], quiet: float = 0.5) -> Recording:
    n = len(timestamps_ms)
    channels = {column: np.full(n, quiet) for column in NUMERIC_COLUMNS}
    observed = np.array([v is not None for v in ppg])
    filled = np.array([0.0 if v is None else v for v in ppg])
    last = 0.0
    for i in range(n):
        last = filled[i] if observed[i] else last
        filled[i] = last
    for column in ("ppg_green", "ppg_red", "ppg_ir"):
        channels[column] = filled.copy()
    return Recording(
        session_id="s", source_path=Path("s.csv"),
        timestamps_ns=np.array([int(t * 1e6) for t in timestamps_ms], dtype=np.int64),
        channels=channels, raw_labels=np.array(["x"] * n, dtype=object), ppg_observed=observed,
    )


def test_the_window_vector_uses_only_rows_that_had_a_real_pulse_sample() -> None:
    # PPG rows every 40 ms with orientation rows in between, whose carried-forward PPG must not count as samples.
    times, ppg = [], []
    for i in range(14):
        times += [1000.0 + i * 40, 1000.0 + i * 40 + 20]
        ppg += [10.0 + (30.0 if i == 7 else 0.0), None]
    recording = _recording(times, ppg)
    window = Window(session_id="s", label="x", start_ns=0, end_ns=0, row_indices=np.arange(len(times)))
    vector = extract_features(recording, window)
    assert vector.shape == (len(FEATURE_NAMES),)
    spikes = dict(zip(SPIKE_FEATURE_NAMES, vector[BASE_FEATURE_COUNT:]))
    assert spikes["ppg_green_spike_height"] > 20
    assert spikes["ppg_green_spike_time_frac"] == pytest.approx(7 / 13)  # position among the 14 real samples
    assert spikes["ppg_green_spike_count"] == 1.0


def _cases() -> list[dict]:
    rng = random.Random(20261011)
    cases: list[dict] = []

    def add(name: str, values: list[float], times: list[float]) -> None:
        cases.append({"name": name, "values": values, "timestampsMs": times, "expected": run(values, times)})

    flat = [7.0] * 10
    add("flat", flat, evenly(10))
    add("too_short", [1.0, 5.0, 2.0], evenly(3))
    spike = [10.0] * 12
    spike[7] = 40.0
    add("one_spike", spike, evenly(12))
    wide = [10.0] * 14
    for i in (6, 7, 8):
        wide[i] = -30.0
    add("wide_down_spike", wide, evenly(14))
    drift = [200 - 5.0 * i for i in range(12)]
    drift[5] += 60.0
    add("spike_on_drift", drift, evenly(12))
    add("two_spikes", [10.0, 10.2, 9.9, 10.1, 30.0, 10.0, 9.8, 10.1, 30.0, 10.0, 10.2, 9.9], evenly(12))
    add("equal_timestamps", [1, 2, 3, 20, 5, 4, 3, 2], [5000.0] * 8)
    add("batched_timestamps", [10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 40.0, 10.0, 10.0, 10.0, 10.0], [1000.0 + (i // 3) * 105.0 + (i % 3) * 4e-5 for i in range(12)])
    for index in range(6):
        n = rng.choice([4, 5, 11, 12, 13, 25])
        t = 123456.5
        stamps = []
        for _ in range(n):
            t += rng.choice([20.0, 38.5, 40.0, 41.25, 80.0])
            stamps.append(t)
        values = [round(rng.gauss(52000, 40) + (rng.choice([0, 0, 600, -450]) if rng.random() < 0.3 else 0), 3) for _ in range(n)]
        add(f"noisy_{index}", values, stamps)
    return cases


def test_the_shared_cases_match_what_this_module_computes() -> None:
    cases = _cases()
    if os.environ.get("SPIKE_FIXTURE_REGENERATE"):
        FIXTURE.write_text(json.dumps({"statOrder": list(SPIKE_STATS), "cases": cases}, indent=1) + "\n", encoding="utf-8")
    stored = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert stored["statOrder"] == list(SPIKE_STATS)
    assert len(stored["cases"]) == len(cases)
    for mine, theirs in zip(cases, stored["cases"]):
        assert mine["name"] == theirs["name"] and mine["values"] == theirs["values"]
        for stat in SPIKE_STATS:
            assert mine["expected"][stat] == pytest.approx(theirs["expected"][stat], abs=1e-9, rel=1e-9), (mine["name"], stat)
