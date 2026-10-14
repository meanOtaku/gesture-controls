"""One-shot held-out test of the 2026-10 PPG pinch-onset techniques on the 2026-10-14 recordings.

Protocol, fixed before the run (do not tune on the result, do not rerun with changed settings):

* Training: only the 26-recording manifest set (the 17 usable recordings), read through load.py's default.
* Test: the 15 recordings of 2026-10-14 (9 pinch, 4 fist, 2 everything_else), used once.
* Techniques, as in ppg-green-onset-experiments-2026-10.md and ppg-rgb-onset-follow-up-2026-10.md (features from
  evaluate_green_onset_60_40.py: causal 2 s median/MAD, zero-order hold on a 40 ms grid from -400 to +880 ms):
    1. green robust step                      (1 feature)
    2. two-stage green step                   (z-score -> sigmoid -> round 1e-5 -> median/MAD; 1 feature)
    3. green step + red/IR quality            (9 features, quality_features)
    4. green/red/IR robust steps              (3 features; the app's rel_z_step idea)
    5. RGB candidate                          (33-sample RGB waveform + 8 red/IR quality + 9 shape = 116 features)
  each as train-only StandardScaler + LogisticRegression(C=1).
* Two training negatives, both frozen:
    A. "as documented": pinch recordings only, controls >= 1.5 s from any mark (rest draws 0-9, scores averaged);
    B. "all other moments": every original recording; pinch_mid, unmarked time, other gestures' starts and middles.
* Pinch starts: marked stretches merged across gaps < 400 ms, at least 200 ms long; 2.5 s before and 1.5 s after.
* Test negatives, each scored separately: everything_else (the whole recording is non-pinch), mid-pinch, unmarked time
  in pinch/fist recordings, fist starts, mid-fist. AUC with 95% intervals from resampling test recordings.
* Continuous detection on every test recording at fixed thresholds 0.5, 0.7, 0.9 (decision at +900 ms, detections at
  least 1.5 s apart, found within +/-600 ms of a marked pinch start).

Usage (from tools/label-trainer): uv run python -I <this> <scripts dir> <output dir>
"""

import glob
import re
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
from load import recordings  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402
from label_trainer.label_train import repair_millisecond_ppg_timestamps  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

GRID = np.arange(-400, 901, 40)  # 33 samples, -400..+880 ms
BEFORE = (GRID >= -400) & (GRID <= -100)
AFTER = (GRID >= 400) & (GRID <= 900)
SECONDS = GRID / 1000.0
CLEAR = 1500
lines = []


def say(text=""):
    print(text)
    lines.append(text)


class study:  # noqa: N801  (the merged-holds rule of study.py, without running that study)
    @staticmethod
    def holds(rec):
        """Marked stretches (start_ms, end_ms, label), merged across gaps under 400 ms, at least 200 ms long."""
        t = rec.timestamps_ns / 1e6
        lab = np.array(rec.raw_labels)
        b = [0, *(np.flatnonzero(lab[1:] != lab[:-1]) + 1), len(lab)]
        merged = []
        for s, e, label in ((t[a], t[z - 1], lab[a]) for a, z in zip(b, b[1:]) if lab[a] != "rest"):
            if merged and merged[-1][2] == label and s - merged[-1][1] < 400:
                merged[-1] = (merged[-1][0], e, label)
            else:
                merged.append((s, e, label))
        return [h for h in merged if h[1] - h[0] >= 200]


# ---- the techniques' signal processing (as evaluate_green_onset_60_40.py) ---------------------------------------------
def robust_signal(times, values):
    out = np.zeros(len(values)); left = 0
    for i, now in enumerate(times):
        while times[left] < now - 2000:
            left += 1
        past = values[left:i]
        if len(past) >= 20:
            median = np.median(past)
            scale = np.median(np.abs(past - median)) * 1.4826
            if scale:
                out[i] = (values[i] - median) / scale
    return out


