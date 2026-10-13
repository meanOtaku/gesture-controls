"""Is the PPG slope/morphology around a gesture consistent from session to session?

Event-locked analysis on the Downloads recordings (camera/manual marks give the boundaries). Everything causal: each
sample is compared with the median of the 2 s before it and divided by the spread (MAD) of those 2 s, so a session's
absolute PPG level and contact strength drop out. Outputs tables and one figure.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, sys.argv[1])
OUT = Path(sys.argv[2])
from load import recordings  # noqa: E402

CHANNELS = ("ppg_green", "ppg_red", "ppg_ir")
BASELINE_MS = 2000
MERGE_GAP_MS = 400
MIN_HOLD_MS = 200
PRE_MS, POST_MS = 500, 1500
SEARCH = (-200, 1200)  # where the peak may be, around the marked boundary
CONTROL_CLEARANCE_MS = 1500
rng = np.random.default_rng(7)


def holds(rec):
    """Merged gesture stretches (start_ms, end_ms, label) on the recording's own clock."""
    t = rec.timestamps_ns / 1e6
    lab = np.array(rec.raw_labels)
    b = [0, *(np.flatnonzero(lab[1:] != lab[:-1]) + 1), len(lab)]
    raw = [(t[a], t[e - 1], lab[a]) for a, e in zip(b, b[1:]) if lab[a] != "rest"]
    merged = []
    for s, e, l in raw:
        if merged and merged[-1][2] == l and s - merged[-1][1] < MERGE_GAP_MS:
            merged[-1] = (merged[-1][0], e, l)
        else:
            merged.append((s, e, l))
    return [h for h in merged if h[1] - h[0] >= MIN_HOLD_MS]


def normalised(times, x):
    """Causal: (x - median of the past 2 s) / MAD of the past 2 s, per sample; NaN until 2 s of past exist."""
    out = np.full(len(x), np.nan)
    lo = 0
    for i in range(len(x)):
        while times[lo] < times[i] - BASELINE_MS:
            lo += 1
        past = x[lo:i]
        if i == 0 or times[i] - times[0] < BASELINE_MS or len(past) < 20:
            continue
        med = np.median(past)
        mad = np.median(np.abs(past - med)) * 1.4826
        if mad > 0:
            out[i] = (x[i] - med) / mad
    return out


def morphology(times, z, at):
    """Shape of the excursion after `at`: signed, in MAD units and milliseconds. None when there is no usable data."""
    win = (times >= at + SEARCH[0]) & (times <= at + SEARCH[1]) & np.isfinite(z)
    if win.sum() < 10:
        return None
    idx = np.flatnonzero(win)
    peak = idx[np.argmax(np.abs(z[idx]))]
    sign = np.sign(z[peak]) or 1.0
    prominence = abs(z[peak])
    # Onset: the last sample before the peak still within 1 MAD of the baseline (or the search start).
    before = idx[idx < peak]
    quiet = before[np.abs(z[before]) < 1.0]
    onset = quiet[-1] if len(quiet) else idx[0]
    after = np.flatnonzero((times > times[peak]) & (times <= at + POST_MS) & np.isfinite(z))
    half = after[np.abs(z[after]) < prominence / 2]
    recovery = half[0] if len(half) else None
    rise_ms = times[peak] - times[onset]
    d = np.diff(z[onset:peak + 1]) / np.maximum(np.diff(times[onset:peak + 1]) / 1000.0, 1e-3)
    return {
        "sign": sign,
        "prominence": prominence,
        "onset_to_peak_ms": rise_ms,
        "rise_slope": (prominence / (rise_ms / 1000.0)) if rise_ms > 0 else np.nan,
        "max_slope": float(np.max(np.abs(d))) if len(d) else np.nan,
        "peak_delay_ms": times[peak] - at,
        "fall_ms": (times[recovery] - times[peak]) if recovery is not None else np.nan,
    }


def locked_trace(times, z, at, grid):
    return np.interp(at + grid, times, np.nan_to_num(z, nan=0.0), left=np.nan, right=np.nan)


grid = np.arange(-PRE_MS, POST_MS + 1, 40.0)
rows = []  # (session, gesture, day, kind, channel, features)
traces = {}  # (session, gesture, kind, channel) -> list of traces
rest_rate = []

