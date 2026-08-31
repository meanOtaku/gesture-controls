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
from .labels import resolve_target
from .windowing import Window, WindowConfig, build_windows


@dataclass(frozen=True)
class Dataset:
    features: np.ndarray  # (n_windows, len(FEATURE_NAMES))
    targets: np.ndarray  # (n_windows,) str
    groups: np.ndarray  # (n_windows,) str, session_id
    raw_labels: np.ndarray  # (n_windows,) str, original recorder label
    windows: list[Window]
    feature_names: tuple[str, ...] = FEATURE_NAMES


def build_dataset(paths: list[str | Path], window_config: WindowConfig, hold_handling: str) -> Dataset:
    recordings = load_recordings(paths)
    return build_dataset_from_recordings(recordings, window_config, hold_handling)


def build_dataset_from_recordings(
    recordings: list[Recording], window_config: WindowConfig, hold_handling: str
) -> Dataset:
    feature_rows: list[np.ndarray] = []
    targets: list[str] = []
    groups: list[str] = []
    raw_labels: list[str] = []
    kept_windows: list[Window] = []

    for recording in recordings:
        for window in build_windows(recording, window_config):
            target = resolve_target(window.label, hold_handling)
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
