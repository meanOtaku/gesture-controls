"""Assembles a feature matrix, target vector, and group vector from CSV exports.

The group vector is the recording's session_id (CSV filename stem). Grouped
holdout splitting (see train.py) guarantees no session contributes windows to
both the train and test sets, so evaluation never sees a recording the model
trained on.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .csv_io import Recording, load_recordings
from .features import FEATURE_NAMES, extract_features
from .labels import LabelMapping, missing_labels, resolve_target
from .windowing import Window, WindowConfig, build_windows


@dataclass(frozen=True)
class Dataset:
    features: np.ndarray  # (n_windows, len(FEATURE_NAMES))
    targets: np.ndarray  # (n_windows,) str
    groups: np.ndarray  # (n_windows,) str, session_id
    raw_labels: np.ndarray  # (n_windows,) str, original recorder label
    windows: list[Window]
    feature_names: tuple[str, ...] = FEATURE_NAMES


def build_dataset(
    paths: list[str | Path],
    window_config: WindowConfig,
    hold_handling: str,
    label_mapping: LabelMapping | None = None,
) -> Dataset:
    recordings = load_recordings(paths)
    return build_dataset_from_recordings(recordings, window_config, hold_handling, label_mapping=label_mapping)


def build_dataset_from_recordings(
    recordings: list[Recording],
    window_config: WindowConfig,
    hold_handling: str,
    label_mapping: LabelMapping | None = None,
) -> Dataset:
    """`label_mapping`, when given, fully replaces `hold_handling` and the legacy `resolve_target` lookup:
    every raw label present in `recordings` must have an explicit entry, or the whole run is rejected
    before any windowing/training happens (see `LabelMapping.resolve` / `missing_labels`).
    """
    if label_mapping is not None:
        raw_labels_present = {label for recording in recordings for label in recording.raw_labels.tolist()}
        unmapped = missing_labels(label_mapping, raw_labels_present)
        if unmapped:
            raise ValueError(
                "the following collection label(s) have no explicit training role mapping "
                f"(target/negative/exclude): {', '.join(sorted(unmapped))}. Assign a role for each "
                "before training; unmapped labels are never silently treated as negative."
            )

    feature_rows: list[np.ndarray] = []
    targets: list[str] = []
    groups: list[str] = []
    raw_labels: list[str] = []
    kept_windows: list[Window] = []

    for recording in recordings:
        for window in build_windows(recording, window_config):
            target = label_mapping.resolve(window.label) if label_mapping is not None else resolve_target(window.label, hold_handling)
            if target is None:
                continue
            feature_rows.append(extract_features(recording, window))
            targets.append(target)
            groups.append(window.session_id)
            raw_labels.append(window.label)
            kept_windows.append(window)

    if not feature_rows:
        raise ValueError(
            "no windows survived windowing + hold_handling filtering; check --window-ms/--max-gap-ms "
            "against the recording rate, and confirm the inputs contain more than one contiguous sample run"
        )

    return Dataset(
        features=np.stack(feature_rows),
        targets=np.array(targets, dtype=object),
        groups=np.array(groups, dtype=object),
        raw_labels=np.array(raw_labels, dtype=object),
        windows=kept_windows,
    )
