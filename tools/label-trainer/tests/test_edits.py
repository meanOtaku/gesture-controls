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


@pytest.mark.parametrize("backend", ["logreg", "torch-mlp", "cnn1d"])
def test_emphasising_an_input_scales_what_it_feeds_the_first_layer_and_nothing_else(tmp_path: Path, backend: str) -> None:
    if backend != "logreg":
        pytest.importorskip("torch")
    extra = {"gridSteps": 8, "features": ["accel_x", "accel_y", "gyro_x"], "network": {"epochs": 10}} if backend == "cnn1d" else {"features": ["accel_x_std", "accel_y_std", "gyro_x_std"]}
    if backend == "torch-mlp":
        extra["network"] = {"hidden": [{"units": 4}], "epochs": 10}
    raw, out, _ = train(tmp_path, backend, **extra)
    spec = lt.parse_spec(raw)
    model = restore_model(spec, out)
    from label_trainer.edits import _Params

    def first_layer(m):
        p = _Params(spec, m)
        return p.conv[0].copy() if backend == "cnn1d" else p.dense[0][0].copy()

    before = first_layer(model)
    name = spec.features[1]
    said = apply_edits(spec, model, [{"kind": "scaleInput", "input": name, "factor": 3}])
    assert said == [f"multiplied what {name} feeds the first layer by 3"]
    after = first_layer(model)
    if backend == "cnn1d":
        assert np.allclose(after[:, 1, :], before[:, 1, :] * 3)
        assert np.array_equal(after[:, [0, 2], :], before[:, [0, 2], :])
    else:
        assert np.allclose(after[1, :], before[1, :] * 3)
        assert np.array_equal(after[[0, 2], :], before[[0, 2], :])


@pytest.mark.parametrize("factor", [0, -1, 11, True, "2", float("nan")])
def test_an_emphasis_outside_zero_to_ten_is_refused(tmp_path: Path, factor) -> None:
    raw, out, _ = train(tmp_path, "logreg", features=["accel_x_std", "accel_x_mean", "gyro_x_std"])
    spec = lt.parse_spec(raw)
    with pytest.raises(EditRefused, match="factor"):
        apply_edits(spec, restore_model(spec, out), [{"kind": "scaleInput", "input": "accel_x_std", "factor": factor}])
    with pytest.raises(EditRefused, match="no input"):
        apply_edits(spec, restore_model(spec, out), [{"kind": "scaleInput", "input": "nope", "factor": 2}])


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


# ---- fine-tuning --------------------------------------------------------------------------------------------------------

def tuned(tmp_path: Path, raw: dict, source: Path, edits: list[dict], fine_tune: dict, name: str = "tuned"):
    spec = {**raw, "edit": {"fromDir": str(source), "fromModel": "snap-v1", "edits": edits, "fineTune": fine_tune}}
    out = tmp_path / name
    return lt.run(spec, out), out


def test_fine_tuning_carries_on_training_and_holds_what_was_set_by_hand(tmp_path: Path, capsys) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "torch-mlp", features=["accel_x_std", "accel_y_std", "gyro_x_std"], network={"hidden": [{"units": 6}, {"units": 4}], "epochs": 10})
    capsys.readouterr()
    pinned = {"kind": "setWeight", "layer": 0, "row": 0, "column": 1, "value": 0.77}
    result, new = tuned(tmp_path, raw, out, [pinned, {"kind": "disableInput", "input": "gyro_x_std"}], {"epochs": 12, "learningRate": 0.02, "freezeDense": [2]})
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("@curve ")]
    assert len(lines) >= 2 and json.loads(lines[-1][len("@curve "):])["epoch"] == 12  # the desktop draws the fine-tuning as it happens
    spec = lt.parse_spec(raw)
    before = extract(spec, restore_model(spec, out))
    after = extract(spec, restore_model(spec, new))
    assert after.dense[0].weights[0, 1] == pytest.approx(0.77, abs=1e-6)  # held where it was put, however long it trained
    assert np.all(after.dense[0].weights[2, :] == 0)  # the switched-off input stays off
    assert not np.allclose(after.dense[0].weights[1, :], before.dense[0].weights[1, :])  # the rest moved
    assert np.array_equal(after.output.weights, before.output.weights)  # the frozen layer (the output layer) did not
    inspection = json.loads((new / "inspection.json").read_text())
    assert any("fine-tuned for 12 rounds" in line and "dense layer 3 frozen" in line and "held where they were set" in line for line in inspection["edit"]["said"])
    assert inspection["edit"]["fineTune"]["epochs"] == 12
    assert inspection["curve"][-1]["epoch"] == 12  # this run's curve is the fine-tuning


