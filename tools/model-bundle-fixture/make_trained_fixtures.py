"""Writes bundles made by the real per-label trainer (`label-classifier-train`) for `crates/label-inference` to read.

It proves the trainer's output is accepted by the desktop's bundle validator and scores like the trained model does.
The recordings are synthetic (a vigorous-acceleration "snap" against quiet "idle"); these are not gesture models.

    cd tools/label-trainer
    uv run --extra onnx --extra torch python ../model-bundle-fixture/make_trained_fixtures.py <crates/label-inference/tests/fixtures>
"""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "label-trainer" / "tests"))
from label_trainer import label_train as lt  # noqa: E402
from test_label_train import spec_for  # noqa: E402


def main(out_root: Path) -> None:
    for backend, name in (("logreg", "trained_logreg_bundle"), ("mlp", "trained_mlp_bundle"), ("torch-mlp", "trained_torch_bundle")):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            spec = spec_for(tmp_path, backend, params={"epochs": 120} if backend == "torch-mlp" else {})
            run_dir = tmp_path / "run"
            result = lt.run(spec, run_dir)
            assert result["outcome"] == "deployable", result["message"]
            parsed = lt.parse_spec(spec)
            x_train, y_train, x_eval, y_eval = lt.build_matrices(parsed)
            model = lt.fit(parsed, x_train, y_train)
            probe = np.vstack([x_eval[y_eval == 0][:2], x_eval[y_eval == 1][:2]]).astype(np.float32)
            destination = out_root / name
            destination.mkdir(parents=True, exist_ok=True)
            for file in ("manifest.json", "model.onnx"):
                (destination / file).write_bytes((run_dir / "bundle" / file).read_bytes())
            (destination / "expected.json").write_text(
                json.dumps({"features": result["features"], "inputs": probe.tolist(), "positive_probability": model.predict_proba(probe)[:, 1].tolist()}, indent=2)
            )
            print("wrote", destination, "f1", round(result["metrics"]["f1"], 3))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
