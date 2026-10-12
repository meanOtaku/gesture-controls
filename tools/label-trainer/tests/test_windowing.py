from __future__ import annotations

from label_trainer.csv_io import load_recording
from label_trainer.windowing import WindowConfig, build_windows

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


def _labelled_recording(labels: list[str]):
    """A recording of one row every 20 ms with the given label on each row."""
    from pathlib import Path

    import numpy as np

    from label_trainer.csv_io import Recording
    from label_trainer.schema import NUMERIC_COLUMNS

    n = len(labels)
    return Recording(
        session_id="r",
        source_path=Path("r.csv"),
        timestamps_ns=np.arange(n, dtype=np.int64) * 20_000_000,
        channels={column: np.zeros(n) for column in NUMERIC_COLUMNS},
        raw_labels=np.array(labels, dtype=object),
    )


def _overlap_labels(labels: list[str], window_ms: float = 500.0, excluded: tuple[str, ...] = ()):
    import numpy as np

    from label_trainer.windowing import continuous_windows, label_by_overlap

    recording = _labelled_recording(labels)
    config = WindowConfig(window_ms=window_ms, stride_ms=100.0, max_gap_ms=250.0, min_samples_per_window=3)
    raw = recording.raw_labels
    labelled = label_by_overlap(recording, continuous_windows(recording, config), raw == "tap", np.isin(raw, list(excluded)))
    return [(w.start_ns // 1_000_000, y) for w, y in labelled]


def test_a_quick_gesture_is_positive_in_windows_that_hold_most_of_it():
    # A 200 ms tap (rows 50-59) in a 500 ms window can never fill half of it, but windows holding all of it are the tap.
    labelled = dict(_overlap_labels(["rest"] * 50 + ["tap"] * 10 + ["rest"] * 50))
    assert [labelled[start] for start in (700, 800, 900, 1000)] == [1] * 4  # each holds the whole tap at 1000-1200
    assert labelled[0] == 0 and labelled[1400] == 0  # no tap in them
    assert 600 not in labelled and 1100 not in labelled  # half the tap each: neither, so left out


def test_a_held_gesture_is_positive_where_it_fills_half_the_window():
    labelled = dict(_overlap_labels(["rest"] * 50 + ["tap"] * 100 + ["rest"] * 50))
    assert labelled[1500] == 1  # wholly inside the hold (1000-3000)
    assert labelled[800] == 1  # [800, 1300]: 300 of 500 ms are the hold
    assert 600 not in labelled  # [600, 1100]: 100 ms of it, the edge
    assert labelled[400] == 0


def test_a_window_that_touches_a_left_out_label_is_dropped():
    labelled = dict(_overlap_labels(["rest"] * 50 + ["noise"] * 10 + ["rest"] * 50, excluded=("noise",)))
    assert 800 not in labelled and 1000 not in labelled
    assert labelled[0] == 0


def test_a_gesture_cut_by_a_few_stray_rows_is_one_gesture():
    import numpy as np

    from label_trainer.windowing import labelled_spans

    # A tap, then 2 rows (40 ms) of rest, then the tap again: rows labelled on arrival around a change of label.
    labels = ["rest"] * 20 + ["tap"] * 10 + ["rest"] * 2 + ["tap"] * 10 + ["rest"] * 20 + ["tap"] * 10
    recording = _labelled_recording(labels)
    spans = labelled_spans(recording, np.array(labels) == "tap")
    assert len(spans) == 2  # the first two runs are one tap; the last, 400 ms later, is another
    assert spans[0] == (20 * 20_000_000, 41 * 20_000_000)
