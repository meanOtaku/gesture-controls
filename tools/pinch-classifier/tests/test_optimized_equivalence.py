"""The vectorized loader, windowing, carry-forward and feature extraction must be *bit-identical*
to the straightforward loops they replaced (kept in `reference_impl.py`).

Identical to the last bit matters here: these functions feed model training, whose
reproducibility is a documented property, so an optimization may not change a single feature
value. Comparisons are on raw bytes, which also distinguishes -0.0 and NaN payloads.
"""

from __future__ import annotations

import random

import numpy as np
import pytest

from pinch_classifier.csv_io import CsvFormatError, _carry_forward, load_recording
from pinch_classifier.features import extract_features
from pinch_classifier.schema import HEADER_COLUMNS, NUMERIC_COLUMNS
from pinch_classifier.windowing import WindowConfig, build_windows

from .reference_impl import (
    reference_build_windows,
    reference_carry_forward,
    reference_extract_features,
    reference_load_recording,
)

LABELS = ("idle", "pinch_start", "walking")


def _write_csv(tmp_path, name, rows):
    path = tmp_path / name
    path.write_text("\n".join([",".join(HEADER_COLUMNS), *rows]) + "\n", encoding="utf-8")
    return path


def _random_rows(rng: random.Random, count: int, *, label_run: int, gap_every: int, duplicates: bool) -> list[str]:
    """Rows with random blanks in every numeric column, label changes, time gaps and equal timestamps."""
    rows = []
    timestamp = rng.randrange(0, 10**12)
    label = rng.choice(LABELS)
    for index in range(count):
        if index and index % label_run == 0:
            label = rng.choice(LABELS)
        step = 0 if (duplicates and rng.random() < 0.1) else rng.choice((15, 20, 20, 20, 25)) * 1_000_000
        if gap_every and index and index % gap_every == 0:
            step += 600_000_000  # exceeds the default 250 ms max gap
        timestamp += step
        fields = [str(timestamp), str(index)]
        for _ in NUMERIC_COLUMNS:
            fields.append("" if rng.random() < 0.4 else f"{rng.uniform(-1000, 1000):.6f}")
        fields.append(label)
        rows.append(",".join(fields))
    return rows


def _same_bytes(a: np.ndarray, b: np.ndarray) -> bool:
    return a.dtype == b.dtype and a.shape == b.shape and a.tobytes() == b.tobytes()


def _assert_recordings_identical(actual, expected) -> None:
    assert actual.session_id == expected.session_id
    assert _same_bytes(actual.timestamps_ns, expected.timestamps_ns)
    assert list(actual.raw_labels) == list(expected.raw_labels)
    assert set(actual.channels) == set(expected.channels)
    for column in expected.channels:
        assert _same_bytes(actual.channels[column], expected.channels[column]), column


class TestCarryForward:
    def test_matches_the_loop_over_random_nan_patterns(self):
        rng = np.random.default_rng(7)
        for length in (1, 2, 3, 17, 500):
            for nan_rate in (0.0, 0.1, 0.5, 0.95, 1.0):
                values = rng.normal(size=length) * 100
                values[rng.random(length) < nan_rate] = np.nan
                assert _same_bytes(_carry_forward(values), reference_carry_forward(values)), (length, nan_rate)

    def test_keeps_infinities_and_negative_zero_and_does_not_mutate_its_input(self):
        values = np.array([np.nan, -0.0, np.inf, np.nan, -np.inf, np.nan, 3.5])
        before = values.copy()
        assert _same_bytes(_carry_forward(values), reference_carry_forward(values))
        assert _same_bytes(values, before) or np.array_equal(values, before, equal_nan=True)

    def test_leading_nans_become_zero(self):
        out = _carry_forward(np.array([np.nan, np.nan, 5.0, np.nan]))
        assert out.tolist() == [0.0, 0.0, 5.0, 5.0]