def two_stage_green(times, values):
    first = np.zeros(len(values)); left = 0
    for i, now in enumerate(times):
        while times[left] < now - 2000:
            left += 1
        past = values[left:i]
        if len(past) >= 20 and (std := past.std()):
            z = (values[i] - past.mean()) / std
            first[i] = round(1 / (1 + np.exp(-np.clip(z, -60, 60))), 5)
    return robust_signal(times, first)


def trace_at(times, signal, at):
    return signal[np.clip(np.searchsorted(times, at + GRID, side="right") - 1, 0, len(times) - 1)]


def quality_features(g, r, ir):
    return [
        g[AFTER].mean() - g[BEFORE].mean(), np.diff(r).std(), np.diff(ir).std(),
        np.abs(np.diff(r)).mean(), np.abs(np.diff(ir)).mean(), np.abs(g - r).mean(),
        np.abs(g - ir).mean(), (r + ir).mean() / 2, (r[AFTER].mean() + ir[AFTER].mean()) / 2,
    ]


def shape_features(trace):
    slope = np.polyfit(SECONDS, trace, 1)[0]
    return [float(np.sqrt(np.mean(np.diff(trace) ** 2))), float(slope), float(trace[-1] - trace[0])]


METHODS = ("1 green robust step", "2 two-stage green", "3 green + red/IR quality", "4 RGB robust steps", "5 RGB candidate")


def method_features(sig, at):
    g, r, i = (trace_at(sig["t"], sig[c], at) for c in ("g", "r", "i"))
    two = trace_at(sig["t"], sig["two"], at)
    step = lambda x: float(x[AFTER].mean() - x[BEFORE].mean())  # noqa: E731
    q = quality_features(g, r, i)
    return {
        METHODS[0]: [step(g)],
        METHODS[1]: [step(two)],
        METHODS[2]: q,
        METHODS[3]: [step(g), step(r), step(i)],
        METHODS[4]: list(g) + list(r) + list(i) + q[1:] + shape_features(g) + shape_features(r) + shape_features(i),
    }


def signals(rec):
    seen = rec.ppg_observed
    t = (rec.timestamps_ns / 1e6)[seen]
    green, red, ir = (rec.channels[c][seen].astype(float) for c in ("ppg_green", "ppg_red", "ppg_ir"))
    return {"t": t, "g": robust_signal(t, green), "r": robust_signal(t, red), "i": robust_signal(t, ir), "two": two_stage_green(t, green)}


# ---- recordings -------------------------------------------------------------------------------------------------------
def usable(rec):
    t = rec.timestamps_ns / 1e6
    return np.all(np.diff(t) >= 0) and (t[-1] - t[0]) < 3_600_000


train_recs = [(n, g, d, r) for n, g, d, r in recordings() if usable(r)]


def load_new():
    folder = Path(sys.argv[1]).resolve().parents[3] / "data" / "recordings" / "2026-10-downloads"
    tmp = Path(tempfile.mkdtemp())
    out = []
    for f in sorted(glob.glob(str(folder / "gesture-dataset-*2026-10-14T*.csv"))):
        name = Path(f).name[len("gesture-dataset-"):-len(".csv")]
        gesture = re.sub(r"-\d{4}-\d\d-\d\dT.*$", "", name)
        lines_ = Path(f).read_text().splitlines()
        fixed = [l if l.startswith("#") or l.startswith("timestamp_ns") else (l + "rest" if l.endswith(",") else l) for l in lines_]
        p = tmp / Path(f).name
        p.write_text("\n".join(fixed) + "\n")
        out.append((name, gesture, "2026-10-14", repair_millisecond_ppg_timestamps(load_recording(p))))
    return out


test_recs = [x for x in load_new() if usable(x[3])]
say(f"training: {len(train_recs)} recordings (manifest set); test: {len(test_recs)} recordings from 2026-10-14 "
    f"({', '.join(f'{g} {sum(1 for x in test_recs if x[1] == g)}' for g in sorted({x[1] for x in test_recs}))})")


