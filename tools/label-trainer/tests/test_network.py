"""The network a person can design: its limits, that the defaults are what each method always was, and that a designed one trains."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("onnxruntime")

from label_trainer import label_train as lt  # noqa: E402
from label_trainer.network import NetworkRefused, default_network, parameter_count, parse_network  # noqa: E402

from .test_label_train import spec_for  # noqa: E402


def test_the_defaults_are_what_each_method_was_before_it_could_be_set() -> None:
    dense = default_network("torch-mlp")
    assert [(l.units, l.activation) for l in dense.hidden] == [(32, "relu"), (16, "relu")]
    assert (dense.learning_rate, dense.epochs, dense.batch_size, dense.dropout) == (0.01, 200, 0, 0.0)
    cnn = default_network("cnn1d")
    assert [(c.filters, c.kernel) for c in cnn.conv] == [(16, 5), (16, 5)]
    assert (cnn.pooling, cnn.dropout, cnn.epochs, cnn.batch_size, cnn.augment) == ("mean_max", 0.2, 80, 64, True)
    assert parse_network(None, "torch-mlp") == dense and parse_network({}, "cnn1d") == cnn


def test_settings_outside_the_limits_are_refused_with_the_reason() -> None:
    bad = [
        ({"hidden": [{"units": 0}]}, "units"),
        ({"hidden": [{"units": 600}]}, "units"),
        ({"hidden": [{"units": 4, "activation": "swish"}]}, "activation"),
        ({"hidden": [{"units": 4}] * 7}, "at most"),
        ({"learningRate": 5}, "learningRate"),
        ({"epochs": 2}, "epochs"),
        ({"batchSize": 1000}, "batchSize"),
        ({"dropout": 0.9}, "dropout"),
        ({"pooling": "median"}, "pooling"),
        ({"conv": [{"filters": 4, "kernel": 5}]}, "only apply to the convolutional"),
    ]
    for raw, message in bad:
        with pytest.raises(NetworkRefused, match=message):
            parse_network(raw, "torch-mlp")
    with pytest.raises(NetworkRefused, match="odd width"):
        parse_network({"conv": [{"filters": 4, "kernel": 4}]}, "cnn1d")
    with pytest.raises(NetworkRefused, match="from 1 to"):
        parse_network({"conv": []}, "cnn1d")


def test_the_parameter_count_matches_what_pytorch_actually_holds() -> None:
    torch = pytest.importorskip("torch")
    from label_trainer.nets import CnnModel, TorchModel

    dense = parse_network({"hidden": [{"units": 10}, {"units": 7, "activation": "tanh"}], "dropout": 0.1}, "torch-mlp")
    model = TorchModel(9, 1, {}, dense)
    assert parameter_count(dense, 9, "torch-mlp") == sum(p.numel() for p in model.net.parameters())
    for pooling in ("mean_max", "mean", "max"):
        cnn = parse_network({"conv": [{"filters": 6, "kernel": 3}, {"filters": 5, "kernel": 7}], "hidden": [{"units": 4}], "pooling": pooling}, "cnn1d")
        model = CnnModel(4, 16, 1, {}, False, cnn)
        held = sum(p.numel() for p in model.net.parameters()) + sum(p.numel() for p in model.head.parameters())
        assert parameter_count(cnn, 4, "cnn1d") == held, pooling
    assert torch


@pytest.mark.parametrize("activation", ["tanh", "sigmoid", "leaky_relu"])
def test_a_designed_dense_network_trains_exports_and_reports_its_progress(tmp_path: Path, activation: str, capsys) -> None:
    pytest.importorskip("torch")
    network = {"hidden": [{"units": 8, "activation": activation}, {"units": 4, "activation": "relu"}], "epochs": 30, "batchSize": 32, "learningRate": 0.02, "weightDecay": 0.001, "dropout": 0.1}
    out = tmp_path / "run"
    result = lt.run(spec_for(tmp_path, "torch-mlp", network=network), out)
    assert result["outcome"] == "deployable", result["message"]
    assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE
    curve = json.loads((out / "training_curve.json").read_text())
    assert curve[0]["epoch"] == 1 and curve[-1]["epoch"] == 30
    assert all({"trainLoss", "evalLoss"} <= set(point) for point in curve)
    assert curve[-1]["trainLoss"] < curve[0]["trainLoss"]  # it learned
    printed = [line for line in capsys.readouterr().out.splitlines() if line.startswith("@curve ")]
    assert len(printed) == len(curve)  # the desktop draws these live
    manifest = json.loads((out / "bundle" / "manifest.json").read_text())
    assert manifest["provenance"]["network"]["hidden"][0] == {"units": 8, "activation": activation}
    assert manifest["provenance"]["parameters"] == parameter_count(parse_network(network, "torch-mlp"), 14 + 14, "torch-mlp")


def test_a_designed_convolutional_network_trains_and_exports(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    network = {"conv": [{"filters": 8, "kernel": 3, "activation": "tanh"}, {"filters": 8, "kernel": 7}], "pooling": "max", "hidden": [{"units": 6, "activation": "leaky_relu"}], "epochs": 25, "augment": False}
    result = lt.run(spec_for(tmp_path, "cnn1d", gridSteps=16, network=network), tmp_path / "run")
    assert result["outcome"] == "deployable", result["message"]
    assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE


def test_the_scikit_learn_network_takes_its_layer_sizes_and_reports_a_curve(tmp_path: Path) -> None:
    out = tmp_path / "run"
    result = lt.run(spec_for(tmp_path, "mlp", network={"hidden": [{"units": 12}, {"units": 6}, {"units": 3}]}), out)
    assert result["outcome"] == "deployable", result["message"]
    assert len(json.loads((out / "training_curve.json").read_text())) > 1


def test_a_chosen_subset_of_inputs_is_what_the_model_reads(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path, features=["accel_x_std", "gyro_z_max"]))
    assert spec.features == ["accel_x_std", "gyro_z_max"]
    cnn = lt.parse_spec(spec_for(tmp_path, "cnn1d", features=["gyro_y", "accel_x"], gridSteps=16))
    assert cnn.features == ["accel_x", "gyro_y"]  # in canonical order
    with pytest.raises(lt.TrainingRefused, match="not computed from the chosen streams"):
        lt.parse_spec(spec_for(tmp_path, features=["ppg_green_mean"]))
