"""The pulse-sensor level relative to its recent past: what it means, which samples it uses, and that the desktop's Rust copy
computes the same numbers.

`fixtures/baseline_cases.json` holds inputs and the numbers this module computes for them. The Rust crate `pinch-inference`
reads the same file and must reproduce every value. Regenerate it after an intended change with
`BASELINE_FIXTURE_REGENERATE=1 uv run pytest tests/test_baseline_features.py`.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import numpy as np
import pytest

from label_trainer.csv_io import Recording
from label_trainer.dataset import build_dataset_from_recordings
from label_trainer.features import (
    BASE_FEATURE_COUNT,
    BASELINE_FEATURE_NAMES,
    BASELINE_Z_FEATURE_NAMES,
    BASELINE_HIGH_PERCENT,
    BASELINE_LOW_PERCENT,
    BASELINE_MIN_SAMPLES,
    BASELINE_SLACK_MS,
    FEATURE_NAMES,
    SPIKE_FEATURE_NAMES,
    baseline_features,
    baseline_z_features,
    pulse_z,
    baseline_rows,
    extract_features,
)
from label_trainer.schema import NUMERIC_COLUMNS
from label_trainer.windowing import Window, WindowConfig

FIXTURE = Path(__file__).parent / "fixtures" / "baseline_cases.json"


def test_the_names_come_after_the_spike_features_and_cover_every_ppg_channel() -> None:
    start = BASE_FEATURE_COUNT + len(SPIKE_FEATURE_NAMES)
    assert FEATURE_NAMES[BASE_FEATURE_COUNT:start] == SPIKE_FEATURE_NAMES
    assert FEATURE_NAMES[start : start + len(BASELINE_FEATURE_NAMES)] == BASELINE_FEATURE_NAMES
    # The pulse in units of its recent past comes last, after the motion dynamics, so nothing before it moved.
    assert FEATURE_NAMES[-len(BASELINE_Z_FEATURE_NAMES) :] == BASELINE_Z_FEATURE_NAMES
    assert BASELINE_FEATURE_NAMES == (
        "ppg_green_rel_low", "ppg_red_rel_low", "ppg_ir_rel_low", "ppg_green_rel_high", "ppg_red_rel_high", "ppg_ir_rel_high",
    )


def _arrays(*lists: list[float]) -> list[np.ndarray]:
    return [np.array(values, dtype=np.float64) for values in lists]


def test_the_features_are_the_window_average_minus_the_low_and_the_high_end_of_the_past() -> None:
    past = [100.0 + i for i in range(21)]  # 100..120: the 10th percentile is rank 2 (102), the 90th rank 18 (118)
    window = [110.0, 112.0, 114.0]  # mean 112
    out = baseline_features(_arrays(window, window, window), _arrays(past, past, past))
    assert out == [10.0, 10.0, 10.0, -6.0, -6.0, -6.0]


def test_the_ends_of_the_past_do_not_depend_on_how_much_of_it_was_spent_pinching() -> None:
    rest, held = 1000.0, 4000.0
    window_rest, window_held = [rest + 1.0, rest - 1.0], [held + 1.0, held - 1.0]
    for share in (0.2, 0.5, 0.8):  # the share of the past that was a held pinch
        past = [held if i < int(40 * share) else rest for i in range(40)]
        low_rest, high_rest = baseline_features(_arrays(window_rest, window_rest, window_rest), _arrays(past, past, past))[::3]
        low_held, high_held = baseline_features(_arrays(window_held, window_held, window_held), _arrays(past, past, past))[::3]
        assert (low_rest, high_rest, low_held, high_held) == (0.0, -3000.0, 3000.0, 0.0), share
    only_rest = [rest] * 40  # nothing but rest in the past: the pinch stands out at both ends
    out = baseline_features(_arrays(window_held, window_held, window_held), _arrays(only_rest, only_rest, only_rest))
    assert out[0] == out[3] == 3000.0


def test_a_different_session_level_changes_nothing_only_the_change_counts() -> None:
    past = [100.0 + (i % 5) for i in range(20)]
    window = [105.0, 106.0, 107.0]
    base = baseline_features(_arrays(window, window, window), _arrays(past, past, past))
    shifted = baseline_features(
        _arrays(*[[v + 250_000.0 for v in window]] * 3), _arrays(*[[v + 250_000.0 for v in past]] * 3)
    )
    assert shifted == pytest.approx(base)


def test_too_little_past_or_an_empty_window_gives_zeros() -> None:
    few = [1.0] * (BASELINE_MIN_SAMPLES - 1)
    assert baseline_features(_arrays([5.0], [5.0], [5.0]), _arrays(few, few, few)) == [0.0] * 6
    past = [1.0] * 20
    assert baseline_features(_arrays([], [], []), _arrays(past, past, past)) == [0.0] * 6


def _recording(n: int = 400, step_ms: float = 20.0, ppg_every: int = 3, level: float = 100.0, jump: tuple[int, int, float] | None = None) -> Recording:
    """A recording with a pulse sample every `ppg_every` rows (the other rows carry the last one forward)."""
    times = np.array([int(i * step_ms * 1e6) for i in range(n)], dtype=np.int64)
    rng = np.random.default_rng(3)
    ppg = np.full(n, np.nan)
    observed = np.zeros(n, dtype=bool)
    for i in range(0, n, ppg_every):
        value = level + rng.normal(0, 1)
        if jump and jump[0] <= i < jump[1]:
            value += jump[2]
        ppg[i], observed[i] = value, True
    filled, last = ppg.copy(), level
    for i in range(n):
        if observed[i]:
            last = ppg[i]
        filled[i] = last
    channels = {column: np.full(n, 0.5) for column in NUMERIC_COLUMNS}
    for column in ("ppg_green", "ppg_red", "ppg_ir"):
        channels[column] = filled.copy()
    return Recording(session_id="s", source_path=Path("s.csv"), timestamps_ns=times, channels=channels, raw_labels=np.array(["x"] * n, dtype=object), ppg_observed=observed)


def _window(first: int, last: int) -> Window:
    return Window(session_id="s", label="x", start_ns=0, end_ns=0, row_indices=np.arange(first, last))


def test_the_baseline_is_the_real_samples_just_before_the_window_never_the_window_itself() -> None:
    recording = _recording()
    window = _window(250, 275)  # 5.0 s to 5.5 s
    rows = baseline_rows(recording, window, 2000)
    assert rows is not None and rows.max() < 250
    assert recording.timestamps_ns[rows].min() >= recording.timestamps_ns[250] - 2_000_000_000
    assert all(recording.ppg_observed[rows])  # only rows that had a pulse sample
    assert baseline_rows(recording, window, 4000).shape[0] > rows.shape[0]


def test_a_window_near_the_start_has_too_little_past_and_has_no_baseline() -> None:
    recording = _recording()
    assert baseline_rows(recording, _window(10, 35), 2000) is None
    assert baseline_rows(recording, _window(120, 145), 2000) is not None  # 2.4 s in: 2.0 s of past is there
    assert baseline_rows(recording, _window(80, 105), 2000) is None  # 1.6 s in: not that far back


def test_a_held_level_shift_shows_in_the_vector_and_is_zero_without_a_baseline() -> None:
    recording = _recording(jump=(200, 300, 40.0))
    inside = extract_features(recording, _window(240, 265), None, 4000)
    before = extract_features(recording, _window(150, 175), None, 4000)
    low = FEATURE_NAMES.index("ppg_red_rel_low")
    assert inside[low] > 30 and abs(before[low]) < 6  # the past reaches back 4 s: all rest before the shift
    assert not np.any(extract_features(recording, _window(240, 265))[-6:])  # no baseline asked for: nothing there
    assert not np.any(extract_features(recording, _window(10, 35), None, 2000)[-6:])  # not enough past


def test_windows_with_no_baseline_are_left_out_of_the_dataset() -> None:
    recording = _recording()
    config = WindowConfig(window_ms=500, stride_ms=150, max_gap_ms=250, min_samples_per_window=3)
    everything = build_dataset_from_recordings([recording], config, "exclude")
    with_baseline = build_dataset_from_recordings([recording], config, "exclude", baseline_ms=2000)
    assert len(with_baseline.windows) < len(everything.windows)
    first_allowed = min(w.start_ns for w in with_baseline.windows)
    assert first_allowed >= 2_000_000_000 - 250_000_000 + int(recording.timestamps_ns[0])  # the whole of the past must be there, give or take a slack


def _cases() -> list[dict]:
    rng = random.Random(20261012)
    cases: list[dict] = []

    def add(name: str, window: list[list[float]], past: list[list[float]]) -> None:
        arrays_w, arrays_p = _arrays(*window), _arrays(*past)
        times = [40.0 * i + (3.0 if i % 3 == 2 else 0.0) for i in range(len(window[0]))]  # 25 Hz, a little uneven
        cases.append({
            "name": name, "window": window, "baseline": past, "windowTimesMs": times,
            "expected": baseline_features(arrays_w, arrays_p),
            "expectedZ": baseline_z_features(arrays_w, np.array(times), arrays_p),
            # What a convolutional model's pulse channels become (input.grid.pulse "recentPast").
            "zSeries": [pulse_z(w, b).tolist() if b.shape[0] else [] for w, b in zip(arrays_w, arrays_p)],
        })

    steady = [[100.0 + (i % 5) for i in range(20)]] * 3
    add("steady_up", [[110.0, 112.0, 114.0]] * 3, steady)
    add("steady_down", [[90.0, 91.0, 89.0]] * 3, steady)
    add("too_little_past", [[5.0, 6.0]] * 3, [[1.0] * 10] * 3)
    add("no_window", [[], [], []], steady)
    add("flat_past", [[3.0]] * 3, [[1.0] * 20] * 3)
    add("rest_and_held_mixed", [[4001.0, 3999.0]] * 3, [[4000.0 if i < 28 else 1000.0 for i in range(40)]] * 3)
    add("session_offset", [[250_105.0, 250_106.0, 250_107.0]] * 3, [[250_100.0 + (i % 5) for i in range(20)]] * 3)
    for n in range(3):
        past = [[rng.gauss(50_000.0 * (c + 1), 800.0) for _ in range(30 + 7 * n)] for c in range(3)]
        window = [[rng.gauss(50_000.0 * (c + 1) + 1500.0 * n, 800.0) for _ in range(9)] for c in range(3)]
        add(f"random_{n}", window, past)
    return cases


def test_the_pulse_in_units_of_its_past_ignores_the_sessions_level_and_swing() -> None:
    rng = np.random.default_rng(1)
    rest = rng.normal(0.0, 1.0, 40)
    window = np.array([0.0, 2.0, 4.0])
    # The same change in two sessions: one sitting at -250,000 counts with a small swing, one at +310,000 with a swing 8x larger.
    quiet = pulse_z(-250_000 + 100 * window, -250_000 + 100 * rest)
    loud = pulse_z(310_000 + 800 * window, 310_000 + 800 * rest)
    assert np.allclose(quiet, loud)
    assert pulse_z(np.array([1e9]), rest * 100).max() == 20.0  # a jump saturates
    assert np.all(np.isfinite(pulse_z(np.array([5.0]), np.ones(20))))  # a flat past does not divide by zero


def test_the_shared_cases_with_the_desktop_match() -> None:
    cases = _cases()
    if os.environ.get("BASELINE_FIXTURE_REGENERATE"):
        FIXTURE.write_text(json.dumps({"version": 1, "minSamples": BASELINE_MIN_SAMPLES, "slackMs": BASELINE_SLACK_MS, "lowPercent": BASELINE_LOW_PERCENT, "highPercent": BASELINE_HIGH_PERCENT, "cases": cases}, indent=1) + "\n")
    saved = json.loads(FIXTURE.read_text())
    assert saved["cases"] == json.loads(json.dumps(cases)), "regenerate the fixture (BASELINE_FIXTURE_REGENERATE=1) and make the Rust side agree"


# ---- end to end: the level differs between sessions, only the change against the recent past generalises --------------------

def _write_session(directory: Path, rid: str, *, seed: int, level: float, seconds: float = 60.0) -> Path:
    """A session at 50 Hz with a pulse sample every third row. The level is the session's own (as real sessions differ by
    hundreds of thousands); a held "pinch" lifts it by a few thousand, in blocks of about 1.5 s between about 0.7 s of rest."""
    from label_trainer.schema import HEADER_COLUMNS

    rng = np.random.default_rng(seed)
    lines = ["# gesture-dataset-export: 1", "# label: pinch", ",".join(HEADER_COLUMNS)]
    rows = int(seconds * 50)
    pinching, until, drift = False, 0, 0.0
    for row in range(rows):
        if row >= until:
            pinching = not pinching
            until = row + int(50 * (rng.uniform(1.2, 1.8) if pinching else rng.uniform(0.5, 0.9)))
        label = "pinch" if pinching else "idle"
        drift += rng.normal(0, 8.0)  # the level wanders slowly all the time
        accel = rng.normal(0, 0.3, 3)
        if row % 3 == 0:
            value = level + drift + (3000.0 if pinching else 0.0) + rng.normal(0, 150.0)
            ppg = [f"{value:.1f}"] * 3
        else:
            ppg = ["", "", ""]
        fields = [str(row * 20_000_000), str(row), *ppg, *(f"{v:.4f}" for v in accel), "0", "0", "0", "1", "0", "0", "0", "3" if row % 3 == 0 else "", label]
        lines.append(",".join(fields))
    path = directory / f"{rid}.csv"
    path.write_text("\n".join(lines) + "\n")
    return path


def _session_spec(tmp_path: Path, **over) -> dict:
    levels = {"p1": 90_000.0, "p2": -50_000.0, "p3": 310_000.0, "p4": 20_000.0, "p5": 175_000.0}
    recordings = {rid: str(_write_session(tmp_path, rid, seed=index, level=level)) for index, (rid, level) in enumerate(levels.items())}
    spec = {
        "version": 1, "target": "pinch", "negatives": ["idle"], "excludes": [], "recordings": recordings,
        "train": ["p1", "p2", "p3"], "evaluation": ["p4", "p5"], "sources": ["watchPpg"],
        "window": {"windowMs": 500, "strideMs": 150, "maxGapMs": 250, "minSamples": 3},
        "backend": "logreg", "seed": 7,
    }
    spec.update(over)
    return spec


def test_a_model_on_the_level_against_the_recent_past_works_on_sessions_whose_own_level_is_unlike_the_training_ones(tmp_path: Path) -> None:
    pytest.importorskip("onnxruntime")
    from label_trainer import label_train as lt

    out = tmp_path / "with"
    result = lt.run(_session_spec(tmp_path, baselineMs=4000, features=list(BASELINE_FEATURE_NAMES)), out)
    assert result["outcome"] == "deployable", result["message"]
    assert result["metrics"]["rocAuc"] > 0.9
    manifest = json.loads((out / "bundle" / "manifest.json").read_text())
    assert manifest["preprocessing"] == {"kind": "none", "baselineMs": 4000}
    assert manifest["input"]["features"] == list(BASELINE_FEATURE_NAMES)
    inspection = json.loads((out / "inspection.json").read_text())
    assert inspection["baselineMs"] == 4000

    plain = lt.run(_session_spec(tmp_path, features=["ppg_green_mean", "ppg_red_mean", "ppg_ir_mean"]), tmp_path / "without")
    assert plain["metrics"]["rocAuc"] < result["metrics"]["rocAuc"] - 0.1  # the absolute level is the session's, not the gesture's


def test_the_baseline_needs_the_pulse_sensor_and_a_known_length(tmp_path: Path) -> None:
    from label_trainer import label_train as lt

    with pytest.raises(lt.TrainingRefused, match="baseline"):
        lt.parse_spec(_session_spec(tmp_path, baselineMs=3000))
    spec = lt.parse_spec(_session_spec(tmp_path, baselineMs=2000, sources=["watchAcceleration"]))
    assert spec.baseline_ms is None  # nothing for it to read
    assert not any(name in BASELINE_FEATURE_NAMES for name in spec.features)
    assert [n for n in lt.parse_spec(_session_spec(tmp_path, baselineMs=2000)).features if n in BASELINE_FEATURE_NAMES] == list(BASELINE_FEATURE_NAMES)


def test_the_pulse_in_units_of_its_past_works_on_sessions_whose_level_and_swing_are_unlike_the_training_ones(tmp_path: Path) -> None:
    pytest.importorskip("onnxruntime")
    from label_trainer import label_train as lt

    result = lt.run(_session_spec(tmp_path, baselineMs=4000, features=list(BASELINE_Z_FEATURE_NAMES)), tmp_path / "z")
    assert result["outcome"] == "deployable", result["message"]
    assert result["metrics"]["rocAuc"] > 0.9 and result["metrics"]["crossCheckRocAuc"] > 0.9


def test_a_columns_model_reads_its_pulse_in_units_of_its_past_with_a_baseline(tmp_path: Path) -> None:
    pytest.importorskip("onnxruntime")
    from label_trainer import label_train as lt
    from label_trainer.csv_io import load_recording
    from label_trainer.grid import build_grid
    from label_trainer.windowing import WindowConfig, continuous_windows

    raw = _session_spec(tmp_path, inputMode="raw", gridSteps=4, baselineMs=4000, features=["ppg_green"])
    spec = lt.parse_spec(raw)
    assert lt.grid_pulse_baseline(spec) == 4000
    result = lt.run(raw, tmp_path / "run")
    assert result["outcome"] == "deployable", result["message"]
    manifest = json.loads((tmp_path / "run" / "bundle" / "manifest.json").read_text())
    assert manifest["input"]["grid"]["pulse"] == "recentPast" and manifest["preprocessing"]["baselineMs"] == 4000
    # Two sessions 360,000 counts apart give the same inputs for the same change against their own past.
    recording = load_recording(raw["recordings"]["p2"])
    windows = continuous_windows(recording, WindowConfig(window_ms=500, stride_ms=150, max_gap_ms=250))
    early = build_grid(recording, windows[0], ["ppg_green"], 4, pulse_baseline_ms=4000)
    assert early is None  # not enough past yet: not used, as live
    late = [build_grid(recording, w, ["ppg_green"], 4, pulse_baseline_ms=4000) for w in windows[-5:]]
    assert all(g is not None and np.all(np.abs(g) <= 20) for g in late)
    # Without a baseline a columns model reads the counts, as before.
    plain = lt.parse_spec(_session_spec(tmp_path, inputMode="raw", gridSteps=4, features=["ppg_green"]))
    assert lt.grid_pulse_baseline(plain) is None
