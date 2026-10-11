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


# ---- working the range out for a model trained before it was recorded -----------------------------------------------------

def _old_model(tmp_path: Path, **over) -> tuple[dict, Path, dict]:
    """A trained model whose manifest has its range taken out, as one trained before the range was kept."""
    raw = spec_for(tmp_path, "logreg", features=["accel_x_std", "gyro_x_std", "accel_y_mean"], **over)
    out = tmp_path / "run"
    assert lt.run(raw, out)["outcome"] == "deployable"
    path = out / "bundle" / "manifest.json"
    manifest = json.loads(path.read_text())
    original = manifest["input"].pop("trainingRange")
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    return raw, path, original


def test_the_range_of_an_existing_model_is_worked_out_from_its_training_windows_and_nothing_else_changes(tmp_path: Path) -> None:
    raw, path, original = _old_model(tmp_path)
    before = json.loads(path.read_text())
    result = lt.backfill_range(raw, [path])
    assert result["outcome"] == "written" and result["inputs"] == 3
    after = json.loads(path.read_text())
    assert after["input"]["trainingRange"] == original  # the very range it would have recorded
    after["input"].pop("trainingRange")
    assert after == before  # the model file's hash, its settings and everything else are untouched


def test_the_command_line_writes_every_manifest_given_and_says_what_happened(tmp_path: Path, capsys) -> None:
    raw, path, _ = _old_model(tmp_path)
    second = tmp_path / "second.json"
    second.write_text(path.read_text())
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(raw))
    assert lt.main(["--spec", str(spec_path), "--backfill-range", "--manifest", str(path), "--manifest", str(second)]) == 0
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert printed["outcome"] == "written"
    assert "trainingRange" in json.loads(path.read_text())["input"] and "trainingRange" in json.loads(second.read_text())["input"]


def test_a_model_whose_recordings_are_gone_or_whose_settings_do_not_match_is_refused_and_left_alone(tmp_path: Path, capsys) -> None:
    raw, path, _ = _old_model(tmp_path)
    untouched = path.read_text()
    gone = {**raw, "recordings": {**raw["recordings"], "s1": str(tmp_path / "deleted.csv")}}
    with pytest.raises(lt.TrainingRefused, match="no longer there"):
        lt.backfill_range(gone, [path])
    different = {**raw, "features": ["accel_x_std", "gyro_x_std"]}
    with pytest.raises(lt.TrainingRefused, match="do not name the inputs"):
        lt.backfill_range(different, [path])
    assert path.read_text() == untouched
    spec_path = tmp_path / "gone.json"
    spec_path.write_text(json.dumps(gone))
    assert lt.main(["--spec", str(spec_path), "--backfill-range", "--manifest", str(path)]) == 2
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["outcome"] == "refused"
