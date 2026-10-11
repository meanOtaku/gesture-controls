"""The Inspect view's data: that what it shows is what the model computes, for every method and design."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("onnxruntime")

from label_trainer import label_train as lt  # noqa: E402
from label_trainer.inspection import extract, forward  # noqa: E402

from .test_label_train import spec_for  # noqa: E402


def trained(tmp_path: Path, backend: str, **over):
    spec = spec_for(tmp_path, backend, **over)
    out = tmp_path / "run"
    result = lt.run(spec, out)
    assert result["outcome"] == "deployable", result["message"]
    return json.loads((out / "inspection.json").read_text()), lt.parse_spec(spec), out


@pytest.mark.parametrize("backend", ["logreg", "mlp", "torch-mlp"])
def test_a_statistics_model_is_inspectable_down_to_each_input(tmp_path: Path, backend: str) -> None:
    if backend == "torch-mlp":
        pytest.importorskip("torch")
    inspection, spec, _ = trained(tmp_path, backend)
    names = [i["name"] for i in inspection["inputs"]]
    assert names == spec.features and inspection["inputKind"] == "features"
    assert inspection["forwardMaxAbsDifference"] < 1e-3  # what is shown is what the model computes
    assert [i["name"] for i in inspection["importance"]] == names
    assert all(i["std"] > 0 for i in inspection["inputs"])
    kinds = {"logreg": "linear", "mlp": "dense", "torch-mlp": "dense"}
    assert inspection["network"]["kind"] == kinds[backend]
    first = inspection["network"]["dense"][0] if inspection["network"]["dense"] else inspection["network"]["output"]
    assert len(first["weights"]) == len(names)  # one row of weights per input
    # The windows come from the held-out recordings, with what each input took as its value and how much each moved the answer.
    assert inspection["windows"] and {w["recording"] for w in inspection["windows"]} <= set(spec.evaluation)
    window = inspection["windows"][0]
    assert len(window["values"]) == len(names) == len(window["contributions"])
    assert window["category"] in {"truePositive", "falseNegative", "trueNegative", "falsePositive"}
    evaluation = inspection["evaluation"]
    assert len(evaluation["probabilities"]) == len(evaluation["labels"]) == len(evaluation["recordings"])
    assert set(evaluation["recordings"]) <= set(spec.evaluation)
    assert evaluation["metrics"]["rocAuc"] > 0.9


def test_the_inputs_that_matter_are_the_ones_the_gesture_changes(tmp_path: Path) -> None:
    # The "snap" is vigorous acceleration against quiet: its spread tells the two apart, its average does not. (With every
    # input offered each one is redundant, and shuffling any single one costs nothing, which importance would show too.)
    inspection, _, _ = trained(tmp_path, "logreg", features=["accel_x_std", "accel_x_mean"])
    drops = {i["name"]: i["aucDrop"] for i in inspection["importance"]}
    assert drops["accel_x_std"] > 0.2
    assert drops["accel_x_std"] > 5 * abs(drops["accel_x_mean"])


def test_a_convolutional_model_shows_its_filters_feature_maps_and_what_each_stretch_of_each_channel_did(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    inspection, spec, _ = trained(tmp_path, "cnn1d", gridSteps=16, network={"epochs": 25}, movementOnly=True)
    assert inspection["inputKind"] == "channels" and inspection["gridSteps"] == 16 and inspection["centreWindows"] is True
    assert inspection["forwardMaxAbsDifference"] < 1e-3
    conv = inspection["network"]["conv"]
    assert len(conv) == 2 and np.array(conv[0]["weights"]).shape == (16, len(spec.features), 5)
    window = inspection["windows"][0]
    assert len(window["values"]) == len(spec.features) * 16
    assert np.array(window["activations"][0]).shape == (16, 16)  # filters x steps
    blocks = -(-16 // inspection["windows"][0]["occlusion"]["blockSteps"])
    assert np.array(window["occlusion"]["drop"]).shape == (len(spec.features), blocks)
    assert [i["name"] for i in inspection["importance"]] == spec.features


@pytest.mark.parametrize("pooling", ["mean_max", "mean", "max"])
@pytest.mark.parametrize("activation", ["relu", "tanh", "sigmoid", "leaky_relu"])
def test_the_numpy_forward_pass_agrees_with_the_model_for_every_design(activation: str, pooling: str) -> None:
    torch = pytest.importorskip("torch")
    from label_trainer.network import parse_network
    from label_trainer.nets import CnnModel, TorchModel

    rng = np.random.default_rng(3)
    dense = parse_network({"hidden": [{"units": 7, "activation": activation}, {"units": 5, "activation": "relu"}], "epochs": 5}, "torch-mlp")
    x = rng.normal(5, 3, (60, 9)).astype(np.float32)
    y = (x[:, 0] > 5).astype(np.int64)
    model = TorchModel(9, 1, {}, dense).fit(x, y)
    spec = type("S", (), {"backend": "torch-mlp", "features": [f"f{i}" for i in range(9)]})()
    p = extract(spec, model)
    assert np.max(np.abs(forward(p, x)[0] - model.predict_proba(x)[:, 1])) < 1e-4

    cnn = parse_network({"conv": [{"filters": 4, "kernel": 3, "activation": activation}, {"filters": 3, "kernel": 5}], "pooling": pooling, "hidden": [{"units": 4, "activation": activation}], "epochs": 5, "augment": False}, "cnn1d")
    grid = rng.normal(0, 1, (50, 3 * 12)).astype(np.float32)
    labels = (grid[:, :12].mean(axis=1) > 0).astype(np.int64)
    for centre in (False, True):
        model = CnnModel(3, 12, 1, {}, centre, cnn).fit(grid, labels)
        spec = type("S", (), {"backend": "cnn1d", "features": ["a", "b", "c"]})()
        p = extract(spec, model)
        assert np.max(np.abs(forward(p, grid)[0] - model.predict_proba(grid)[:, 1])) < 1e-4, (activation, pooling, centre)
    assert torch


def test_the_inspection_never_stops_a_model_being_shipped(tmp_path: Path, monkeypatch) -> None:
    from label_trainer import inspection

    def boom(*args, **kwargs):
        raise RuntimeError("no inspection today")

    monkeypatch.setattr(inspection, "build_inspection", boom)
    out = tmp_path / "run"
    result = lt.run(spec_for(tmp_path, "logreg"), out)
    assert result["outcome"] == "deployable"
    assert (out / "bundle" / "model.onnx").exists() and not (out / "inspection.json").exists()


def test_the_research_checks_retrain_on_less_data_and_on_all_but_one_recording(tmp_path: Path) -> None:
    inspection, spec, _ = trained(tmp_path, "logreg", research=True)
    research = inspection["research"]
    curve = research["learningCurve"]
    assert [row["fraction"] for row in curve] == [0.25, 0.5, 0.75, 1.0]
    assert [row["windows"] for row in curve] == sorted(row["windows"] for row in curve)  # more data each time
    assert all(0.0 <= row["aucMean"] <= 1.0 and row["aucStd"] >= 0 for row in curve)
    assert curve[-1]["draws"] == 1 and curve[0]["draws"] == 3
    loo = research["leaveOneOut"]
    assert {fold["recording"] for fold in loo["folds"]} == set(spec.recordings)  # every recording, training and held-out
    scored = [fold for fold in loo["folds"] if "skipped" not in fold]
    assert scored and all(fold["meanScore"] >= 0 for fold in scored)
    assert loo["pooledAuc"] is not None and loo["pooledAuc"] > 0.9
    assert loo["pooledWindows"] == sum(fold["windows"] for fold in scored)


def test_without_asking_there_are_no_research_checks_and_a_failure_does_not_stop_the_model(tmp_path: Path, monkeypatch) -> None:
    inspection, _, _ = trained(tmp_path, "logreg")
    assert inspection["research"] is None
    from label_trainer import research

    monkeypatch.setattr(research, "run_research", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no research today")))
    out = tmp_path / "again"
    result = lt.run(spec_for(tmp_path, "logreg", research=True), out)
    assert result["outcome"] == "deployable"
    assert json.loads((out / "inspection.json").read_text())["research"] is None


def test_a_recording_that_leaves_too_little_to_train_on_is_skipped_with_the_reason() -> None:
    from label_trainer.research import leave_one_recording_out

    class Const:
        def __init__(self, *a):
            pass

        def predict_proba(self, x):
            return np.tile([0.5, 0.5], (len(x), 1))

    y = np.array([1] * 12 + [0] * 12 + [1] * 12)
    groups = np.array(["a"] * 12 + ["b"] * 12 + ["c"] * 12)
    result = leave_one_recording_out(lambda x, y: Const(), np.zeros((36, 2)), y, groups)
    by = {f["recording"]: f for f in result["folds"]}
    assert "skipped" in by["b"] and "only 24 windows of the gesture and 0" in by["b"]["skipped"]  # without b there is nothing else to train on
    assert "skipped" not in by["a"] or "gesture" in by["a"]["skipped"]
