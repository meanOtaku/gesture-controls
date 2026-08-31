from __future__ import annotations

from pinch_classifier.csv_io import load_recording
from pinch_classifier.windowing import WindowConfig, build_windows

from .conftest import SAMPLE_INTERVAL_NS, make_dataset_csv


def test_builds_overlapping_windows(tmp_path):
    path = make_dataset_csv(tmp_path, "session.csv", "idle", row_count=100)
    recording = load_recording(path)
    config = WindowConfig(window_ms=200.0, stride_ms=100.0, max_gap_ms=250.0, min_samples_per_window=3)

    windows = build_windows(recording, config)

    assert len(windows) > 1
    assert all(window.label == "idle" for window in windows)
    assert all(window.row_indices.shape[0] >= config.min_samples_per_window for window in windows)
    # Overlap: consecutive windows share rows.
    first, second = windows[0], windows[1]
    assert set(first.row_indices.tolist()) & set(second.row_indices.tolist())


def test_splits_on_discontinuity(tmp_path):
    path = make_dataset_csv(
        tmp_path, "session_gap.csv", "idle", row_count=60, gap_after_row=29, gap_ns=1_000_000_000
    )
    recording = load_recording(path)
    config = WindowConfig(window_ms=200.0, stride_ms=100.0, max_gap_ms=250.0, min_samples_per_window=3)

    windows = build_windows(recording, config)

    # No window may straddle the 1s gap: every window's span must be <= configured window_ms.
    for window in windows:
        assert (window.end_ns - window.start_ns) <= 200 * 1_000_000
    # Windows exist on both sides of the gap.
    pre_gap_row_ns = 29 * SAMPLE_INTERVAL_NS
    assert any(window.end_ns <= pre_gap_row_ns + SAMPLE_INTERVAL_NS for window in windows)
    assert any(window.start_ns >= pre_gap_row_ns + 1_000_000_000 for window in windows)


def test_drops_short_trailing_segment(tmp_path):
    path = make_dataset_csv(tmp_path, "session_short.csv", "idle", row_count=2)
    recording = load_recording(path)
    config = WindowConfig(window_ms=200.0, stride_ms=100.0, max_gap_ms=250.0, min_samples_per_window=3)

    windows = build_windows(recording, config)

    assert windows == []
