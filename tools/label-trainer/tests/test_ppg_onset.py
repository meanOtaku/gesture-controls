"""The pinch-start model's inputs and the decisions it trains on."""

from __future__ import annotations

import json

import numpy as np

from label_trainer import ppg_onset as P

from .make_ppg_onset_cases import FIXTURE, build, trace

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


def test_there_are_1701_named_features_in_history_order_window_statistic_channel_order() -> None:
    assert P.FEATURE_COUNT == 1701 == len(set(P.FEATURE_NAMES))
    assert P.FEATURE_NAMES[:3] == ("ppg_z1000ms_d1_green_n8_q10", "ppg_z1000ms_d1_red_n8_q10", "ppg_z1000ms_d1_ir_n8_q10")
    assert P.FEATURE_NAMES[-1] == "ppg_z4000ms_d3_ir_n32_mean_absolute_change"


def test_the_differentiator_recovers_a_cubic_exactly() -> None:
    t = np.arange(-9, 0) * 0.04
    poly = 3.0 + 2.0 * t - 5.0 * t ** 2 + 7.0 * t ** 3
    assert np.allclose(P.COEFFICIENTS @ poly, [2.0, -10.0, 42.0])


def test_a_decision_never_depends_on_anything_after_it() -> None:
    ts, values = trace(260, 11)
    decision = ts[200]
    before = P.features(ts, values, np.array([decision]))
    changed = values.copy()
    changed[201:] += 1e6
    after = P.features(ts, changed, np.array([decision]))
    assert np.isfinite(before).all() and np.array_equal(before, after)
    assert np.array_equal(P.features(ts[:201], values[:201], np.array([decision])), before)


def test_too_little_history_or_a_gap_in_the_span_gives_no_features() -> None:
    ts, values = trace(260, 12)
    assert not np.isfinite(P.features(ts, values, ts[[30]])).any()          # 1.2 s of history
    assert np.isfinite(P.features(ts, values, ts[[200]])).all()
    keep = np.ones(260, dtype=bool)
    keep[150:158] = False                                                       # 320 ms without samples
    assert not np.isfinite(P.features(ts[keep], values[keep], ts[[200]])).any()


def test_holds_are_runs_of_a_label_joined_across_short_gaps_and_short_ones_are_ignored() -> None:
    ts = np.arange(0, 40) * 100 * MS
    labels = np.array([""] * 5 + ["pinch"] * 5 + [""] * 3 + ["pinch"] * 6 + [""] * 10 + ["fist"] + [""] * 10, dtype=object)
    # pinch 500..900, a 400 ms gap (10 .. 12 unlabelled, next row at 1300): exactly the limit, so two holds; fist is one row.
    assert P.holds(ts, labels) == [(500 * MS, 900 * MS, "pinch"), (1300 * MS, 1800 * MS, "pinch")]
    labels[12] = "pinch"                                                        # a 300 ms gap: one hold
    assert P.holds(ts, labels) == [(500 * MS, 1800 * MS, "pinch")]


def test_decisions_are_starts_other_starts_mid_holds_and_quiet_time() -> None:
    ts = np.arange(0, 1500, dtype=np.int64) * 40 * MS
    holds = [(10_000 * MS, 14_000 * MS, "pinch"), (20_000 * MS, 21_000 * MS, "fist"), (30_000 * MS, 31_000 * MS, "noise")]
    d, y, kinds = P.sample_decisions(ts, holds, "pinch", {"noise"})
    by_kind = {kind: d[[k == kind for k in kinds]] for kind in set(kinds)}
    assert by_kind["start"].tolist() == [10_880 * MS] and y[kinds.index("start")] == 1
    assert by_kind["other_start"].tolist() == [20_880 * MS]
    assert "noise" not in kinds and set(y[[k != "start" for k in kinds]].tolist()) == {0}
    # Inside the 4 s pinch only, at least 1.5 s from its edges (measured from the decision less 880 ms).
    mid = by_kind["target_mid"] - 880 * MS
    assert mid.size and (mid >= 11_500 * MS).all() and (mid <= 12_500 * MS).all()
    assert "other_mid" not in by_kind                                           # the 1 s fist is too short
    quiet = by_kind["unlabelled"] - 880 * MS
    assert len(quiet) == P.PER_KIND
    for s, e, _ in holds:
        assert not ((quiet > s - 1500 * MS) & (quiet < e + 1500 * MS)).any()
    # Nothing whose 5.6 s span touches the excluded hold.
    assert not ((d >= 30_000 * MS) & (d - 5_600 * MS <= 31_000 * MS)).any()


def test_a_recording_with_no_holds_gives_more_quiet_time() -> None:
    ts = np.arange(0, 1500, dtype=np.int64) * 40 * MS
    _, y, kinds = P.sample_decisions(ts, [], "pinch", set())
    assert kinds == ["unlabelled"] * P.UNLABELLED_ONLY and not y.any()


def test_detections_wait_out_the_cooldown_and_match_one_start_each() -> None:
    times = np.arange(0, 100, dtype=np.int64) * 40 * MS
    scores = np.zeros(100)
    scores[[22, 23, 30, 70]] = 0.9                                             # 880, 920 (one rise), 1200 (too soon), 2800
    assert P.detect(times, scores, 0.5) == [880 * MS, 2_800 * MS]
    caught, latencies = P.match([880 * MS, 2_800 * MS], [0, 1_000 * MS])
    assert caught == 1 and latencies == [880 * MS]                              # 2800 is 1800 after the second start: too late
