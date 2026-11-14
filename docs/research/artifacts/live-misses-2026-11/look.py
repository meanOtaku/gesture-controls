import json, os, sys, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    from features import load, starts
D = os.path.expanduser("~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab")
idx = json.load(open(f"{D}/datasets/index.json"))["datasets"]
miss = sorted([i for i in idx if i.get("group") == "Misses"], key=lambda i: i["sequence"])
picks = [(miss[6], "Session 1, 12:59 (last window): 6 misses in a row at the end"), (miss[8], "Session 2, 13:42: all caught by the current model")]
fig, axes = plt.subplots(4, 2, figsize=(14, 9), sharex="col")
for col, (it, title) in enumerate(picks):
    d = f"{D}/datasets/{it['id']}"; I, P = load(d)
    L = json.load(open(f"{d}/live_log.json"))
    t0 = I["t"][0]; ti = (I["t"] - t0) / 1000; tp = (P["t"] - t0) / 1000
    end = max(I["t"][-1], P["t"][-1])
    g = np.sqrt(I["gyro_x"]**2 + I["gyro_y"]**2 + I["gyro_z"]**2)
    a = np.sqrt(I["accel_x"]**2 + I["accel_y"]**2 + I["accel_z"]**2)
    sc = [((end - e["msBeforeMark"] - t0) / 1000, e["value"]) for e in L["entries"] if e["kind"] == "score" and e["label"] == "pinch_in"]
    ev = [(end - e["msBeforeMark"] - t0) / 1000 for e in L["entries"] if e["kind"] == "detected" and e["label"] == "pinch_in"]
    lab = np.array(P["lab"])
    def shade(ax):
        for l, c in (("pinch_in", "#2a78d6"), ("pinch_hold", "#999999"), ("pinch_out", "#eb6834")):
            m = lab == l
            ax.fill_between(tp, 0, 1, where=m, color=c, alpha=0.15, transform=ax.get_xaxis_transform(), lw=0)
    ax = axes[0, col]; shade(ax); ax.plot(*zip(*sc), lw=1); ax.axhline(0.99, ls="--", c="k", lw=0.7)
    for e in ev: ax.axvline(e, c="g", lw=0.8)
    ax.set_ylabel("live pinch_in score"); ax.set_title(title, loc="left")
    ax = axes[1, col]; shade(ax); ax.plot(ti, g, lw=0.6); ax.set_ylabel("gyro |ω| rad/s"); ax.set_ylim(0, 3)
    ax = axes[2, col]; shade(ax); ax.plot(ti, a, lw=0.6); ax.set_ylabel("accel | a | m/s²"); ax.set_ylim(0, 10)
    ax = axes[3, col]; shade(ax)
    for ch, c in (("ppg_green", "g"), ("ppg_ir", "m")):
        x = P[ch]; ax.plot(tp, (x - np.median(x)) / (np.median(abs(x - np.median(x))) * 1.48 + 1e-9), lw=0.6, c=c, label=ch)
    ax.set_ylim(-15, 15); ax.set_ylabel("PPG (robust z)"); ax.legend(loc="upper left", fontsize=7); ax.set_xlabel("s")
fig.tight_layout(); fig.savefig(sys.argv[1], dpi=110)