class TestLoadRecording:
    @pytest.mark.parametrize("seed", range(6))
    def test_valid_documents_load_identically(self, tmp_path, seed):
        rng = random.Random(seed)
        rows = _random_rows(rng, rng.choice((1, 2, 60, 400)), label_run=37, gap_every=53, duplicates=True)
        path = _write_csv(tmp_path, f"s{seed}.csv", rows)
        _assert_recordings_identical(load_recording(path), reference_load_recording(path))

    def test_comment_lines_and_whitespace_load_identically(self, tmp_path):
        rows = _random_rows(random.Random(1), 30, label_run=10, gap_every=0, duplicates=False)
        path = tmp_path / "c.csv"
        path.write_text("# a\n# label: idle\n" + ",".join(HEADER_COLUMNS) + "\n" + "\n".join(rows) + "\n", encoding="utf-8")
        _assert_recordings_identical(load_recording(path), reference_load_recording(path))

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda rows: rows[:3] + ["1,2,3"] + rows[3:],  # wrong column count
            lambda rows: rows[:3] + [rows[3].replace(rows[3].split(",")[0], "abc", 1)] + rows[4:],  # bad timestamp
            lambda rows: rows[:2] + [rows[3]] + [rows[2]] + rows[4:],  # timestamps go backwards
            lambda rows: [rows[0].replace(rows[0].split(",")[3], "oops", 1)] + rows[1:],  # non-numeric value
            lambda rows: rows[:5] + [rows[5].rsplit(",", 1)[0] + ","] + rows[6:],  # empty label
            lambda rows: [rows[0].replace(rows[0].split(",")[0], "99999999999999999999999", 1)] + rows[1:],  # int64 overflow
        ],
        ids=["columns", "timestamp", "backwards", "value", "label", "overflow"],
    )
    def test_malformed_documents_fail_with_the_same_error(self, tmp_path, mutate):
        rows = _random_rows(random.Random(3), 12, label_run=100, gap_every=0, duplicates=False)
        path = _write_csv(tmp_path, "bad.csv", mutate(rows))
        with pytest.raises((CsvFormatError, OverflowError, ValueError)) as expected:
            reference_load_recording(path)
        with pytest.raises(type(expected.value)) as actual:
            load_recording(path)
        assert str(actual.value) == str(expected.value)


class TestWindowsAndFeatures:
    @pytest.mark.parametrize("seed", range(8))
    @pytest.mark.parametrize("window_ms", (200.0, 500.0, 1300.0))
    def test_windows_and_features_are_bit_identical(self, tmp_path, seed, window_ms):
        rng = random.Random(seed * 31 + 5)
        # Segments (label runs and time gaps) must be long enough for the largest window
        # (1300 ms is ~65 rows) to form, or the case compares nothing.
        rows = _random_rows(rng, 700, label_run=rng.choice((90, 250, 700)), gap_every=rng.choice((0, 130)), duplicates=True)
        recording = load_recording(_write_csv(tmp_path, "r.csv", rows))
        config = WindowConfig(window_ms=window_ms, stride_ms=window_ms / 3, min_samples_per_window=3)

        expected_windows = reference_build_windows(recording, config)
        actual_windows = build_windows(recording, config)

        assert len(actual_windows) == len(expected_windows) > 0
        for actual, expected in zip(actual_windows, expected_windows, strict=True):
            assert (actual.session_id, actual.label, actual.start_ns, actual.end_ns) == (
                expected.session_id,
                expected.label,
                expected.start_ns,
                expected.end_ns,
            )
            assert np.array_equal(actual.row_indices, expected.row_indices)
            assert _same_bytes(extract_features(recording, actual), reference_extract_features(recording, expected))

    def test_a_window_whose_samples_share_one_timestamp_has_zero_slopes_exactly_as_before(self, tmp_path):
        base = 5_000_000_000
        rows = []
        for index in range(6):
            fields = [str(base), str(index)] + [str(float(index + 1)) for _ in NUMERIC_COLUMNS] + ["idle"]
            rows.append(",".join(fields))
        recording = load_recording(_write_csv(tmp_path, "flat.csv", rows))
        window = reference_build_windows(recording, WindowConfig(window_ms=100, stride_ms=100, min_samples_per_window=2))
        # All six rows share one timestamp, so there is no span to place a window on; build one directly.
        from pinch_classifier.windowing import Window

        manual = Window("flat", "idle", base, base, np.arange(6))
        assert window == []
        assert _same_bytes(extract_features(recording, manual), reference_extract_features(recording, manual))

    def test_the_cached_channel_matrix_is_built_once_and_matches_the_channels(self, tmp_path):
        recording = load_recording(
            _write_csv(tmp_path, "m.csv", _random_rows(random.Random(9), 50, label_run=50, gap_every=0, duplicates=False))
        )
        matrix = recording.channel_matrix
        assert recording.channel_matrix is matrix
        for row, column in enumerate(NUMERIC_COLUMNS):
            assert _same_bytes(matrix[row], recording.channels[column])
