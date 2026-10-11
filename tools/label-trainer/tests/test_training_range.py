"""The usual range of each input, written into the manifest so the desktop can tell when a live window is unlike any the
model trained on."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("onnxruntime")

from label_trainer import label_train as lt  # noqa: E402

from .test_label_train import spec_for  # noqa: E402


def manifest_of(tmp_path: Path, backend: str = "logreg", **over) -> dict:
    tmp_path.mkdir(parents=True, exist_ok=True)
    out = tmp_path / "run"
    result = lt.run(spec_for(tmp_path, backend, **over), out)
    assert result["outcome"] == "deployable", result["message"]
    return json.loads((out / "bundle" / "manifest.json").read_text())


def test_a_statistics_model_records_one_low_and_high_per_input(tmp_path: Path) -> None:
    manifest = manifest_of(tmp_path, features=["accel_x_std", "gyro_x_std", "accel_y_mean"])
    usual = manifest["input"]["trainingRange"]
    assert len(usual["low"]) == len(usual["high"]) == len(manifest["input"]["features"]) == 3
    assert all(low <= high for low, high in zip(usual["low"], usual["high"]))
    (tmp_path / "again").mkdir()
    spec = lt.parse_spec(spec_for(tmp_path / "again", "logreg", features=["accel_x_std", "gyro_x_std", "accel_y_mean"]))
    x_train, *_ = lt.build_matrices(spec)
    assert usual["low"][0] == pytest.approx(np.percentile(x_train[:, 0], 1), rel=1e-6)
    assert usual["high"][0] == pytest.approx(np.percentile(x_train[:, 0], 99), rel=1e-6)


def test_a_model_that_reads_columns_over_steps_records_one_range_per_column(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    manifest = manifest_of(tmp_path, "cnn1d", gridSteps=8, features=["accel_x", "accel_y", "gyro_x"], network={"epochs": 5})
    usual = manifest["input"]["trainingRange"]
    assert len(usual["low"]) == len(usual["high"]) == 3  # per column, not per step
    dense = manifest_of(tmp_path / "raw", "torch-mlp", inputMode="raw", gridSteps=4, features=["accel_x", "gyro_x"], network={"epochs": 5})
    assert len(dense["input"]["trainingRange"]["low"]) == 2


def test_no_range_when_the_level_is_taken_away_or_there_are_too_few_windows(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    centred = manifest_of(tmp_path, "cnn1d", gridSteps=8, features=["accel_x", "accel_y"], movementOnly=True, network={"epochs": 5})
    assert "trainingRange" not in centred["input"]
    (tmp_path / "few").mkdir()
    spec = lt.parse_spec(spec_for(tmp_path / "few", "logreg"))
    assert lt.training_range(spec, np.zeros((lt.RANGE_MIN_WINDOWS - 1, len(spec.features)))) is None
