from __future__ import annotations

import json

import pytest

from pinch_classifier.bundle import (
    BundleValidationError,
    build_metadata,
    validate_metadata,
    write_and_validate_metadata,
)
from pinch_classifier.windowing import WindowConfig


def _metadata(tmp_path):
    model_path = tmp_path / "model.tflite"
    model_path.write_bytes(b"synthetic tflite payload")
    return build_metadata(
        model_path=model_path,
        window_config=WindowConfig(),
        random_seed=7,
        tensorflow_version="test",
        run_info={
            "model_type": "keras.Sequential",
            "epochs": 2,
            "batch_size": 4,
            "learning_rate": 0.001,
            "final_training_loss": 0.5,
            "n_windows_train": 6,
            "n_windows_test": 3,
            "groups_train": ["train"],
            "groups_test": ["test"],
            "input_files": ["fixture.csv"],
            "metrics": {},
        },
        parity={
            "passed": True,
            "sample_count": 3,
            "absolute_tolerance": 1e-5,
            "max_absolute_error": 1e-7,
            "argmax_agreement": 1.0,
        },
    )


def test_metadata_round_trip_validates_model_hash(tmp_path):
    metadata = _metadata(tmp_path)
    path = write_and_validate_metadata(metadata, tmp_path)
    assert json.loads(path.read_text(encoding="utf-8"))["model"]["sha256"] == metadata["model"]["sha256"]


def test_metadata_rejects_tampered_model(tmp_path):
    metadata = _metadata(tmp_path)
    (tmp_path / "model.tflite").write_bytes(b"tampered")
    with pytest.raises(BundleValidationError, match="sha256 mismatch"):
        validate_metadata(metadata, tmp_path)


def test_metadata_rejects_false_or_incomplete_parity(tmp_path):
    metadata = _metadata(tmp_path)
    metadata["conversion_parity"]["passed"] = False
    with pytest.raises(BundleValidationError, match="passed"):
        validate_metadata(metadata)