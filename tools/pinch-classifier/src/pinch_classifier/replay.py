"""Offline, side-effect-free replay of managed recordings against a LiteRT bundle.

This deliberately consumes the same CSV/window/feature/bundle contracts as training.
It emits one bounded JSON document and never imports desktop control code.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

from .bundle import CLASS_NAMES, METADATA_FILENAME, MODEL_FILENAME, validate_metadata
from .dataset import Dataset, build_dataset
from .labels import (
    LabelMapping,
    legacy_compatibility_mapping,
    load_label_mapping,
    validate_mapping_targets,
)
from .windowing import WindowConfig

MAX_OUTCOMES = 200
# Written next to the model by the desktop's training job (`model_lab.rs`), so a
# replay can resolve labels exactly as the run that produced the bundle did.
LABEL_MAPPING_FILENAME = "label_mapping.json"


def resolve_replay_label_mapping(bundle_dir: Path) -> LabelMapping:
    """The label mapping a replay must use: the one the bundle was trained with.

    Training always resolves labels through an explicit mapping, so replaying
    without it re-roles every user-defined collection label to `negative`
    (D-M3-5). A bundle with no mapping file (e.g. an imported custom bundle)
    falls back to the legacy fixed-vocabulary mapping, which -- unlike the old
    behavior -- rejects any label it does not cover instead of silently
    treating it as negative.
    """
    path = bundle_dir / LABEL_MAPPING_FILENAME
    if not path.is_file():
        return legacy_compatibility_mapping("exclude")
    mapping = load_label_mapping(json.loads(path.read_text(encoding="utf-8")))
    validate_mapping_targets(mapping, CLASS_NAMES[1:])
    return mapping


def build_replay_dataset(bundle_dir: Path, metadata: dict[str, Any], inputs: list[Path]) -> Dataset:
    """Windows `inputs` with the bundle's declared window config and its training label mapping."""
    config = WindowConfig(**{key: metadata["window_config"][key] for key in (
        "window_ms", "stride_ms", "max_gap_ms", "min_samples_per_window"
    )})
    return build_dataset(
        list(inputs), config, "exclude", label_mapping=resolve_replay_label_mapping(bundle_dir)
    )


def replay(bundle_dir: Path, inputs: list[Path], max_outcomes: int = MAX_OUTCOMES) -> dict[str, Any]:
    """Run fixed-contract offline inference and return bounded, serializable results."""
    if not 1 <= max_outcomes <= MAX_OUTCOMES:
        raise ValueError(f"max_outcomes must be between 1 and {MAX_OUTCOMES}")
    metadata = json.loads((bundle_dir / METADATA_FILENAME).read_text(encoding="utf-8"))
    validate_metadata(metadata, bundle_dir)
    dataset = build_replay_dataset(bundle_dir, metadata, inputs)
    try:
        import tensorflow as tf
    except ImportError as exc:
        raise RuntimeError("offline LiteRT replay requires pinch-classifier[tensorflow]") from exc
    interpreter = tf.lite.Interpreter(model_path=str(bundle_dir / MODEL_FILENAME))
    interpreter.allocate_tensors()
    input_detail = interpreter.get_input_details()[0]
    output_detail = interpreter.get_output_details()[0]
    outcomes: list[dict[str, Any]] = []
    correct = 0
    predicted_counts = {label: 0 for label in CLASS_NAMES}
    for index, (features, target, window) in enumerate(zip(dataset.features, dataset.targets, dataset.windows, strict=True)):
        interpreter.set_tensor(input_detail["index"], features.astype(np.float32).reshape(1, -1))
        interpreter.invoke()
        probabilities = interpreter.get_tensor(output_detail["index"])[0]
        if probabilities.shape != (len(CLASS_NAMES),) or not np.isfinite(probabilities).all():
            raise ValueError("LiteRT model returned invalid probabilities")
        predicted = CLASS_NAMES[int(np.argmax(probabilities))]
        predicted_counts[predicted] += 1
        matched = predicted == target
        correct += int(matched)
        if len(outcomes) < max_outcomes:
            outcomes.append({
                "index": index,
                "session_id": window.session_id,
                "timestamp_ns": window.end_ns,
                "expected": str(target),
                "predicted": predicted,
                "matched": matched,
                "confidence": float(np.max(probabilities)),
            })
    return {
        "model_sha256": metadata["model"]["sha256"],
        "window_count": len(dataset.windows),
        "matched_count": correct,
        "accuracy": correct / len(dataset.windows),
        "predicted_counts": predicted_counts,
        "outcomes": outcomes,
        "outcomes_truncated": len(dataset.windows) > len(outcomes),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay recordings against a validated LiteRT bundle without desktop actions.")
    parser.add_argument("--bundle-dir", required=True)
    parser.add_argument("--input", nargs="+", required=True)
    parser.add_argument("--max-outcomes", type=int, default=MAX_OUTCOMES)
    args = parser.parse_args(argv)
    result = replay(Path(args.bundle_dir), [Path(value) for value in args.input], args.max_outcomes)
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
