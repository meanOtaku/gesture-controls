"""A dense model that reads the dataset's columns themselves: each column (at each of a few steps) is one input neuron."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("onnxruntime")

from label_trainer import label_train as lt  # noqa: E402
from label_trainer.edits import apply_edits, restore_model  # noqa: E402
from label_trainer.inspection import extract, forward  # noqa: E402

from .test_label_train import spec_for  # noqa: E402

COLUMNS = ["accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z"]


def train(tmp_path: Path, backend: str, steps: int, **over):
    over.setdefault("network", {"epochs": 60} if backend == "torch-mlp" else {})
    raw = spec_for(tmp_path, backend, inputMode="raw", gridSteps=steps, **over)
    out = tmp_path / "run"
    result = lt.run(raw, out)
    assert result["outcome"] == "deployable", result["message"]
    return raw, out, result


@pytest.mark.parametrize("backend,steps", [("mlp", 1), ("torch-mlp", 1), ("torch-mlp", 4)])
def test_each_column_at_each_step_is_one_input_neuron(tmp_path: Path, backend: str, steps: int) -> None:
    if backend == "torch-mlp":
        pytest.importorskip("torch")
    raw, out, result = train(tmp_path, backend, steps)
    spec = lt.parse_spec(raw)
    assert spec.features == COLUMNS and lt.input_count(spec) == 6 * steps
    manifest = json.loads((out / "bundle" / "manifest.json").read_text())
    assert manifest["input"]["features"] == COLUMNS
    assert manifest["input"]["shape"] == [None, 6 * steps]
    assert manifest["input"]["grid"] == {"steps": steps}
    assert manifest["preprocessing"] == {"kind": "none"}
    assert manifest["provenance"]["inputMode"] == "raw"
    assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE
    assert result["metrics"]["rocAuc"] > 0.7  # the toy gesture is vigorous motion: a network can tell it from its raw readings


def test_a_linear_model_cannot_see_how_hard_a_signal_swings_from_raw_readings(tmp_path: Path) -> None:
    """The toy gesture differs from rest in how much the readings swing, not in their value: a straight-line model on the
    readings themselves has nothing to go on, which is what the lab should show, not hide (a network can, or statistics)."""
    result = lt.run(spec_for(tmp_path, "logreg", inputMode="raw", gridSteps=1), tmp_path / "run")
    assert result["outcome"] == "evaluationOnly" and "barely tell" in result["message"]


def test_the_thirteen_dataset_columns_make_thirteen_input_neurons_at_one_step(tmp_path: Path) -> None:
    raw = spec_for(tmp_path, "logreg", inputMode="raw", gridSteps=1, sources=["watchPpg", "watchAcceleration", "watchGyroscope", "watchOrientation"])
    spec = lt.parse_spec(raw)
    assert spec.features == ["ppg_green", "ppg_red", "ppg_ir", "accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z", "quat_w", "quat_x", "quat_y", "quat_z"]
    assert lt.input_count(spec) == 13


def test_a_chosen_set_of_columns_and_its_neuron_count(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path, "mlp", inputMode="raw", gridSteps=8, features=["gyro_z", "accel_x"]))
    assert spec.features == ["accel_x", "gyro_z"] and lt.input_count(spec) == 16
    with pytest.raises(lt.TrainingRefused, match="samples per window"):
        lt.parse_spec(spec_for(tmp_path, "logreg", inputMode="raw", gridSteps=65))
    with pytest.raises(lt.TrainingRefused, match="samples per window"):
        lt.parse_spec(spec_for(tmp_path, "logreg", inputMode="raw", gridSteps=0))


def test_the_window_values_are_the_columns_laid_onto_the_steps(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path, "logreg", inputMode="raw", gridSteps=3, features=["accel_x", "gyro_x"]))
    x_train, _, _, _ = lt.build_matrices(spec)
    assert x_train.shape[1] == 6  # 2 columns x 3 steps, column after column


def test_inspecting_a_raw_columns_model_works_per_column(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "torch-mlp", 4)
    inspection = json.loads((out / "inspection.json").read_text())
    assert inspection["inputKind"] == "columns" and inspection["gridSteps"] == 4
    assert [i["name"] for i in inspection["inputs"]] == COLUMNS and all(i["neurons"] == 4 for i in inspection["inputs"])
    assert [i["name"] for i in inspection["importance"]] == COLUMNS  # shuffled a column at a time, across all its steps
    window = inspection["windows"][0]
    assert len(window["values"]) == 6 * 4 and len(window["contributions"]) == 6  # one contribution per column
    assert len(inspection["network"]["dense"][0]["weights"]) == 24  # a weight for every neuron of the first layer
    assert inspection["forwardMaxAbsDifference"] < 1e-3


def test_switching_a_column_off_silences_all_its_neurons(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    raw, out, _ = train(tmp_path, "torch-mlp", 4)
    spec = lt.parse_spec(raw)
    model = restore_model(spec, out)
    apply_edits(spec, model, [{"kind": "disableInput", "input": "accel_y"}])
    weights = extract(spec, model).dense[0].weights
    assert np.all(weights[4:8] == 0) and np.any(weights[0:4] != 0)  # accel_y is the second column: neurons 5 to 8
    _, _, x_eval, _ = lt.build_matrices(spec)
    assert np.max(np.abs(forward(extract(spec, model), x_eval)[0] - model.predict_proba(x_eval)[:, 1])) < 1e-4
