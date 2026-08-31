"""CLI: trains and evaluates the scikit-learn pinch_start/pinch_release baseline.

    pinch-classifier-train --input session1.csv session2.csv ... --output-dir artifacts/

Evaluation is a grouped holdout by CSV file (session): every window from a
given file lands entirely in train or entirely in test, so the reported
metrics reflect generalization to an unseen recording, not just an unseen
window. Outputs a serialized model (model.joblib) and a model card
(model_card.json) capturing the feature contract, window config, and metrics
— see README.md for how to read them.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import GroupShuffleSplit

from . import __version__
from .dataset import Dataset, build_dataset
from .labels import HOLD_HANDLING_CHOICES, NEGATIVE_TARGET, positive_targets
from .windowing import (
    DEFAULT_MAX_GAP_MS,
    DEFAULT_MIN_SAMPLES_PER_WINDOW,
    DEFAULT_STRIDE_MS,
    DEFAULT_WINDOW_MS,
    WindowConfig,
)


def _resolve_inputs(raw_inputs: list[str]) -> list[Path]:
    paths: list[Path] = []
    for raw in raw_inputs:
        path = Path(raw)
        if path.is_dir():
            found = sorted(path.glob("*.csv"))
            if not found:
                raise SystemExit(f"--input {raw}: no .csv files found in directory")
            paths.extend(found)
        elif path.is_file():
            paths.append(path)
        else:
            raise SystemExit(f"--input {raw}: no such file or directory")
    return paths


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train the pinch_start/pinch_release scikit-learn baseline.")
    parser.add_argument(
        "--input", nargs="+", required=True,
        help="One or more Milestone 9 dataset CSV exports, or directories of them.",
    )
    parser.add_argument("--output-dir", default="artifacts", help="Where to write model.joblib and model_card.json.")
    parser.add_argument("--window-ms", type=float, default=DEFAULT_WINDOW_MS, help="Window duration in milliseconds.")
    parser.add_argument("--stride-ms", type=float, default=DEFAULT_STRIDE_MS, help="Window stride in milliseconds (overlap = window-ms - stride-ms).")
    parser.add_argument("--max-gap-ms", type=float, default=DEFAULT_MAX_GAP_MS, help="Max gap between samples before a session is split into segments.")
    parser.add_argument("--min-samples-per-window", type=int, default=DEFAULT_MIN_SAMPLES_PER_WINDOW, help="Minimum raw rows required to keep a window.")
    parser.add_argument(
        "--hold-handling", choices=HOLD_HANDLING_CHOICES, default="exclude",
        help="How to treat pinch_hold rows: exclude (default, dropped), negative (folded into the negative class), or class (trained as its own class).",
    )
    parser.add_argument("--test-size", type=float, default=0.25, help="Fraction of sessions (groups) held out for evaluation.")
    parser.add_argument("--random-seed", type=int, default=42, help="Random seed for the split and the classifier.")
    parser.add_argument("--n-estimators", type=int, default=200, help="Number of trees in the RandomForest baseline.")
    return parser


def _split_by_group(dataset: Dataset, test_size: float, random_seed: int) -> tuple[np.ndarray, np.ndarray]:
    unique_groups = np.unique(dataset.groups)
    if unique_groups.shape[0] < 2:
        raise SystemExit(
            f"grouped holdout needs at least 2 distinct recording sessions, got {unique_groups.shape[0]}. "
            "Provide more CSV files (one per recording session)."
        )
    splitter = GroupShuffleSplit(n_splits=1, test_size=test_size, random_state=random_seed)
    train_idx, test_idx = next(splitter.split(dataset.features, dataset.targets, dataset.groups))
    return train_idx, test_idx


def _false_activation_metrics(y_true: np.ndarray, y_pred: np.ndarray, hold_handling: str) -> dict:
    negative_mask = y_true == NEGATIVE_TARGET
    total_negative = int(np.sum(negative_mask))
    if total_negative == 0:
        return {
            "false_activation_count": 0,
            "false_activation_total_negative_windows": 0,
            "false_activation_rate": None,
        }
    positives = set(positive_targets(hold_handling))
    false_activations = int(sum(1 for pred in y_pred[negative_mask] if pred in positives))
    return {
        "false_activation_count": false_activations,
        "false_activation_total_negative_windows": total_negative,
        "false_activation_rate": false_activations / total_negative,
    }


def train_and_evaluate(dataset: Dataset, args: argparse.Namespace) -> tuple[RandomForestClassifier, dict]:
    train_idx, test_idx = _split_by_group(dataset, args.test_size, args.random_seed)

    x_train, x_test = dataset.features[train_idx], dataset.features[test_idx]
    y_train, y_test = dataset.targets[train_idx], dataset.targets[test_idx]

    model = RandomForestClassifier(
        n_estimators=args.n_estimators,
        random_state=args.random_seed,
        class_weight="balanced",
        n_jobs=1,
    )
    model.fit(x_train, y_train)
    y_pred = model.predict(x_test)

    labels = sorted(np.unique(dataset.targets).tolist())
    report = classification_report(y_test, y_pred, labels=labels, output_dict=True, zero_division=0)
    matrix = confusion_matrix(y_test, y_pred, labels=labels)

    metrics = {
        "accuracy": float(report["accuracy"]),
        "macro_f1": float(report["macro avg"]["f1-score"]),
        "classification_report": report,
        "confusion_matrix": {"labels": labels, "matrix": matrix.tolist()},
        **_false_activation_metrics(y_test, y_pred, args.hold_handling),
    }

    run_info = {
        "n_windows_train": int(train_idx.shape[0]),
        "n_windows_test": int(test_idx.shape[0]),
        "groups_train": sorted(np.unique(dataset.groups[train_idx]).tolist()),
        "groups_test": sorted(np.unique(dataset.groups[test_idx]).tolist()),
        "classes": labels,
        "metrics": metrics,
    }
    return model, run_info


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    input_paths = _resolve_inputs(args.input)
    window_config = WindowConfig(
        window_ms=args.window_ms,
        stride_ms=args.stride_ms,
        max_gap_ms=args.max_gap_ms,
        min_samples_per_window=args.min_samples_per_window,
    )

    dataset = build_dataset(input_paths, window_config, args.hold_handling)
    model, run_info = train_and_evaluate(dataset, args)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    model_path = output_dir / "model.joblib"
    joblib.dump(model, model_path)

    model_card = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "package_version": __version__,
        "sklearn_version": sklearn.__version__,
        "numpy_version": np.__version__,
        "model_file": model_path.name,
        "model_type": "sklearn.ensemble.RandomForestClassifier",
        "random_seed": args.random_seed,
        "window_config": asdict(window_config),
        "hold_handling": args.hold_handling,
        "feature_names": list(dataset.feature_names),
        "input_files": [str(path) for path in input_paths],
        "tflite_export": "not yet implemented — this slice only trains and evaluates the scikit-learn baseline",
        **run_info,
    }
    model_card_path = output_dir / "model_card.json"
    model_card_path.write_text(json.dumps(model_card, indent=2), encoding="utf-8")

    print(f"trained on {run_info['n_windows_train']} windows from {len(run_info['groups_train'])} session(s)")
    print(f"evaluated on {run_info['n_windows_test']} windows from {len(run_info['groups_test'])} held-out session(s)")
    print(f"accuracy={run_info['metrics']['accuracy']:.4f} macro_f1={run_info['metrics']['macro_f1']:.4f}")
    fa_rate = run_info["metrics"]["false_activation_rate"]
    fa_rate_str = f"{fa_rate:.4f}" if fa_rate is not None else "n/a (no negative windows in test set)"
    print(
        f"false_activation_rate={fa_rate_str} "
        f"({run_info['metrics']['false_activation_count']}/{run_info['metrics']['false_activation_total_negative_windows']})"
    )
    print(f"wrote {model_path}")
    print(f"wrote {model_card_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
