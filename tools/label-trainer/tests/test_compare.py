"""Every method trained on the same recordings and split, side by side."""

from __future__ import annotations

import json
from pathlib import Path

from label_trainer import compare
from label_trainer import label_train as lt

from .test_label_train import spec_for


def test_each_method_gets_the_shared_settings_and_its_own_defaults(tmp_path: Path) -> None:
    raw = spec_for(tmp_path, "torch-mlp", features=["accel_x_std"], network={"hidden": [{"units": 4}]}, baselineMs=4000, movementOnly=True)
    for method in compare.METHODS:
        spec = compare.spec_for_method(raw, method)
        assert spec["backend"] == method and spec["train"] == raw["train"] and spec["movementOnly"] is True
        assert "features" not in spec and "network" not in spec
    assert compare.spec_for_method(raw, "cnn1d")["baselineMs"] == 4000  # it reads its pulse channels against their past


def test_comparing_trains_each_method_and_writes_the_table(tmp_path: Path) -> None:
    rows = compare.compare(spec_for(tmp_path), tmp_path / "out", methods=("logreg", "gbt"))
    assert [r["method"] for r in rows] == ["logreg", "gbt"]
    assert all(r["outcome"] == "deployable" for r in rows), rows
    assert json.loads((tmp_path / "out" / "compare.json").read_text()) == rows
    text = compare.table(rows)
    assert "logreg" in text and "gbt" in text and "cross" in text
    assert lt.main(["--compare", "--spec", str(_write(tmp_path, spec_for(tmp_path))), "--out", str(tmp_path / "cli")]) == 0


def _write(tmp_path: Path, spec: dict) -> Path:
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(spec))
    return path
