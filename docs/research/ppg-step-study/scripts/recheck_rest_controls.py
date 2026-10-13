"""How many of the study's rest controls were inside a gesture, and does the pinch step hold against true rest?"""
import sys
import numpy as np
sys.path.insert(0, sys.argv[1])
import study  # noqa: E402  (reruns extraction; gives holds, normalised, grid)
from load import recordings  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402

grid = study.grid
B = (grid >= -400) & (grid <= -100); A = (grid >= 400) & (grid <= 900)
rng = np.random.default_rng(7)
inside_total = outside_total = 0
rows = []  # (session, kind, steps[3])
for name, gesture, day, rec in recordings():
    t_all = rec.timestamps_ns / 1e6
    if not np.all(np.diff(t_all) >= 0) or (t_all[-1] - t_all[0]) > 3_600_000:
        continue
    times = t_all[rec.ppg_observed]
    hs = study.holds(rec)
    bounds = np.array([b for h in hs for b in (h[0], h[1])])
    inside = lambda c: any(s <= c <= e for s, e, _ in hs)
    cand = times[(times > times[0] + 2500) & (times < times[-1] - 1500)]
    old_far = [c for c in cand if len(bounds) == 0 or np.min(np.abs(bounds - c)) > 1500]
    inside_total += sum(inside(c) for c in old_far); outside_total += sum(not inside(c) for c in old_far)
    if gesture != "pinch":
        continue
    starts = [h[0] for h in hs if times[0] + 2500 < h[0] < times[-1] - 1500]
    rest = [c for c in old_far if not inside(c)]
    mid = [c for c in old_far if inside(c)]
    z = {c: np.nan_to_num(study.normalised(times, rec.channels[c][rec.ppg_observed])) for c in study.CHANNELS}
    def steps(at):
        return [np.interp(at + grid, times, z[c])[A].mean() - np.interp(at + grid, times, z[c])[B].mean() for c in study.CHANNELS]
    for kind, moments in (("start", starts), ("rest", rest), ("mid", mid)):
        pick = moments if kind == "start" else list(rng.choice(moments, size=min(len(moments), 20), replace=False)) if moments else []
        rows += [(name, kind, steps(at)) for at in pick]

print(f"old rest controls (all gestures): {inside_total} inside a gesture, {outside_total} outside -> {inside_total / (inside_total + outside_total):.0%} were not rest")
for negative in ("rest", "mid"):
    data = [(s, k, x) for s, k, x in rows if k in ("start", negative)]
    g = np.array([d[0] for d in data]); y = np.array([d[1] == "start" for d in data]); X = np.array([d[2] for d in data])
    per = []
    for held in np.unique(g):
        te = g == held
        if y[te].all() or not y[te].any():
            continue
        per.append(roc_auc_score(y[te], LogisticRegression().fit(X[~te], y[~te]).predict_proba(X[te])[:, 1]))
    n_neg = int((~y).sum())
    print(f"pinch start vs {'true rest (unlabelled time)' if negative == 'rest' else 'middle of a held pinch'}: "
          f"{int(y.sum())} starts, {n_neg} negatives, judged on {len(per)} sessions -> median AUC {np.median(per):.2f}, worst {min(per):.2f}" if per else f"{negative}: no session has both")
    for kind in ("start", negative):
        v = np.array([x[0] for s, k, x in rows if k == kind])
        print(f"   green step, {kind:5s}: median {np.median(v):+.2f}, rising {np.mean(v > 0):.0%} (n={len(v)})")
