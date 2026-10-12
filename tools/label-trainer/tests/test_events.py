"""A model judged as a detector over whole held-out recordings, the cut-off chosen without them, and the gate that uses both.

`fixtures/detection_cases.json` holds score sequences with the detections `events.detect` finds in them; the runtime's
`TemporalDetector` (crates/label-inference) reads the same file and must find the same ones. Regenerate it after an intended
change with `DETECTION_FIXTURE_REGENERATE=1 uv run pytest tests/test_events.py`.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import numpy as np
import pytest

from label_trainer import label_train as lt
from label_trainer.events import Policy, continuous_windows, detect, match_events
from label_trainer.windowing import WindowConfig

from .test_label_train import INTERVAL_NS, spec_for, write_recording

FIXTURE = Path(__file__).parent / "fixtures" / "detection_cases.json"
MS = 1_000_000
S = 1_000 * MS


def test_a_detection_rises_at_the_activation_threshold_and_falls_below_the_release_one() -> None:
    times = [i * 100 * MS for i in range(8)]
    scores = [0.1, 0.85, 0.7, 0.65, 0.5, 0.9, 0.95, 0.9]
    assert detect(times, scores, Policy(0.8, 0.6)) == [(100 * MS, 400 * MS), (500 * MS, None)]


def test_debounce_and_cooldown_hold_back_a_rise() -> None:
    times = [i * 100 * MS for i in range(11)]
    scores = [0.9, 0.1, 0.9, 0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9]
    # A lone high score is not enough; one held for 200 ms is (rises at 400). After it falls at 500, high scores in the
    # 300 ms cooldown do not count, so the next run starts at 800 and rises 200 ms later.
    assert detect(times, scores, Policy(0.8, 0.6, debounce_ms=200, cooldown_ms=300)) == [(400 * MS, 500 * MS), (1_000 * MS, None)]


def _detection_cases() -> list[dict]:
    rng = random.Random(20261011)
    cases = []
    for index in range(16):
        policy = Policy(
            activation=rng.choice([0.5, 0.7, 0.8, 0.9]),
            release=0.0,
            debounce_ms=rng.choice([0, 0, 150, 400]),
            cooldown_ms=rng.choice([0, 0, 300, 1000]),
        )
        policy = Policy(policy.activation, round(policy.activation - rng.choice([0.0, 0.1, 0.3]), 2), policy.debounce_ms, policy.cooldown_ms)
        times, scores, at, level = [], [], 1_000 * MS, rng.random()
        for _ in range(rng.choice([20, 60, 120])):
            at += rng.choice([100, 150, 200]) * MS
            level = min(1.0, max(0.0, level + rng.gauss(0, 0.25)))
            times.append(at)
            scores.append(round(level, 4))
        found = detect(times, scores, policy)
        cases.append({
            "name": f"random_{index}",
            "policy": {"activation": policy.activation, "release": policy.release, "debounceMs": policy.debounce_ms, "cooldownMs": policy.cooldown_ms},
            "timesNs": times,
            "scores": scores,
            "detections": [[rise, fall] for rise, fall in found],
        })
    return cases


def test_the_shared_detection_cases_still_hold() -> None:
    cases = _detection_cases()
    if os.environ.get("DETECTION_FIXTURE_REGENERATE"):
        FIXTURE.write_text(json.dumps({"cases": cases}, indent=1) + "\n")
    stored = json.loads(FIXTURE.read_text())["cases"]
    assert stored == json.loads(json.dumps(cases))
    assert sum(len(case["detections"]) for case in stored) > 20, "the cases exercise many rises and falls"


def test_events_are_matched_with_the_gestures_in_the_labels() -> None:
    gestures = [(10 * S, 11 * S), (30 * S, 31 * S)]
    ignored = [(50 * S, 52 * S)]
    detections = [
        (int(10.3 * S), int(10.8 * S)),  # catches the first gesture, 300 ms after it started
        (int(11.2 * S), int(11.4 * S)),  # within one window after it: a repeat, not a false alarm
        (20 * S, 21 * S),  # nothing there: a false activation
        (51 * S, None),  # in an excluded label's span: counts neither way
    ]
    result = match_events(detections, gestures, ignored, [(0, 60 * S)], window_ms=500)
    assert (result["gestures"], result["caught"], result["repeats"], result["falseActivations"]) == (2, 1, 1, 1)
    assert result["latenciesMs"] == [300.0]
    # 60 s observed, less each gesture plus a window (1.5 s twice) and the excluded span plus a window (2.5 s).
    assert result["negativeNs"] == int(54.5 * S)


def test_windows_slide_across_label_changes_as_they_do_live(tmp_path: Path) -> None:
    from label_trainer.csv_io import load_recording

    a = write_recording(tmp_path, "a", "idle", seed=1, rows=100)
    lines = a.read_text().splitlines()
    head, body = lines[:3], lines[3:]
    body = [line if i < 50 else line.rsplit(",", 1)[0] + ",snap" for i, line in enumerate(body)]
    a.write_text("\n".join(head + body) + "\n")
    windows = continuous_windows(load_recording(a), WindowConfig(window_ms=500, stride_ms=150, max_gap_ms=250))
    recording = load_recording(a)
    mixed = [w for w in windows if len(set(recording.raw_labels[w.row_indices].tolist())) == 2]
    assert mixed, "some windows hold the end of one label and the start of the next"
    assert all(w.end_ns - w.start_ns == 500 * MS for w in windows)


def test_the_cut_off_is_chosen_on_the_training_recordings_only(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path))
    x_train, y_train, x_eval, y_eval, _, groups = lt.build_matrices_with_groups(spec)
    threshold, source, cross_check = lt.out_of_fold_threshold(spec, x_train, y_train, groups)
    assert source == "trainingRecordings" and 0.05 <= threshold <= 0.95
    assert cross_check is not None and cross_check > 0.9  # the toy gesture is the same in every recording
    # It cannot depend on the held-out recordings: they are not even passed in.
    one_recording = np.array(["s1"] * groups.shape[0], dtype=object)
    assert lt.out_of_fold_threshold(spec, x_train, y_train, one_recording) == (lt.ACTIVATION, "default", None)


def test_a_model_whose_training_recordings_disagree_is_not_kept_however_it_did_on_the_test_ones() -> None:
    rng = np.random.default_rng(5)
    y = np.array([1] * 50 + [0] * 50)
    metrics = lt.evaluate(np.concatenate([rng.uniform(0.6, 1, 50), rng.uniform(0, 0.4, 50)]), y, 0.5, "trainingRecordings")
    metrics["crossCheckRocAuc"] = 0.55
    assert "do not agree with each other" in (lt.verdict(metrics) or "")


def test_a_model_that_flags_every_other_window_is_not_kept_however_good_its_f1() -> None:
    """A real run: 342 held-out windows of the gesture, 6 of anything else, a cut-off of 0.05. F1 0.98, yet it fired on all
    six others, which F1 hides when the held-out recordings are mostly the gesture."""
    rng = np.random.default_rng(3)
    y = np.array([1] * 342 + [0] * 6)
    probability = np.concatenate([rng.uniform(0.2, 1.0, 342), rng.uniform(0.06, 0.3, 6)])
    metrics = lt.evaluate(probability, y, 0.05, "trainingRecordings")
    assert metrics["f1"] > 0.95 and metrics["falseActivationRate"] == 1.0
    assert "wrongly flagged 100%" in (lt.verdict(metrics) or "")


def _long_spec(tmp_path: Path, idle_rows: int) -> dict:
    """Held-out recordings long enough to judge false alarms: `idle_rows` rows (20 ms each) of the non-gesture session."""
    spec = spec_for(tmp_path)
    write_recording(tmp_path, "i3", "idle", seed=9, rows=idle_rows)
    return spec


@pytest.mark.strict_gate
def test_too_little_time_without_the_gesture_is_refused_with_what_to_record(tmp_path: Path) -> None:
    result = lt.run(spec_for(tmp_path), tmp_path / "run")
    assert result["outcome"] == "evaluationOnly"
    assert "too little to tell how often it would fire by mistake" in result["message"]
    assert "Record a few minutes of ordinary activity" in result["message"]


@pytest.mark.strict_gate
def test_a_model_is_kept_when_it_is_quiet_over_minutes_without_the_gesture(tmp_path: Path) -> None:
    rows = int(90 * S / INTERVAL_NS)
    result = lt.run(_long_spec(tmp_path, rows), tmp_path / "run")
    assert result["outcome"] == "deployable", result["message"]
    events = result["metrics"]["events"]
    assert events["negativeSeconds"] >= 60
    assert events["falseActivationsPerHour"] == 0.0
    assert events["gestures"] == 1 and events["caught"] == 1
    evaluation = json.loads((tmp_path / "run" / "evaluation.json").read_text())
    assert evaluation["events"] == events
