"""Maps recorder labels onto classifier targets.

Boundary note (M1-B): a recorder label (a collection label, see
`label_registry.rs` on the desktop side) carries no training semantics by
itself. Whether a given label is trained as a target class, folded into the
negative/background class, or excluded from training entirely is decided per
training run by an explicit, versioned `LabelMapping` (see `LabelMapping`
below): a label with no entry in that mapping is never silently treated as
negative — `build_dataset`/`build_dataset_from_recordings` rejects the run.

`legacy_compatibility_mapping()` is the one sanctioned exception: it
reproduces this module's original hard-coded behavior (pinch_start and
pinch_release are always targets; every other recorder label, including
pinch_hold by default, is not a target) so that CSVs recorded before
per-label training roles existed keep training exactly as before, without
requiring an explicit mapping file. New, non-legacy labels are never covered
by it and must be supplied an explicit mapping entry.

pinch_hold's fate under the legacy mapping is controlled by
--hold-handling (see train.py --help / README.md): there is no silent
default that changes behavior based on what happens to be in the data.
"""

from __future__ import annotations

from dataclasses import dataclass

from .schema import (
    GESTURE_DATASET_LABELS,
    PINCH_HOLD_LABEL,
    PINCH_RELEASE_LABEL,
    PINCH_START_LABEL,
)

NEGATIVE_TARGET = "negative"

HOLD_HANDLING_CHOICES = ("exclude", "negative", "class")

LABEL_MAPPING_VERSION = 1
_VALID_MAPPING_ROLES = ("target", "negative", "exclude")


@dataclass(frozen=True)
class LabelMappingEntry:
    """One label's explicit training role. `target` is required (and only meaningful) when role == "target"."""

    role: str  # "target" | "negative" | "exclude"
    target: str | None = None


@dataclass(frozen=True)
class LabelMapping:
    """A versioned, explicit label-to-training-target mapping owned by a training selection.

    Never attach this to a collection label's persisted identity: it is
    recomputed (legacy defaults merged with any explicit overrides) for each
    training run, not stored as part of the label itself.
    """

    version: int
    entries: dict[str, LabelMappingEntry]

    def resolve(self, label: str) -> str | None:
        """Returns the classifier target for `label`, or None to drop the row.

        Raises KeyError if `label` has no entry; callers must check
        `missing_labels()` against every label present in the input data
        before calling this, so an unmapped label is always a clear
        rejection rather than a KeyError surfacing mid-run.
        """
        entry = self.entries[label]
        if entry.role == "exclude":
            return None
        if entry.role == "negative":
            return NEGATIVE_TARGET
        return entry.target


def load_label_mapping(payload: dict) -> LabelMapping:
    """Parses a `LabelMapping` from JSON (see the desktop's `training_label_mapping.rs`, which mirrors this shape)."""
    version = payload.get("version")
    if version != LABEL_MAPPING_VERSION:
        raise ValueError(f"unsupported label mapping version {version!r}; expected {LABEL_MAPPING_VERSION}")
    entries: dict[str, LabelMappingEntry] = {}
    for label, raw_entry in payload.get("entries", {}).items():
        role = raw_entry.get("role")
        if role not in _VALID_MAPPING_ROLES:
            raise ValueError(f"label {label!r}: role must be one of {_VALID_MAPPING_ROLES}, got {role!r}")
        target = raw_entry.get("target")
        if role == "target" and not target:
            raise ValueError(f"label {label!r}: role 'target' requires a non-empty 'target' class name")
        entries[label] = LabelMappingEntry(role=role, target=target)
    return LabelMapping(version=version, entries=entries)


def missing_labels(mapping: LabelMapping, labels: set[str]) -> set[str]:
    """Labels present in the data with no explicit entry in `mapping`. Callers must reject these, never default them."""
    return {label for label in labels if label not in mapping.entries}