for name, gesture, day, rec in recordings():
    t_all = rec.timestamps_ns / 1e6
    if not np.all(np.diff(t_all) >= 0) or (t_all[-1] - t_all[0]) > 3_600_000:
        print(f"skipping {name}: its timestamps are not usable")
        continue
    ppg = rec.ppg_observed
    times = t_all[ppg]
    hs = holds(rec)
    starts = [h[0] for h in hs]
    ends = [h[1] for h in hs]
    boundaries = np.array(starts + ends)
    # Controls: random rest moments well away from any boundary, as many as there are starts.
    candidates = times[(times > times[0] + BASELINE_MS + PRE_MS) & (times < times[-1] - POST_MS)]
    far = [c for c in candidates if np.min(np.abs(boundaries - c)) > CONTROL_CLEARANCE_MS] if len(boundaries) else list(candidates)
    controls = list(rng.choice(far, size=min(len(far), max(len(starts), 10)), replace=False)) if far else []
    for channel in CHANNELS:
        x = rec.channels[channel][ppg]
        z = normalised(times, x)
        for kind, moments in (("start", starts), ("end", ends), ("rest", controls)):
            for at in moments:
                f = morphology(times, z, at)
                if f is None:
                    continue
                rows.append((name, gesture, day, kind, channel, f))
                traces.setdefault((name, gesture, kind, channel), []).append(locked_trace(times, z, at, grid))
        if channel == "ppg_green":
            # How often a 4-MAD excursion happens at rest: what a threshold tracker would fire on without gestures.
            rest = np.ones(len(times), bool)
            for s, e, _ in hs:
                rest &= ~((times > s - 1000) & (times < e + 1000))
            finite = rest & np.isfinite(z)
            crossings = np.flatnonzero((np.abs(z[1:]) >= 4) & (np.abs(z[:-1]) < 4) & finite[1:])
            minutes = finite.sum() / 25.0 / 60.0
            rest_rate.append((name, len(crossings) / minutes if minutes > 0 else np.nan))

sessions = sorted({r[0] for r in rows})
print(f"\n{len(sessions)} sessions, {sum(1 for r in rows if r[3]=='start' and r[4]=='ppg_green')} marked starts, "
      f"{sum(1 for r in rows if r[3]=='rest' and r[4]=='ppg_green')} rest controls (green channel)\n")

FEATURES = ("prominence", "onset_to_peak_ms", "rise_slope", "max_slope", "peak_delay_ms", "fall_ms")


def auc(pos, neg):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return np.nan
    ranks = np.argsort(np.argsort(np.concatenate([pos, neg]))) + 1
    return (ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


report = []
for channel in CHANNELS:
    report.append(f"\n=== {channel} ===")
    # 1. Does a gesture start look different from rest, in each session on its own?
    report.append("per-session AUC, gesture start vs rest (0.5 = no difference, 1 = always larger):")
    report.append(f"{'session':44s} " + " ".join(f"{f[:13]:>13s}" for f in FEATURES) + "   +sign")
    for s in sessions:
        st = [r[5] for r in rows if r[0] == s and r[3] == "start" and r[4] == channel]
        rs = [r[5] for r in rows if r[0] == s and r[3] == "rest" and r[4] == channel]
        if len(st) < 5 or len(rs) < 5:
            continue
        aucs = [auc([f[k] for f in st], [f[k] for f in rs]) for k in FEATURES]
        pos = np.mean([f["sign"] > 0 for f in st])
        report.append(f"{s[:44]:44s} " + " ".join(f"{a:13.2f}" for a in aucs) + f"   {pos:5.0%}")
    # 2. Consistency: spread of session medians vs spread within sessions, per gesture.
    report.append("\nconsistency of gesture starts (between-session spread / within-session spread; < 1 means sessions agree):")
    for gesture in sorted({r[1] for r in rows}):
        per = {}
        for s in sessions:
            st = [r[5] for r in rows if r[0] == s and r[1] == gesture and r[3] == "start" and r[4] == channel]
            if len(st) >= 5:
                per[s] = st
        if len(per) < 2:
            continue
        line = []
        for k in FEATURES:
            meds = [np.nanmedian([f[k] for f in v]) for v in per.values()]
            iqrs = [np.subtract(*np.nanpercentile([f[k] for f in v], [75, 25])) for v in per.values()]
            between = np.subtract(*np.nanpercentile(meds, [75, 25])) if len(meds) > 2 else abs(meds[0] - meds[1])
            within = np.nanmedian(iqrs)
            line.append(f"{k}={between / within if within else np.nan:.2f} (median {np.nanmedian(meds):.1f})")
        signs = [np.mean([f["sign"] > 0 for f in v]) for v in per.values()]
        report.append(f"  {gesture} ({len(per)} sessions): " + ", ".join(line))
        report.append(f"      share of starts that rise, per session: {', '.join(f'{p:.0%}' for p in signs)}")

# 3. Leave-one-session-out: train on the other sessions, test on the held-out one.
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

def matrix(kinds, channel_set=CHANNELS):
    keyed = {}
    for s, g, d, kind, ch, f in rows:
        if kind not in kinds or ch not in channel_set:
            continue
        keyed.setdefault((s, g, kind), {}).setdefault(ch, []).append(f)
    X, y, groups, gest, days = [], [], [], [], []
    day_of = {r[0]: r[2] for r in rows}
    for (s, g, kind), by_ch in keyed.items():
        n = min(len(v) for v in by_ch.values())
        for i in range(n):
            vec = []
            for ch in channel_set:
                f = by_ch[ch][i]
                vec += [f["sign"] * f["prominence"], f["onset_to_peak_ms"], f["rise_slope"], f["max_slope"], f["peak_delay_ms"], f["fall_ms"]]
            X.append(vec); y.append(kind); groups.append(s); gest.append(g); days.append(day_of[s])
    return np.nan_to_num(np.array(X, float), nan=-1.0), np.array(y), np.array(groups), np.array(gest), np.array(days)


def loso(X, labels, groups, positive, model):
    scores, truth, per = [], [], []
    for held in np.unique(groups):
        train, test = groups != held, groups == held
        ytr, yte = labels[train] == positive, labels[test] == positive
        if ytr.all() or not ytr.any() or yte.all() or not yte.any():
            continue
        m = model().fit(X[train], ytr)
        p = m.predict_proba(X[test])[:, 1]
        per.append(roc_auc_score(yte, p)); scores += list(p); truth += list(yte)
    return roc_auc_score(truth, scores), per

report.append("\n=== held-out sessions (train on the others, test on the one left out) ===")
for label, chans in (("green only", ("ppg_green",)), ("all three channels", CHANNELS)):
    X, y, g, _, _ = matrix({"start", "rest"}, chans)
    for mname, model in (("logistic", lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))),
                         ("boosted trees", lambda: HistGradientBoostingClassifier(max_depth=3, random_state=0))):
        pooled, per = loso(X, y, g, "start", model)
        report.append(f"gesture start vs rest, {label}, {mname}: AUC {pooled:.2f} (per session median {np.median(per):.2f}, worst {min(per):.2f}, best {max(per):.2f}, {len(per)} sessions)")
