"""The trainer's steadiness test: the same cases as `crates/label-inference/src/steadiness.rs`, so both judge alike."""

from __future__ import annotations

import numpy as np

from label_trainer import steadiness

LEVEL = (1.0, 0.0, 0.0, 0.0)
# Two seconds at 100 Hz, and a decision at the last sample.
TS = 10_000_000_000 + np.arange(200, dtype=np.int64) * 10_000_000
END = int(TS[-1])


def judge(accel, gyro, quaternions=None, decisions=(END,)):
    quaternions = np.tile(LEVEL, (len(TS), 1)) if quaternions is None else quaternions
    return steadiness.still_before(TS, np.asarray(accel, float), np.asarray(gyro, float), quaternions, np.array(decisions))


def test_a_still_hand_with_small_tremor_is_still() -> None:
    wobble = np.where(np.arange(200) % 2 == 0, 0.1, -0.1)
    accel = np.stack([wobble, np.zeros(200), np.full(200, 0.05)], axis=1)
    gyro = np.tile([0.05, -0.05, 0.0], (200, 1))
    assert judge(accel, gyro).tolist() == [True]


def test_a_moving_arm_a_turning_wrist_and_a_tilting_watch_are_each_not_still() -> None:
    i = np.arange(200)
    swing = np.stack([1.5 * np.sin(i / 8.0), np.zeros(200), np.zeros(200)], axis=1)
    assert judge(swing, np.zeros((200, 3))).tolist() == [False]
    assert judge(np.zeros((200, 3)), np.tile([0.0, 0.0, 1.0], (200, 1))).tolist() == [False]
    half = np.radians(30.0) * i / 200 / 2
    tilting = np.stack([np.cos(half), np.sin(half), np.zeros(200), np.zeros(200)], axis=1)
    assert judge(np.zeros((200, 3)), np.zeros((200, 3)), tilting).tolist() == [False]


def test_only_the_window_before_the_decision_counts_so_the_gesture_s_own_jolt_does_not() -> None:
    jolt = np.where(np.arange(200) >= 170, 3.0, 0.0)
    motion = np.stack([jolt, np.zeros(200), np.zeros(200)], axis=1)
    assert judge(motion, motion).tolist() == [True]


def test_too_little_motion_is_not_still_and_unusable_samples_are_left_out() -> None:
    still = np.zeros((200, 3))
    # A decision far later than the motion, and one too early for a whole window.
    assert judge(still, still, decisions=(END + 10_000_000_000, int(TS[0]) + 600_000_000)).tolist() == [False, False]
    # Samples with a value that is not finite, or no usable quaternion, are dropped; too few remain.
    broken = np.zeros((200, 3))
    broken[::2, 0] = np.nan
    quaternions = np.tile(LEVEL, (200, 1))
    quaternions[1::2] = 0.0
    assert judge(broken, still, quaternions).tolist() == [False]
    assert steadiness.still_before(np.array([], dtype=np.int64), np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 4)), np.array([END])).tolist() == [False]


def test_the_window_sits_before_the_gesture_s_estimated_start_whatever_the_model_s_delay() -> None:
    moving = np.where(np.arange(200) >= 110, 3.0, 0.0)
    motion = np.stack([moving, np.zeros(200), np.zeros(200)], axis=1)
    quaternions = np.tile(LEVEL, (200, 1))
    assert steadiness.still_before(TS, motion, motion, quaternions, np.array([END]), 900_000_000).tolist() == [True]
    assert steadiness.still_before(TS, motion, motion, quaternions, np.array([END]), 0).tolist() == [False]
