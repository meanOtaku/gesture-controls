"""Threshold sweep for pinch_in-ae0a22bf on recordings that share no stream with its training data."""
import json, os, sys, hashlib, math
sys.path.insert(0, os.environ["TRAINER_SRC"])
import numpy as np
from label_trainer import cnn, label_train
ROOT = "/Users/vaibhavbisht/Documents/GitHub/gesture-controls"
HL = f"{ROOT}/data/recordings/Hand labeled"
B = f"{ROOT}/trained-models/pinch_in-hand-labeled"
man = json.load(open(f"{B}/manifest.json")); mb = open(f"{B}/model.cnn", "rb").read()
assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
inv = json.load(open(os.path.join(os.path.dirname(__file__), "inventory.json")))
SKIP_OVERLAP = {"07-29-39", "07-29-43", "07-29-55", "07-30-01", "07-30-03", "08-11-45"}
use = [o for o in inv if not o["train"] and not any(s in o["dir"] for s in SKIP_OVERLAP)]
NEG = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
THRESH = [0.999, 0.998, 0.995, 0.99, 0.98, 0.97, 0.95, 0.93, 0.90, 0.85, 0.80]
def group(o):
    n = os.path.basename(o["dir"])
    # By label, not folder name: a Recorder export of everyday noise is named "unlabeled" when no label was selected.
    if "everyday_noise" in n or "everyday_noise" in o["labels"]: return "everyday noise"
    if o["kind"] == "noise": return "still / supported"
    if "2026-11-13" in n: return "live misses (13 Nov)"
    return "pinch sessions"
acc = {}
for o in use:
    rid = os.path.basename(o["dir"])
    spec = label_train.parse_spec({"version": 1, "target": "pinch_in", "negatives": NEG, "excludes": ["left_out"],
        "recordings": {rid: o["dir"]}, "train": [], "evaluation": [rid], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": 17, "steadyStarts": False})
    rec = label_train.load_spec_recordings(spec)[rid]
    sc = label_train.timeline(spec, rec, lambda x: cnn.predict(mb, x))
    if sc is None: print("no inputs:", rid); continue
    for th in THRESH:
        r = label_train.detections(spec, rec, *sc, label_train.policy_for(th, spec.trigger))
        a = acc.setdefault((group(o), th), dict(gestures=0, caught=0, fa=0, neg_s=0.0))
        a["gestures"] += r["gestures"]; a["caught"] += r["caught"]; a["fa"] += r["falseActivations"]; a["neg_s"] += r["negativeNs"] / 1e9
        a.setdefault("falseOn", {})
        for k, v in r["falseOn"].items(): a["falseOn"][k] = a["falseOn"].get(k, 0) + v
        if th == 0.99: print(f"  {rid[16:]:42s} eval={o['eval']!s:5s} caught {r['caught']}/{r['gestures']}  FA {r['falseActivations']}")
groups = ["pinch sessions", "live misses (13 Nov)", "everyday noise", "still / supported"]
print("activation | " + " | ".join(groups) + " | total false activations")
for th in THRESH:
    cells = []
    tot_fa = tot_h = 0
    for g in groups:
        a = acc.get((g, th))
        if not a: cells.append("-"); continue
        tot_fa += a["fa"]; tot_h += a["neg_s"] / 3600
        cells.append((f"{a['caught']}/{a['gestures']} caught, " if a["gestures"] else "") + f"{a['fa']} FA")
    upper = -math.log(0.05) / tot_h if tot_fa == 0 else None
    print(f"{th:g} | " + " | ".join(cells) + f" | {tot_fa} in {tot_h:.2f} h = {tot_fa / tot_h:.1f}/h" + (f" (95% upper {upper:.1f}/h)" if upper else ""))
print("false activations by label at 0.99 / 0.95 / 0.90:", [ {g: acc[(g, th)].get("falseOn") for g in groups if (g, th) in acc and acc[(g, th)]["fa"]} for th in (0.99, 0.95, 0.90)])
print("no-gesture hours by group:", {g: round(acc[(g, 0.99)]["neg_s"] / 3600, 3) for g in groups if (g, 0.99) in acc})
json.dump({f"{g}|{th}": v for (g, th), v in acc.items()}, open(os.path.join(os.path.dirname(__file__), "sweep.json"), "w"), indent=1)