def moments(name, gesture, rec, rng, per=20):
    """(kind, time) pairs: starts of the recording's gesture, its middles, unmarked time, all with the timing margins."""
    t = (rec.timestamps_ns / 1e6)[rec.ppg_observed]
    lo, hi = t[0] + 2500, t[-1] - 1500
    holds = study.holds(rec)
    bounds = np.array([b for h in holds for b in (h[0], h[1])])
    inside = lambda x: any(s <= x <= e for s, e, _ in holds)  # noqa: E731
    clear = lambda x: len(bounds) == 0 or np.min(np.abs(bounds - x)) > CLEAR  # noqa: E731
    grid = np.arange(lo, hi, 40.0)
    out = []
    starts = [h[0] for h in holds if lo < h[0] < hi]
    pre = "pinch" if gesture == "pinch" else ("other" if gesture != "everything_else" else "everything_else")
    if gesture == "everything_else":
        pool = list(np.arange(lo, hi, 250.0))
        out += [("everything_else", float(x)) for x in rng.choice(pool, size=min(len(pool), 40), replace=False)]
        return out
    out += [(f"{pre}_start", x) for x in starts]
    mids = [x for x in grid if inside(x) and clear(x)]
    rests = [x for x in grid if not inside(x) and clear(x)]
    for kind, pool in ((f"{pre}_mid", mids), ("unmarked", rests)):
        out += [(kind, float(x)) for x in (rng.choice(pool, size=min(len(pool), per), replace=False) if pool else [])]
    return out


def as_documented_controls(rec, rng):
    """The green study's controls: pinch recordings, >= 1.5 s from any mark (inside holds or not)."""
    t = (rec.timestamps_ns / 1e6)[rec.ppg_observed]
    holds = study.holds(rec)
    starts = [h[0] for h in holds if t[0] + 2500 < h[0] < t[-1] - 1500]
    bounds = np.array([b for h in holds for b in (h[0], h[1])])
    cand = t[(t > t[0] + 2500) & (t < t[-1] - 1500)]
    far = [x for x in cand if len(bounds) and np.min(np.abs(bounds - x)) > CLEAR]
    return list(rng.choice(far, size=min(len(far), max(len(starts), 10)), replace=False)) if far else []


# ---- features --------------------------------------------------------------------------------------------------------
say("computing signals ...")
sig = {n: signals(r) for n, _, _, r in train_recs + test_recs}
rng = np.random.default_rng(7)

train_B = []  # (kind, feats)
for n, g, d, r in train_recs:
    for kind, at in moments(n, g, r, rng):
        train_B.append((kind, method_features(sig[n], at)))
train_A_by_seed = []
for seed in range(10):
    rs = np.random.default_rng(seed)
    rows = []
    for n, g, d, r in train_recs:
        if g != "pinch":
            continue
        t = (r.timestamps_ns / 1e6)[r.ppg_observed]
        starts = [h[0] for h in study.holds(r) if t[0] + 2500 < h[0] < t[-1] - 1500]
        rows += [(1, method_features(sig[n], at)) for at in starts]
        rows += [(0, method_features(sig[n], at)) for at in as_documented_controls(r, rs)]
    train_A_by_seed.append(rows)

test_rows = []  # (rec, gesture, kind, feats)
for n, g, d, r in test_recs:
    for kind, at in moments(n, g, r, rng):
        test_rows.append((n, g, kind, method_features(sig[n], at)))
kinds = {}
for _, _, k, _ in test_rows:
    kinds[k] = kinds.get(k, 0) + 1
say("test moments: " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())))


def fit(X, y):
    return make_pipeline(StandardScaler(), LogisticRegression(max_iter=5000)).fit(np.nan_to_num(X), y)


models = {}
for m in METHODS:
    a_models = []
    for rows in train_A_by_seed:
        X = np.array([f[m] for _, f in rows]); y = np.array([lab for lab, _ in rows])
        a_models.append(fit(X, y))
    XB = np.array([f[m] for _, f in train_B]); yB = np.array([k == "pinch_start" for k, _ in train_B])
    models[m] = {"A as documented": a_models, "B all other moments": [fit(XB, yB)]}


