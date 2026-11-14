"""Replay the stored hand-labelled pinch_in model (ae0a22bf) over the 13 Nov miss recordings."""
import json, os, sys, datetime as dt, hashlib
sys.path.insert(0, os.environ["TRAINER_SRC"])
import numpy as np
from label_trainer import cnn, label_train, ppg_onset
from label_trainer.events import detect
ROOT = "/Users/vaibhavbisht/Documents/GitHub/gesture-controls"
D = os.path.expanduser("~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab")
B = f"{ROOT}/trained-models/pinch_in-hand-labeled"
man = json.load(open(f"{B}/manifest.json")); mb = open(f"{B}/model.cnn", "rb").read()
assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
idx = json.load(open(f"{D}/datasets/index.json"))["datasets"]
miss = sorted([i for i in idx if i.get("group") == "Misses"], key=lambda i: i["sequence"])
NEG = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
res = {}
marks = []
for it in miss:
    d = f"{D}/datasets/{it['id']}"
    L = json.load(open(f"{d}/live_log.json"))
    M = dt.datetime.fromisoformat(L["savedAt"].replace("Z", "+00:00")).timestamp() * 1000; marks.append(M)
    spec = label_train.parse_spec({"version": 1, "target": "pinch_in", "negatives": NEG, "excludes": ["left_out"],
        "recordings": {it["id"]: d}, "train": [], "evaluation": [it["id"]], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": 17, "steadyStarts": False})
    rec = label_train.load_spec_recordings(spec)[it["id"]]
    pol = label_train.policy_for(man["thresholds"]["activation"], spec.trigger)
    sc = label_train.timeline(spec, rec, lambda x: cnn.predict(mb, x))
    if sc is None: continue
    times, scores = sc
    held = ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
    lo, hi = ppg_onset.match_window_ms(spec.decision_delay_ms)
    starts = [s for s, _, l in held if l == "pinch_in" and times[0] <= s + lo * 1e6 <= times[-1]]
    rises = [r for r, _ in detect(times, scores, pol)]
    pairs = ppg_onset.match_pairs(rises, starts, spec.decision_delay_ms)
    caught = {j for _, j in pairs}
    off = M - max(rec.timestamps_ns) / 1e6
    for j, s in enumerate(starts):
        w = (times >= s) & (times <= s + 1500e6)
        key = round((s / 1e6 + off) / 1000, 1)
        res.setdefault(key, (j in caught, float(scores[w].max()) if w.any() else None))
t0 = (min(marks) - 46000) / 1000
live = {round(r["t"], 1): r for r in json.load(open(os.path.join(os.path.dirname(__file__), "misses.json")))["rows"] if r["label"] == "pinch_in"}
both = []
for k, (c, pk) in sorted(res.items()):
    t = round(k - t0, 1)
    lv = next((v for kk, v in live.items() if abs(kk - t) <= 0.3), None)
    if lv: both.append((t, lv["detected"], lv["peak"], c, pk))
print(f"{'t (s)':>8} {'live 006520':>12} {'peak':>6} {'ae0a22bf':>9} {'peak':>6}")
for t, l, lp, c, cp in both: print(f"{t:8.1f} {('caught' if l else 'MISSED'):>12} {lp:6.3f} {('caught' if c else 'MISSED'):>9} {cp:6.3f}")
print(f"live model: {sum(b[1] for b in both)}/{len(both)}   ae0a22bf replay: {sum(b[3] for b in both)}/{len(both)}")
print("missed by both:", sum((not b[1]) and (not b[3]) for b in both), " live-missed but ae0a22bf caught:", sum((not b[1]) and b[3] for b in both))
