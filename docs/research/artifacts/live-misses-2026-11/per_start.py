"""Peak score in each annotated pinch_in start's match window, for one bundle over the compare.py held-out pinch recordings.
Usage: TRAINER_SRC=<matching trainer src> python per_start.py <bundle dir> <name>   -> per-start-<name>.json"""
import json, os, sys, hashlib
sys.path.insert(0, os.environ["TRAINER_SRC"])
import numpy as np
from label_trainer import cnn, label_train, ppg_onset
HERE = os.path.dirname(os.path.abspath(__file__))
B, NAME = sys.argv[1], sys.argv[2]
man = json.load(open(f"{B}/manifest.json")); mb = open(f"{B}/model.cnn", "rb").read()
# The grid the model was trained on (a manifest without it predates 100 Hz: the trainer's own default then).
HZ = json.load(open(f"{B}/manifest.json")).get("preprocessing", {}).get("motionHz")
assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
inv = json.load(open(f"{HERE}/inventory.json"))
SKIP = {"07-29-39", "07-29-43", "07-29-55", "07-30-01", "07-30-03", "08-11-45"}
use = [o for o in inv if not o["train"] and o["kind"] == "pinch" and not any(s in o["dir"] for s in SKIP)]
NEG = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
out = []
for o in use:
    rid = os.path.basename(o["dir"])
    spec = label_train.parse_spec({"version": 1, "target": "pinch_in", "negatives": NEG, "excludes": ["left_out"],
        "recordings": {rid: o["dir"]}, "train": [], "evaluation": [rid], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": 17, "steadyStarts": False,
        **({"motionHz": HZ} if HZ else {})})
    rec = label_train.load_spec_recordings(spec)[rid]
    t, s = label_train.timeline(spec, rec, lambda x: cnn.predict(mb, x))
    held = ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
    lo, hi = ppg_onset.match_window_ms(spec.decision_delay_ms)
    r = label_train.detections(spec, rec, t, s, label_train.policy_for(0.99, spec.trigger))
    for st, en, lab in held:
        if lab != "pinch_in" or not (t[0] <= st + lo * 1e6 <= t[-1]): continue
        m = (t >= st + lo * 1e6) & (t <= st + hi * 1e6)
        out.append(dict(rec=rid, start_ns=int(st), end_ns=int(en), peak=float(np.nanmax(s[m])) if m.any() else None,
                        live="2026-11-13" in rid))
    print(rid[16:], r["caught"], "/", r["gestures"])
json.dump(out, open(f"{HERE}/per-start-{NAME}.json", "w"))