def test_a_convolutional_model_can_be_fine_tuned_with_a_layer_frozen(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "cnn1d", gridSteps=8, features=["accel_x", "accel_y", "gyro_x"], network={"conv": [{"filters": 4, "kernel": 3}, {"filters": 3, "kernel": 3}], "epochs": 10})
    result, new = tuned(tmp_path, raw, out, [], {"epochs": 8, "freezeConv": [0]})  # fine-tuning on its own, no edits
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    spec = lt.parse_spec(raw)
    before = extract(spec, restore_model(spec, out))
    after = extract(spec, restore_model(spec, new))
    assert np.array_equal(after.conv[0].weights, before.conv[0].weights)  # frozen
    assert not np.array_equal(after.conv[1].weights, before.conv[1].weights)  # the rest carried on learning


def test_a_plan_can_freeze_everything_but_the_output_layer_without_naming_layers(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "cnn1d", gridSteps=8, features=["accel_x", "accel_y", "gyro_x"], network={"conv": [{"filters": 4, "kernel": 3}], "hidden": [{"units": 5}], "epochs": 10})
    result, new = tuned(tmp_path, raw, out, [], {"epochs": 8, "freeze": "allButOutput"})
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    spec = lt.parse_spec(raw)
    before = extract(spec, restore_model(spec, out))
    after = extract(spec, restore_model(spec, new))
    assert np.array_equal(after.conv[0].weights, before.conv[0].weights)
    assert np.array_equal(after.dense[0].weights, before.dense[0].weights)
    assert not np.array_equal(after.output.weights, before.output.weights)  # only the output layer learned
    bad, _ = tuned(tmp_path, raw, out, [], {"freeze": "sideways"}, name="bad")
    assert bad["outcome"] == "failed" and "allButOutput" in bad["message"]


def test_extra_recordings_count_more_in_a_fine_tune_and_the_note_says_so(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "torch-mlp", features=["accel_x_std", "accel_y_std", "gyro_x_std"], network={"hidden": [{"units": 6}], "epochs": 10})
    extra = [raw["train"][0]]
    plain, plain_out = tuned(tmp_path, raw, out, [], {"epochs": 8}, name="plain")
    weighted, weighted_out = tuned(tmp_path, raw, out, [], {"epochs": 8, "extraRecordings": extra, "extraWeight": 6}, name="weighted")
    assert weighted["outcome"] in ("deployable", "evaluationOnly"), weighted["message"]
    said = json.loads((weighted_out / "inspection.json").read_text())["edit"]["said"]
    assert any("extra recording" in line and "counted 6 times" in line for line in said)
    spec = lt.parse_spec(raw)
    a = extract(spec, restore_model(spec, plain_out))
    b = extract(spec, restore_model(spec, weighted_out))
    assert not np.allclose(a.output.weights, b.output.weights)  # the weighting changed what it learned
    bad, _ = tuned(tmp_path, raw, out, [], {"epochs": 3, "extraRecordings": extra, "extraWeight": 50}, name="bad")
    assert bad["outcome"] == "failed" and "1 to 10" in bad["message"]
    none, _ = tuned(tmp_path, raw, out, [], {"epochs": 3, "extraRecordings": ["not-a-recording"], "extraWeight": 2}, name="none")
    assert none["outcome"] == "failed" and "no windows" in none["message"]


@pytest.mark.parametrize("settings,message", [
    ({"epochs": 0}, "rounds"),
    ({"epochs": 9999}, "rounds"),
    ({"learningRate": 5}, "learning rate"),
    ({"surprise": 1}, "unknown fine-tuning"),
    ({"freezeDense": [0, 1, 2]}, "frozen"),
    ({"freezeConv": [0]}, "convolution layers to freeze"),
])
def test_fine_tuning_settings_are_checked(tmp_path: Path, settings: dict, message: str) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "torch-mlp", features=["accel_x_std", "accel_y_std"], network={"hidden": [{"units": 4}, {"units": 3}], "epochs": 8})
    result, _ = tuned(tmp_path, raw, out, [], settings)
    assert result["outcome"] == "failed" and message in result["message"]


def test_the_scikit_learn_methods_cannot_be_fine_tuned_and_nothing_to_change_is_refused(tmp_path: Path) -> None:
    raw, out, _ = train(tmp_path, "logreg", features=["accel_x_std", "accel_y_std"])
    result, _ = tuned(tmp_path, raw, out, [], {"epochs": 5})
    assert result["outcome"] == "failed" and "PyTorch" in result["message"]
    spec = {**raw, "edit": {"fromDir": str(out), "fromModel": "snap-v1", "edits": []}}
    nothing = lt.run(spec, tmp_path / "nothing")
    assert nothing["outcome"] == "failed" and "nothing to change" in nothing["message"]
