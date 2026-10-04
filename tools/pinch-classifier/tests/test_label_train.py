"""The per-label trainer: refusals, a real end-to-end run per backend, and what it writes."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("onnxruntime")

from pinch_classifier import label_train as lt  # noqa: E402
from pinch_classifier.schema import HEADER_COLUMNS  # noqa: E402

INTERVAL_NS = 20_000_000


def write_recording(directory: Path, rid: str, label: str, *, seed: int, rows: int = 400) -> Path:
    """One session of one label. The target ("snap") has vigorous acceleration; everything else is quiet."""
    rng = np.random.default_rng(seed)
    scale = 4.0 if label == "snap" else 0.3
    lines = ["# gesture-dataset-export: 1", f"# label: {label}", ",".join(HEADER_COLUMNS)]
    for row in range(rows):
        accel = rng.normal(0.0, scale, 3)
        gyro = rng.normal(0.0, scale / 4, 3)
        fields = [str(row * INTERVAL_NS), str(row), "1000", "900", "800", *(f"{v:.4f}" for v in accel), *(f"{v:.4f}" for v in gyro), "1", "0", "0", "0", "3", label]
        lines.append(",".join(fields))
    path = directory / f"{rid}.csv"
    path.write_text("\n".join(lines) + "\n")
    return path


def spec_for(tmp_path: Path, backend: str = "logreg", **over) -> dict:
    plan = {"s1": "snap", "s2": "snap", "s3": "snap", "i1": "idle", "i2": "idle", "i3": "idle"}
    recordings = {rid: str(write_recording(tmp_path, rid, label, seed=index)) for index, (rid, label) in enumerate(plan.items())}
    spec = {
        "version": 1,
        "target": "snap",
        "negatives": ["idle"],
        "excludes": [],
        "recordings": recordings,
        "train": ["s1", "s2", "i1", "i2"],
        "evaluation": ["s3", "i3"],
        "sources": ["watchAcceleration", "watchGyroscope"],
        "window": {"windowMs": 500, "strideMs": 150, "maxGapMs": 250, "minSamples": 3},
        "backend": backend,
        "seed": 7,
    }
    spec.update(over)
    return spec


def test_features_follow_the_chosen_streams_and_window_level_values_need_ppg() -> None:
    motion = lt.features_for(["watchAcceleration", "watchGyroscope"])
    assert motion and all(lt.source_of(name) in {"watchAcceleration", "watchGyroscope"} for name in motion)
    assert "sample_count" not in motion and "duration_ms" not in motion
    assert "sample_count" in lt.features_for(["watchPpg"])
    assert lt.features_for(["watchAcceleration", "watchGyroscope", "watchOrientation", "watchPpg"]) == list(lt.FEATURE_NAMES)
    with pytest.raises(lt.TrainingRefused):
        lt.features_for(["headPose"])


@pytest.mark.parametrize("backend", ["logreg", "mlp"])
def test_a_trained_model_is_exported_checked_and_described(tmp_path: Path, backend: str) -> None:
    out = tmp_path / "run"
    result = lt.run(spec_for(tmp_path, backend), out)
    assert result["outcome"] == "deployable", result["message"]
    assert result["metrics"]["f1"] > 0.9
    assert result["metrics"]["falseActivationRate"] < 0.1
    assert result["parityMaxAbsDifference"] <= lt.PARITY_TOLERANCE

    manifest = json.loads((out / "bundle" / "manifest.json").read_text())
    model_bytes = (out / "bundle" / "model.onnx").read_bytes()
    assert manifest["model"]["sha256"] == hashlib.sha256(model_bytes).hexdigest() == result["modelSha256"]
    assert manifest["targetLabel"] == "snap"
    assert manifest["sources"] == ["watchAcceleration", "watchGyroscope"]
    assert manifest["input"]["features"] == result["features"]
    assert manifest["preprocessing"] == {"kind": "none"}
    assert manifest["quality"] == {"maxContactQuality": 0.0, "minSampleCount": 3}
    assert manifest["provenance"]["trainRecordings"] == ["i1", "i2", "s1", "s2"]
    assert manifest["provenance"]["evaluationRecordings"] == ["i3", "s3"]
    assert json.loads((out / "result.json").read_text())["outcome"] == "deployable"


def test_the_exported_file_scores_windows_like_the_trained_model(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path))
    x_train, y_train, x_eval, _ = lt.build_matrices(spec)
    model = lt.fit(spec, x_train, y_train)
    path = tmp_path / "m.onnx"
    lt.export_onnx(spec, model, x_train, path)
    assert np.allclose(lt.onnx_probabilities(path, x_eval)[:, 1], model.predict_proba(x_eval)[:, 1], atol=1e-4)


def test_it_refuses_when_the_held_out_recordings_cannot_test_the_model(tmp_path: Path) -> None:
    result = lt.run(spec_for(tmp_path, train=["s1", "s2", "s3", "i1", "i2"], evaluation=["i3"]), tmp_path / "run")
    assert result["outcome"] == "failed"
    assert "held-out" in result["message"]
    assert not (tmp_path / "run" / "bundle").exists()


def test_it_refuses_too_little_of_the_target(tmp_path: Path) -> None:
    spec = spec_for(tmp_path)
    for rid in ("s1", "s2"):
        write_recording(tmp_path, rid, "snap", seed=1, rows=20)
    result = lt.run(spec, tmp_path / "run")
    assert result["outcome"] == "failed" and "Record more" in result["message"]


@pytest.mark.parametrize(
    "change, text",
    [
        ({"backend": "keras"}, "unknown backend"),
        ({"version": 2}, "unsupported spec version"),
        ({"train": ["s1", "s2", "i1", "i2", "s3"]}, "both the training and the evaluation"),
        ({"train": ["s1", "i1"]}, "exactly one"),
        ({"sources": ["watchAcceleration"], "features": ["gyro_x_std"]}, "not computed from the chosen streams"),
        ({"target": ""}, "no target"),
    ],
)
def test_a_bad_spec_is_refused_before_any_training(tmp_path: Path, change: dict, text: str) -> None:
    result = lt.run(spec_for(tmp_path, **change), tmp_path / "run")
    assert result["outcome"] == "failed" and text in result["message"], result["message"]


def test_a_label_with_no_role_is_never_silently_treated_as_negative(tmp_path: Path) -> None:
    spec = spec_for(tmp_path, negatives=[])
    result = lt.run(spec, tmp_path / "run")
    assert result["outcome"] == "failed"
    assert "no explicit training role" in result["message"]


def test_an_excluded_label_is_left_out(tmp_path: Path) -> None:
    write_recording(tmp_path, "w1", "walking", seed=99)
    spec = spec_for(tmp_path, excludes=["walking"])
    spec["recordings"]["w1"] = str(tmp_path / "w1.csv")
    spec["train"].append("w1")
    result = lt.run(spec, tmp_path / "run")
    assert result["outcome"] == "deployable", result["message"]
    assert result["trainWindows"] == lt.build_matrices(lt.parse_spec(spec_for(tmp_path)))[0].shape[0]


def test_the_pytorch_backend_exports_a_model_that_matches_the_trained_one(tmp_path: Path) -> None:
    pytest.importorskip("torch")
    pytest.importorskip("onnxscript")
    out = tmp_path / "run"
    result = lt.run(spec_for(tmp_path, "torch-mlp", params={"epochs": 120}), out)
    assert result["outcome"] == "deployable", result["message"]
    assert result["metrics"]["f1"] > 0.9
    manifest = json.loads((out / "bundle" / "manifest.json").read_text())
    assert manifest["framework"]["name"] == "pytorch"
    assert manifest["model"]["opset"] == lt.TORCH_OPSET


def test_the_pytorch_backend_says_so_when_torch_is_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    real_import = builtins.__import__

    def refuse_torch(name, *args, **kwargs):
        if name == "torch":
            raise ImportError("no torch")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", refuse_torch)
    result = lt.run(spec_for(tmp_path, "torch-mlp"), tmp_path / "run")
    assert result["outcome"] == "failed" and "PyTorch is not installed" in result["message"]


def test_an_exported_file_using_an_operator_the_desktop_cannot_run_is_refused(tmp_path: Path) -> None:
    import onnx
    from onnx import TensorProto, helper

    graph = helper.make_graph(
        [helper.make_node("LinearClassifier", ["X"], ["Y", "P"], domain="ai.onnx.ml", coefficients=[1.0], intercepts=[0.0], classlabels_ints=[0, 1])],
        "g", [helper.make_tensor_value_info("X", TensorProto.FLOAT, [None, 1])], [helper.make_tensor_value_info("P", TensorProto.FLOAT, [None, 2])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 15), helper.make_opsetid("ai.onnx.ml", 1)])
    path = tmp_path / "bad.onnx"
    path.write_bytes(model.SerializeToString())
    with pytest.raises(lt.TrainingRefused, match="cannot run"):
        lt.check_runnable(path)
    assert onnx.load(str(path))  # the file itself is fine; the desktop just cannot run it


def test_the_dense_export_folds_scaling_in_so_it_needs_no_preprocessing(tmp_path: Path) -> None:
    spec = lt.parse_spec(spec_for(tmp_path, "mlp"))
    x_train, y_train, x_eval, _ = lt.build_matrices(spec)
    model = lt.fit(spec, x_train, y_train)
    path = tmp_path / "m.onnx"
    lt.export_onnx(spec, model, x_train, path)
    import onnx

    ops = {node.op_type for node in onnx.load(str(path)).graph.node}
    assert ops <= {op for _, op in lt.RUNNABLE_OPERATORS} and "Scaler" not in ops
    assert np.allclose(lt.onnx_probabilities(path, x_eval)[:, 1], model.predict_proba(x_eval)[:, 1], atol=1e-4)
