"""Writes tests/fixtures/imu_onset_cases.json: motion traces, decisions and the features `imu_onset.features` gives them.

The desktop's runtime (`crates/pinch-inference/src/imu_onset.rs`) is tested against the same file, so the two compute the
same model inputs. Regenerate after changing the features on purpose:

    uv run --project tools/label-trainer python tools/label-trainer/tests/make_imu_onset_cases.py
"""
import json
from pathlib import Path

import numpy as np

from label_trainer import imu_onset as I

FIXTURE = Path(__file__).parent / "fixtures" / "imu_onset_cases.json"
MS = 1_000_000


def trace(n: int, seed: int, jitter_ms: float = 1.5, still_gyro: bool = False):
    """`n` motion samples about 20 ms apart: small noise, a slow sway, and a sharp tap at samples 230-240."""
    rng = np.random.default_rng(seed)
    t = 1_000_000_000_000 + np.cumsum(np.full(n, 20 * MS) + rng.integers(-int(jitter_ms * MS), int(jitter_ms * MS) + 1, n))
    k = np.arange(n)
    sway = 0.05 * np.sin(2 * np.pi * k / 90.0)
    tap = np.where((k >= 230) & (k < 240), 0.8 * np.sin(np.pi * (k - 230) / 10.0), 0.0)
    accel = np.stack([sway + tap + rng.normal(0, 0.02, n), rng.normal(0, 0.02, n) - tap / 2, 0.03 + rng.normal(0, 0.02, n)], axis=1)
    gyro = np.zeros((n, 3)) if still_gyro else np.stack([rng.normal(0, 0.01, n), sway / 2 + rng.normal(0, 0.01, n), tap / 3], axis=1)
    return t.astype(np.int64), np.round(np.concatenate([accel, gyro], axis=1), 7)


def case(name: str, ts: np.ndarray, values: np.ndarray, decisions):
    decisions = np.asarray(decisions, dtype=np.int64)
    rows = I.features(ts, values, decisions)
    return {
        "name": name,
        "samples": [[int(a), *map(float, v)] for a, v in zip(ts, values)],
        "decisions": [int(d) for d in decisions],
        "expected": [None if not np.isfinite(row).all() else [float(v) for v in row] for row in rows],
    }


def build():
    ts, values = trace(320, 1)
    gap_ts, gap_values = trace(320, 2)
    keep = ~((np.arange(320) >= 250) & (np.arange(320) < 265))                   # 300 ms without samples
    still_ts, still_values = trace(260, 3, still_gyro=True)
    between = lambda t, i: int(t[i]) + 7 * MS                                    # a decision between two samples
    return {
        "feature_names": list(I.FEATURE_NAMES),
        "cases": [
            case("jittered 50 Hz with a tap", ts, values, [ts[100], ts[213], ts[214], between(ts, 236), ts[245], ts[319]]),
            case("a gap of 300 ms", gap_ts[keep], gap_values[keep], [gap_ts[240], gap_ts[249], gap_ts[300], gap_ts[319]]),
            case("a still gyroscope", still_ts, still_values, [still_ts[230], still_ts[259]]),
        ],
    }


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps(build()) + "\n")
    print(f"wrote {FIXTURE}")
