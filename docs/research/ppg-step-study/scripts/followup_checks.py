"""The open questions about the PPG onset step, tested as far as the current recordings allow.

1. negatives that are not mid-pinch: unmarked time ("rest"), fist and thumbs-up starts, and their mid-gesture moments;
2. continuous detection: the rule run causally over whole held-out recordings (found / missed / false per minute);
3. decision delay: deciding 300, 500, 700 or 900 ms after the start;
4. motion: a motion-only detector on the same events, PPG + motion, and the PPG step on the calmest vs busiest starts;
5. days: train on 2026-10-11, test on the other days;
6. uncertainty: 95% intervals by resampling whole recordings;
8. mark timing: each marked pinch start against when the gyroscope shows the hand starting to move;
9. fist and thumbs-up: start vs their own mid-gesture moments.

Item 7 (a held-back set no one has analysed) cannot be done on this data. Scores come from leave-one-recording-out models
(standardised features, logistic regression), pooled over recordings: the step is in units of each session's own spread,
so one scale is meaningful across recordings.

Usage (from tools/label-trainer): uv run --with matplotlib python -I <this> <scripts dir> <output dir>
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
import study  # noqa: E402
from load import recordings  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

CH = study.CHANNELS
DELAYS = (300, 500, 700, 900)
CLEAR_MS = 1500
rng = np.random.default_rng(7)
lines = []


def say(text=""):
    print(text)
    lines.append(text)


def mean_between(t, x, lo, hi):
    sel = (t >= lo) & (t <= hi)
    return float(np.nanmean(x[sel])) if sel.sum() else np.nan


# ---- data ------------------------------------------------------------------------------------------------------------
recs = []
for name, gesture, day, rec in recordings():
    t_all = rec.timestamps_ns / 1e6
    if not np.all(np.diff(t_all) >= 0) or (t_all[-1] - t_all[0]) > 3_600_000:
        continue
    pt = t_all[rec.ppg_observed]
    z = {c: study.normalised(pt, rec.channels[c][rec.ppg_observed].astype(float)) for c in CH}
    it = t_all[rec.orient_observed]
    acc = np.linalg.norm(np.stack([rec.channels[c][rec.orient_observed] for c in ("accel_x", "accel_y", "accel_z")], 1), axis=1)
    gyr = np.linalg.norm(np.stack([rec.channels[c][rec.orient_observed] for c in ("gyro_x", "gyro_y", "gyro_z")], 1), axis=1)
    holds = study.holds(rec)
    recs.append(dict(name=name, gesture=gesture, day=day, pt=pt, z=z, it=it, acc=acc, gyr=gyr, holds=holds,
                     t0=pt[0] + 2500, t1=pt[-1] - 1500))


def inside(r, t):
    return any(s <= t <= e for s, e, _ in r["holds"])


def clear_of_bounds(r, t):
    b = [x for h in r["holds"] for x in (h[0], h[1])]
    return not b or min(abs(x - t) for x in b) > CLEAR_MS


def ppg_feats(r, T, d):
    out = []
    for c in CH:
        before = mean_between(r["pt"], r["z"][c], T - 400, T - 100)
        after = mean_between(r["pt"], r["z"][c], T + max(d - 400, 0), T + d)
        out.append(after - before)
    return out


def imu_feats(r, T, d):
    out = []
    for x in (r["acc"], r["gyr"]):
        base = mean_between(r["it"], x, T - 1400, T - 400)
        now = mean_between(r["it"], x, T, T + d)
        sel = (r["it"] >= T) & (r["it"] <= T + d)
        out += [now - base, float(np.std(x[sel])) if sel.sum() > 2 else np.nan]
    return out


rows = []  # dict(rec, gesture, day, kind, T)
for r in recs:
    starts = [h[0] for h in r["holds"] if r["t0"] < h[0] < r["t1"]]
    kind_start = "pinch_start" if r["gesture"] == "pinch" else "other_start"
    rows += [dict(rec=r["name"], gesture=r["gesture"], day=r["day"], kind=kind_start, T=T) for T in starts]
    grid = np.arange(r["t0"], r["t1"], 40.0)
    mids = [t for t in grid if inside(r, t) and clear_of_bounds(r, t)]
    rests = [t for t in grid if not inside(r, t) and clear_of_bounds(r, t)]
    kind_mid = "pinch_mid" if r["gesture"] == "pinch" else "other_mid"
    for kind, pool in ((kind_mid, mids), ("rest", rests)):
        pick = rng.choice(pool, size=min(len(pool), 20), replace=False) if pool else []
        rows += [dict(rec=r["name"], gesture=r["gesture"], day=r["day"], kind=kind, T=float(T)) for T in pick]
by_name = {r["name"]: r for r in recs}
for row in rows:
    r = by_name[row["rec"]]
    for d in DELAYS:
        row[f"ppg{d}"] = ppg_feats(r, row["T"], d)
        row[f"imu{d}"] = imu_feats(r, row["T"], d)

counts = {k: sum(1 for x in rows if x["kind"] == k) for k in ("pinch_start", "pinch_mid", "rest", "other_start", "other_mid")}
say("moments: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
say(f"recordings: {len(recs)} ({sum(r['gesture'] == 'pinch' for r in recs)} pinch); 'rest' = unmarked time >= 1.5 s from any mark")


# ---- pooled leave-one-recording-out scoring --------------------------------------------------------------------------
def model():
    return make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))


def features(row, kind):
    if kind == "ppg":
        return row[f"ppg{D}"]
    if kind == "imu":
        return row[f"imu{D}"]
    return row[f"ppg{D}"] + row[f"imu{D}"]


def loso_scores(pos, negs, feat):
    """Each recording's rows scored by a model trained on the others; returns (y, score, rec) pooled."""
    use = [x for x in rows if x["kind"] == pos or x["kind"] in negs]
    X = np.nan_to_num(np.array([features(x, feat) for x in use], float))
    y = np.array([x["kind"] == pos for x in use])
    g = np.array([x["rec"] for x in use])
    s = np.full(len(use), np.nan)
    for held in np.unique(g):
        te = g == held
        if y[~te].all() or not y[~te].any():
            continue
        s[te] = model().fit(X[~te], y[~te]).predict_proba(X[te])[:, 1]
    ok = np.isfinite(s)
    return y[ok], s[ok], g[ok]


