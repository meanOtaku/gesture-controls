"""Writes tests/fixtures/cnn_input_cases.json: motion and pulse traces, decisions and the inputs `cnn_input.inputs` gives them.

The desktop's runtime (`crates/pinch-inference/src/cnn_input.rs`) is tested against the same file, so the two compute the
same model inputs. Regenerate after changing the inputs on purpose:

    uv run --project tools/label-trainer python tools/label-trainer/tests/make_cnn_input_cases.py
"""
import json
from pathlib import Path

import numpy as np

from label_trainer import cnn_input as C

FIXTURE = Path(__file__).parent / "fixtures" / "cnn_input_cases.json"
MS = 1_000_000
START = 1_000_000_000_000


def motion(n: int, seed: int, still: bool = False):
    """`n` motion samples about 10 ms apart (100 Hz): noise, a slow sway and a tap at samples 1100-1110."""
    rng = np.random.default_rng(seed)
    t = START + np.cumsum(np.full(n, 10 * MS) + rng.integers(-MS, MS + 1, n))
    k = np.arange(n)
    sway = 0.05 * np.sin(2 * np.pi * k / 180.0)
    tap = np.where((k >= 1100) & (k < 1110), 0.6 * np.sin(np.pi * (k - 1100) / 10.0), 0.0)
    accel = np.stack([sway + tap + rng.normal(0, 0.02, n), rng.normal(0, 0.02, n) - tap / 2, 0.03 + rng.normal(0, 0.02, n)], axis=1)
    gyro = np.zeros((n, 3)) if still else np.stack([rng.normal(0, 0.01, n), sway / 2 + rng.normal(0, 0.01, n), tap / 3], axis=1)
    return t.astype(np.int64), np.round(np.concatenate([accel, gyro], axis=1), 7)


def turning(n: int, seed: int, start: int, end: int):
    """`motion(n, seed)` with the wrist turning fast (gyroscope swings of about 2.5 rad/s, the arm swaying) from sample
    `start` to `end`: the ticks the median scaling leaves out."""
    t, values = motion(n, seed)
    k = np.arange(n)
    on = (k >= start) & (k < end)
    swing = np.where(on, np.sin(2 * np.pi * k / 70.0), 0.0)
    values[:, 3] += 2.5 * swing
    values[:, 4] += 1.5 * np.where(on, np.cos(2 * np.pi * k / 90.0), 0.0)
    values[:, 0] += 3.0 * swing
    values[:, 2] += np.where(on, 2.0, 0.0)
    return t, np.round(values, 7)


def pulse(n: int, seed: int):
    """`n` pulse samples about 40 ms apart (25 Hz): a large level with a heartbeat and a slow drift."""
    rng = np.random.default_rng(seed)
    t = START + 5 * MS + np.cumsum(np.full(n, 40 * MS) + rng.integers(-2 * MS, 2 * MS + 1, n))
    k = np.arange(n)
    beat = np.sin(2 * np.pi * k / 21.0)
    values = np.stack([200_000 + 900 * beat + 3 * k, 150_000 + 500 * beat, 300_000 + 700 * beat - 2 * k], axis=1)
    return t.astype(np.int64), np.round(values + rng.normal(0, 20, values.shape))


def case(name, m, p, decisions):
    decisions = np.asarray(decisions, dtype=np.int64)
    rows = C.inputs(m[0], m[1], p[0], p[1], decisions, scaling=C.ROLLING)
    median = C.inputs(m[0], m[1], p[0], p[1], decisions, scaling=C.MEDIAN)
    # On the 100 Hz grid, which the trainer now makes CNNs on (median scaling only, as those models use).
    median_100 = C.inputs(m[0], m[1], p[0], p[1], decisions, scaling=C.MEDIAN, hz=100)
    return {
        "name": name,
        "motion": [[int(a), *map(float, v)] for a, v in zip(*m)],
        "pulse": [[int(a), *map(float, v)] for a, v in zip(*p)],
        "decisions": [int(d) for d in decisions],
        "expected": [None if not np.isfinite(row).all() else [float(v) for v in row] for row in rows],
        "expected_median": [None if not np.isfinite(row).all() else [float(v) for v in row] for row in median],
        "expected_median_100": [None if not np.isfinite(row).all() else [float(v) for v in row] for row in median_100],
    }


def build():
    m, p = motion(1300, 1), pulse(320, 2)
    gm, gp = motion(1300, 3), pulse(320, 4)
    keep = ~((np.arange(320) >= 290) & (np.arange(320) < 298))              # 320 ms without pulse samples
    sm, sp = motion(1250, 5, still=True), pulse(310, 6)
    tm, tp = turning(2400, 7, 500, 1150), pulse(600, 8)
    between = lambda t, i: int(t[i]) + 13 * MS                              # a decision between two pulse samples
    return {
        "feature_names": list(C.FEATURE_NAMES),
        "feature_names_100": list(C.feature_names(100)),
        "cases": [
            case("100 Hz motion, 25 Hz pulse, a tap", m, p, [p[0][200], p[0][280], p[0][300], between(p[0], 305), p[0][315]]),
            case("a gap of 320 ms in the pulse", gm, (gp[0][keep], gp[1][keep]), [gp[0][285], gp[0][305], gp[0][315]]),
            case("a still gyroscope", sm, sp, [sp[0][290], sp[0][305]]),
            # 6.5 s of fast turning ending 1.0 s (decision 1), 0.4 s (2, the margin reaching the window) and 2.4 s (3) before
            # the decisions, and one where the turning has left the grid
            case("fast turning, then still", tm, tp, [tp[0][312], tp[0][297], tp[0][347], int(tm[0][1260]) + 11_000 * MS]),
        ],
    }


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps(build()) + "\n")
    print(f"wrote {FIXTURE}")