def validate_mapping_targets(mapping: LabelMapping, allowed_targets: tuple[str, ...]) -> None:
    """Rejects a mapping that would produce a "target" role class outside `allowed_targets`.

    For a caller whose deployment output is hard-pinned to a fixed class set (see
    train_tflite.py's `CLASS_NAMES`), an explicit mapping must not be able to smuggle in a
    class the deployed model was never built to emit.
    """
    disallowed = sorted(
        {
            entry.target
            for entry in mapping.entries.values()
            if entry.role == "target" and entry.target not in allowed_targets
        }
    )
    if disallowed:
        raise ValueError(
            f"label mapping targets {disallowed} are not in the deployable class set {list(allowed_targets)}; "
            "use role 'negative' or 'exclude' for any label that must not train one of these target classes"
        )


def mapping_positive_targets(mapping: LabelMapping) -> tuple[str, ...]:
    """Targets that count as an activation under an explicit mapping (mirrors `positive_targets` for legacy runs)."""
    return tuple(sorted({entry.target for entry in mapping.entries.values() if entry.role == "target" and entry.target}))


def legacy_compatibility_mapping(hold_handling: str) -> LabelMapping:
    """The explicit-mapping equivalent of this module's original hard-coded resolve_target()/positive_targets()
    behavior, for recordings made before per-label training roles existed. Only the fixed legacy vocabulary
    (`GESTURE_DATASET_LABELS`) is covered; any other label is left unmapped on purpose.
    """
    if hold_handling not in HOLD_HANDLING_CHOICES:
        raise ValueError(f"unknown hold_handling {hold_handling!r}, expected one of {HOLD_HANDLING_CHOICES}")
    entries = {label: LabelMappingEntry(role="negative") for label in GESTURE_DATASET_LABELS}
    entries[PINCH_START_LABEL] = LabelMappingEntry(role="target", target=PINCH_START_LABEL)
    entries[PINCH_RELEASE_LABEL] = LabelMappingEntry(role="target", target=PINCH_RELEASE_LABEL)
    if hold_handling == "exclude":
        entries[PINCH_HOLD_LABEL] = LabelMappingEntry(role="exclude")
    elif hold_handling == "negative":
        entries[PINCH_HOLD_LABEL] = LabelMappingEntry(role="negative")
    else:
        entries[PINCH_HOLD_LABEL] = LabelMappingEntry(role="target", target=PINCH_HOLD_LABEL)
    return LabelMapping(version=LABEL_MAPPING_VERSION, entries=entries)


def resolve_target(label: str, hold_handling: str) -> str | None:
    """Returns the classifier target for a raw recorder label, or None to drop the row.

    hold_handling:
      - "exclude": pinch_hold rows are dropped entirely (not trained on, not evaluated).
      - "negative": pinch_hold rows count as the negative class (a held pinch must not
        look like a false activation of start/release).
      - "class": pinch_hold is trained and evaluated as its own explicit class.
    """
    if hold_handling not in HOLD_HANDLING_CHOICES:
        raise ValueError(f"unknown hold_handling {hold_handling!r}, expected one of {HOLD_HANDLING_CHOICES}")

    if label == PINCH_START_LABEL:
        return PINCH_START_LABEL
    if label == PINCH_RELEASE_LABEL:
        return PINCH_RELEASE_LABEL
    if label == PINCH_HOLD_LABEL:
        if hold_handling == "exclude":
            return None
        if hold_handling == "negative":
            return NEGATIVE_TARGET
        return PINCH_HOLD_LABEL  # "class"
    return NEGATIVE_TARGET


def positive_targets(hold_handling: str) -> tuple[str, ...]:
    """Targets that count as an activation (used for the false-activation metric)."""
    if hold_handling == "class":
        return (PINCH_START_LABEL, PINCH_RELEASE_LABEL, PINCH_HOLD_LABEL)
    return (PINCH_START_LABEL, PINCH_RELEASE_LABEL)
