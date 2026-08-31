"""Maps recorder labels onto classifier targets.

pinch_start and pinch_release are always trained as classes. Every other
recorder label (idle, walking, typing, ...) becomes the "negative" class, and
those windows are retained through evaluation so we can measure false
activations. pinch_hold is optional and its handling must be picked
explicitly via --hold-handling (see train.py --help / README.md); there is no
silent default that changes behavior based on what happens to be in the data.
"""

from __future__ import annotations

from .schema import PINCH_HOLD_LABEL, PINCH_RELEASE_LABEL, PINCH_START_LABEL

NEGATIVE_TARGET = "negative"

HOLD_HANDLING_CHOICES = ("exclude", "negative", "class")


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