def auc_ci(y, s, g, n=1000):
    """Pooled AUC and a 95% interval from resampling whole recordings."""
    if y.all() or not y.any():
        return np.nan, np.nan, np.nan
    point = roc_auc_score(y, s)
    recs_u = np.unique(g)
    idx = {r: np.flatnonzero(g == r) for r in recs_u}
    boot = []
    for _ in range(n):
        pick = np.concatenate([idx[r] for r in rng.choice(recs_u, size=len(recs_u), replace=True)])
        if y[pick].all() or not y[pick].any():
            continue
        boot.append(roc_auc_score(y[pick], s[pick]))
    lo, hi = np.percentile(boot, [2.5, 97.5])
    return point, lo, hi


def fmt(a):
    p, lo, hi = a
    return "  n/a" if not np.isfinite(p) else f"{p:.2f} [{lo:.2f}-{hi:.2f}]"


NEGS = {
    "mid-pinch": {"pinch_mid"},
    "unmarked time (rest)": {"rest"},
    "fist / thumbs-up starts": {"other_start"},
    "fist / thumbs-up mid-gesture": {"other_mid"},
    "all non-start moments": {"pinch_mid", "rest", "other_start", "other_mid"},
}

say("\n=== 1, 3, 6. Pinch start against each kind of other moment, by decision delay (PPG steps only) ===")
say("AUC [95% interval, resampling recordings]; 0.5 = chance")
say(f"{'other moment':32s}" + "".join(f"{f'decide at +{d} ms':>22s}" for d in DELAYS))
for label, negs in NEGS.items():
    cells = []
    for D in DELAYS:
        cells.append(fmt(auc_ci(*loso_scores("pinch_start", negs, "ppg"))))
    say(f"{label:32s}" + "".join(f"{c:>22s}" for c in cells))

