"""Training in stages: the plan in the spec, the rows each stage trains on, and stages training one after another."""
import json

import numpy as np
import pytest

from label_trainer import cnn, label_train as lt
from tests.pulse_data import spec_for

torch = pytest.importorskip("torch")  # the `cnn` extra


def raw_spec(stages, backend=lt.CNN_BACKEND, train=("a", "b", "c")):
    return {"version": 1, "target": "pinch", "recordings": {r: "x" for r in (*train, "held")}, "train": list(train),
            "evaluation": ["held"], "backend": backend, "sources": list(lt.MOTION_SOURCES), "stages": stages}


def test_a_plan_is_read_with_its_defaults():
    spec = lt.parse_spec(raw_spec([{"name": "Pinches", "recordings": ["a", "b"]}, {"recordings": ["c"], "rehearse": False, "epochs": 4}]))
    assert spec.stages == (lt.TrainingStage("Pinches", ("a", "b"), True, None), lt.TrainingStage("Stage 2", ("c",), False, 4))
    assert lt.parse_spec(raw_spec([])).stages == ()


@pytest.mark.parametrize(("stages", "backend", "message"), [
    ([{"recordings": ["a", "b", "c"]}], lt.BACKEND, "only the CNN can train in stages"),
    ([{"recordings": ["a", "b", "c", "held"]}], lt.CNN_BACKEND, "not training recordings: held"),
    ([{"recordings": ["a", "b"]}], lt.CNN_BACKEND, "not in any: c"),
    ([{"recordings": []}, {"recordings": ["a", "b", "c"]}], lt.CNN_BACKEND, "stage 1 .* names no recordings"),
    ([{"recordings": ["a", "b", "c"], "epochs": 0}], lt.CNN_BACKEND, "1 to 50 passes"),
    ([{"recordings": ["a", "b", "c"]}] * 9, lt.CNN_BACKEND, "1 to 8 stages"),
])
def test_a_plan_that_cannot_be_followed_is_refused(stages, backend, message):
    with pytest.raises(lt.TrainingRefused, match=message):
        lt.parse_spec(raw_spec(stages, backend))


def test_a_rehearsing_stage_takes_every_earlier_start_and_half_the_other_moments():
    groups = np.array(["a"] * 10 + ["b"] * 10 + [lt.MINED_GROUP] * 2, dtype=object)
    y = np.array([1, 1] + [0] * 8 + [1] + [0] * 9 + [0, 0])
    keep = np.array([False] * 20 + [True, True])
    stages = (lt.TrainingStage("A", ("a",)), lt.TrainingStage("B", ("b",)), lt.TrainingStage("B alone", ("b",), rehearse=False, epochs=2))
    first, second, third = lt.stage_rows(stages, y, groups, keep, seed=1)
    assert first[0].tolist() == list(range(10)) and first[1] is None
    rehearsed = sorted(set(second[0].tolist()) - set(range(10, 20)))
    assert {0, 1} <= set(rehearsed) and len(rehearsed) == 2 + 4     # both of A's starts and half of its 8 other moments
    assert sorted(third[0].tolist()) == list(range(10, 22)) and third[1] == 2  # no rehearsal; the mined rows go last


def test_a_stage_with_no_rows_left_is_skipped():
    groups = np.array(["a"] * 4, dtype=object)
    plan = lt.stage_rows((lt.TrainingStage("held out here", ("b",)), lt.TrainingStage("A", ("a",))), np.array([1, 0, 0, 0]), groups, None, 0)
    assert len(plan) == 1 and plan[0][0].tolist() == [0, 1, 2, 3]


def test_stages_train_one_network_one_after_another(monkeypatch):
    seen = []
    monkeypatch.setattr(cnn, "MEMBERS", 1)
    monkeypatch.setattr(cnn, "_train", lambda net, x, y, keep, epochs, rng: seen.append((id(net), len(y), epochs)))
    x = np.zeros((6, cnn.CHANNELS * cnn.LENGTH))
    cnn.fit_stages([(x[:4], np.array([1, 0, 0, 0]), None, 3), (x[:6], np.array([1, 0, 0, 0, 0, 0]), None, 5)], seed=0)
    assert [(n, e) for _, n, e in seen] == [(4, 3), (6, 5)]
    assert seen[0][0] == seen[1][0], "the second stage continues the first one's network"


def test_one_stage_trains_exactly_as_training_without_a_plan():
    rng = np.random.default_rng(0)
    x = rng.random((80, cnn.CHANNELS * cnn.LENGTH)).astype(np.float32)
    y = (rng.random(80) < 0.2).astype(int)
    epochs, cnn.EPOCHS = cnn.EPOCHS, 1
    try:
        plain = cnn.to_bytes(cnn.fit(x, y, 5))
        staged = cnn.to_bytes(cnn.fit_stages([(x, y, None, 1)], 5))
    finally:
        cnn.EPOCHS = epochs
    assert plain == staged


def test_a_staged_spec_trains_a_bundle_that_records_its_plan(tmp_path, monkeypatch):
    monkeypatch.setattr(cnn, "EPOCHS", 2)
    monkeypatch.setattr(cnn, "MEMBERS", 1)
    for name, value in (("MIN_NEGATIVE_SECONDS", 0.0), ("MAX_FALSE_ACTIVATIONS_PER_HOUR", float("inf")), ("MIN_GESTURE_RECALL", 0.0)):
        monkeypatch.setattr(lt, name, value)
    raw = spec_for(tmp_path, seconds=40.0, every_s=5.0, motion=True)
    raw["backend"] = lt.CNN_BACKEND
    half = len(raw["train"]) // 2
    raw["stages"] = [{"name": "First", "recordings": raw["train"][:half]},
                     {"name": "Second", "recordings": raw["train"][half:], "epochs": 1}]
    result = lt.run(raw, tmp_path / "run")
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    manifest = json.loads((tmp_path / "run" / "bundle" / "manifest.json").read_text())
    assert [s["name"] for s in manifest["provenance"]["trainingStages"]] == ["First", "Second"]
    assert manifest["provenance"]["trainingStages"][1]["epochs"] == 1
