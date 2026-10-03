from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

from pinch_classifier.replay import (
    LABEL_MAPPING_FILENAME,
    build_replay_dataset,
    resolve_replay_label_mapping,
)

from .conftest import make_dataset_csv

FIXTURE_METADATA = json.loads(
    (Path(__file__).parent / "fixtures" / "valid_bundle" / "metadata.json").read_text(encoding="utf-8")
)

# A user-defined collection label the training run mapped to a deployable target.
TRAINING_MAPPING = {
    "version": 1,
    "entries": {
        "idle": {"role": "negative"},
        "fist_clench": {"role": "target", "target": "pinch_start"},
    },
}


def _inputs(tmp_path: Path) -> list[Path]:
    return [
        make_dataset_csv(tmp_path, "idle.csv", "idle", 120),
        make_dataset_csv(tmp_path, "fist.csv", "fist_clench", 120, accel_bias=0.5),
    ]


def test_replay_resolves_labels_through_the_training_mapping(tmp_path):
    """D-M3-5: a label trained as pinch_start must be replayed as pinch_start, not negative."""
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / LABEL_MAPPING_FILENAME).write_text(json.dumps(TRAINING_MAPPING), encoding="utf-8")

    dataset = build_replay_dataset(bundle_dir, FIXTURE_METADATA, _inputs(tmp_path))

    counts = Counter(str(target) for target in dataset.targets)
    assert counts["pinch_start"] > 0, "fist_clench windows must keep their trained target"
    assert counts["negative"] > 0
    assert {str(w.label) for w, t in zip(dataset.windows, dataset.targets) if str(t) == "pinch_start"} == {
        "fist_clench"
    }


def test_replay_without_a_mapping_rejects_unknown_labels_instead_of_scoring_them_negative(tmp_path):
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()  # an imported bundle: no label_mapping.json

    with pytest.raises(ValueError, match="fist_clench"):
        build_replay_dataset(bundle_dir, FIXTURE_METADATA, _inputs(tmp_path))


def test_replay_without_a_mapping_uses_the_legacy_vocabulary(tmp_path):
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    mapping = resolve_replay_label_mapping(bundle_dir)
    assert mapping.resolve("pinch_start") == "pinch_start"
    assert mapping.resolve("pinch_hold") is None  # excluded, as the tflite trainer's legacy path does


def test_replay_rejects_a_mapping_that_targets_a_class_the_bundle_cannot_emit(tmp_path):
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    bad = {"version": 1, "entries": {"fist_clench": {"role": "target", "target": "double_tap"}}}
    (bundle_dir / LABEL_MAPPING_FILENAME).write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError, match="double_tap"):
        resolve_replay_label_mapping(bundle_dir)
