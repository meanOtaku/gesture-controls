"""Every recording available, deduplicated by sensor-stream hash, minus the model's training streams."""
import csv, hashlib, json, os, glob, collections
ROOT = "/Users/vaibhavbisht/Documents/GitHub/gesture-controls"
APP = os.path.expanduser("~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab/datasets")
def stream_hash(path):
    h = hashlib.sha256(); n = 0; t0 = t1 = None
    with open(path) as f:
        rows = csv.reader(l for l in f if not l.startswith("#"))
        head = next(rows); keep = [i for i, c in enumerate(head) if c not in ("label", "manual_label")]
        for r in rows:
            h.update(",".join(r[i] for i in keep).encode()); n += 1
            t = int(r[0]); t0 = t if t0 is None else t0; t1 = t
    return h.hexdigest(), (t1 - t0) / 1e9 if n else 0
def labels(path):
    c = collections.Counter()
    with open(path) as f:
        for r in csv.DictReader(l for l in f if not l.startswith("#")):
            c[r.get("manual_label") or r.get("label") or ""] += 1
    return c
dirs = [d for d in glob.glob(f"{ROOT}/data/recordings/*/*") if os.path.isfile(f"{d}/ppg.csv") and os.path.isfile(f"{d}/imu.csv")]
dirs += [d for d in glob.glob(f"{APP}/*") if os.path.isfile(f"{d}/ppg.csv") and os.path.isfile(f"{d}/imu.csv")]
man = json.load(open(f"{ROOT}/trained-models/pinch_in-hand-labeled/manifest.json"))["provenance"]
train_keys = set()
for rid in man["trainRecordings"]:
    d = f"{ROOT}/data/recordings/Hand labeled/{rid}"
    train_keys.add((stream_hash(f"{d}/ppg.csv")[0], stream_hash(f"{d}/imu.csv")[0]))
seen, out = set(), []
for d in sorted(dirs):
    hp, dur = stream_hash(f"{d}/ppg.csv"); hi, _ = stream_hash(f"{d}/imu.csv")
    key = (hp, hi)
    if key in seen: continue
    seen.add(key)
    lab = labels(f"{d}/ppg.csv")
    kind = "pinch" if any(k.startswith("pinch") for k in lab) else ("noise" if any(lab.values()) else "unlabelled")
    out.append(dict(dir=d, minutes=round(dur / 60, 2), kind=kind, train=key in train_keys,
                    labels={k: v for k, v in lab.items() if k}, eval=os.path.basename(d) in man["evaluationRecordings"]))
json.dump(out, open(os.path.join(os.path.dirname(__file__), "inventory.json"), "w"), indent=1)
un = [o for o in out if not o["train"]]
print(f"distinct streams: {len(out)}; in training: {sum(o['train'] for o in out)}; unseen: {len(un)}")
for k in ("noise", "pinch", "unlabelled"):
    g = [o for o in un if o["kind"] == k]
    print(f"  unseen {k:10s}: {len(g):3d} recordings, {sum(o['minutes'] for o in g):7.1f} min")
print("unseen noise labels:", collections.Counter(l for o in un if o["kind"] == "noise" for l in o["labels"]).most_common())
