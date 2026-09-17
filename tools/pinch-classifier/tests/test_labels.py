from __future__ import annotations

import pytest

from pinch_classifier.labels import LabelMapping, LabelMappingEntry, validate_mapping_targets


def _mapping(entries: dict[str, LabelMappingEntry]) -> LabelMapping:
    return LabelMapping(version=1, entries=entries)


def test_validate_mapping_targets_accepts_only_allowed_targets():
    mapping = _mapping(
        {
            "pinch_start": LabelMappingEntry(role="target", target="pinch_start"),
            "idle": LabelMappingEntry(role="negative"),
            "pinch_hold": LabelMappingEntry(role="exclude"),
        }
    )
    validate_mapping_targets(mapping, ("pinch_start", "pinch_release"))


def test_validate_mapping_targets_rejects_a_target_outside_the_allowed_set():
    mapping = _mapping({"double_tap": LabelMappingEntry(role="target", target="double_tap")})
    with pytest.raises(ValueError, match="double_tap"):
        validate_mapping_targets(mapping, ("pinch_start", "pinch_release"))
