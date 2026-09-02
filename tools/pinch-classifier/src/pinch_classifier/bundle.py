"""Validated deployment-bundle metadata for the TFLite pinch classifier."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

from .features import FEATURE_NAMES
from .windowing import WindowConfig

BUNDLE_SCHEMA_VERSION = 1
CLASS_NAMES: tuple[str, ...] = ("negative", "pinch_start", "pinch_release")
MODEL_FILENAME = "model.tflite"
METADATA_FILENAME = "metadata.json"
PREPROCESSING_POLICY: dict[str, Any] = {
    "input": "the 55 engineered window features in feature_contract.ordered_names order",
    "missing_sensor_values": "carry-forward within each recording; leading missing values become 0.0",
    "normalization": "per-feature standard score fitted on training sessions only and embedded in model.tflite",
    "zero_variance_scale": 1.0,
    "input_dtype": "float32",
}


class BundleValidationError(ValueError):
    """The deployment metadata or its model payload violates the bundle contract."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_metadata(
    *,
    model_path: Path,
    window_config: WindowConfig,
    random_seed: int,
    tensorflow_version: str,
    run_info: dict[str, Any],
    parity: dict[str, Any],
) -> dict[str, Any]:
    """Build the portable inference contract; timestamps are intentionally omitted."""
    return {
        "schema_version": BUNDLE_SCHEMA_VERSION,
        "model": {
            "file": MODEL_FILENAME,
            "format": "TFLite",
            "sha256": sha256_file(model_path),
            "input_shape": [1, len(FEATURE_NAMES)],
            "input_dtype": "float32",
            "output_shape": [1, len(CLASS_NAMES)],
            "output_dtype": "float32",
        },
        "classes": [{"index": index, "label": label} for index, label in enumerate(CLASS_NAMES)],
        "feature_contract": {
            "count": len(FEATURE_NAMES),
            "ordered_names": list(FEATURE_NAMES),
        },
        "window_config": {
            "window_ms": window_config.window_ms,
            "stride_ms": window_config.stride_ms,
            "max_gap_ms": window_config.max_gap_ms,
            "min_samples_per_window": window_config.min_samples_per_window,
            "boundary_policy": "windows never cross recording, label, or max_gap_ms boundaries",
        },
        "preprocessing": PREPROCESSING_POLICY,
        "training": {
            "random_seed": random_seed,
            "tensorflow_version": tensorflow_version,
            **run_info,
        },
        "conversion_parity": parity,
    }