X, y, g, gest, days = matrix({"start"}, CHANNELS)
keep = np.isin(gest, ["pinch", "fist"])
pooled, per = loso(X[keep], gest[keep], days[keep], "pinch", lambda: HistGradientBoostingClassifier(max_depth=3, random_state=0))
report.append(f"pinch vs fist starts, a whole day held out (each session holds one gesture): AUC {pooled:.2f} (per day {', '.join(f'{a:.2f}' for a in per)})")

report.append("\n=== how often a 4-MAD excursion happens at rest (green), per minute ===")
report.append(", ".join(f"{r:.1f}" for _, r in rest_rate) + f"  (median {np.nanmedian([r for _, r in rest_rate]):.1f}/min)")

text = "\n".join(report)
print(text)
(OUT / "report.txt").write_text(text)

# Figure: each session's mean green trace around gesture starts, and rest controls.
import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

gestures = [g for g in ("pinch", "fist", "thumbs_up") if any(k[1] == g for k in traces)]
fig, axes = plt.subplots(len(gestures), 3, figsize=(15, 3.6 * len(gestures)), sharex=True, squeeze=False)
for row, gesture in enumerate(gestures):
    for col, channel in enumerate(CHANNELS):
        ax = axes[row][col]
        for (s, g, kind, ch), tr in traces.items():
            if g != gesture or ch != channel or kind != "start":
                continue
            arr = np.array(tr)
            ax.plot(grid, np.nanmean(arr, axis=0), lw=1.4, label=f"{s[len(gesture)+1:len(gesture)+17]} (n={len(arr)})")
        rest = [np.array(tr) for (s, g, kind, ch), tr in traces.items() if g == gesture and ch == channel and kind == "rest"]
        if rest:
            allrest = np.concatenate(rest)
            ax.plot(grid, np.nanmean(allrest, axis=0), color="black", lw=2, ls="--", label="rest (all sessions)")
        ax.axvline(0, color="grey", lw=0.8)
        ax.axhline(0, color="grey", lw=0.5)
        ax.set_title(f"{gesture} start, {channel.replace('ppg_', '')}")
        ax.set_ylabel("MAD units vs past 2 s")
        if row == len(gestures) - 1:
            ax.set_xlabel("ms from the marked start")
        if col == 0:
            ax.legend(fontsize=7, loc="upper left")
fig.suptitle("PPG around gesture starts: one line per session (mean). If the slope idea holds across sessions, the coloured lines share a shape and stand apart from rest.")
fig.tight_layout()
fig.savefig(OUT / "starts_by_session.png", dpi=110)
print(f"\nfigure: {OUT / 'starts_by_session.png'}")
