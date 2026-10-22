"""Training a pinch-start model end to end on synthetic pulse recordings, and the checks around it."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

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
    assert manifest["thresholds"]["activation"] in lt.THRESHOLD_CANDIDATES
    assert trees.read((bundle / "model.trees").read_bytes())[0] == 2733
    assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE
    metrics = result["metrics"]
    assert metrics["rocAuc"] > 0.9 and metrics["thresholdSource"] == "trainingRecordings"
    # The cut-off was chosen on a replay of the training recordings, each scored by a model that had not seen it.
    cross = metrics["crossCheckEvents"]
    assert cross["gestures"] > 0 and cross["targetFalseActivationsPerMinute"] == lt.TARGET_FALSE_ACTIVATIONS_PER_MINUTE
    events = metrics["events"]
    assert events["policy"]["trigger"] == "peak"
    assert events["gestures"] > 0 and events["caught"] / events["gestures"] >= 0.5
    assert 680 <= events["medianLatencyMs"] <= 1280


def test_the_cut_off_catches_the_most_starts_within_the_false_activation_target() -> None:
    def summary(caught: int, false: int) -> dict:
        return {"recordings": 1, "gestures": 10, "caught": caught, "gestureRecall": caught / 10, "repeats": 0, "medianLatencyMs": 900.0,
                "falseActivations": false, "negativeSeconds": 60.0, "falseActivationsPerHour": float(false) * 60}
    # Ten minutes of recording: the target is 20 false activations.
    table = {t: summary(caught, false) for t, caught, false in [(0.3, 9, 40), (0.5, 8, 25), (0.6, 7, 20), (0.7, 7, 12), (0.8, 4, 5)]}
    ten_minutes = np.array([0, 600 * 10**9])
    original = (lt.summarise, lt.detections, lt.THRESHOLD_CANDIDATES)
    try:
        lt.summarise = lambda per_recording: per_recording[0]
        lt.detections = lambda spec, r, times, scores, policy: table[policy.activation]
        lt.THRESHOLD_CANDIDATES = tuple(table)
        spec = lt.Spec("pinch", [], [], {}, [], [], False, 17)
        threshold, events = lt.budget_threshold(spec, [(None, ten_minutes, None)])
        # 0.6 and 0.7 both catch 7 within 2 a minute: the higher cut-off wins the tie.
        assert threshold == 0.7 and events["withinTarget"] and events["falseActivationsPerMinute"] == 1.2
        # None within it: the most caught less false (0.8: 6 - 25 = -19 beats 0.7: 7 - 30 = -23).
        table.update({0.3: summary(9, 60), 0.5: summary(8, 50), 0.6: summary(7, 40), 0.7: summary(7, 30), 0.8: summary(6, 25)})
        threshold, events = lt.budget_threshold(spec, [(None, ten_minutes, None)])
        assert threshold == 0.8 and not events["withinTarget"]
        # Never simply the highest cut-off when a lower one catches far more for its false activations.
        table.update({0.7: summary(9, 25), 0.8: summary(1, 21)})
        assert lt.budget_threshold(spec, [(None, ten_minutes, None)])[0] == 0.7
    finally:
        lt.summarise, lt.detections, lt.THRESHOLD_CANDIDATES = original


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


def test_a_model_that_flags_every_other_moment_is_not_kept_however_good_its_f1() -> None:
    rng = np.random.default_rng(3)
    y = np.array([1] * 342 + [0] * 6)
    probability = np.concatenate([rng.uniform(0.2, 1.0, 342), rng.uniform(0.06, 0.3, 6)])
    metrics = lt.evaluate(probability, y, 0.05, "trainingRecordings")
    assert metrics["f1"] > 0.95 and metrics["falseActivationRate"] == 1.0
    assert "wrongly flagged 100%" in (lt.verdict(metrics) or "")
