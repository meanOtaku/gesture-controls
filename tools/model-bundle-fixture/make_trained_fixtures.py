"""Writes bundles made by the real per-label trainer (`label-classifier-train`) for `crates/label-inference` to read.

It proves the trainer's output is accepted by the desktop's bundle validator and scores like the trained model does.
The recordings are synthetic (a vigorous-acceleration "snap" against quiet "idle"); these are not gesture models.

    cd tools/label-trainer
    uv run --extra onnx --extra torch python ../model-bundle-fixture/make_trained_fixtures.py <crates/label-inference/tests/fixtures> [name ...]

With names (for example `trained_cnn_bundle`) only those fixtures are written. The convolutional one reads the window as a
grid, so its `inputs` are flat grids (channels x steps) and its probabilities are what the exported ONNX file gives.
"""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "label-trainer" / "tests"))
from label_trainer import label_train as lt  # noqa: E402
from test_label_train import spec_for  # noqa: E402


def main(out_root: Path, only: list[str]) -> None:
    designed_dense = {"hidden": [{"units": 8, "activation": "tanh"}, {"units": 5, "activation": "leaky_relu"}, {"units": 4, "activation": "sigmoid"}], "epochs": 80, "dropout": 0.1}
    designed_cnn = {"conv": [{"filters": 8, "kernel": 3, "activation": "tanh"}, {"filters": 6, "kernel": 7}], "pooling": "max", "hidden": [{"units": 5, "activation": "leaky_relu"}], "epochs": 40}
    for backend, name, network in (
        ("logreg", "trained_logreg_bundle", None), ("mlp", "trained_mlp_bundle", None), ("torch-mlp", "trained_torch_bundle", None),
        ("cnn1d", "trained_cnn_bundle", None),
        ("torch-mlp", "trained_designed_dense_bundle", designed_dense), ("cnn1d", "trained_designed_cnn_bundle", designed_cnn),
    ):
        if only and name not in only:
            continue
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            extra = {"gridSteps": 16} if backend == "cnn1d" else {}
            if network:
                extra["network"] = network
            spec = spec_for(tmp_path, backend, params={} if network else {"epochs": 120} if backend == "torch-mlp" else {"epochs": 60} if backend == "cnn1d" else {}, **extra)
            run_dir = tmp_path / "run"
            result = lt.run(spec, run_dir)
            assert result["outcome"] == "deployable", result["message"]
            parsed = lt.parse_spec(spec)
            x_train, y_train, x_eval, y_eval = lt.build_matrices(parsed)
            model = lt.fit(parsed, x_train, y_train)
            probe = np.vstack([x_eval[y_eval == 0][:2], x_eval[y_eval == 1][:2]]).astype(np.float32)
            # What the shipped file gives, which is what the desktop's runtime must reproduce.
            shipped = lt.onnx_probabilities(run_dir / "model.onnx", probe)[:, 1] if backend == "cnn1d" or network else model.predict_proba(probe)[:, 1]
            destination = out_root / name
            destination.mkdir(parents=True, exist_ok=True)
            for file in ("manifest.json", "model.onnx"):
                (destination / file).write_bytes((run_dir / "bundle" / file).read_bytes())
            (destination / "expected.json").write_text(
                json.dumps({"features": result["features"], "inputs": probe.tolist(), "positive_probability": shipped.tolist()}, indent=2)
            )
            print("wrote", destination, "f1", round(result["metrics"]["f1"], 3))


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2:])
