"""Training a pinch-start model end to end on synthetic pulse recordings, and the checks around it."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from types import SimpleNamespace

import numpy as np
import pytest

from label_trainer import imu_onset, label_train as lt
from label_trainer import ppg_onset, trees

from .pulse_data import spec_for, write_pulse_recording


def test_a_spec_for_anything_but_the_pulse_model_is_refused(tmp_path: Path) -> None:
    spec = spec_for(tmp_path, train=1, evaluation=1)
    for change, reason in [
        ({"version": 2}, "unsupported spec version"),
        ({"backend": "logreg"}, "unknown backend"),
        ({"sources": ["watchAcceleration"]}, "reads the pulse sensor and motion"),
        ({"evaluation": spec["train"]}, "both the training and the evaluation"),
        ({"labelOffsetMs": 2000}, "label offset"),
        ({"target": ""}, "no target label"),
        ({"steadyStarts": "yes"}, "steadyStarts must be true or false"),
        ({"hardNegatives": 1}, "hardNegatives must be true or false"),
    ]:
        with pytest.raises(lt.TrainingRefused, match=reason):
            lt.parse_spec({**spec, **change})


def test_a_motion_model_reads_the_pulse_and_motion_and_detects_on_the_peak(tmp_path: Path) -> None:
    result = lt.run(spec_for(tmp_path, motion=True, every_s=5.0), tmp_path / "run")
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    bundle = tmp_path / "run" / "bundle"
    manifest = json.loads((bundle / "manifest.json").read_text())
    names = list(ppg_onset.FEATURE_NAMES) + list(imu_onset.FEATURE_NAMES)
    assert manifest["input"]["features"] == names and manifest["input"]["shape"] == [None, 2733]
    assert manifest["sources"] == ["watchPpg", "watchOrientation"] and manifest["preprocessing"] == {"kind": "ppg_imu_onset"}
    assert manifest["thresholds"]["trigger"] == "peak" and manifest["thresholds"]["cooldownMs"] == 1500
    assert manifest["thresholds"]["decisionDelayMs"] == ppg_onset.ONSET_DELAY_MS
    assert manifest["thresholds"]["activation"] in lt.THRESHOLD_CANDIDATES
    assert trees.read((bundle / "model.trees").read_bytes())[0] == 2733
    assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE
    metrics = result["metrics"]
    assert metrics["rocAuc"] > 0.9 and metrics["thresholdSource"] == "trainingRecordings"
    # The cut-off was chosen on a replay of the training recordings, each scored by a model that had not seen it.
    cross = metrics["crossCheckEvents"]
    assert cross["gestures"] > 0 and cross["falseActivationsBudgetPerHour"] == lt.FALSE_ACTIVATIONS_BUDGET_PER_HOUR
    events = metrics["events"]
    assert events["policy"]["trigger"] == "peak"
    assert events["gestures"] > 0 and events["caught"] / events["gestures"] >= 0.5
    assert 680 <= events["medianLatencyMs"] <= 1280


def test_with_steady_starts_only_moments_with_the_hand_still_count(tmp_path: Path) -> None:
    # The synthetic motion is a still hand, so a motion model trains as before, on all but the first moments (no window yet).
    (tmp_path / "motion").mkdir()
    (tmp_path / "pulse").mkdir()
    spec = spec_for(tmp_path / "motion", motion=True, every_s=5.0)
    recordings = lt.load_spec_recordings(lt.parse_spec(spec))
    every = lt.examples(lt.parse_spec(spec), recordings, spec["train"])
    still = lt.examples(lt.parse_spec({**spec, "steadyStarts": True}), recordings, spec["train"])
    assert 0 < still.y.shape[0] <= every.y.shape[0] and int(still.y.sum()) == int(every.y.sum())
    result = lt.run({**spec, "steadyStarts": True}, tmp_path / "run")
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    assert result["metrics"]["steadyStarts"] is True
    # Without motion samples nothing can be judged still, so nothing counts, and the refusal says why.
    pulse_only = spec_for(tmp_path / "pulse", motion=False)
    refused = lt.run({**pulse_only, "steadyStarts": True}, tmp_path / "refused")
    assert refused["outcome"] == "failed" and "made with the hand still" in refused["message"]


def test_the_cut_off_catches_the_most_starts_within_the_false_activation_budget() -> None:
    def summary(caught: int, false: int) -> dict:
        # An hour without the gesture: the false activations are the rate per hour.
        return {"recordings": 1, "gestures": 10, "caught": caught, "gestureRecall": caught / 10, "repeats": 0, "late": 0,
                "medianLatencyMs": 900.0, "falseActivations": false, "negativeSeconds": 3600.0, "falseActivationsPerHour": float(false)}
    table = {t: summary(caught, false) for t, caught, false in [(0.3, 9, 60), (0.5, 8, 45), (0.6, 7, 30), (0.7, 7, 20), (0.8, 4, 5)]}
    an_hour = np.array([0, 3600 * 10**9])
    recording = SimpleNamespace(session_id="r")
    original = (lt.summarise, lt.detections, lt.THRESHOLD_CANDIDATES)
    try:
        lt.summarise = lambda per_recording: per_recording[0]
        lt.detections = lambda spec, r, times, scores, policy: table[policy.activation]
        lt.THRESHOLD_CANDIDATES = tuple(table)
        spec = lt.Spec("pinch", [], [], {}, [], [], False, 17)
        threshold, events = lt.budget_threshold(spec, [(recording, an_hour, None)])
        # 0.6 and 0.7 both catch 7 within 30 an hour: the higher cut-off wins the tie.
        assert threshold == 0.7 and events["withinTarget"] and events["falseActivationsPerHour"] == 20
        # None within it: the most caught less false (0.8: 6 - 55 = -49 beats 0.7: 7 - 60 = -53).
        table.update({0.3: summary(9, 90), 0.5: summary(8, 80), 0.6: summary(7, 70), 0.7: summary(7, 60), 0.8: summary(6, 55)})
        threshold, events = lt.budget_threshold(spec, [(recording, an_hour, None)])
        assert threshold == 0.8 and not events["withinTarget"]
        # Never simply the highest cut-off when a lower one catches far more for its false activations.
        table.update({0.7: summary(9, 55), 0.8: summary(1, 51)})
        assert lt.budget_threshold(spec, [(recording, an_hour, None)])[0] == 0.7
    finally:
        lt.summarise, lt.detections, lt.THRESHOLD_CANDIDATES = original


def test_a_firing_during_a_pinch_is_a_repeat_or_late_and_only_one_with_no_gesture_under_way_is_false(monkeypatch) -> None:
    ms = 1_000_000
    t = np.arange(0, 20_000, 10, dtype=np.int64) * ms
    labels = np.full(len(t), "", dtype=object)
    for start, end, label in [(2000, 2300, "pinch_in"), (2300, 4000, "pinch_hold"), (4000, 4300, "pinch_out"),
                              (10000, 10300, "pinch_in"), (10300, 12000, "pinch_hold"), (12000, 12300, "pinch_out"),
                              (15000, 16000, "fist")]:
        labels[(t >= start * ms) & (t < end * ms)] = label
    recording = SimpleNamespace(timestamps_ns=t, raw_labels=labels)
    # Caught 0.9 s after the first pinch, again during its hold, late in the second, during a fist, and with nothing held.
    rises = [2900, 3500, 11500, 15500, 18000]
    monkeypatch.setattr(lt, "detect", lambda times, scores, policy: [(r * ms, None) for r in rises])
    spec = lt.Spec("pinch_in", ["fist", "pinch_hold", "pinch_out"], [], {}, [], [], False, 17)
    counted = lt.detections(spec, recording, t, np.zeros(len(t)), lt.policy_for(0.5, "peak"))
    assert (counted["gestures"], counted["caught"], counted["repeats"], counted["late"], counted["falseActivations"]) == (2, 1, 1, 1, 2)
    assert counted["falseOn"] == {"fist": 1, "unlabelled": 1}
    # Time without the gesture leaves out both pinches, from their start through pinch out.
    assert counted["negativeNs"] == (19_990 - 2_290 - 2_290) * ms
    assert lt.gesture_episodes(lt.ppg_onset.holds(t, labels), "pinch_in") == [(2000 * ms, 4290 * ms), (10000 * ms, 12290 * ms)]


def test_results_are_judged_on_the_camera_timed_recordings_when_there_are_enough_of_them() -> None:
    def part(gestures: int, caught: int, false: int, seconds: float) -> dict:
        return {"gestures": gestures, "caught": caught, "repeats": 0, "late": 0, "falseActivations": false, "latenciesMs": [],
                "negativeNs": int(seconds * 1e9)}
    spec = lt.Spec("pinch_in", [], [], {}, [], [], False, 17, label_timing={"a": "camera", "b": "estimated"})
    judged = lt.cohort(spec, [("a", part(25, 10, 3, 600)), ("b", part(30, 28, 0, 600))])
    assert judged["cohort"] == "camera" and (judged["gestures"], judged["caught"]) == (25, 10)
    assert judged["byLabelTiming"]["estimated"]["caught"] == 28
    # Too few camera-timed gestures to judge by: all of them, still split by timing.
    few = lt.cohort(spec, [("a", part(5, 2, 0, 600)), ("b", part(30, 28, 0, 600))])
    assert few["cohort"] == "all" and few["gestures"] == 35 and set(few["byLabelTiming"]) == {"camera", "estimated"}
    # No timings given: all, as before.
    plain = lt.cohort(lt.Spec("pinch_in", [], [], {}, [], [], False, 17), [("a", part(25, 10, 3, 600))])
    assert plain == {**lt.summarise([part(25, 10, 3, 600)]), "cohort": "all"}


def test_a_recording_of_everyday_noise_is_judged_with_the_camera_timed_ones() -> None:
    def part(gestures: int, caught: int, false: int, seconds: float) -> dict:
        return {"gestures": gestures, "caught": caught, "repeats": 0, "late": 0, "falseActivations": false, "latenciesMs": [],
                "negativeNs": int(seconds * 1e9)}
    timing = {"a": "camera", "b": "estimated", "n": "noGesture"}
    spec = lt.Spec("pinch_in", [], [], {}, [], [], False, 17, label_timing=timing)
    judged = lt.cohort(spec, [("a", part(25, 10, 3, 600)), ("b", part(30, 28, 0, 600)), ("n", part(0, 0, 6, 1800))])
    # Its false activations and its time count with the camera-timed recordings'; the estimated ones stay apart.
    assert judged["cohort"] == "camera" and (judged["gestures"], judged["falseActivations"]) == (25, 9)
    assert judged["falseActivationsPerHour"] == pytest.approx(9 / (2400 / 3600))
    assert judged["byLabelTiming"]["noGesture"]["falseActivations"] == 6
    # Camera-timed and noise only: nothing to set apart, so all of them.
    only = lt.Spec("pinch_in", [], [], {}, [], [], False, 17, label_timing={"a": "camera", "n": "noGesture"})
    assert lt.cohort(only, [("a", part(25, 10, 3, 600)), ("n", part(0, 0, 6, 1800))])["cohort"] == "all"


def test_a_recording_with_no_gesture_gives_the_trees_many_more_moments_of_what_is_not_it(tmp_path: Path) -> None:
    ms = 1_000_000
    ts = np.arange(0, 300_000, 40, dtype=np.int64) * ms                     # five minutes of pulse samples
    held = [(10_000 * ms, 290_000 * ms, "everything_else")]
    few = ppg_onset.sample_decisions(ts, held, "pinch_in", set())
    many = ppg_onset.sample_decisions(ts, held, "pinch_in", set(), most=150)
    assert len(few[0]) <= 2 * ppg_onset.PER_KIND + 1 and len(many[0]) > 100 and not many[1].any()


def test_hard_negatives_train_it_again_with_the_moments_it_fired_by_mistake(monkeypatch) -> None:
    spec = lt.Spec("pinch_in", ["everything_else"], [], {}, ["r"], [], False, 17, hard_negatives=True)
    train = lt.Examples(np.ones((4, 2)), np.array([1, 0, 1, 0]), np.array(["r"] * 4), [], np.arange(4))
    monkeypatch.setattr(lt, "timeline", lambda spec, recording, predict: (np.arange(3), np.zeros(3)))
    monkeypatch.setattr(lt, "detections", lambda *args: {"falseRisesNs": [7, 9]})
    monkeypatch.setattr(lt, "inputs", lambda spec, recording, rises: np.full((len(rises), 2), 5.0))
    fitted = {}
    monkeypatch.setattr(lt, "fit", lambda x, y, seed, backend=lt.BACKEND: fitted.update(x=x, y=y) or "again")
    first = SimpleNamespace(predict_proba=lambda x: np.zeros((len(x), 2)))
    model, mined = lt.reinforce(spec, first, train, {"r": None}, ["r"])
    assert (model, mined) == ("again", 2)
    assert fitted["x"].shape == (6, 2) and fitted["y"].tolist() == [1, 0, 1, 0, 0, 0]
    # Off unless asked for.
    assert lt.reinforce(lt.Spec("pinch_in", [], [], {}, ["r"], [], False, 17), first, train, {"r": None}, ["r"]) == (first, 0)


def test_a_model_trained_with_hard_negatives_says_how_many(tmp_path: Path) -> None:
    result = lt.run({**spec_for(tmp_path, motion=True, every_s=5.0), "hardNegatives": True}, tmp_path / "run")
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    manifest = json.loads((tmp_path / "run" / "bundle" / "manifest.json").read_text())
    assert result["metrics"]["hardNegatives"] == manifest["provenance"]["hardNegatives"] >= 0


def test_a_motion_model_without_motion_samples_has_nothing_to_learn_from(tmp_path: Path) -> None:
    spec = {**spec_for(tmp_path), "sources": ["watchPpg", "watchOrientation"]}           # pulse-only recordings
    result = lt.run(spec, tmp_path / "run")
    assert result["outcome"] == "failed" and "starts of the target label" in result["message"]


def test_a_label_with_no_role_is_refused_rather_than_taken_as_negative(tmp_path: Path) -> None:
    spec = lt.parse_spec({**spec_for(tmp_path, train=1, evaluation=1), "negatives": []})
    with pytest.raises(lt.TrainingRefused, match="fist"):
        lt.check_labels(spec, lt.load_spec_recordings(spec))


def test_a_trained_model_ships_as_trees_that_give_its_answers(tmp_path: Path) -> None:
    result = lt.run(spec_for(tmp_path), tmp_path / "run")
    assert result["outcome"] == "deployable", result["message"]
    bundle = tmp_path / "run" / "bundle"
    manifest = json.loads((bundle / "manifest.json").read_text())
    data = (bundle / "model.trees").read_bytes()
    assert manifest["model"] == {"file": "model.trees", "sha256": hashlib.sha256(data).hexdigest(), "format": "trees", "opset": 0}
    assert manifest["input"]["features"] == list(ppg_onset.FEATURE_NAMES) and manifest["input"]["shape"] == [None, 1701]
    assert manifest["sources"] == ["watchPpg"] and manifest["preprocessing"] == {"kind": "ppg_multiscale_onset"}
    assert manifest["window"] == {"durationMs": 5640, "strideMs": 40, "maxGapMs": 250, "minSamples": 100}
    assert manifest["thresholds"]["cooldownMs"] == 1500
    assert len(manifest["input"]["trainingRange"]["low"]) == 1701
    assert trees.read(data)[0] == 1701 and len(trees.read(data)[1]) == lt.TREES
    assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE
    metrics = result["metrics"]
    assert metrics["rocAuc"] > 0.9  # a step up is easy to tell from a step down
    events = metrics["events"]
    assert events["gestures"] > 0 and events["caught"] / events["gestures"] >= 0.8
    assert 680 <= events["medianLatencyMs"] <= 1280
    inspection = json.loads((tmp_path / "run" / "inspection.json").read_text())
    assert inspection["kind"] == "trees" and inspection["importance"][0]["name"] in ppg_onset.FEATURE_NAMES
    held = inspection["evaluation"]
    assert len(held["probabilities"]) == len(held["labels"]) == len(held["recordings"]) == metrics["windows"]


@pytest.mark.strict_gate
def test_a_model_that_cannot_go_live_is_still_written_so_it_can_run_in_monitor(tmp_path: Path) -> None:
    # Two 20 s held-out recordings hold too little time without a pinch to trust a false-alarm rate.
    result = lt.run(spec_for(tmp_path, seconds=20.0), tmp_path / "run")
    assert result["outcome"] == "evaluationOnly"
    assert "too little to tell how often it would fire by mistake" in result["message"]
    assert result["bundleDir"] == "bundle" and (tmp_path / "run" / "bundle" / "model.trees").is_file()


def test_the_cut_off_is_chosen_on_the_training_recordings_only(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path, train=4, evaluation=1))
    recordings = lt.load_spec_recordings(spec)
    train = lt.examples(spec, recordings, spec.train)
    threshold, source, cross_check, events = lt.out_of_fold_threshold(spec, train, recordings)
    assert source == "trainingRecordings" and 0.05 <= threshold <= 0.95 and cross_check > 0.9 and events is None
    alone = lt.Examples(train.x, train.y, np.array(["r0"] * len(train.y)), train.kinds, train.decisions)
    assert lt.out_of_fold_threshold(spec, alone, recordings) == (lt.ACTIVATION, "default", None, None)


def test_too_few_starts_to_learn_from_is_refused(tmp_path: Path) -> None:
    for i in range(2):
        write_pulse_recording(tmp_path, f"q{i}", seed=i, seconds=12.0, gestures=("pinch",), every_s=20.0)
    spec = {**spec_for(tmp_path, train=1, evaluation=1), "recordings": {f"q{i}": str(tmp_path / f"q{i}.csv") for i in range(2)}, "train": ["q0"], "evaluation": ["q1"]}
    result = lt.run(spec, tmp_path / "run")
    assert result["outcome"] == "failed" and "starts of the target label" in result["message"]


def test_a_model_whose_training_recordings_disagree_is_not_kept_however_it_did_on_the_test_ones() -> None:
    rng = np.random.default_rng(5)
    y = np.array([1] * 50 + [0] * 50)
    metrics = lt.evaluate(np.concatenate([rng.uniform(0.6, 1, 50), rng.uniform(0, 0.4, 50)]), y, 0.5, "trainingRecordings")
    metrics["crossCheckRocAuc"] = 0.55
    assert "do not agree with each other" in (lt.verdict(metrics) or "")


def test_when_no_cut_off_kept_the_false_alarms_down_the_message_names_the_label_they_fell_on() -> None:
    y = np.array([1] * 50 + [0] * 500)
    metrics = lt.evaluate(np.concatenate([np.full(50, 0.5), np.full(500, 0.1)]), y, 0.99, "trainingRecordings")
    assert metrics["balancedAccuracy"] < lt.MIN_BALANCED_ACCURACY
    assert "Record more sessions" in lt.verdict(metrics)
    metrics["crossCheckEvents"] = {"gestures": 140, "caught": 0, "falseActivations": 50, "withinTarget": False,
                                   "falseOn": {"pinch": 38, "unlabelled": 9, "fist": 3}}
    message = lt.verdict(metrics)
    assert "caught 0 of 140 starts there and fired 50 times" in message and "38 of those were during 'pinch'" in message
    assert "Record more sessions" not in message
    metrics["crossCheckEvents"]["falseOn"] = {"unlabelled": 50}
    assert "Record more ordinary activity" in lt.verdict(metrics)
    metrics["crossCheckEvents"]["withinTarget"] = True
    assert "Record more sessions" in lt.verdict(metrics)


def test_a_false_activation_is_counted_by_the_label_it_fell_on() -> None:
    ms = 1_000_000
    t = np.arange(0, 20_000, 10, dtype=np.int64) * ms
    labels = np.array([""] * len(t), dtype=object)
    labels[(t >= 2_000 * ms) & (t < 2_400 * ms)] = "pinch_in"
    labels[(t >= 8_000 * ms) & (t < 10_000 * ms)] = "pinch"
    recording = type("R", (), {"timestamps_ns": t, "raw_labels": labels})()
    spec = type("S", (), {"target": "pinch_in", "excludes": (), "decision_delay_ms": 500, "steady_starts": False})()
    scores = np.zeros(len(t))
    for at_ms in (2_500, 8_600, 15_000):  # a catch, one during 'pinch', one in nothing
        scores[(t >= at_ms * ms) & (t < (at_ms + 60) * ms)] = 1.0
    out = lt.detections(spec, recording, t, scores, lt.policy_for(0.5, "peak"))
    assert out["caught"] == 1 and out["falseActivations"] == 2
    assert out["falseOn"] == {"pinch": 1, "unlabelled": 1}


def test_a_model_that_flags_every_other_moment_is_not_kept_however_good_its_f1() -> None:
    rng = np.random.default_rng(3)
    y = np.array([1] * 342 + [0] * 6)
    probability = np.concatenate([rng.uniform(0.2, 1.0, 342), rng.uniform(0.06, 0.3, 6)])
    metrics = lt.evaluate(probability, y, 0.05, "trainingRecordings")
    assert metrics["f1"] > 0.95 and metrics["falseActivationRate"] == 1.0
    assert "wrongly flagged 100%" in (lt.verdict(metrics) or "")
