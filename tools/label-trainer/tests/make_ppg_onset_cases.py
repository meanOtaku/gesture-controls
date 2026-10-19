"""Writes tests/fixtures/ppg_onset_cases.json: PPG traces, decisions and the features `ppg_onset.features` gives them.

The desktop's runtime (`crates/pinch-inference/src/ppg_onset.rs`) is tested against the same file, so the two compute the
same model inputs. Regenerate after changing the features on purpose:

    uv run --project tools/label-trainer python tools/label-trainer/tests/make_ppg_onset_cases.py
"""
import json
from pathlib import Path

import numpy as np

from label_trainer import ppg_onset as P

FIXTURE = Path(__file__).parent / "fixtures" / "ppg_onset_cases.json"
MS = 1_000_000


def trace(n: int, seed: int, jitter_ms: float = 3.0, flat_red: bool = False):
    rng = np.random.default_rng(seed)
    t = 1_000_000_000_000 + np.cumsum(np.full(n, 40 * MS) + rng.integers(-int(jitter_ms * MS), int(jitter_ms * MS) + 1, n))
    k = np.arange(n)
    pulse = np.sin(2 * np.pi * k / 25.0)
    green = -150_000 + 900 * pulse + rng.normal(0, 40, n) + np.where((k > 180) & (k < 200), 2500, 0)   # a step, like a pinch
    red = np.full(n, 1_693_452.0) if flat_red else 1_693_000 + 120 * pulse + rng.normal(0, 15, n)
    ir = 2_224_000 + 80 * np.cos(2 * np.pi * k / 25.0) + rng.normal(0, 10, n)
    return t.astype(np.int64), np.stack([green, red, ir], axis=1)


def case(name: str, ts: np.ndarray, values: np.ndarray, decision_indices: list[int]):
    decisions = ts[decision_indices]
    rows = P.features(ts, values, decisions)
    return {
        "name": name,
        "samples": [[int(a), float(g), float(r), float(i)] for a, (g, r, i) in zip(ts, values)],
        "decisions": [int(d) for d in decisions],
        "expected": [None if not np.isfinite(row).all() else [float(v) for v in row] for row in rows],
    }


def build():
    ts, values = trace(260, 1)
    gap_ts, gap_values = trace(260, 2)
    keep = ~((np.arange(260) >= 200) & (np.arange(260) < 208))                         # 320 ms without samples
    flat_ts, flat_values = trace(220, 3, flat_red=True)
    return {
        "coefficients": P.COEFFICIENTS.tolist(),
        "feature_names": list(P.FEATURE_NAMES),
        "cases": [
            case("jittered 25 Hz with a step", ts, values, [30, 60, 120, 141, 190, 199, 259]),
            case("a gap of 320 ms", gap_ts[keep], gap_values[keep], [150, 199, 205, 240, 251]),
            case("a flat red channel", flat_ts, flat_values, [150, 219]),
        ],
    }


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps(build()) + "\n")
    print(f"wrote {FIXTURE}")
