"""One v2 CNN for several gestures: what it writes for each, and its confusion matrices."""
import json

import numpy as np
import pytest

from label_trainer import cnn, cnn_v2, label_train as lt, multi_gesture

from .pulse_data import spec_for


def multi_spec(tmp_path):
    spec = {**spec_for(tmp_path, motion=True, every_s=5.0, motion_hz=100), "backend": lt.CNN_V2_BACKEND, "motionHz": 100}
    return {**spec, "negatives": [], "gestures": ["pinch", "fist"]}


def test_a_multi_gesture_spec_is_the_v2_cnn_alone_with_its_target_first(tmp_path):
    spec = multi_spec(tmp_path)
    assert lt.parse_spec(spec).classes == ("pinch", "fist")
    for change in ({"backend": lt.CNN_BACKEND}, {"gestures": ["fist", "pinch"]}, {"gestures": ["pinch"]},
                   {"gestures": ["pinch", "pinch"]}):
        with pytest.raises(lt.TrainingRefused):
            lt.parse_spec({**spec, **change})


def test_the_labels_say_which_gesture_starts(tmp_path):
    spec = lt.parse_spec(multi_spec(tmp_path))
    recording = lt.load_spec_recordings(spec)[spec.train[0]]
    _, y, _ = lt.cnn_examples(spec, recording)
    assert set(np.unique(y).tolist()) == {0, 1, 2}


def test_moments_are_confused_by_what_passes_each_cut_off():
    spec = lt.Spec(target="a", negatives=[], excludes=[], recordings={}, train=[], evaluation=[], research=False, seed=1,
                   backend=lt.CNN_V2_BACKEND, classes=("a", "b"))
    p = np.array([[0.9, 0.05, 0.05], [0.1, 0.8, 0.1], [0.1, 0.45, 0.45], [0.2, 0.1, 0.7]])
    m = multi_gesture.moment_confusion(spec, np.array([0, 1, 2, 2]), p, {"a": 0.5, "b": 0.6})
    assert m["labels"] == ["nothing", "a", "b"]
    assert m["counts"] == [[1, 0, 0], [0, 1, 0], [1, 0, 1]]


def test_a_multi_gesture_run_writes_a_model_for_each_gesture_and_the_confusion_matrices(tmp_path, monkeypatch):
    monkeypatch.setattr(cnn_v2, "MEMBERS", 1)
    monkeypatch.setattr(cnn, "EPOCHS", 1)
    result = lt.run(multi_spec(tmp_path), tmp_path / "run")
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    assert set(result["gestures"]) == {"pinch", "fist"}
    model = None
    for index, gesture in enumerate(["pinch", "fist"], 1):
        folder = tmp_path / "run" / "gestures" / gesture
        manifest = json.loads((folder / "bundle" / "manifest.json").read_text())
        assert manifest["targetLabel"] == gesture
        assert manifest["output"]["shape"] == [None, 3] and manifest["output"]["positiveIndex"] == index
        assert manifest["provenance"]["gestures"] == ["pinch", "fist"]
        same = (folder / "bundle" / "model.cnn").read_bytes()
        assert model is None or same == model
        model = same
        inspection = json.loads((folder / "inspection.json").read_text())
        assert inspection["target"] == gesture and inspection["multiGesture"]["gestures"] == ["pinch", "fist"]
    events = result["confusion"]["events"]
    assert [row["gesture"] for row in events["rows"]] == ["pinch", "fist"]
    for row in events["rows"]:
        assert row["starts"] > 0 and set(row["caughtBy"]) == {"pinch", "fist"} and 0 <= row["missed"] <= row["starts"]
    moments = result["confusion"]["moments"]
    assert moments["labels"] == ["nothing", "pinch", "fist"] and len(moments["counts"]) == 3
    assert sum(map(sum, moments["counts"])) == result["evaluationWindows"]
    assert json.loads(model)["outputs"] == ["nothing", "pinch", "fist"]
