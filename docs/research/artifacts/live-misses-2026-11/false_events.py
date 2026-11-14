"""Where pinch_in-ae0a22bf fires on the 14 Nov everyday-noise recordings (activation 0.99): time, peak score, wrist motion."""
import json, os, sys, hashlib, csv
sys.path.insert(0, os.environ["TRAINER_SRC"])
import numpy as np
from label_trainer import cnn, label_train
from label_trainer.events import detect
ROOT = "/Users/vaibhavbisht/Documents/GitHub/gesture-controls"
HL = f"{ROOT}/data/recordings/Hand labeled"
B = f"{ROOT}/trained-models/pinch_in-hand-labeled"
man = json.load(open(f"{B}/manifest.json")); mb = open(f"{B}/model.cnn", "rb").read()
assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
NEG = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
RECS = sys.argv[1:] or ["gesture-dataset-unlabeled-2026-11-14T09-58-34.967Z", "gesture-dataset-unlabeled-2026-11-14T10-29-35.618Z"]
out = []
for rid in RECS:
    d = f"{HL}/{rid}"
    spec = label_train.parse_spec({"version": 1, "target": "pinch_in", "negatives": NEG, "excludes": ["left_out"],
        "recordings": {rid: d}, "train": [], "evaluation": [rid], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": 17, "steadyStarts": False})
    rec = label_train.load_spec_recordings(spec)[rid]
    t, s = label_train.timeline(spec, rec, lambda x: cnn.predict(mb, x))
    imu = np.array([[float(r["timestamp_ns"]), *(float(r[k]) for k in ("gyro_x", "gyro_y", "gyro_z", "accel_x", "accel_y", "accel_z"))]
                    for r in csv.DictReader(l for l in open(f"{d}/imu.csv") if not l.startswith("#"))])
    w = np.linalg.norm(imu[:, 1:4], axis=1); a = np.linalg.norm(imu[:, 4:7], axis=1)
    pol = label_train.policy_for(0.99, spec.trigger)
    for rise, _ in detect(t, s, pol):
        i = np.searchsorted(t, rise); seg = s[max(0, i - 5): i + 50]
        before = (imu[:, 0] >= rise - 1.3e9) & (imu[:, 0] < rise); around = (imu[:, 0] >= rise - 0.5e9) & (imu[:, 0] < rise + 0.5e9)
        out.append(dict(rec=rid[-24:-5], min=round((rise - t[0]) / 6e10, 2), peak=round(float(seg.max()), 4),
                        gyro_before=round(float(np.median(w[before])), 3), gyro_around_max=round(float(w[around].max()), 2),
                        accel_std_around=round(float(a[around].std()), 3)))
    ab = s >= 0.99
    print(f"{rid}: {len(t)} decisions, {(t[-1]-t[0])/6e10:.1f} min, {ab.mean()*100:.2f}% of decisions above 0.99, median score {np.median(s):.3f}")
for e in out: print(e)
g = np.array([e["gyro_before"] for e in out]); print(f"median gyro before false events: {np.median(g):.3f} rad/s (training pinches 0.01, live caught 0.12)")
gaps = np.diff([e["min"] for e in out if e["rec"] == out[0]["rec"]]); print("minutes between events (first rec):", np.round(gaps, 2).tolist())
json.dump(out, open(os.path.join(os.path.dirname(__file__), "false_events.json"), "w"), indent=1)
