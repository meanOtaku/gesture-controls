"""Score one pinch_in bundle on the held-out set shared by ae0a22bf and the 14 Nov retrains.

Held out: every stream in inventory.json that ae0a22bf did not train on, minus overlapping miss windows, minus the
20-minute 14 Nov noise recording (training data for the retrain). The 27-minute one is the everyday test.
Usage: TRAINER_SRC=<trainer src matching the bundle> python compare.py <bundle dir> <name>
"""
import json, os, sys, hashlib, math
sys.path.insert(0, os.environ["TRAINER_SRC"])
from label_trainer import cnn, label_train
HERE = os.path.dirname(os.path.abspath(__file__))
B, NAME = sys.argv[1], sys.argv[2]
man = json.load(open(f"{B}/manifest.json")); mb = open(f"{B}/model.cnn", "rb").read()
# The grid the model was trained on (a manifest without it predates 100 Hz: the trainer's own default then).
HZ = json.load(open(f"{B}/manifest.json")).get("preprocessing", {}).get("motionHz")
assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
inv = json.load(open(f"{HERE}/inventory.json"))
SKIP = {"07-29-39", "07-29-43", "07-29-55", "07-30-01", "07-30-03", "08-11-45", "2026-11-14T09-58-34"}
use = [o for o in inv if not o["train"] and not any(s in o["dir"] for s in SKIP)]
NEG = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
THRESH = [0.999, 0.998, 0.995, 0.99, 0.98, 0.97, 0.95, 0.90, 0.85, 0.80, 0.70]
def group(o):
    n = os.path.basename(o["dir"])
    if "everyday_noise" in n or "everyday_noise" in o["labels"]: return "everyday"
    if o["kind"] == "noise": return "still"
    if "2026-11-13" in n: return "live"
    return "pinch"
acc = {}
for o in use:
    rid = os.path.basename(o["dir"])
    spec = label_train.parse_spec({"version": 1, "target": "pinch_in", "negatives": NEG, "excludes": ["left_out"],
        "recordings": {rid: o["dir"]}, "train": [], "evaluation": [rid], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": 17, "steadyStarts": False,
        **({"motionHz": HZ} if HZ else {})})
    rec = label_train.load_spec_recordings(spec)[rid]
    sc = label_train.timeline(spec, rec, lambda x: cnn.predict(mb, x))
    if sc is None: print("no inputs:", rid); continue
    for th in THRESH:
        r = label_train.detections(spec, rec, *sc, label_train.policy_for(th, spec.trigger))
        a = acc.setdefault(f"{group(o)}|{th}", dict(gestures=0, caught=0, fa=0, neg_h=0.0))
        a["gestures"] += r["gestures"]; a["caught"] += r["caught"]; a["fa"] += r["falseActivations"]; a["neg_h"] += r["negativeNs"] / 3.6e12
print(f"{NAME}: trainer-chosen activation {man['thresholds']['activation']}")
print("activation | pinch sessions | live-style | everyday FA (rate) | still/supported FA")
for th in THRESH:
    g = {k: acc[f"{k}|{th}"] for k in ("pinch", "live", "everyday", "still")}
    print(f"{th:g} | {g['pinch']['caught']}/{g['pinch']['gestures']} | {g['live']['caught']}/{g['live']['gestures']} | "
          f"{g['everyday']['fa']} ({g['everyday']['fa'] / g['everyday']['neg_h']:.1f}/h) | {g['still']['fa']}")
json.dump({"model": man["modelId"], "activation": man["thresholds"]["activation"], "results": acc},
          open(f"{HERE}/compare-{NAME}.json", "w"), indent=1)
