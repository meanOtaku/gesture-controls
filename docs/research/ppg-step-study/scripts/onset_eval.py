"""Same trainer features, but the question 'did a pinch just start?': a window is positive when a pinch began inside it,
negative when no gesture began or ended within 1 s of it (mid-hold windows are left out: neither answer is right there)."""
import sys, tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0, sys.argv[1])
from load import recordings  # noqa: E402
import study  # noqa: E402
from label_trainer import label_train as lt  # noqa: E402
from label_trainer.features import BASELINE_STEP_FEATURE_NAMES, BASELINE_Z_FEATURE_NAMES  # noqa: E402
from label_trainer.research import leave_one_recording_out  # noqa: E402

recs, starts, boundaries = {}, {}, {}
for name, gesture, day, rec in recordings():
    t = rec.timestamps_ns / 1e6
    if not (np.all(np.diff(t) >= 0) and (t[-1] - t[0]) < 3_600_000):
        continue
    hs = study.holds(rec)
    recs[name] = rec
    starts[name] = np.array([h[0] for h in hs if h[2] == "pinch"])
    boundaries[name] = np.array([b for h in hs for b in (h[0], h[1])])
ids = list(recs)
ppg_base = lt.features_for(["watchPpg"])
sets = {
    "A  PPG window statistics": ppg_base,
    "B  A + rel_z (current best)": ppg_base + list(BASELINE_Z_FEATURE_NAMES),
    "C  B + step (new)": ppg_base + list(BASELINE_Z_FEATURE_NAMES) + list(BASELINE_STEP_FEATURE_NAMES),
    "D  step only": list(BASELINE_STEP_FEATURE_NAMES),
}
tmp = Path(tempfile.mkdtemp())
for window_ms in (1300,):
    print(f"\n--- 'a pinch just started', window {window_ms} ms, baseline 2000 ms, {len(ids)} recordings ---")
    for label, features in sets.items():
        for backend in ("logreg", "gbt"):
            raw = {"version": 1, "target": "pinch", "negatives": ["rest", "fist", "thumbs_up"], "excludes": [],
                   "recordings": {rid: str(tmp / f"{rid}.csv") for rid in ids}, "train": ids, "evaluation": [],
                   "sources": ["watchPpg"], "features": features,
                   "window": {"windowMs": window_ms, "strideMs": 150, "maxGapMs": 250, "minSamples": 3},
                   "baselineMs": 2000, "backend": backend, "seed": 7}
            spec = lt.parse_spec(raw)
            x, _, groups, meta = lt.build_all(spec, recs)
            keep, y = [], []
            for i, (g, w) in enumerate(zip(groups, meta)):
                ws = w.start_ns / 1e6 if hasattr(w, "start_ns") else w["startNs"] / 1e6
                we = ws + window_ms
                began = starts[g][(starts[g] >= ws + 0.1 * window_ms) & (starts[g] <= ws + 0.6 * window_ms)]
                near = boundaries[g][(boundaries[g] > ws - 1000) & (boundaries[g] < we + 1000)] if len(boundaries[g]) else []
                if len(began):
                    keep.append(i); y.append(1)
                elif len(near) == 0:
                    keep.append(i); y.append(0)
            keep, y = np.array(keep), np.array(y)
            result = leave_one_recording_out(lambda xs, ys: lt.fit(spec, xs, ys), x[keep], y, groups[keep])
            aucs = [f["auc"] for f in result["folds"] if f.get("auc") is not None]
            print(f"  {label:30s} {backend:6s} pooled AUC {result['pooledAuc']:.2f}  per recording median {np.median(aucs):.2f}  worst {min(aucs):.2f}  ({len(aucs)} recordings; {int(y.sum())} start / {int((y == 0).sum())} quiet windows)")
