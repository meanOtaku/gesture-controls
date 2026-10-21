"""The motion half of the PPG + IMU pinch-start model's inputs."""

from __future__ import annotations

import json

import numpy as np

from label_trainer import imu_onset as I

from .make_imu_onset_cases import FIXTURE, build, trace

MS = 1_000_000


def test_the_shared_cases_are_what_the_features_give_now() -> None:
    """The runtime is tested against this file; if the features change on purpose, regenerate it (see the script)."""
    stored, now = json.loads(FIXTURE.read_text()), json.loads(json.dumps(build()))
    assert stored["feature_names"] == now["feature_names"]
    for a, b in zip(stored["cases"], now["cases"]):
        assert a["decisions"] == b["decisions"]
        for row_a, row_b in zip(a["expected"], b["expected"]):
            assert (row_a is None) == (row_b is None)
            if row_a is not None:
                assert np.allclose(row_a, row_b, rtol=1e-12, atol=1e-12)
    assert sum(row is not None for case in stored["cases"] for row in case["expected"]) >= 6


def test_there_are_1032_named_features_in_window_signal_channel_statistic_order() -> None:
    assert I.FEATURE_COUNT == 1032 == len(set(I.FEATURE_NAMES))
    assert I.FEATURE_NAMES[0] == "imu_accel_x_raw_n320ms_q10"
    assert I.FEATURE_NAMES[21] == "imu_accel_y_raw_n320ms_q10"
    assert I.FEATURE_NAMES[8 * 21] == "imu_accel_x_diff_n320ms_q10"
    assert I.FEATURE_NAMES[2 * 8 * 21] == "imu_accel_x_spread_vs_3s_n320ms"
    assert I.FEATURE_NAMES[-1] == "imu_gyro_mag_spread_vs_3s_n1280ms"


def test_a_decision_never_depends_on_anything_after_it() -> None:
    ts, values = trace(320, 11)
    decision = np.array([ts[260]])
    before = I.features(ts, values, decision)
    changed = values.copy()
    changed[261:] += 5.0
    assert np.isfinite(before).all() and np.array_equal(before, I.features(ts, changed, decision))
    assert np.array_equal(I.features(ts[:261], values[:261], decision), before)


def test_too_little_history_or_a_gap_in_the_span_gives_no_features() -> None:
    ts, values = trace(320, 12)
    assert not np.isfinite(I.features(ts, values, ts[[150]])).any()        # 3 s of history: less than the 4.3 s it reads
    assert np.isfinite(I.features(ts, values, ts[[260]])).all()
    keep = np.ones(320, dtype=bool)
    keep[200:214] = False                                                    # 280 ms without samples
    assert not np.isfinite(I.features(ts[keep], values[keep], ts[[260]])).any()


def test_a_tap_raises_the_spread_of_the_short_window_against_the_seconds_before() -> None:
    ts, values = trace(320, 13)
    spread = I.FEATURE_NAMES.index("imu_accel_mag_spread_vs_3s_n320ms")
    quiet, tapped = I.features(ts, values, ts[[225, 238]])[:, spread]
    assert tapped > quiet + 1.0
