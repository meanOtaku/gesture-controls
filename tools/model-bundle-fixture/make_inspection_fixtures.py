"""Writes real `inspection.json` documents (made by the real trainer) for the desktop's Inspect view tests to read.

They pin the contract between `label_trainer/inspection.py` and `apps/desktop/src/features/model-lab/inspection.ts`: the
tests parse these exact files. The recordings are synthetic (a vigorous-acceleration "snap" against quiet "idle").

    cd tools/label-trainer
    uv run --extra onnx --extra torch python ../model-bundle-fixture/make_inspection_fixtures.py <apps/desktop/src/features/model-lab/fixtures>
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "label-trainer" / "tests"))
from label_trainer import label_train as lt  # noqa: E402
from test_label_train import spec_for  # noqa: E402

CASES = {
    "inspection-linear": ("logreg", {"features": ["accel_x_std", "accel_x_mean", "accel_y_std", "gyro_x_std"]}),
    "inspection-dense": ("torch-mlp", {"features": ["accel_x_std", "accel_y_std", "accel_z_std", "gyro_x_std", "gyro_y_std"], "network": {"hidden": [{"units": 6, "activation": "tanh"}, {"units": 4}], "epochs": 40}}),
    "inspection-conv": ("cnn1d", {"gridSteps": 8, "features": ["accel_x", "accel_y", "gyro_x"], "network": {"conv": [{"filters": 4, "kernel": 3}, {"filters": 3, "kernel": 3}], "epochs": 20}}),
}


def main(out_root: Path) -> None:
    out_root.mkdir(parents=True, exist_ok=True)
    for name, (backend, extra) in CASES.items():
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            run_dir = tmp_path / "run"
            result = lt.run(spec_for(tmp_path, backend, **extra), run_dir)
            assert result["outcome"] == "deployable", result["message"]
            (out_root / f"{name}.json").write_text((run_dir / "inspection.json").read_text())
            print("wrote", name, (out_root / f"{name}.json").stat().st_size, "bytes")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
