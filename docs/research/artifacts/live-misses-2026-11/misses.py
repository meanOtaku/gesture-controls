"""Merge the 9 miss-recorder windows of 13 Nov into one timeline; check each labelled start against the live model."""
import json, csv, os, sys, datetime as dt
import numpy as np
D = os.path.expanduser("~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab")
idx = json.load(open(f"{D}/datasets/index.json"))["datasets"]
miss = sorted([i for i in idx if i.get("group") == "Misses"], key=lambda i: i["sequence"])

def rows(p):
    return list(csv.DictReader(l for l in open(p) if not l.startswith("#")))

def runs(ts, labs):
    out, cur, start = [], None, None
    for t, l in zip(ts, labs):
        if l != cur:
            if cur: out.append((start, prev, cur))
            cur, start = l, t
        prev = t
    if cur: out.append((start, prev, cur))
    return out

starts = {"pinch_in": [], "pinch_out": []}
events = {"pinch_in": [], "pinch_out": []}
scores = {"pinch_in": {}, "pinch_out": {}}
resets, marks, gyro = [], [], {}
for it in miss:
    d = f"{D}/datasets/{it['id']}"
    L = json.load(open(f"{d}/live_log.json"))
    M = dt.datetime.fromisoformat(L["savedAt"].replace("Z", "+00:00")).timestamp() * 1000
    marks.append(M)
    imu = rows(f"{d}/imu.csv"); ppg = rows(f"{d}/ppg.csv")
    last = max(int(imu[-1]["timestamp_ns"]), int(ppg[-1]["timestamp_ns"])) / 1e6
    off = M - last                       # watch ms -> wall ms (mark ~ last sample)
    tp = np.array([int(r["timestamp_ns"]) / 1e6 + off for r in ppg])
    for s, e, l in runs(tp, [r["manual_label"] or r["label"] for r in ppg]):
        if l in starts: starts[l].append(s)
    for r in imu:
        t = round(int(r["timestamp_ns"]) / 1e6 + off)
        gyro[t] = float(np.sqrt(sum(float(r[k]) ** 2 for k in ("gyro_x", "gyro_y", "gyro_z"))))
    for e in L["entries"]:
        t = M - e["msBeforeMark"]
        if e["kind"] == "score": scores[e["label"]][round(t)] = e["value"]
        elif e["kind"] == "detected": events[e["label"]].append(t)
        elif e["kind"] == "reset": resets.append((t, e.get("detail")))
def dedupe(xs, tol=300):
    out = []
    for x in sorted(xs):
        if not out or x - out[-1] > tol: out.append(x)
    return out
for k in starts: starts[k] = dedupe(starts[k]); events[k] = dedupe(events[k], 200)
gt = np.array(sorted(gyro)); gv = np.array([gyro[t] for t in gt])
t0 = min(marks) - 46000
def calm_before(s, thr=1.0):
    # seconds since the 0.3 s gyro RMS last exceeded thr before s
    m = gt < s
    tt, vv = gt[m], gv[m]
    if not len(tt): return None
    rms = np.sqrt(np.convolve(vv**2, np.ones(30)/30, mode="same"))
    hot = tt[rms > thr]
    return (s - hot[-1]) / 1000 if len(hot) else (s - tt[0]) / 1000
out = []
for lab in ("pinch_in", "pinch_out"):
    st = scores[lab]; stt = np.array(sorted(st)); sv = np.array([st[t] for t in stt])
    for s in starts[lab]:
        win = (stt >= s) & (stt <= s + 1500)
        if not win.any(): continue      # no live scores here (outside every log)
        ev = [e for e in events[lab] if s - 200 <= e <= s + 1500]
        prev_starts = [x for x in starts["pinch_in"] + starts["pinch_out"] if x < s - 100]
        out.append(dict(label=lab, t=round((s - t0) / 1000, 2), detected=bool(ev),
                        lag_ms=round(ev[0] - s) if ev else None, peak=round(float(sv[win].max()), 4),
                        calm_s=round(calm_before(s), 2) if calm_before(s) is not None else None,
                        since_prev_s=round((s - max(prev_starts)) / 1000, 2) if prev_starts else None))
json.dump(dict(rows=out, marks=[(m - t0) / 1000 for m in marks], resets=[((t - t0) / 1000, d) for t, d in resets]),
          open(sys.argv[1], "w"), indent=1)
for lab in ("pinch_in", "pinch_out"):
    r = [x for x in out if x["label"] == lab]; c = [x for x in r if x["detected"]]
    print(f"{lab}: {len(c)}/{len(r)} labelled starts detected live")
    for x in r: print("   ", x)
print("marks (s):", [round((m - t0) / 1000, 1) for m in marks])
print("resets:", [(round((t - t0) / 1000, 1), d) for t, d in resets])

# ---- false activations and threshold sensitivity (live scores, live hysteresis approximated) ----
def fire(ts, vs, act, rel=0.84, cool=1500):
    ev, active, last = [], False, -1e18
    prevv = None
    peak_pending = False
    for t, v in zip(ts, vs):
        if active:
            if peak_pending and prevv is not None and v < prevv:
                ev.append(t); peak_pending = False; last = t
            if v < rel: active = False
        elif v >= act and t - last >= cool:
            active, peak_pending = True, True
        prevv = v
    return ev
for lab in ("pinch_in",):
    st = scores[lab]; stt = sorted(st); sv = [st[t] for t in stt]
    S_ = starts[lab]; other = starts["pinch_out"]
    for act in (0.99, 0.97, 0.95, 0.9, 0.85, 0.8, 0.7):
        ev = fire(stt, sv, act)
        caught = sum(any(s + 100 <= e <= s + 1500 for e in ev) for s in S_ if any(s <= t <= s + 1500 for t in stt[::10]))
        fa = [e for e in ev if not any(s + 100 <= e <= s + 1500 for s in S_)]
        on_out = sum(any(s - 200 <= e <= s + 1500 for s in other) for e in fa)
        print(f"activation {act:.2f}: caught {caught}/{len(S_)}  unmatched events {len(fa)} (of which near a pinch-out start: {on_out})")
