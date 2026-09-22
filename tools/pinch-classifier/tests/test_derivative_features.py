from __future__ import annotations

import numpy as np

from pinch_classifier.csv_io import load_recording
from pinch_classifier.derivative_features import (
    DERIVATIVE_FEATURE_NAMES,
    check_timestamp_regularity,
    extract_derivative_features,
)
from pinch_classifier.windowing import WindowConfig, build_windows

from .conftest import make_dataset_csv


def _first_window(tmp_path, **kwargs):
    path = make_dataset_csv(tmp_path, "session.csv", "idle", row_count=50, **kwargs)
    recording = load_recording(path)
    config = WindowConfig(window_ms=200.0, stride_ms=100.0, max_gap_ms=250.0, min_samples_per_window=3)
    windows = build_windows(recording, config)
    return recording, windows[0]


def test_check_timestamp_regularity_accepts_uniform_cadence(tmp_path):
    recording, window = _first_window(tmp_path)
    timestamps_ns = recording.timestamps_ns[window.row_indices]
    ok, reason = check_timestamp_regularity(timestamps_ns)
    assert ok
    assert reason == ""


def test_check_timestamp_regularity_rejects_irregular_cadence():
    # First interval is 20ms, second is 200ms: 10x the median -- clearly irregular.
    timestamps_ns = np.array([0, 20_000_000, 220_000_000], dtype=np.int64)
    ok, reason = check_timestamp_regularity(timestamps_ns)
    assert not ok
    assert "deviates" in reason


def test_check_timestamp_regularity_rejects_non_monotonic():
    timestamps_ns = np.array([0, 20_000_000, 20_000_000], dtype=np.int64)
    ok, reason = check_timestamp_regularity(timestamps_ns)
    assert not ok
    assert "non-positive or duplicate" in reason


def test_extract_derivative_features_matches_contract_length(tmp_path):
    recording, window = _first_window(tmp_path)
    vector = extract_derivative_features(recording, window)
    assert vector.shape == (len(DERIVATIVE_FEATURE_NAMES),)
    assert np.all(np.isfinite(vector))


def test_extract_derivative_features_zero_for_constant_channel(tmp_path):
    recording, window = _first_window(tmp_path)
    # accel_z is a hardcoded constant (9.8) in the synthetic fixture; its derivative
    # mean/std must be ~0 regardless of the other (sinusoidal) channels.
    index = DERIVATIVE_FEATURE_NAMES.index("accel_z_deriv_mean")
    std_index = DERIVATIVE_FEATURE_NAMES.index("accel_z_deriv_std")
    vector = extract_derivative_features(recording, window)
    assert abs(vector[index]) < 1e-9
    assert abs(vector[std_index]) < 1e-9


def test_extract_derivative_features_rejects_irregular_timestamps(tmp_path):
    recording, window = _first_window(tmp_path, gap_after_row=5, gap_ns=2_000_000_000)
    # Window straddling the injected 2s gap should fail the precondition.
    straddling = [w for w in build_windows(
        recording, WindowConfig(window_ms=2500.0, stride_ms=1000.0, max_gap_ms=5_000.0, min_samples_per_window=3)
    ) if w.row_indices[0] <= 5 <= w.row_indices[-1]]
    assert straddling, "expected at least one window straddling the injected gap"
    try:
        extract_derivative_features(recording, straddling[0])
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "precondition" in str(exc)
