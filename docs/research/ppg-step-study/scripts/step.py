"""Per-event step across the gesture start: does each single event rise as the averages do, in every session?"""
import sys
import numpy as np
sys.path.insert(0, sys.argv[1])
import study  # noqa: E402  (re-runs the extraction; its traces are on a 40 ms grid from -500 to +1500)

grid = study.grid
before = (grid >= -400) & (grid <= -100)
after = (grid >= 400) & (grid <= 900)

def step(trace):
    return np.nanmean(trace[after]) - np.nanmean(trace[before])

print("\n=== step across the start (mean 400..900 ms after minus mean 400..100 ms before), MAD units ===")
for gesture in ("pinch", "fist", "thumbs_up"):
    for channel in study.CHANNELS:
        lines, X_rows = [], []
        for (s, g, kind, ch), tr in sorted(study.traces.items()):
            if g != gesture or ch != channel or kind != "start":
                continue
            starts = np.array([step(t) for t in tr])
            rests = np.array([step(t) for t in study.traces.get((s, g, "rest", ch), [])])
            starts, rests = starts[np.isfinite(starts)], rests[np.isfinite(rests)]
            if len(starts) < 5 or len(rests) < 5:
                continue
            lines.append((s, np.median(starts), np.mean(starts > 0), study.auc(starts, rests), len(starts)))
        if not lines:
            continue
        print(f"\n{gesture} / {channel.replace('ppg_', '')}: session, median step, share rising, AUC vs rest (0.5 none, 1 perfect)")
        for s, m, up, a, n in lines:
            print(f"   {s[:34]:34s} n={n:3d}  step {m:+5.2f}  rising {up:4.0%}  AUC {a:.2f}")
        print(f"   -> sessions with a positive median step: {sum(1 for l in lines if l[1] > 0)}/{len(lines)};"
              f" median AUC {np.median([l[3] for l in lines]):.2f}")

# One rule for every session: the green+red+ir steps, trained on all other sessions, judged on the one left out.
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
print("\n=== a single slope rule, held-out sessions (pinch only, steps of all three channels) ===")
data = {}
for (s, g, kind, ch), tr in study.traces.items():
    if g == "pinch":
        data.setdefault((s, kind), {})[ch] = [step(t) for t in tr]
X, y, grp = [], [], []
for (s, kind), by in data.items():
    n = min(len(v) for v in by.values())
    for i in range(n):
        X.append([by[c][i] for c in study.CHANNELS]); y.append(kind == "start"); grp.append(s)
X, y, grp = np.nan_to_num(np.array(X)), np.array(y), np.array(grp)
per = []
for held in np.unique(grp):
    tr, te = grp != held, grp == held
    if y[te].all() or not y[te].any():
        continue
    m = LogisticRegression().fit(X[tr], y[tr])
    per.append((held, roc_auc_score(y[te], m.predict_proba(X[te])[:, 1])))
for held, a in per:
    print(f"   {held[:34]:34s} AUC {a:.2f}")
print(f"   median {np.median([a for _, a in per]):.2f}, worst {min(a for _, a in per):.2f}, best {max(a for _, a in per):.2f}")
