"""Editing a trained model by hand: that an edit does what it says, is scored like any model, and never touches the original."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("onnxruntime")

from label_trainer import label_train as lt  # noqa: E402
from label_trainer.edits import EditRefused, apply_edits, restore_model  # noqa: E402
from label_trainer.inspection import extract, forward  # noqa: E402

from .test_label_train import spec_for  # noqa: E402


def train(tmp_path: Path, backend: str, **over):
    raw = spec_for(tmp_path, backend, **over)
    out = tmp_path / "run"
    result = lt.run(raw, out)
    assert result["outcome"] == "deployable", result["message"]
    return raw, out, result


def edited(tmp_path: Path, raw: dict, source: Path, edits: list[dict], name: str = "edited"):
    """The way the desktop asks for an edit: the same spec, plus where the model is and what to change."""
    spec = {**raw, "edit": {"fromDir": str(source), "fromModel": "snap-v1", "edits": edits}}
    out = tmp_path / name
    return lt.run(spec, out), out


@pytest.mark.parametrize("backend", ["logreg", "mlp", "torch-mlp", "cnn1d"])
def test_every_method_saves_its_parameters_and_can_be_restored_exactly(tmp_path: Path, backend: str) -> None:
    if backend in ("torch-mlp", "cnn1d"):
        pytest.importorskip("torch")
    extra = {"gridSteps": 8, "network": {"epochs": 10}} if backend == "cnn1d" else {"network": {"epochs": 10}} if backend == "torch-mlp" else {}
    raw, out, _ = train(tmp_path, backend, **extra)
    spec = lt.parse_spec(raw)
    x_train, y_train, x_eval, y_eval = lt.build_matrices(spec)
    again = restore_model(spec, out)
    onnx = lt.onnx_probabilities(out / "model.onnx", x_eval)[:, 1]
    assert np.max(np.abs(again.predict_proba(x_eval)[:, 1] - onnx)) < 1e-4  # the restored model is the one that was shipped


def test_switching_an_input_off_makes_the_model_ignore_it(tmp_path: Path) -> None:
    raw, out, _ = train(tmp_path, "logreg", features=["accel_x_std", "accel_x_mean", "gyro_x_std"])
    spec = lt.parse_spec(raw)
    _, _, x_eval, _ = lt.build_matrices(spec)
    model = restore_model(spec, out)
    before = model.predict_proba(x_eval)[:, 1]
    said = apply_edits(spec, model, [{"kind": "disableInput", "input": "accel_x_std"}])
    assert said == ["switched off accel_x_std"]
    shuffled = x_eval.copy()
    shuffled[:, spec.features.index("accel_x_std")] = np.random.default_rng(1).permutation(shuffled[:, spec.features.index("accel_x_std")])
    assert np.allclose(model.predict_proba(x_eval)[:, 1], model.predict_proba(shuffled)[:, 1])  # nothing it reads changes with that input
    assert not np.allclose(before, model.predict_proba(x_eval)[:, 1])


def test_an_edited_model_is_scored_exported_and_described_as_a_new_model_and_the_original_is_untouched(tmp_path: Path) -> None:
    raw, out, original = train(tmp_path, "logreg", features=["accel_x_std", "accel_y_std", "gyro_x_std"])
    sha_before = (out / "bundle" / "model.onnx").read_bytes()
    result, new = edited(tmp_path, raw, out, [{"kind": "setBias", "layer": 0, "neuron": 0, "value": 0.25}, {"kind": "disableInput", "input": "gyro_x_std"}])
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    assert (out / "bundle" / "model.onnx").read_bytes() == sha_before  # the original is exactly as it was
    if result["outcome"] == "deployable":
        manifest = json.loads((new / "bundle" / "manifest.json").read_text())
        assert manifest["provenance"]["editedFrom"] == "snap-v1" and len(manifest["provenance"]["edits"]) == 2
        assert manifest["model"]["sha256"] != json.loads((out / "bundle" / "manifest.json").read_text())["model"]["sha256"]
        assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE
        inspection = json.loads((new / "inspection.json").read_text())
        assert inspection["edit"]["fromModel"] == "snap-v1"
        assert inspection["edit"]["said"] == ["set the bias of neuron 1 in dense layer 1 from " + inspection["edit"]["said"][0].split("from ")[1], "switched off gyro_x_std"]
        assert inspection["edit"]["before"]["rocAuc"] == original["metrics"]["rocAuc"]  # compared with the model it came from
        assert inspection["edit"]["after"]["rocAuc"] == inspection["evaluation"]["metrics"]["rocAuc"]
        assert inspection["forwardMaxAbsDifference"] < 1e-3
        assert (new / "model.pkl").is_file()  # and it can be edited in turn


def test_a_dense_network_can_have_a_weight_set_and_a_neuron_silenced(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "torch-mlp", features=["accel_x_std", "accel_y_std", "gyro_x_std"], network={"hidden": [{"units": 5, "activation": "tanh"}, {"units": 4}], "epochs": 20})
    spec = lt.parse_spec(raw)
    model = restore_model(spec, out)
    p = extract(spec, model)
    apply_edits(spec, model, [
        {"kind": "setWeight", "layer": 0, "row": 1, "column": 2, "value": 0.5},
        {"kind": "silenceNeuron", "layer": 0, "neuron": 3},
        {"kind": "disableInput", "input": "gyro_x_std"},
    ])
    q = extract(spec, model)
    assert q.dense[0].weights[1, 2] == pytest.approx(0.5, abs=1e-6)
    assert np.all(q.dense[1].weights[3, :] == 0)  # nothing downstream listens to neuron 4 of layer 1
    assert np.all(q.dense[0].weights[2, :] == 0)  # gyro_x_std is the third input
    assert q.dense[0].weights[0, 0] == pytest.approx(p.dense[0].weights[0, 0])  # the rest is untouched
    _, _, x_eval, _ = lt.build_matrices(spec)
    assert np.max(np.abs(forward(q, x_eval)[0] - model.predict_proba(x_eval)[:, 1])) < 1e-4  # the inspector still agrees with the model


def test_a_convolutional_model_can_have_a_filter_weight_set_a_filter_silenced_and_a_channel_switched_off(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "cnn1d", gridSteps=8, features=["accel_x", "accel_y", "gyro_x"], network={"conv": [{"filters": 4, "kernel": 3}, {"filters": 3, "kernel": 3}], "epochs": 10})
    spec = lt.parse_spec(raw)
    model = restore_model(spec, out)
    apply_edits(spec, model, [
        {"kind": "setFilterWeight", "layer": 0, "filter": 1, "channel": 2, "tap": 0, "value": 0.75},
        {"kind": "silenceNeuron", "layer": 0, "neuron": 2, "conv": True},
        {"kind": "silenceNeuron", "layer": 1, "neuron": 1, "conv": True},
        {"kind": "disableInput", "input": "accel_y"},
    ])
    q = extract(spec, model)
    assert q.conv[0].weights[1, 2, 0] == pytest.approx(0.75, abs=1e-6)
    assert np.all(q.conv[1].weights[:, 2, :] == 0)  # nothing in the next layer listens to filter 3 of layer 1
    assert np.all(q.dense[0].weights[[1, 1 + 3], :] == 0) if q.dense else np.all(q.output.weights[[1, 1 + 3], :] == 0)  # nor does the output to filter 2 of layer 2 (average and maximum)
    assert np.all(q.conv[0].weights[:, 1, :] == 0)  # the accel_y channel
    _, _, x_eval, _ = lt.build_matrices(spec)
    assert np.max(np.abs(forward(q, x_eval)[0] - model.predict_proba(x_eval)[:, 1])) < 1e-4


@pytest.mark.parametrize("edit,message", [
    ({"kind": "teleport"}, "unknown kind"),
    ({"kind": "disableInput", "input": "ppg_green_mean"}, "no input"),
    ({"kind": "setWeight", "layer": 5, "row": 0, "column": 0, "value": 1}, "layer must be"),
    ({"kind": "setWeight", "layer": 0, "row": 99, "column": 0, "value": 1}, "row must be"),
    ({"kind": "setWeight", "layer": 0, "row": 0, "column": 0, "value": float("inf")}, "finite"),
    ({"kind": "setFilterWeight", "layer": 0, "filter": 0, "channel": 0, "tap": 0, "value": 1}, "only a convolutional"),
    ({"kind": "silenceNeuron", "layer": 0, "neuron": 0}, "layer must be"),  # the logistic regression has only the answer layer
])
def test_an_edit_that_does_not_fit_is_refused_and_changes_nothing(tmp_path: Path, edit: dict, message: str) -> None:
    raw, out, _ = train(tmp_path, "logreg", features=["accel_x_std", "accel_y_std"])
    spec = lt.parse_spec(raw)
    model = restore_model(spec, out)
    before = model.named_steps["model"].coef_.copy()
    bias_before = model.named_steps["model"].intercept_.copy()
    with pytest.raises(EditRefused, match=message):
        apply_edits(spec, model, [{"kind": "setBias", "layer": 0, "neuron": 0, "value": 0.1}, edit])
    # Refused part-way, but nothing was written back: the first (fine) edit did not leak into the model.
    assert np.array_equal(model.named_steps["model"].coef_, before)
    assert np.array_equal(model.named_steps["model"].intercept_, bias_before)
    with pytest.raises(EditRefused, match="nothing to change"):
        apply_edits(spec, model, [])


def test_a_model_without_saved_parameters_says_so(tmp_path: Path) -> None:
    raw, out, _ = train(tmp_path, "logreg")
    (out / "model.pkl").unlink()
    result, _ = edited(tmp_path, raw, out, [{"kind": "setBias", "layer": 0, "neuron": 0, "value": 0.1}])
    assert result["outcome"] == "failed" and "cannot be edited" in result["message"]
