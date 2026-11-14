"""Retrain A's score at each held-out pinch with one channel group neutralised (0.5, a z of 0), live vs sessions,
plus the inputs' statistics per channel. Needs the current trainer (TRAINER_SRC)."""
import json, os, sys, hashlib
sys.path.insert(0, os.environ["TRAINER_SRC"])
import numpy as np
from label_trainer import cnn, label_train, ppg_onset
from label_trainer.label_train import inputs, pulse_of
HERE = os.path.dirname(os.path.abspath(__file__))
B = f"{HERE}/retrain-2026-11-14/A-baseline/bundle"
mb = open(f"{B}/model.cnn", "rb").read()
inv = json.load(open(f"{HERE}/inventory.json"))
SKIP = {"07-29-39", "07-29-43", "07-29-55", "07-30-01", "07-30-03", "08-11-45"}
use = [o for o in inv if not o["train"] and o["kind"] == "pinch" and not any(s in o["dir"] for s in SKIP)]
NEG = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
CH = ["ax", "ay", "az", "gx", "gy", "gz", "green", "red", "ir"]
GROUPS = {"none": [], "pulse": [6, 7, 8], "accel": [0, 1, 2], "gyro": [3, 4, 5]}
res = {g: {"live": [], "sess": []} for g in GROUPS}; stats = {"live": [], "sess": []}
for o in use:
    rid = os.path.basename(o["dir"]); kind = "live" if "2026-11-13" in rid else "sess"
    spec = label_train.parse_spec({"version": 1, "target": "pinch_in", "negatives": NEG, "excludes": ["left_out"],
        "recordings": {rid: o["dir"]}, "train": [], "evaluation": [rid], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": 17, "steadyStarts": False})
    rec = label_train.load_spec_recordings(spec)[rid]
    ts, _ = pulse_of(rec)
    x = inputs(spec, rec, ts); n_ch = 9; w = x.shape[1] // n_ch
    lo, hi = ppg_onset.match_window_ms(spec.decision_delay_ms)
    for st, en, lab in ppg_onset.holds(rec.timestamps_ns, rec.raw_labels):
        if lab != "pinch_in": continue
        m = (ts >= st + lo * 1e6) & (ts <= st + hi * 1e6) & np.isfinite(x).all(axis=1)
        if not m.any(): continue
        xs = x[m]
        stats[kind].append([np.mean(np.abs(xs[:, c * w:(c + 1) * w] - 0.5) > 0.49) for c in range(n_ch)])
        for g, chans in GROUPS.items():
            xa = xs.copy()
            for c in chans: xa[:, c * w:(c + 1) * w] = 0.5
            res[g][kind].append(float(cnn.predict(mb, xa).max()))
for g in GROUPS:
    print(f"neutralise {g:5s}: live caught {sum(p >= .99 for p in res[g]['live'])}/{len(res[g]['live'])} median {np.median(res[g]['live']):.3f}"
          f" | sessions {sum(p >= .99 for p in res[g]['sess'])}/{len(res[g]['sess'])} median {np.median(res[g]['sess']):.3f}")
for k in stats: print(f"{k}: share of window inputs saturated (z beyond about ±5) per channel:", dict(zip(CH, np.round(np.mean(stats[k], 0), 3))))
