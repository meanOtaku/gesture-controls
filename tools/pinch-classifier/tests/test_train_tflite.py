from __future__ import annotations

import json

import numpy as np
import pytest

tf = pytest.importorskip("tensorflow")

from pinch_classifier.bundle import validate_metadata
from pinch_classifier.train_tflite import _tflite_predictions, main

from .conftest import make_dataset_csv


def test_neural_cli_exports_valid_bundle_and_preserves_source_parity(tmp_path):
    for index in range(4):
        make_dataset_csv(tmp_path, f"idle_{index}.csv", "idle", 80, start_ns=index * 10_000_000_000)
        make_dataset_csv(
            tmp_path, f"start_{index}.csv", "pinch_start", 80,
            start_ns=(index + 10) * 10_000_000_000, accel_bias=5.0,
        )
        make_dataset_csv(
            tmp_path, f"release_{index}.csv", "pinch_release", 80,
            start_ns=(index + 20) * 10_000_000_000, accel_bias=-5.0,
        )
    output = tmp_path / "bundle"
    assert main([
        "--input", str(tmp_path), "--output-dir", str(output),
        "--window-ms", "200", "--stride-ms", "100", "--test-size", "0.25",
        "--random-seed", "4", "--epochs", "2", "--batch-size", "16",
    ]) == 0

    metadata = json.loads((output / "metadata.json").read_text(encoding="utf-8"))
    validate_metadata(metadata, output)
    assert [entry["label"] for entry in metadata["classes"]] == ["negative", "pinch_start", "pinch_release"]
    assert metadata["conversion_parity"]["passed"] is True
    assert metadata["conversion_parity"]["argmax_agreement"] == 1.0
    assert (output / "model.tflite").stat().st_size > 0

    predictions = _tflite_predictions(output / "model.tflite", np.zeros((2, 55), dtype=np.float32))
    assert predictions.shape == (2, 3)
    np.testing.assert_allclose(np.sum(predictions, axis=1), 1.0, atol=1e-5)