def validate_metadata(metadata: dict[str, Any], bundle_dir: Path | None = None) -> None:
    """Validate all inference-critical fields and, when provided, the model hash."""
    if metadata.get("schema_version") != BUNDLE_SCHEMA_VERSION:
        raise BundleValidationError(f"schema_version must be {BUNDLE_SCHEMA_VERSION}")

    expected_classes = [{"index": index, "label": label} for index, label in enumerate(CLASS_NAMES)]
    if metadata.get("classes") != expected_classes:
        raise BundleValidationError(f"classes must be exactly {expected_classes!r}")

    feature_contract = metadata.get("feature_contract")
    if not isinstance(feature_contract, dict):
        raise BundleValidationError("feature_contract must be an object")
    if feature_contract.get("count") != len(FEATURE_NAMES):
        raise BundleValidationError(f"feature_contract.count must be {len(FEATURE_NAMES)}")
    if feature_contract.get("ordered_names") != list(FEATURE_NAMES):
        raise BundleValidationError("feature_contract.ordered_names does not match the ordered 55-feature contract")

    if metadata.get("preprocessing") != PREPROCESSING_POLICY:
        raise BundleValidationError("preprocessing does not match the supported deployment policy")

    window_config = metadata.get("window_config")
    required_window_fields = {"window_ms", "stride_ms", "max_gap_ms", "min_samples_per_window", "boundary_policy"}
    if not isinstance(window_config, dict) or set(window_config) != required_window_fields:
        raise BundleValidationError(f"window_config must contain exactly {sorted(required_window_fields)}")
    for field in ("window_ms", "stride_ms", "max_gap_ms"):
        value = window_config[field]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise BundleValidationError(f"window_config.{field} must be positive")
    minimum = window_config["min_samples_per_window"]
    if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum <= 0:
        raise BundleValidationError("window_config.min_samples_per_window must be a positive integer")

    model = metadata.get("model")
    if not isinstance(model, dict):
        raise BundleValidationError("model must be an object")
    expected_model_fields = {
        "file": MODEL_FILENAME,
        "format": "TFLite",
        "input_shape": [1, len(FEATURE_NAMES)],
        "input_dtype": "float32",
        "output_shape": [1, len(CLASS_NAMES)],
        "output_dtype": "float32",
    }
    for field, expected in expected_model_fields.items():
        if model.get(field) != expected:
            raise BundleValidationError(f"model.{field} must be {expected!r}")
    digest = model.get("sha256")
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise BundleValidationError("model.sha256 must be a lowercase SHA-256 hex digest")

    parity = metadata.get("conversion_parity")
    if not isinstance(parity, dict) or parity.get("passed") is not True:
        raise BundleValidationError("conversion_parity must record a passed source-vs-TFLite check")
    required_parity_fields = {
        "passed", "sample_count", "absolute_tolerance", "max_absolute_error", "argmax_agreement"
    }
    if set(parity) != required_parity_fields:
        raise BundleValidationError(f"conversion_parity must contain exactly {sorted(required_parity_fields)}")
    if not isinstance(parity["sample_count"], int) or isinstance(parity["sample_count"], bool) or parity["sample_count"] <= 0:
        raise BundleValidationError("conversion_parity.sample_count must be a positive integer")
    for field in ("absolute_tolerance", "max_absolute_error", "argmax_agreement"):
        value = parity[field]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise BundleValidationError(f"conversion_parity.{field} must be finite")
    if parity["absolute_tolerance"] < 0 or parity["max_absolute_error"] < 0:
        raise BundleValidationError("conversion parity errors/tolerances must be non-negative")
    if parity["max_absolute_error"] > parity["absolute_tolerance"]:
        raise BundleValidationError("conversion parity error exceeds its absolute tolerance")
    if parity["argmax_agreement"] != 1.0:
        raise BundleValidationError("conversion_parity.argmax_agreement must be 1.0")

    training = metadata.get("training")
    required_training_fields = {
        "random_seed", "tensorflow_version", "model_type", "epochs", "batch_size", "learning_rate",
        "final_training_loss", "n_windows_train", "n_windows_test", "groups_train", "groups_test",
        "input_files", "metrics",
    }
    if not isinstance(training, dict) or set(training) != required_training_fields:
        raise BundleValidationError(f"training must contain exactly {sorted(required_training_fields)}")
    if not isinstance(training["random_seed"], int) or isinstance(training["random_seed"], bool):
        raise BundleValidationError("training.random_seed must be an integer")
    for field in ("tensorflow_version", "model_type"):
        if not isinstance(training[field], str) or not training[field]:
            raise BundleValidationError(f"training.{field} must be a non-empty string")
    for field in ("epochs", "batch_size", "n_windows_train", "n_windows_test"):
        if not isinstance(training[field], int) or isinstance(training[field], bool) or training[field] <= 0:
            raise BundleValidationError(f"training.{field} must be a positive integer")
    for field in ("learning_rate", "final_training_loss"):
        value = training[field]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
            raise BundleValidationError(f"training.{field} must be a finite non-negative number")
    for field in ("groups_train", "groups_test", "input_files"):
        if not isinstance(training[field], list) or not training[field] or not all(isinstance(v, str) and v for v in training[field]):
            raise BundleValidationError(f"training.{field} must be a non-empty string array")
    if set(training["groups_train"]) & set(training["groups_test"]):
        raise BundleValidationError("training group split leaks a session between train and test")
    if not isinstance(training["metrics"], dict):
        raise BundleValidationError("training.metrics must be an object")

    if bundle_dir is not None:
        model_path = bundle_dir / MODEL_FILENAME
        if not model_path.is_file():
            raise BundleValidationError(f"bundle is missing {MODEL_FILENAME}")
        actual_digest = sha256_file(model_path)
        if actual_digest != digest:
            raise BundleValidationError(f"model.sha256 mismatch: metadata={digest}, actual={actual_digest}")


def write_and_validate_metadata(metadata: dict[str, Any], output_dir: Path) -> Path:
    path = output_dir / METADATA_FILENAME
    path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    loaded = json.loads(path.read_text(encoding="utf-8"))
    validate_metadata(loaded, output_dir)
    return path
