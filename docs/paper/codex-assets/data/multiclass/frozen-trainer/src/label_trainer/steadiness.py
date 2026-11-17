"""Whether the hand was still before a decision: the live runtime only lets a gesture start when it was.

Mirrors `crates/label-inference/src/steadiness.rs` (the gate the desktop applies to every start). With the spec's
`steadyStarts`, the trainer keeps only the decisions the gate would let through, so a model is trained and tested on the
moments it will be asked about live, and the replay counts only the starts the runtime would allow.

A model decides some time after a gesture starts (its decision delay), so the gesture's start is put that long before the
decision, and over the watch's motion from `WINDOW_FROM_NS` to `WINDOW_TO_NS` before that start (on the watch clock both
share), the hand was still when all three hold:

* acceleration spread (each linear acceleration axis's standard deviation, as one magnitude) at most `MAX_ACCEL_SPREAD`;
* gyroscope RMS at most `MAX_TURNING`;
* the change in world up between the window's first and last samples at most `MAX_TILT_DEG`.

Fewer than `MIN_SAMPLES` motion samples in the window is not still.
"""

from __future__ import annotations

import numpy as np

MAX_ACCEL_SPREAD = 0.4             # m/s²
MAX_TURNING = 0.5                  # rad/s
MAX_TILT_DEG = 10.0
WINDOW_FROM_NS = 1_500_000_000
WINDOW_TO_NS = 500_000_000
MIN_SAMPLES = 25


def up_vectors(quaternions: np.ndarray) -> np.ndarray:
    """World up in the watch's axes from `[w, x, y, z]` rotation-vector quaternions (watch to world); NaN where unusable."""
    q = np.asarray(quaternions, dtype=float)
    norm = np.linalg.norm(q, axis=1, keepdims=True)
    q = np.where((norm >= 0.5) & np.isfinite(norm), q / np.where(norm > 0, norm, 1.0), np.nan)
    w, x, y, z = q.T
    return np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], axis=1)


def still_before(motion_ts: np.ndarray, accel: np.ndarray, gyro: np.ndarray, quaternions: np.ndarray,
                 decisions_ns: np.ndarray, decision_delay_ns: int = 0) -> np.ndarray:
    """For each decision, by a model deciding `decision_delay_ns` after a gesture starts, whether the hand was still over
    the window before that start. Samples with any value that is not finite are left out, as the runtime leaves them out;
    the samples must be in time order."""
    accel, gyro = np.asarray(accel, dtype=float), np.asarray(gyro, dtype=float)
    up = up_vectors(quaternions)
    keep = np.isfinite(accel).all(1) & np.isfinite(gyro).all(1) & np.isfinite(up).all(1)
    ts, accel, gyro, up = np.asarray(motion_ts)[keep], accel[keep], gyro[keep], up[keep]
    decisions_ns = np.asarray(decisions_ns, dtype=np.int64) - int(decision_delay_ns)
    out = np.zeros(len(decisions_ns), dtype=bool)
    if len(ts) == 0:
        return out
    # Running sums, so every window's mean and spread come from two lookups.
    zero = np.zeros((1, 3))
    s1 = np.concatenate([zero, np.cumsum(accel, axis=0)])
    s2 = np.concatenate([zero, np.cumsum(accel ** 2, axis=0)])
    g2 = np.concatenate([[0.0], np.cumsum((gyro ** 2).sum(1))])
    lo = np.searchsorted(ts, decisions_ns - WINDOW_FROM_NS, side="left")
    hi = np.searchsorted(ts, decisions_ns - WINDOW_TO_NS, side="right")
    n = hi - lo
    ok = n >= MIN_SAMPLES
    if not ok.any():
        return out
    lo, hi, nn = lo[ok], hi[ok], n[ok].astype(float)[:, None]
    mean = (s1[hi] - s1[lo]) / nn
    variance = np.maximum((s2[hi] - s2[lo]) / nn - mean ** 2, 0.0)
    spread = np.sqrt(variance.sum(1))
    turning = np.sqrt((g2[hi] - g2[lo]) / nn[:, 0])
    a, b = up[lo], up[hi - 1]
    cos = (a * b).sum(1) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))
    tilt = np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))
    out[ok] = (spread <= MAX_ACCEL_SPREAD) & (turning <= MAX_TURNING) & (tilt <= MAX_TILT_DEG)
    return out
