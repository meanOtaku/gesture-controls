"""Where one bundle's score peaks around each held-out pinch_in start (-1 s to +2.5 s), live windows vs sessions.
Usage: TRAINER_SRC=<matching trainer src> python peak_timing.py <bundle dir> <name>"""
import json, os, sys
sys.path.insert(0, os.environ["TRAINER_SRC"])
import numpy as np
from label_trainer import cnn, label_train, ppg_onset
HERE = os.path.dirname(os.path.abspath(__file__))
B, NAME = sys.argv[1], sys.argv[2]
mb = open(f"{B}/model.cnn", "rb").read()
# The grid the model was trained on (a manifest without it predates 100 Hz: the trainer's own default then).
HZ = json.load(open(f"{B}/manifest.json")).get("preprocessing", {}).get("motionHz")
inv = json.load(open(f"{HERE}/inventory.json"))
SKIP = {"07-29-39", "07-29-43", "07-29-55", "07-30-01", "07-30-03", "08-11-45"}
use = [o for o in inv if not o["train"] and o["kind"] == "pinch" and not any(s in o["dir"] for s in SKIP)]
NEG = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
out = {"live": [], "sess": []}
for o in use:
    rid = os.path.basename(o["dir"]); kind = "live" if "2026-11-13" in rid else "sess"
    spec = label_train.parse_spec({"version": 1, "target": "pinch_in", "negatives": NEG, "excludes": ["left_out"],
        "recordings": {rid: o["dir"]}, "train": [], "evaluation": [rid], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": 17, "steadyStarts": False,
        **({"motionHz": HZ} if HZ else {})})
    rec = label_train.load_spec_recordings(spec)[rid]
    t, s = label_train.timeline(spec, rec, lambda x: cnn.predict(mb, x))
    for st, en, lab in ppg_onset.holds(rec.timestamps_ns, rec.raw_labels):
        if lab != "pinch_in": continue
        m = (t >= st - 1e9) & (t <= st + 2.5e9)
        if m.sum() < 50: continue
        i = np.argmax(s[m]); out[kind].append(((t[m][i] - st) / 1e6, float(s[m][i]), (en - st) / 1e6))
for k, v in out.items():
    v = np.array(v); hit = v[:, 1] >= 0.99
    print(f"{NAME} {k}: n={len(v)}, peak >= 0.99 anywhere in -1..+2.5 s: {hit.sum()}; peak time of those (ms after start): "
          f"median {np.median(v[hit, 0]) if hit.any() else float('nan'):.0f}, inside 300-900: {((v[hit, 0] >= 300) & (v[hit, 0] <= 900)).sum()}; "
          f"label hold median {np.median(v[:, 2]):.0f} ms")
    if k == "live": print("   live peak times (ms):", np.round(v[:, 0]).astype(int).tolist(), "\n   peaks:", np.round(v[:, 1], 2).tolist())
