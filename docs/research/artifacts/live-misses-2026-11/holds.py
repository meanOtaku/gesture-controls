import json, os, sys, datetime as dt, io, contextlib
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
with contextlib.redirect_stdout(io.StringIO()):
    from features import load, starts, ROOT
D = os.path.expanduser("~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab")
idx = json.load(open(f"{D}/datasets/index.json"))["datasets"]
miss = sorted([i for i in idx if i.get("group") == "Misses"], key=lambda i: i["sequence"])
def after(P, s):
    """label sequence after this pinch_in start: hold duration (ms) and whether a pinch_out follows within 3 s"""
    lab, t = P["lab"], P["t"]; j = int(np.searchsorted(t, s)); k = j
    while k < len(lab) and lab[k] == "pinch_in": k += 1
    hold = 0.0
    if k < len(lab) and lab[k] == "pinch_hold":
        h = k
        while h < len(lab) and lab[h] == "pinch_hold": h += 1
        hold = t[min(h, len(t) - 1)] - t[k]; k = h
    out = k < len(lab) and lab[k] == "pinch_out"
    return hold, out, k >= len(lab) - 1
live = json.load(open(os.path.join(os.path.dirname(__file__), "misses.json")))
rows = {round(r["t"], 1): r for r in live["rows"] if r["label"] == "pinch_in"}
marks = []
for it in miss:
    L = json.load(open(f"{D}/datasets/{it['id']}/live_log.json"))
    marks.append(dt.datetime.fromisoformat(L["savedAt"].replace("Z", "+00:00")).timestamp() * 1000)
t0 = min(marks) - 46000
res = {}
for it, M in zip(miss, marks):
    I, P = load(f"{D}/datasets/{it['id']}")
    off = M - max(I["t"][-1], P["t"][-1])
    for s in starts(P):
        key = round((s + off - t0) / 1000, 1)
        hold, out, cut = after(P, s)
        if cut: continue                           # window ends before we can see what followed
        r = next((v for k, v in rows.items() if abs(k - key) <= 0.3), None)
        if r is None: continue
        k2 = round(r["t"], 1)
        if k2 not in res: res[k2] = (r["detected"], hold, out)
tap = [(k, v) for k, v in sorted(res.items()) if v[1] < 200]
held = [(k, v) for k, v in sorted(res.items()) if v[1] >= 200]
print(f"pinch followed by a hold >= 200 ms: live caught {sum(v[0] for _, v in held)}/{len(held)}")
print(f"quick tap (no hold):               live caught {sum(v[0] for _, v in tap)}/{len(tap)}  at t = {[k for k, _ in tap]}")
tr_hold = []
man = json.load(open(f"{ROOT}/trained-models/pinch_in-hand-labeled/manifest.json"))["provenance"]
for rid in man["trainRecordings"]:
    I, P = load(f"{ROOT}/data/recordings/Hand labeled/{rid}")
    for s in starts(P):
        h, o, c = after(P, s)
        if not c: tr_hold.append(h)
tr_hold = np.array(tr_hold)
print(f"training pinches: {len(tr_hold)}, without a hold >= 200 ms: {(tr_hold < 200).sum()}; median hold {np.median(tr_hold):.0f} ms")

# ---- wrist turning: during holds (training vs live) and in the 3 s before each held live pinch ----
def turn_before(I, s, win=3000, thr=0.3, min_ms=400):
    m = (I["t"] >= s - win) & (I["t"] < s - 100)
    g = np.sqrt(I["gyro_x"][m]**2 + I["gyro_y"][m]**2 + I["gyro_z"][m]**2)
    if not len(g): return False
    sm = np.convolve(g, np.ones(30) / 30, mode="same")   # 0.3 s smoothing: sustained turning, not the pinch spike
    return bool((sm > thr).sum() * 10 >= min_ms)
def hold_turn(I, P, s):
    lab, t = P["lab"], P["t"]; j = int(np.searchsorted(t, s)); k = j
    while k < len(lab) and lab[k] == "pinch_in": k += 1
    h = k
    while h < len(lab) and lab[h] == "pinch_hold": h += 1
    if h == k: return None
    m = (I["t"] >= t[k]) & (I["t"] <= t[min(h, len(t) - 1)])
    g = np.sqrt(I["gyro_x"][m]**2 + I["gyro_y"][m]**2 + I["gyro_z"][m]**2)
    return float(np.convolve(g, np.ones(30) / 30, mode="same").max()) if len(g) > 30 else None
tr_turn = []
for rid in man["trainRecordings"]:
    I, P = load(f"{ROOT}/data/recordings/Hand labeled/{rid}")
    for s in starts(P):
        v = hold_turn(I, P, s)
        if v is not None: tr_turn.append(v)
lv_turn, before = [], {}
for it, M in zip(miss, marks):
    I, P = load(f"{D}/datasets/{it['id']}")
    off = M - max(I["t"][-1], P["t"][-1])
    for s in starts(P):
        v = hold_turn(I, P, s)
        if v is not None: lv_turn.append(v)
        key = round((s + off - t0) / 1000, 1)
        k2 = next((k for k in res if abs(k - key) <= 0.3), None)
        if k2 is not None and res[k2][1] >= 200 and k2 not in before and s - P["t"][0] > 3000:
            before[k2] = (res[k2][0], turn_before(I, s))
tr_turn, lv_turn = np.array(tr_turn), np.array(lv_turn)
print(f"\nturning during the hold (peak 0.3 s-smoothed gyro): training median {np.median(tr_turn):.2f} rad/s, "
      f"{(tr_turn > 0.3).mean()*100:.0f}% above 0.3;  live median {np.median(lv_turn):.2f}, {(lv_turn > 0.3).mean()*100:.0f}% above 0.3")
a = [v for v in before.values() if v[1]]; b = [v for v in before.values() if not v[1]]
print(f"held pinches with a wrist turn in the 3 s before: caught {sum(v[0] for v in a)}/{len(a)};  without: {sum(v[0] for v in b)}/{len(b)}")
print("held misses:", {k: ('turn before' if v[1] else 'no turn') for k, v in sorted(before.items()) if not v[0]})