def score(m, train, X):
    return np.mean([mod.predict_proba(np.nan_to_num(X))[:, 1] for mod in models[m][train]], axis=0)


def auc_ci(y, s, g, n=1000):
    if y.all() or not y.any():
        return None
    point = roc_auc_score(y, s)
    recs_u = np.unique(g)
    idx = {r: np.flatnonzero(g == r) for r in recs_u}
    boot_rng = np.random.default_rng(11)
    boot = []
    for _ in range(n):
        pick = np.concatenate([idx[r] for r in boot_rng.choice(recs_u, size=len(recs_u), replace=True)])
        if y[pick].all() or not y[pick].any():
            continue
        boot.append(roc_auc_score(y[pick], s[pick]))
    lo, hi = np.percentile(boot, [2.5, 97.5])
    return f"{point:.2f} [{lo:.2f}-{hi:.2f}]"


NEGS = {
    "everything_else": {"everything_else"},
    "mid-pinch": {"pinch_mid"},
    "unmarked time": {"unmarked"},
    "fist starts": {"other_start"},
    "mid-fist": {"other_mid"},
    "all non-start": {"everything_else", "pinch_mid", "unmarked", "other_start", "other_mid"},
}
for train in ("A as documented", "B all other moments"):
    say(f"\n=== Held-out AUC, pinch start vs each kind of moment, training {train} (95% interval, resampling recordings) ===")
    say(f"{'technique':28s}" + "".join(f"{k:>20s}" for k in NEGS))
    for m in METHODS:
        cells = []
        for negs in NEGS.values():
            use = [row for row in test_rows if row[2] == "pinch_start" or row[2] in negs]
            X = np.array([row[3][m] for row in use]); y = np.array([row[2] == "pinch_start" for row in use])
            g = np.array([row[0] for row in use])
            cells.append(auc_ci(y, score(m, train, X), g) or "n/a")
        say(f"{m:28s}" + "".join(f"{c:>20s}" for c in cells))

# ---- continuous detection (training B models) ------------------------------------------------------------------------
say("\n=== Continuous detection on the 2026-10-14 recordings, training B, decision at +900 ms ===")
say(f"{'technique':28s}{'thr':>5s}{'pinch found':>16s}{'false/min pinch':>17s}{'false/min fist':>16s}{'false/min everything_else':>27s}")
for m in METHODS:
    for th in (0.5, 0.7, 0.9):
        found = total = 0
        false = {"pinch": 0, "fist": 0, "everything_else": 0}
        minutes = {"pinch": 0.0, "fist": 0.0, "everything_else": 0.0}
        for n, g, d, r in test_recs:
            s = sig[n]
            lo, hi = s["t"][0] + 2500, s["t"][-1] - 1500
            ticks = np.arange(lo + 900, hi + 900, 80.0)
            X = np.array([method_features(s, t - 900)[m] for t in ticks])
            sc = score(m, "B all other moments", X)
            starts = [h[0] for h in study.holds(r) if lo < h[0] < hi] if g == "pinch" else []
            minutes[g] += (hi - lo) / 60000.0
            last, matched = -1e18, set()
            for t, v in zip(ticks, sc):
                if v >= th and t - last >= 1500:
                    last = t
                    T = t - 900
                    near = [k for k, s0 in enumerate(starts) if abs(s0 - T) <= 600 and k not in matched]
                    if near:
                        matched.add(near[0])
                    else:
                        false[g] += 1
            found += len(matched); total += len(starts)
        say(f"{m:28s}{th:>5.1f}{f'{found}/{total} ({found / max(total, 1):.0%})':>16s}"
            f"{false['pinch'] / minutes['pinch']:>17.1f}{false['fist'] / minutes['fist']:>16.1f}{false['everything_else'] / minutes['everything_else']:>27.1f}")

(OUT / "heldout-2026-10-14-report.txt").write_text("\n".join(lines) + "\n")
