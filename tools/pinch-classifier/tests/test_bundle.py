from __future__ import annotations

import json

import pytest

from pinch_classifier.bundle import (
    BundleValidationError,
    build_metadata,
    validate_metadata,
    write_and_validate_metadata,
)
from pinch_classifier.features import FEATURE_NAMES
from pinch_classifier.windowing import WindowConfig


def _metadata(tmp_path, feature_names=FEATURE_NAMES):
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
        feature_names=feature_names,
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


def test_metadata_accepts_strict_canonical_order_subset(tmp_path):
    subset = (FEATURE_NAMES[0], FEATURE_NAMES[2], FEATURE_NAMES[5])
    metadata = _metadata(tmp_path, feature_names=subset)
    assert metadata["feature_contract"] == {"count": 3, "ordered_names": list(subset)}
    assert metadata["model"]["input_shape"] == [1, 3]
    path = write_and_validate_metadata(metadata, tmp_path)
    assert json.loads(path.read_text(encoding="utf-8"))["feature_contract"]["ordered_names"] == list(subset)


def test_metadata_rejects_reordered_feature_subset(tmp_path):
    reordered = (FEATURE_NAMES[5], FEATURE_NAMES[0])
    with pytest.raises(ValueError, match="canonical FEATURE_NAMES order"):
        _metadata(tmp_path, feature_names=reordered)


def test_metadata_rejects_duplicate_feature_name(tmp_path):
    with pytest.raises(ValueError, match="duplicate feature name"):
        _metadata(tmp_path, feature_names=(FEATURE_NAMES[0], FEATURE_NAMES[0]))


def test_metadata_rejects_unknown_feature_name(tmp_path):
    with pytest.raises(ValueError, match="unknown feature name"):
        _metadata(tmp_path, feature_names=("not_a_real_feature",))


def test_metadata_rejects_empty_feature_subset(tmp_path):
    with pytest.raises(ValueError, match="must not be empty"):
        _metadata(tmp_path, feature_names=())


def test_validate_metadata_rejects_hand_edited_reordered_contract(tmp_path):
    metadata = _metadata(tmp_path, feature_names=(FEATURE_NAMES[0], FEATURE_NAMES[1]))
    metadata["feature_contract"]["ordered_names"] = [FEATURE_NAMES[1], FEATURE_NAMES[0]]
    with pytest.raises(BundleValidationError, match="feature_contract.ordered_names is invalid"):
        validate_metadata(metadata)


def test_validate_metadata_rejects_feature_count_exceeding_registry(tmp_path):
    metadata = _metadata(tmp_path)
    metadata["feature_contract"]["ordered_names"] = list(FEATURE_NAMES) + ["extra_feature"]
    metadata["feature_contract"]["count"] = len(FEATURE_NAMES) + 1
    with pytest.raises(BundleValidationError, match="more than the canonical"):
        validate_metadata(metadata)