D = 900
say("\n=== 4. Is the PPG step just motion? (decide at +900 ms) ===")
say(f"{'other moment':32s}{'PPG only':>20s}{'motion only':>20s}{'PPG + motion':>20s}")
for label, negs in NEGS.items():
    say(f"{label:32s}" + "".join(f"{fmt(auc_ci(*loso_scores('pinch_start', negs, f))):>20s}" for f in ("ppg", "imu", "both")))

# PPG step on the calmest vs busiest pinch starts (gyroscope change), against all non-start moments.
y, s, g = loso_scores("pinch_start", NEGS["all non-start moments"], "ppg")
use = [x for x in rows if x["kind"] == "pinch_start" or x["kind"] in NEGS["all non-start moments"]]
motion = np.array([x["imu900"][2] for x in use])  # gyroscope: mean during minus before
kinds = np.array([x["kind"] for x in use])
starts_motion = motion[kinds == "pinch_start"]
cut = np.nanmedian(starts_motion)
for half, keep in (("calmest half of pinch starts", (kinds != "pinch_start") | (motion <= cut)),
                   ("busiest half of pinch starts", (kinds != "pinch_start") | (motion > cut))):
    keep = keep[: len(y)]
    say(f"PPG-only score, {half} vs all non-start moments: {fmt(auc_ci(y[keep], s[keep], g[keep]))}")
green = np.array([x["ppg900"][0] for x in use if x["kind"] == "pinch_start"])
ok = np.isfinite(green) & np.isfinite(starts_motion)
from scipy.stats import spearmanr  # noqa: E402
rho, p = spearmanr(green[ok], starts_motion[ok])
say(f"Across pinch starts, green step vs gyroscope change: Spearman rho {rho:+.2f} (p={p:.3f}, n={ok.sum()})")

say("\n=== 5. Train on 2026-10-11, test on the other days (PPG only, +900 ms, against all non-start moments) ===")
use = [x for x in rows if x["kind"] == "pinch_start" or x["kind"] in NEGS["all non-start moments"]]
X = np.nan_to_num(np.array([x["ppg900"] for x in use], float))
y = np.array([x["kind"] == "pinch_start" for x in use])
day = np.array([x["day"] for x in use])
tr = day == "2026-10-11"
m = model().fit(X[tr], y[tr])
for other in sorted(set(day) - {"2026-10-11"}):
    te = day == other
    if y[te].all() or not y[te].any():
        say(f"  {other}: only one class present ({int(y[te].sum())} starts, {int((~y[te]).sum())} others)")
        continue
    say(f"  {other}: AUC {roc_auc_score(y[te], m.predict_proba(X[te])[:, 1]):.2f} ({int(y[te].sum())} pinch starts, {int((~y[te]).sum())} others, "
        f"{len(set(x['rec'] for x, k in zip(use, te) if k))} recordings)")

say("\n=== 9. Fist and thumbs-up: start vs their own mid-gesture moments (PPG only, +900 ms) ===")
for gesture in ("fist", "thumbs_up"):
    use = [x for x in rows if x["gesture"] == gesture and x["kind"] in ("other_start", "other_mid")]
    X = np.nan_to_num(np.array([x["ppg900"] for x in use], float))
    y = np.array([x["kind"] == "other_start" for x in use])
    g = np.array([x["rec"] for x in use])
    s = np.full(len(use), np.nan)
    for held in np.unique(g):
        te = g == held
        if y[~te].all() or not y[~te].any():
            continue
        s[te] = model().fit(X[~te], y[~te]).predict_proba(X[te])[:, 1]
    ok = np.isfinite(s)
    say(f"  {gesture}: {fmt(auc_ci(y[ok], s[ok], g[ok]))} ({int(y.sum())} starts, {int((~y).sum())} mid, {len(np.unique(g))} recordings)")

say("\n=== 8. Mark timing: marked pinch start vs the gyroscope showing the hand start to move ===")
offsets, undetected = [], 0
for x in rows:
    if x["kind"] != "pinch_start":
        continue
    r = by_name[x["rec"]]
    T = x["T"]
    base = r["gyr"][(r["it"] >= T - 1500) & (r["it"] <= T - 500)]
    if len(base) < 10:
        continue
    med = np.median(base)
    thr = med + max(4 * 1.4826 * np.median(np.abs(base - med)), 0.05)
    sel = (r["it"] >= T - 500) & (r["it"] <= T + 1000)
    t, v = r["it"][sel], r["gyr"][sel]
    above = np.flatnonzero((v[:-1] > thr) & (v[1:] > thr))
    if len(above):
        offsets.append(t[above[0]] - T)
    else:
        undetected += 1
