"""CLI: offline-only research harness comparing the existing baseline feature set against a
derivative-feature candidate (M5, see .hermes/plans/2026-09-22_072210-data-collection-derivative-viewer-milestones.md).

    pinch-classifier-experiment --input session1.csv session2.csv ... --output report.json

This never trains a deployable model, never writes model.joblib, and never touches
LiteRT/TFLite bundle contracts, model activation, or live inference: it is analysis only,
run against explicitly supplied local dataset paths (no network, no telemetry).

Both feature sets are trained/evaluated on the exact same grouped session train/test split
and the exact same window subset, so the comparison isolates the effect of adding the
derivative feature block (see derivative_features.py). Windows whose timestamp stream fails
the derivative precondition are excluded from *both* sides (not silently dropped -- their
count and reasons are reported) so the comparison stays apples-to-apples.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix

from . import __version__
from .csv_io import load_recordings
from .dataset import build_dataset
from .derivative_features import (
    DEFAULT_TIMESTAMP_TOLERANCE,
    DERIVATIVE_FEATURE_NAMES,
    check_timestamp_regularity,
    extract_derivative_features,
)
from .features import FEATURE_NAMES
from .labels import HOLD_HANDLING_CHOICES, load_label_mapping, mapping_positive_targets, positive_targets
from .train import _false_activation_metrics, _resolve_inputs, _split_by_group
from .windowing import (
    DEFAULT_MAX_GAP_MS,
    DEFAULT_MIN_SAMPLES_PER_WINDOW,
    DEFAULT_STRIDE_MS,
    DEFAULT_WINDOW_MS,
    WindowConfig,
)

MATERIAL_MACRO_F1_GAIN = 0.01  # smallest macro-F1 improvement worth calling "material"
SMALL_SAMPLE_WINDOW_COUNT = 50  # below this, flag the comparison as indicative only


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare baseline features against baseline+derivative features (offline research only)."
    )
    parser.add_argument("--input", nargs="+", required=True, help="Dataset CSV exports, or directories of them.")
    parser.add_argument("--output", type=Path, required=True, help="Path to write the machine-readable JSON report.")
    parser.add_argument("--window-ms", type=float, default=DEFAULT_WINDOW_MS)
    parser.add_argument("--stride-ms", type=float, default=DEFAULT_STRIDE_MS)
    parser.add_argument("--max-gap-ms", type=float, default=DEFAULT_MAX_GAP_MS)
    parser.add_argument("--min-samples-per-window", type=int, default=DEFAULT_MIN_SAMPLES_PER_WINDOW)
    parser.add_argument("--hold-handling", choices=HOLD_HANDLING_CHOICES, default="exclude")
    parser.add_argument("--label-mapping-file", type=Path, default=None)
    parser.add_argument("--test-size", type=float, default=0.25)
    parser.add_argument("--random-seed", type=int, default=42)
    parser.add_argument("--n-estimators", type=int, default=200)
    parser.add_argument(
        "--timestamp-tolerance", type=float, default=DEFAULT_TIMESTAMP_TOLERANCE,
        help="Max fractional deviation of a sample interval from a window's median cadence "
             "before its timestamp stream is rejected for derivative features.",
    )
    return parser


def _fit_and_score(
    x_train: np.ndarray, y_train: np.ndarray, x_test: np.ndarray, y_test: np.ndarray,
    classes: list[str], positive_target_names: tuple[str, ...], random_seed: int, n_estimators: int,
) -> dict:
    model = RandomForestClassifier(
        n_estimators=n_estimators, random_state=random_seed, class_weight="balanced", n_jobs=1,
    )
    model.fit(x_train, y_train)
    y_pred = model.predict(x_test)

    report = classification_report(y_test, y_pred, labels=classes, output_dict=True, zero_division=0)
    matrix = confusion_matrix(y_test, y_pred, labels=classes)
    return {
        "accuracy": float(report["accuracy"]),
        "macro_f1": float(report["macro avg"]["f1-score"]),
        "classification_report": report,
        "confusion_matrix": {"labels": classes, "matrix": matrix.tolist()},
        **_false_activation_metrics(y_test, y_pred, positive_target_names),
    }


def _recommendation(baseline_metrics: dict, candidate_metrics: dict, kept_window_count: int) -> str:
    caveat = ""
    if kept_window_count < SMALL_SAMPLE_WINDOW_COUNT:
        caveat = (
            f"Only {kept_window_count} windows passed the derivative timestamp precondition; "
            "this dataset is too small to draw a reliable conclusion. "
        )

    f1_gain = candidate_metrics["macro_f1"] - baseline_metrics["macro_f1"]
    baseline_fa = baseline_metrics["false_activation_rate"]
    candidate_fa = candidate_metrics["false_activation_rate"]
    fa_regressed = (
        baseline_fa is not None and candidate_fa is not None and candidate_fa > baseline_fa
    )

    if f1_gain >= MATERIAL_MACRO_F1_GAIN and not fa_regressed:
        verdict = (
            f"Derivative features improved macro F1 by {f1_gain:+.4f} without increasing the false "
            "activation rate; worth a reviewed training run on more sessions before any deployment decision."
        )
    elif f1_gain >= MATERIAL_MACRO_F1_GAIN and fa_regressed:
        verdict = (
            f"Derivative features improved macro F1 by {f1_gain:+.4f} but also increased the false "
            "activation rate; not recommended without further investigation."
        )
    else:
        verdict = (
            f"Derivative features did not materially improve macro F1 ({f1_gain:+.4f} on this dataset); "
            "keep the existing baseline feature set."
        )
    return caveat + verdict


def run_experiment(args: argparse.Namespace) -> dict:
    input_paths = _resolve_inputs(args.input)
    window_config = WindowConfig(
        window_ms=args.window_ms, stride_ms=args.stride_ms,
        max_gap_ms=args.max_gap_ms, min_samples_per_window=args.min_samples_per_window,
    )

    label_mapping = None
    if args.label_mapping_file is not None:
        payload = json.loads(args.label_mapping_file.read_text(encoding="utf-8"))
        label_mapping = load_label_mapping(payload)

    recordings = load_recordings(input_paths)
    recordings_by_session = {recording.session_id: recording for recording in recordings}

    dataset = build_dataset(input_paths, window_config, args.hold_handling, label_mapping=label_mapping)

    kept_indices: list[int] = []
    derivative_rows: list[np.ndarray] = []
    rejection_reasons: Counter[str] = Counter()

    for index, window in enumerate(dataset.windows):
        recording = recordings_by_session[window.session_id]
        timestamps_ns = recording.timestamps_ns[window.row_indices]
        ok, reason = check_timestamp_regularity(timestamps_ns, args.timestamp_tolerance)
        if not ok:
            rejection_reasons[reason.split(" (tolerance")[0]] += 1
            continue
        derivative_rows.append(extract_derivative_features(recording, window))
        kept_indices.append(index)

    total_windows = len(dataset.windows)
    rejected_count = total_windows - len(kept_indices)

    if not kept_indices:
        raise SystemExit(
            f"no windows passed the derivative timestamp-quality precondition out of {total_windows} total "
            f"(reasons: {dict(rejection_reasons)}); cannot run the baseline-vs-derivative comparison"
        )

    kept_indices_array = np.array(kept_indices, dtype=np.int64)
    baseline_features = dataset.features[kept_indices_array]
    candidate_features = np.concatenate([baseline_features, np.stack(derivative_rows)], axis=1)
    targets = dataset.targets[kept_indices_array]
    groups = dataset.groups[kept_indices_array]

    class KeptDataset:
        pass

    kept_for_split = KeptDataset()
    kept_for_split.features = baseline_features
    kept_for_split.targets = targets
    kept_for_split.groups = groups
    train_idx, test_idx = _split_by_group(kept_for_split, args.test_size, args.random_seed)

    classes = sorted(np.unique(targets).tolist())
    positive_target_names = (
        mapping_positive_targets(label_mapping) if label_mapping is not None else positive_targets(args.hold_handling)
    )

    baseline_metrics = _fit_and_score(
        baseline_features[train_idx], targets[train_idx], baseline_features[test_idx], targets[test_idx],
        classes, positive_target_names, args.random_seed, args.n_estimators,
    )
    candidate_metrics = _fit_and_score(
        candidate_features[train_idx], targets[train_idx], candidate_features[test_idx], targets[test_idx],
        classes, positive_target_names, args.random_seed, args.n_estimators,
    )

    raw_label_counts = Counter(dataset.raw_labels[kept_indices_array].tolist())

    return {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "package_version": __version__,
        "sklearn_version": sklearn.__version__,
        "numpy_version": np.__version__,
        "input_files": [str(path) for path in input_paths],
        "window_config": {
            "window_ms": window_config.window_ms,
            "stride_ms": window_config.stride_ms,
            "max_gap_ms": window_config.max_gap_ms,
            "min_samples_per_window": window_config.min_samples_per_window,
        },
        "hold_handling": args.hold_handling,
        "split": {
            "method": "GroupShuffleSplit by session_id (grouped holdout)",
            "test_size": args.test_size,
            "random_seed": args.random_seed,
            "groups_train": sorted(np.unique(groups[train_idx]).tolist()),
            "groups_test": sorted(np.unique(groups[test_idx]).tolist()),
        },
        "dataset_counts": {
            "n_sessions_total": len(recordings),
            "n_windows_total": total_windows,
            "n_windows_kept": len(kept_indices),
            "n_windows_rejected_timestamp_quality": rejected_count,
            "rejection_reasons": dict(rejection_reasons),
            "raw_label_counts": dict(raw_label_counts),
            "classes": classes,
        },
        "timestamp_quality_precondition": {
            "description": "windows whose sample-interval deviation from the window's median "
                            "cadence exceeds the tolerance are excluded from both feature sets",
            "tolerance": args.timestamp_tolerance,
        },
        "baseline": {"feature_names": list(FEATURE_NAMES), "metrics": baseline_metrics},
        "candidate": {
            "feature_names": list(FEATURE_NAMES) + list(DERIVATIVE_FEATURE_NAMES),
            "added_feature_names": list(DERIVATIVE_FEATURE_NAMES),
            "metrics": candidate_metrics,
        },
        "recommendation": _recommendation(baseline_metrics, candidate_metrics, len(kept_indices)),
    }


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    report = run_experiment(args)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"sessions={report['dataset_counts']['n_sessions_total']} "
          f"windows_kept={report['dataset_counts']['n_windows_kept']} "
          f"windows_rejected={report['dataset_counts']['n_windows_rejected_timestamp_quality']}")
    print(f"baseline: accuracy={report['baseline']['metrics']['accuracy']:.4f} "
          f"macro_f1={report['baseline']['metrics']['macro_f1']:.4f}")
    print(f"candidate: accuracy={report['candidate']['metrics']['accuracy']:.4f} "
          f"macro_f1={report['candidate']['metrics']['macro_f1']:.4f}")
    print(report["recommendation"])
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
