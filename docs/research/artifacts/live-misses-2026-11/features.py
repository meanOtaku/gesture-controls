"""Per-pinch signal features: live misses vs live catches (13 Nov) vs the model's training pinches."""
import json, csv, os, glob
import numpy as np
ROOT = "/Users/vaibhavbisht/Documents/GitHub/gesture-controls"
D = os.path.expanduser("~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab")

def load(d):
    rd = lambda f: list(csv.DictReader(l for l in open(f"{d}/{f}") if not l.startswith("#")))
    imu, ppg = rd("imu.csv"), rd("ppg.csv")
    I = {k: np.array([float(r[k]) for r in imu]) for k in ("accel_x","accel_y","accel_z","gyro_x","gyro_y","gyro_z","quat_w","quat_x","quat_y","quat_z")}
    I["t"] = np.array([int(r["timestamp_ns"]) for r in imu]) / 1e6
    P = {k: np.array([float(r[k]) for r in ppg]) for k in ("ppg_green","ppg_red","ppg_ir")}
    P["t"] = np.array([int(r["timestamp_ns"]) for r in ppg]) / 1e6
    P["lab"] = [r["manual_label"] or r["label"] for r in ppg]
    return I, P

def starts(P, lab="pinch_in"):
    out = []; prev = None
    for t, l in zip(P["t"], P["lab"]):
        if l == lab and prev != lab: out.append(t)
        prev = l
    return out

def down_vector(w, x, y, z):
    # gravity direction in the watch frame from the rotation-vector quaternion (world z up)
    return np.array([2*(x*z - w*y), 2*(y*z + w*x), 1 - 2*(x*x + y*y)])

def feats(I, P, s):
    m = (I["t"] >= s - 200) & (I["t"] <= s + 800)
    pre = (I["t"] >= s - 1500) & (I["t"] < s - 200)
    g = np.sqrt(I["gyro_x"]**2 + I["gyro_y"]**2 + I["gyro_z"]**2)
    a = np.sqrt(I["accel_x"]**2 + I["accel_y"]**2 + I["accel_z"]**2)
    i0 = np.argmin(abs(I["t"] - s))
    dv = down_vector(I["quat_w"][i0], I["quat_x"][i0], I["quat_y"][i0], I["quat_z"][i0])
    tilt = float(np.degrees(np.arccos(np.clip(dv[2] / np.linalg.norm(dv), -1, 1))))   # watch-face normal vs vertical
    pm = (P["t"] >= s) & (P["t"] <= s + 1000); pb = (P["t"] >= s - 3000) & (P["t"] < s)
    ppg = {}
    for ch in ("ppg_green", "ppg_ir"):
        base = P[ch][pb]; mad = np.median(abs(base - np.median(base))) * 1.4826 + 1e-9
        ppg[ch] = float((P[ch][pm].max() - P[ch][pm].min()) / mad) if pm.any() and pb.sum() > 5 else np.nan
    dur = None
    j = np.searchsorted(P["t"], s)
    k = j
    while k < len(P["lab"]) and P["lab"][k] == "pinch_in": k += 1
    dur = (P["t"][min(k, len(P["t"]) - 1)] - s)
    return dict(gyro_peak=float(g[m].max()) if m.any() else np.nan,
                gyro_pre=float(np.sqrt(np.mean(g[pre]**2))) if pre.any() else np.nan,
                accel_peak=float(a[m].max()) if m.any() else np.nan,
                tilt_deg=tilt, ppg_green=ppg["ppg_green"], ppg_ir=ppg["ppg_ir"], in_ms=dur)

rows = []
# training pinches of the hand-labelled model
man = json.load(open(f"{ROOT}/trained-models/pinch_in-hand-labeled/manifest.json"))["provenance"]
for rid in man["trainRecordings"]:
    d = f"{ROOT}/data/recordings/Hand labeled/{rid}"
    I, P = load(d)
    for s in starts(P): rows.append(dict(group="training", **feats(I, P, s)))
# live pinches (13 Nov): use the merged-timeline verdicts from misses.json, matched back by wall time
res = json.load(open(f"{os.path.dirname(__file__)}/misses.json"))
import datetime as dt
idx = json.load(open(f"{D}/datasets/index.json"))["datasets"]
miss = sorted([i for i in idx if i.get("group") == "Misses"], key=lambda i: i["sequence"])
marks = []
seen = set()
for it in miss:
    d = f"{D}/datasets/{it['id']}"
    L = json.load(open(f"{d}/live_log.json"))
    M = dt.datetime.fromisoformat(L["savedAt"].replace("Z", "+00:00")).timestamp() * 1000; marks.append((M, d))
t0 = min(m for m, _ in marks) - 46000
verdict = {round(r["t"], 1): r["detected"] for r in res["rows"] if r["label"] == "pinch_in"}
for M, d in marks:
    I, P = load(d)
    off = M - max(I["t"][-1], P["t"][-1])
    for s in starts(P):
        key = round((s + off - t0) / 1000, 1)
        hit = next((v for k, v in verdict.items() if abs(k - key) <= 0.3), None)
        if hit is None or any(abs(key - k) <= 0.3 for k in seen): continue
        if s - P["t"][0] < 1500: continue
        seen.add(key)
        rows.append(dict(group="live caught" if hit else "live missed", t=key, **feats(I, P, s)))
json.dump(rows, open(f"{os.path.dirname(__file__)}/features.json", "w"), indent=1)
keys = ["gyro_peak", "gyro_pre", "accel_peak", "tilt_deg", "ppg_green", "ppg_ir", "in_ms"]
print(f"{'group':12s} {'n':>3s} " + " ".join(f"{k:>11s}" for k in keys))
for g in ("training", "live caught", "live missed"):
    R = [r for r in rows if r["group"] == g]
    med = [np.nanmedian([r[k] for r in R]) for k in keys]
    print(f"{g:12s} {len(R):3d} " + " ".join(f"{v:11.2f}" for v in med))
print("\nlive missed, one by one:")
for r in sorted([r for r in rows if r["group"] == "live missed"], key=lambda r: r["t"]):
    print(f"  t={r['t']:7.1f}s " + " ".join(f"{k}={r[k]:.2f}" for k in keys))