offsets = np.array(offsets)
say(f"  movement found for {len(offsets)} of {len(offsets) + undetected} pinch starts")
say(f"  gyroscope onset minus mark: median {np.median(offsets):+.0f} ms, middle half {np.percentile(offsets, 25):+.0f} to "
    f"{np.percentile(offsets, 75):+.0f} ms; within +/-200 ms: {np.mean(np.abs(offsets) <= 200):.0%}")

# ---- 2. continuous detection -----------------------------------------------------------------------------------------
say("\n=== 2. Continuous detection over whole held-out recordings (PPG only, decide at +900 ms) ===")
all_use = [x for x in rows if x["kind"] == "pinch_start" or x["kind"] in NEGS["all non-start moments"]]
Xall = np.nan_to_num(np.array([x["ppg900"] for x in all_use], float))
yall = np.array([x["kind"] == "pinch_start" for x in all_use])
gall = np.array([x["rec"] for x in all_use])
THRESHOLDS = (0.5, 0.7, 0.8, 0.9)
tally = {th: dict(found=0, starts=0, false_pinch=0, false_other=0, false_rest=0, min_pinch=0.0, min_other=0.0, min_rest=0.0) for th in THRESHOLDS}
for r in recs:
    tr = gall != r["name"]
    m = model().fit(Xall[tr], yall[tr])
    ticks = np.arange(r["t0"] + 900, r["t1"] + 900, 80.0)
    feats = np.nan_to_num(np.array([ppg_feats(r, t - 900, 900) for t in ticks], float))
    score = m.predict_proba(feats)[:, 1]
    starts = [h[0] for h in r["holds"] if r["t0"] < h[0] < r["t1"]] if r["gesture"] == "pinch" else []
    minutes = (r["t1"] - r["t0"]) / 60000.0
    rest_minutes = sum(1 for t in np.arange(r["t0"], r["t1"], 40.0) if not inside(r, t)) * 0.04 / 60.0
    for th in THRESHOLDS:
        tl = tally[th]
        detections, last = [], -1e18
        for t, sc in zip(ticks, score):
            if sc >= th and t - last >= 1500:
                detections.append(t - 900)
                last = t
        matched = set()
        for T in detections:
            near = [i for i, s0 in enumerate(starts) if abs(s0 - T) <= 600 and i not in matched]
            if near:
                matched.add(near[0])
            elif r["gesture"] == "pinch":
                tl["false_pinch"] += 1
            else:
                tl["false_other"] += 1
            if not near and not inside(r, T):
                tl["false_rest"] += 1
        tl["found"] += len(matched)
        tl["starts"] += len(starts)
        if r["gesture"] == "pinch":
            tl["min_pinch"] += minutes
        else:
            tl["min_other"] += minutes
        tl["min_rest"] += rest_minutes
say(f"{'threshold':>10s}{'pinch starts found':>22s}{'false/min, pinch recs':>24s}{'false/min, fist+thumbs recs':>30s}{'false/min in unmarked time':>30s}")
for th, tl in tally.items():
    say(f"{th:>10.1f}{f'{tl['found']}/{tl['starts']} ({tl['found'] / max(tl['starts'], 1):.0%})':>22s}"
        f"{tl['false_pinch'] / max(tl['min_pinch'], 1e-9):>24.1f}{tl['false_other'] / max(tl['min_other'], 1e-9):>30.1f}"
        f"{tl['false_rest'] / max(tl['min_rest'], 1e-9):>30.1f}")
say("(a detection claims a start 900 ms before it fires; it counts as found within +/-600 ms of a marked pinch start,")
say(" one detection per start; detections at least 1.5 s apart. Fist/thumbs-up recordings contain no pinch, so every")
say(" detection there is false. Unmarked time is short in these recordings, so its rate is rough.)")

say("\n7. A held-back set no one has analysed: not possible on this data; every recording has been used.")
(OUT / "followup-report.txt").write_text("\n".join(lines) + "\n")
