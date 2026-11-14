"""Peak gating (TapNet-style): a decision may fire only if the raw accelerometer jerk had a spike in the window before it.

spike(d) = the largest |jerk| (m/s^3, from consecutive raw accelerometer samples) in (d - WINDOW, d]. The gate level is
chosen on the TRAINING recordings only: the q-th percentile of spike() at the training pinch moments the CNN learns as
positives, so that 1 - q of them pass. The gated score is the model's score where spike(d) >= level, else 0.

Usage: python gate.py <run whose test scores are saved> [window_ms ...]
Writes results/<run>-gate<window>-q<q>.json for each window and q.
"""
import sys

import numpy as np

import bench
from label_trainer import label_train

QS = (0.01, 0.02, 0.05, 0.10)


def spike(rec, decisions, window_ms):
    ts, m = label_train.motion_of(rec)
    a = m[:, 0:3]
    dt = np.diff(ts) / 1e9
    j = np.zeros(len(ts))
    j[1:] = np.linalg.norm(np.diff(a, axis=0), axis=1) / np.maximum(dt, 1e-3)
    # Running max over the window via the index ranges each decision covers.
    lo = np.searchsorted(ts, decisions - window_ms * 1_000_000, side="right")
    hi = np.searchsorted(ts, decisions, side="right")
    out = np.zeros(len(decisions))
    # Sparse table for range maximum.
    levels = [j]
    k = 1
    while (1 << k) <= len(j):
        prev = levels[-1]
        levels.append(np.maximum(prev[:-(1 << (k - 1))], prev[(1 << (k - 1)):]))
        k += 1
    n = hi - lo
    ok = n > 0
    p = np.zeros(len(n), dtype=int)
    p[ok] = np.floor(np.log2(n[ok])).astype(int)
    for level in np.unique(p[ok]):
        sel = ok & (p == level)
        t = levels[level]
        out[sel] = np.maximum(t[lo[sel]], t[hi[sel] - (1 << level)])
    return out


def main():
    run = sys.argv[1]
    windows = [int(w) for w in sys.argv[2:]] or [300, 600]
    saved = np.load(bench.SCORES / f"{run}.npz")
    spec = bench.spec_for(bench.SPLIT["train"])
    for w in windows:
        # Training pinch moments (the CNN's positives) and their spikes.
        pos = []
        for rid in bench.SPLIT["train"]:
            rec = bench.recording(rid)
            d, y, _ = label_train.cnn_examples(spec, rec)
            if (y == 1).any():
                pos.append(spike(rec, d[y == 1], w))
        pos = np.concatenate(pos)
        for q in QS:
            level = float(np.quantile(pos, q))
            timelines, passed, total = {}, 0, 0
            for rid in bench.test_ids():
                t, s = saved[f"{rid}|t"], saved[f"{rid}|s"]
                g = spike(bench.recording(rid), t, w) >= level
                passed += int(g.sum()); total += len(g)
                timelines[rid] = (t, s * g)
            res = bench.score_timelines(timelines)
            name = f"{run}-gate{w}-q{int(q * 100):02d}"
            bench.save(name, res, None, {"base": run, "windowMs": w, "q": q, "level": level, "passShare": passed / total},
                       notes=f"`{run}` gated: fires only where the raw accelerometer jerk reached {level:.1f} m/s^3 in the last "
                             f"{w} ms (the {q:.0%} quantile of the training pinch moments); {passed / total:.0%} of test moments pass.")


if __name__ == "__main__":
    main()
