"""Builds the small ONNX model bundle that `crates/label-inference` tests against.

The model is a scikit-learn MLP over four canonical acceleration features, trained on synthetic data so the result is
deterministic: it says "present" when the acceleration is varying a lot. It exists to prove the bundle validator and the
Rust runtime read a real exporter's output; it is not a gesture model.

    uv run --with numpy --with scikit-learn --with skl2onnx python make_fixture.py <output-dir>
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import sklearn
from skl2onnx import to_onnx
from sklearn.neural_network import MLPClassifier

FEATURES = ["accel_x_std", "accel_y_std", "accel_z_std", "accel_magnitude_std"]


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    quiet = rng.normal(0.3, 0.1, size=(400, 4)).clip(0)
    shaking = rng.normal(5.0, 1.0, size=(400, 4)).clip(0)
    x = np.vstack([quiet, shaking]).astype(np.float32)
    y = np.array([0] * 400 + [1] * 400)
    model = MLPClassifier(hidden_layer_sizes=(8,), max_iter=500, random_state=7).fit(x, y)

    onnx_model = to_onnx(model, x[:1], options={id(model): {"zipmap": False}}, target_opset=15)
    model_bytes = onnx_model.SerializeToString()
    (out / "model.onnx").write_bytes(model_bytes)

    probe = np.array(
        [[0.2, 0.3, 0.25, 0.3], [5.0, 4.5, 5.5, 5.0], [2.5, 2.5, 2.5, 2.5]], dtype=np.float32
    )
    (out / "expected.json").write_text(
        json.dumps(
            {"inputs": probe.tolist(), "positive_probability": model.predict_proba(probe)[:, 1].tolist()},
            indent=2,
        )
    )
    manifest = {
        "schemaVersion": 1,
        "modelId": "shake-fixture",
        "targetLabel": "shake_fixture",
        "model": {
            "file": "model.onnx",
            "sha256": hashlib.sha256(model_bytes).hexdigest(),
            "format": "onnx",
            "opset": 15,
        },
        "framework": {"name": "scikit-learn", "version": sklearn.__version__},
        "input": {"name": "X", "shape": [None, len(FEATURES)], "dtype": "float32", "features": FEATURES},
        "output": {"name": "probabilities", "shape": [None, 2], "dtype": "float32", "positiveIndex": 1},
        "sources": ["watchAcceleration"],
        "window": {"durationMs": 1000, "strideMs": 200, "maxGapMs": 300, "minSamples": 5},
        "quality": {"maxContactQuality": 0.0, "minSampleCount": 3},
        "thresholds": {"activation": 0.8, "release": 0.5},
        "preprocessing": {"kind": "none"},
        "provenance": {"backend": "scikit-learn", "note": "synthetic fixture, not a gesture model"},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote", out)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
