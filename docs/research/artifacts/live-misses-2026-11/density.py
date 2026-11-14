"""Relate each held-out pinch's peak score (ae0a22bf vs retrain A) to its 11 s history: pinches in it, moving share, spread."""
import json, os, csv, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
old = json.load(open(f"{HERE}/per-start-ae0a22bf.json")); new = json.load(open(f"{HERE}/per-start-A-baseline.json"))
key = lambda e: (e["rec"], e["start_ns"])
newd = {key(e): e for e in new}
inv = {os.path.basename(o["dir"]): o["dir"] for o in json.load(open(f"{HERE}/inventory.json"))}
imu_cache = {}
def imu(rid):
    if rid not in imu_cache:
        rows = list(csv.DictReader(l for l in open(f"{inv[rid]}/imu.csv") if not l.startswith("#")))
        imu_cache[rid] = np.array([[float(r["timestamp_ns"]), float(r["gyro_x"]), float(r["gyro_y"]), float(r["gyro_z"]),
                                    float(r["accel_x"]), float(r["accel_y"]), float(r["accel_z"])] for r in rows])
    return imu_cache[rid]
starts = collections.defaultdict(list)
for e in old: starts[e["rec"]].append(e["start_ns"])
rows = []
for e in old:
    n = newd.get(key(e))
    if not n or e["peak"] is None or n["peak"] is None: continue
    d = imu(e["rec"]); t = d[:, 0]; T = e["start_ns"] + 500e6          # the decision ~0.5 s after the start
    hist = (t >= T - 11e9) & (t < T - 1e9); win = (t >= T - 1e9) & (t <= T)
    w = np.linalg.norm(d[:, 1:4], axis=1)
    prior = sum(1 for s in starts[e["rec"]] if T - 11e9 <= s < e["start_ns"])
    g = d[hist, 1:4]; mad = float(np.median(np.abs(g - np.median(g, 0)), 0).mean() * 1.4826)
    rows.append(dict(live=e["live"], old=e["peak"], new=n["peak"], prior=prior, mad=mad,
                     win_gyro=float(w[win].max()), before=float(np.median(w[(t >= e["start_ns"] - 1.3e9) & (t < e["start_ns"])]))))
def show(sel, name):
    r = [x for x in rows if sel(x)]
    if not r: return
    f = lambda k: np.median([x[k] for x in r])
    print(f"{name:34s} n={len(r):3d} old caught {sum(x['old'] >= .99 for x in r):3d} new caught {sum(x['new'] >= .99 for x in r):3d} | "
          f"median peak old {f('old'):.3f} new {f('new'):.3f} | prior pinches {f('prior'):.0f} | hist gyro spread {f('mad'):.3f} | gyro before {f('before'):.3f}")
show(lambda x: not x["live"], "pinch sessions")
show(lambda x: x["live"], "live windows")
for p in range(0, 5): show(lambda x, p=p: not x["live"] and x["prior"] == p, f"  sessions, {p} pinches in history")
for p in range(0, 5): show(lambda x, p=p: x["live"] and x["prior"] == p, f"  live, {p} pinches in history")
mads = np.array([x["mad"] for x in rows]); q = np.quantile(mads, [0, .25, .5, .75, 1])
for a, b in zip(q[:-1], q[1:]): show(lambda x, a=a, b=b: a <= x["mad"] <= b and not x["live"], f"  sessions, hist spread {a:.3f}-{b:.3f}")
print("live history spread range:", np.round(sorted(x["mad"] for x in rows if x["live"]), 3).tolist())
json.dump(rows, open(f"{HERE}/density.json", "w"), indent=0)
