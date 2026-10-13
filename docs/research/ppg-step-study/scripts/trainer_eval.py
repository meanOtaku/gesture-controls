"""The trainer's own windows and features, each recording scored by a model trained on the others (leave one out)."""
import sys, tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0, sys.argv[1])
from load import recordings  # noqa: E402
from label_trainer import label_train as lt  # noqa: E402
from label_trainer.features import BASELINE_STEP_FEATURE_NAMES, BASELINE_Z_FEATURE_NAMES  # noqa: E402
from label_trainer.research import leave_one_recording_out  # noqa: E402

recs = {}
for name, gesture, day, rec in recordings():
    t = rec.timestamps_ns / 1e6
    if np.all(np.diff(t) >= 0) and (t[-1] - t[0]) < 3_600_000:
        recs[name] = rec
ids = list(recs)
ppg_base = lt.features_for(["watchPpg"])
sets = {
    "A  PPG window statistics": ppg_base,
    "B  A + rel_z (current best)": ppg_base + list(BASELINE_Z_FEATURE_NAMES),
    "C  B + step (new)": ppg_base + list(BASELINE_Z_FEATURE_NAMES) + list(BASELINE_STEP_FEATURE_NAMES),
    "D  step only": list(BASELINE_STEP_FEATURE_NAMES),
}
tmp = Path(tempfile.mkdtemp())
for window_ms in (500, 1300):
    print(f"\n--- window {window_ms} ms, baseline 2000 ms, pinch against rest/fist/thumbs-up, {len(ids)} recordings ---")
    for label, features in sets.items():
        for backend in ("logreg", "gbt"):
            raw = {
                "version": 1, "target": "pinch", "negatives": ["rest", "fist", "thumbs_up"], "excludes": [],
                "recordings": {rid: str(tmp / f"{rid}.csv") for rid in ids},
                "train": ids, "evaluation": [], "sources": ["watchPpg"], "features": features,
                "window": {"windowMs": window_ms, "strideMs": 150, "maxGapMs": 250, "minSamples": 3},
                "baselineMs": 2000, "backend": backend, "seed": 7,
            }
            spec = lt.parse_spec(raw)
            x, y, groups, _ = lt.build_all(spec, recs)
            result = leave_one_recording_out(lambda xs, ys: lt.fit(spec, xs, ys), x, y, groups)
            aucs = [f["auc"] for f in result["folds"] if f.get("auc") is not None]
            print(f"  {label:30s} {backend:6s} pooled AUC {result['pooledAuc']:.2f}  per recording median {np.median(aucs):.2f}  worst {min(aucs):.2f}  ({len(aucs)} recordings, {len(y)} windows)")
