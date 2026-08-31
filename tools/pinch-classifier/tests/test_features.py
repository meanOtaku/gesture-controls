from __future__ import annotations

import numpy as np

from pinch_classifier.csv_io import load_recording
from pinch_classifier.features import FEATURE_NAMES, extract_features
from pinch_classifier.windowing import WindowConfig, build_windows

from .conftest import make_dataset_csv


def _first_window(tmp_path, **kwargs):
    path = make_dataset_csv(tmp_path, "session.csv", "idle", row_count=50, **kwargs)
    recording = load_recording(path)
    config = WindowConfig(window_ms=200.0, stride_ms=100.0, max_gap_ms=250.0, min_samples_per_window=3)
    windows = build_windows(recording, config)
    return recording, windows[0]


def test_feature_vector_matches_contract_length(tmp_path):
    recording, window = _first_window(tmp_path)
    vector = extract_features(recording, window)
    assert vector.shape == (len(FEATURE_NAMES),)
    assert np.all(np.isfinite(vector))


def test_feature_extraction_is_deterministic(tmp_path):
    recording, window = _first_window(tmp_path)
    first = extract_features(recording, window)
    second = extract_features(recording, window)
    np.testing.assert_array_equal(first, second)


def test_features_do_not_leak_future_samples(tmp_path):
    """Perturbing rows strictly after a window's span must not change that window's features."""
    from dataclasses import replace

    recording, window = _first_window(tmp_path)
    vector = extract_features(recording, window)

    last_index_in_window = int(window.row_indices[-1])
    assert last_index_in_window < recording.timestamps_ns.shape[0] - 1

    perturbed_channels = {column: values.copy() for column, values in recording.channels.items()}
    perturbed_channels["accel_x"][last_index_in_window + 1 :] += 999.0
    perturbed_recording = replace(recording, channels=perturbed_channels)

    vector_after_perturbation = extract_features(perturbed_recording, window)
    np.testing.assert_array_equal(vector, vector_after_perturbation)
