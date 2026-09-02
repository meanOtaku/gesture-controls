"""Train a portable three-class neural classifier and export a validated TFLite bundle."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

# Keep TensorFlow's startup noise out of normal CLI output. This must be set before import.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np
from sklearn.metrics import classification_report, confusion_matrix

from .bundle import CLASS_NAMES, MODEL_FILENAME, build_metadata, write_and_validate_metadata
from .dataset import Dataset, build_dataset
from .features import FEATURE_NAMES
from .labels import NEGATIVE_TARGET
from .train import _false_activation_metrics, _resolve_inputs, _split_by_group
from .windowing import (
    DEFAULT_MAX_GAP_MS,
    DEFAULT_MIN_SAMPLES_PER_WINDOW,
    DEFAULT_STRIDE_MS,
    DEFAULT_WINDOW_MS,
    WindowConfig,
)

CLASS_TO_INDEX = {label: index for index, label in enumerate(CLASS_NAMES)}


def _tensorflow() -> Any:
    try:
        import tensorflow as tf
    except ImportError as exc:  # pragma: no cover - exercised from an environment without the extra
        raise SystemExit(
            "TensorFlow is required for neural training/export. Install the optional extra with "
            "`pip install -e '.[tensorflow]'`."
        ) from exc
    return tf


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Train a three-class neural pinch classifier and export model.tflite + metadata.json."
    )
    parser.add_argument("--input", nargs="+", required=True, help="CSV exports or directories containing CSV exports.")
    parser.add_argument("--output-dir", default="tflite-bundle", help="Deployment-bundle output directory.")
    parser.add_argument("--window-ms", type=float, default=DEFAULT_WINDOW_MS)
    parser.add_argument("--stride-ms", type=float, default=DEFAULT_STRIDE_MS)
    parser.add_argument("--max-gap-ms", type=float, default=DEFAULT_MAX_GAP_MS)
    parser.add_argument("--min-samples-per-window", type=int, default=DEFAULT_MIN_SAMPLES_PER_WINDOW)
    parser.add_argument("--test-size", type=float, default=0.25, help="Fraction of recording sessions held out.")
    parser.add_argument("--random-seed", type=int, default=42)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--parity-atol", type=float, default=1e-5)
    return parser


def _encode_targets(targets: np.ndarray) -> np.ndarray:
    try:
        return np.asarray([CLASS_TO_INDEX[str(target)] for target in targets], dtype=np.int32)
    except KeyError as exc:
        raise ValueError(f"neural export supports exactly the three classes {CLASS_NAMES}; got {exc.args[0]!r}") from exc


def _require_three_class_training_data(targets: np.ndarray, where: str) -> None:
    present = {str(target) for target in targets}
    missing = set(CLASS_NAMES) - present
    if missing:
        raise SystemExit(
            f"{where} split is missing required class(es): {', '.join(sorted(missing))}. "
            "Provide multiple recording sessions for each of negative, pinch_start, and pinch_release, "
            "or choose another --random-seed/--test-size."
        )


def build_model(x_train: np.ndarray, learning_rate: float, random_seed: int) -> Any:
    """Build a small MLP with training-only normalization embedded in the graph."""
    tf = _tensorflow()
    tf.keras.utils.set_random_seed(random_seed)
    try:
        tf.config.experimental.enable_op_determinism()
    except (AttributeError, RuntimeError):
        pass

    normalization = tf.keras.layers.Normalization(axis=-1, name="feature_normalization")
    normalization.adapt(np.asarray(x_train, dtype=np.float32))
    model = tf.keras.Sequential(
        [
            tf.keras.Input(shape=(len(FEATURE_NAMES),), dtype=tf.float32, name="features"),
            normalization,
            tf.keras.layers.Dense(32, activation="relu", name="dense_1"),
            tf.keras.layers.Dense(16, activation="relu", name="dense_2"),
            tf.keras.layers.Dense(len(CLASS_NAMES), activation="softmax", name="class_probabilities"),
        ],
        name="pinch_classifier",
    )
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=learning_rate),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model


def export_tflite(model: Any, destination: Path) -> None:
    tf = _tensorflow()
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.target_spec.supported_types = [tf.float32]
    payload = converter.convert()
    destination.write_bytes(payload)


def _tflite_predictions(model_path: Path, features: np.ndarray) -> np.ndarray:
    tf = _tensorflow()
    interpreter = tf.lite.Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    input_detail = interpreter.get_input_details()[0]
    output_detail = interpreter.get_output_details()[0]

    if tuple(input_detail["shape"]) != (1, len(FEATURE_NAMES)) or input_detail["dtype"] != np.float32:
        raise RuntimeError(f"unexpected TFLite input contract: shape={input_detail['shape']}, dtype={input_detail['dtype']}")
    if tuple(output_detail["shape"]) != (1, len(CLASS_NAMES)) or output_detail["dtype"] != np.float32:
        raise RuntimeError(f"unexpected TFLite output contract: shape={output_detail['shape']}, dtype={output_detail['dtype']}")

    outputs: list[np.ndarray] = []
    for row in np.asarray(features, dtype=np.float32):
        interpreter.set_tensor(input_detail["index"], row[np.newaxis, :])
        interpreter.invoke()
        outputs.append(interpreter.get_tensor(output_detail["index"])[0].copy())
    return np.stack(outputs)


def verify_conversion_parity(model: Any, model_path: Path, features: np.ndarray, atol: float) -> dict[str, Any]:
    """Compare source Keras probabilities with TFLite on held-out feature rows."""
    source = np.asarray(model(np.asarray(features, dtype=np.float32), training=False), dtype=np.float32)
    converted = _tflite_predictions(model_path, features)
    max_abs_error = float(np.max(np.abs(source - converted)))
    matching = int(np.sum(np.argmax(source, axis=1) == np.argmax(converted, axis=1)))
    count = int(features.shape[0])
    agreement = matching / count
    passed = bool(max_abs_error <= atol and matching == count)
    result = {
        "passed": passed,
        "sample_count": count,
        "absolute_tolerance": float(atol),
        "max_absolute_error": max_abs_error,
        "argmax_agreement": agreement,
    }
    if not passed:
        raise RuntimeError(f"source-vs-TFLite parity failed: {result}")
    return result


def _evaluation(y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    predicted_indices = np.argmax(probabilities, axis=1)
    predicted = np.asarray([CLASS_NAMES[index] for index in predicted_indices], dtype=object)
    report = classification_report(y_true, predicted, labels=list(CLASS_NAMES), output_dict=True, zero_division=0)
    matrix = confusion_matrix(y_true, predicted, labels=list(CLASS_NAMES))
    return {
        "accuracy": float(report["accuracy"]),
        "macro_f1": float(report["macro avg"]["f1-score"]),
        "classification_report": report,
        "confusion_matrix": {"labels": list(CLASS_NAMES), "matrix": matrix.tolist()},
        **_false_activation_metrics(y_true, predicted, "exclude"),
    }


def train_and_export(dataset: Dataset, args: argparse.Namespace, output_dir: Path, input_paths: list[Path]) -> dict[str, Any]:
    tf = _tensorflow()
    train_idx, test_idx = _split_by_group(dataset, args.test_size, args.random_seed)
    x_train = np.asarray(dataset.features[train_idx], dtype=np.float32)
    x_test = np.asarray(dataset.features[test_idx], dtype=np.float32)
    y_train_labels, y_test_labels = dataset.targets[train_idx], dataset.targets[test_idx]
    _require_three_class_training_data(y_train_labels, "training")
    y_train = _encode_targets(y_train_labels)

    model = build_model(x_train, args.learning_rate, args.random_seed)
    history = model.fit(
        x_train,
        y_train,
        epochs=args.epochs,
        batch_size=args.batch_size,
        shuffle=True,
        verbose=0,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / MODEL_FILENAME
    export_tflite(model, model_path)
    parity = verify_conversion_parity(model, model_path, x_test, args.parity_atol)
    probabilities = _tflite_predictions(model_path, x_test)
    metrics = _evaluation(y_test_labels, probabilities)

    run_info = {
        "model_type": "keras.Sequential",
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "learning_rate": args.learning_rate,
        "final_training_loss": float(history.history["loss"][-1]),
        "n_windows_train": int(train_idx.shape[0]),
        "n_windows_test": int(test_idx.shape[0]),
        "groups_train": sorted(np.unique(dataset.groups[train_idx]).tolist()),
        "groups_test": sorted(np.unique(dataset.groups[test_idx]).tolist()),
        "input_files": [str(path) for path in input_paths],
        "metrics": metrics,
    }
    metadata = build_metadata(
        model_path=model_path,
        window_config=args.window_config,
        random_seed=args.random_seed,
        tensorflow_version=tf.__version__,
        run_info=run_info,
        parity=parity,
    )
    write_and_validate_metadata(metadata, output_dir)
    return metadata


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    if args.epochs <= 0 or args.batch_size <= 0 or args.learning_rate <= 0 or args.parity_atol < 0:
        raise SystemExit("--epochs, --batch-size, and --learning-rate must be positive; --parity-atol must be non-negative")
    input_paths = _resolve_inputs(args.input)
    args.window_config = WindowConfig(
        window_ms=args.window_ms,
        stride_ms=args.stride_ms,
        max_gap_ms=args.max_gap_ms,
        min_samples_per_window=args.min_samples_per_window,
    )
    # Excluding pinch_hold guarantees the deployment contract remains exactly three classes.
    dataset = build_dataset(input_paths, args.window_config, hold_handling="exclude")
    metadata = train_and_export(dataset, args, Path(args.output_dir), input_paths)
    metrics = metadata["training"]["metrics"]
    parity = metadata["conversion_parity"]
    print(f"accuracy={metrics['accuracy']:.4f} macro_f1={metrics['macro_f1']:.4f}")
    print(
        f"source_vs_tflite_max_abs_error={parity['max_absolute_error']:.3g} "
        f"argmax_agreement={parity['argmax_agreement']:.4f}"
    )
    print(f"wrote validated bundle: {Path(args.output_dir) / MODEL_FILENAME}, {Path(args.output_dir) / 'metadata.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
