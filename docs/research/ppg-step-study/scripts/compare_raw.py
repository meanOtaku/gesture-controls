"""Same events, same held-out sessions: raw PPG versus the normalised step."""
import sys
import numpy as np
sys.path.insert(0, sys.argv[1])
import study  # noqa: E402
from load import recordings  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

grid = study.grid
B = (grid >= -400) & (grid <= -100)
A = (grid >= 400) & (grid <= 900)
rng = np.random.default_rng(7)

rows = []  # (session, is_start, raw_level_after[3], raw_step[3], norm_step[3])
for name, gesture, day, rec in recordings():
    if gesture != "pinch":
        continue
    t_all = rec.timestamps_ns / 1e6
    if not np.all(np.diff(t_all) >= 0) or (t_all[-1] - t_all[0]) > 3_600_000:
        continue
    times = t_all[rec.ppg_observed]
    hs = study.holds(rec)
    # Only moments with 2.5 s of past (the normalisation's 2 s and the step's 0.5 s) and 1.5 s after, for every feature set.
    starts = [h[0] for h in hs if times[0] + 2500 < h[0] < times[-1] - 1500]
    bounds = np.array(starts + [h[1] for h in hs])
    cand = times[(times > times[0] + 2500) & (times < times[-1] - 1500)]
    far = [c for c in cand if np.min(np.abs(bounds - c)) > 1500]
    controls = list(rng.choice(far, size=min(len(far), max(len(starts), 10)), replace=False)) if far else []
    raw = {c: rec.channels[c][rec.ppg_observed] for c in study.CHANNELS}
    norm = {c: study.normalised(times, raw[c]) for c in study.CHANNELS}
    for is_start, moments in ((True, starts), (False, controls)):
        for at in moments:
            lvl, rstep, nstep = [], [], []
            for c in study.CHANNELS:
                rt = np.interp(at + grid, times, raw[c])
                nt = np.interp(at + grid, times, np.nan_to_num(norm[c]))
                lvl.append(rt[A].mean()); rstep.append(rt[A].mean() - rt[B].mean()); nstep.append(nt[A].mean() - nt[B].mean())
            rows.append((name, is_start, lvl, rstep, nstep))

groups = np.array([r[0] for r in rows]); y = np.array([r[1] for r in rows])
def loso(X, model):
    per = []
    for held in np.unique(groups):
        tr, te = groups != held, groups == held
        if y[te].all() or not y[te].any():
            continue
        p = model().fit(X[tr], y[tr]).predict_proba(X[te])[:, 1]
        per.append(roc_auc_score(y[te], p))
    return np.median(per), min(per), len(per)

sets = {
    "raw PPG level (what a model on raw values sees)": np.array([r[2] for r in rows]),
    "raw PPG step (after minus before, raw counts)": np.array([r[3] for r in rows]),
    "normalised step (the slope idea)": np.array([r[4] for r in rows]),
}
models = {"logistic": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
          "boosted trees": lambda: HistGradientBoostingClassifier(max_depth=3, random_state=0)}
print(f"pinch start vs rest, {int(y.sum())} starts / {int((~y).sum())} rest moments, each session held out in turn")
for label, X in sets.items():
    for mname, m in models.items():
        med, worst, n = loso(X, m)
        print(f"  {label:50s} {mname:13s} median AUC {med:.2f}  worst {worst:.2f}  ({n} sessions)")
