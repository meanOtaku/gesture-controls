"""Does smoothing keep the features the gesture is recognised by?

The research document's process: smooth before differentiating, causal smoothing only for anything live (no zero-phase
filters), then the derivative in physical units. This runs causal smoothers over the raw PPG of the study's sessions and
checks, against no smoothing:

1. the step across a gesture start (mean 400..900 ms after less 400..100 ms before, in units of the past 2 s): its size,
   how often a pinch rises, and how well a rule on it tells pinch starts from rest on sessions it never saw;
2. the steepest rise (largest first derivative, per second) in the 900 ms after the start: how well it still tells gesture
   starts from rest, and how much of it survives;
3. timing: when the steepest rise happens, against a zero-phase reference (allowed offline only), i.e. the lag a causal
   smoother adds.

Usage (from tools/label-trainer): uv run --with matplotlib python -I <this> <scripts dir> <output dir>
"""

import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, filtfilt, lfilter, savgol_coeffs

sys.path.insert(0, sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
import study  # noqa: E402  (event extraction, holds, normalisation)
from load import recordings  # noqa: E402

RATE_HZ = 25.0
CHANNELS = study.CHANNELS


def moving_average(n):
    return lambda x: lfilter(np.ones(n) / n, [1.0], x, zi=np.full(n - 1, x[0] / n) * np.arange(n - 1, 0, -1))[0]


def ema(alpha):
    return lambda x: lfilter([alpha], [1.0, alpha - 1.0], x, zi=[(1.0 - alpha) * x[0]])[0]


def butter_causal(cutoff_hz, order=2):
    b, a = butter(order, cutoff_hz / (RATE_HZ / 2.0))
    from scipy.signal import lfilter_zi
    return lambda x: lfilter(b, a, x, zi=lfilter_zi(b, a) * x[0])[0]


def butter_zero_phase(cutoff_hz, order=2):
    b, a = butter(order, cutoff_hz / (RATE_HZ / 2.0))
    return lambda x: filtfilt(b, a, x)


def savgol_causal(window, poly):
    # Coefficients that estimate the newest sample from it and the window-1 before it: no future samples.
    coefficients = savgol_coeffs(window, poly, pos=window - 1)
    return lambda x: np.concatenate([x[: window - 1], np.convolve(x, coefficients[::-1], mode="valid")])


SMOOTHERS = {
    "none": lambda x: x,
    "moving average 3 (120 ms)": moving_average(3),
    "moving average 5 (200 ms)": moving_average(5),
    "moving average 7 (280 ms)": moving_average(7),
    "exponential a=0.5": ema(0.5),
    "exponential a=0.3": ema(0.3),
    "Butterworth 6 Hz": butter_causal(6.0),
    "Butterworth 4 Hz": butter_causal(4.0),
    "Butterworth 2.5 Hz": butter_causal(2.5),
    "Savitzky-Golay 7/2 causal": savgol_causal(7, 2),
}
REFERENCE = butter_zero_phase(4.0)  # zero-phase: no lag; offline only, used as the timing reference

grid = np.arange(-500, 1501, 40.0)
BEFORE = (grid >= -400) & (grid <= -100)
AFTER = (grid >= 400) & (grid <= 900)
RISE = (grid >= 0) & (grid <= 900)
rng = np.random.default_rng(7)

# moments[(session, gesture, kind)] -> list of times; computed once from the raw data
sessions = []
for name, gesture, day, rec in recordings():
    t_all = rec.timestamps_ns / 1e6
    if not np.all(np.diff(t_all) >= 0) or (t_all[-1] - t_all[0]) > 3_600_000:
        continue
    times = t_all[rec.ppg_observed]
    hs = study.holds(rec)
    starts = [h[0] for h in hs if times[0] + 2500 < h[0] < times[-1] - 1500]
    bounds = np.array([b for h in hs for b in (h[0], h[1])])
    cand = times[(times > times[0] + 2500) & (times < times[-1] - 1500)]
    far = [c for c in cand if len(bounds) == 0 or np.min(np.abs(bounds - c)) > 1500]
    rests = list(rng.choice(far, size=min(len(far), max(len(starts), 10)), replace=False)) if far else []
    raw = {c: rec.channels[c][rec.ppg_observed].astype(float) for c in CHANNELS}
    sessions.append((name, gesture, times, raw, starts, rests))


def traces(smooth):
    """Per session, kind and channel: the normalised signal around each moment on an even 40 ms grid, and its first
    derivative (per second) taken on that grid. The PPG timestamps jitter (a late sample is often followed by one stamped
    a few ms after it), so a derivative over consecutive raw timestamps divides by near-zero gaps and explodes."""
    out = {}
    for name, gesture, times, raw, starts, rests in sessions:
        for channel in CHANNELS:
            z = np.nan_to_num(study.normalised(times, smooth(raw[channel])))
            for kind, moments in (("start", starts), ("rest", rests)):
                for at in moments:
                    zg = np.interp(at + grid, times, z)
                    out.setdefault((name, gesture, kind, channel), []).append((zg, np.gradient(zg, 0.040)))
    return out


def step(z):
    return z[AFTER].mean() - z[BEFORE].mean()


def loso_step_auc(tr):
    """A logistic rule on the three channels' steps, each pinch session held out in turn: median AUC."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score

    X, y, g = [], [], []
    for name, gesture, *_ in sessions:
        if gesture != "pinch":
            continue
        for kind in ("start", "rest"):
            per = [tr.get((name, gesture, kind, c), []) for c in CHANNELS]
            for i in range(min(len(p) for p in per)):
                X.append([step(per[c][i][0]) for c in range(3)]); y.append(kind == "start"); g.append(name)
    X, y, g = np.array(X), np.array(y), np.array(g)
    per_session = []
    for held in np.unique(g):
        test = g == held
        if y[test].all() or not y[test].any():
            continue
        p = LogisticRegression().fit(X[~test], y[~test]).predict_proba(X[test])[:, 1]
        per_session.append(roc_auc_score(y[test], p))
    return float(np.median(per_session)), float(np.min(per_session)), len(per_session)


reference = traces(REFERENCE)
raw_tr = traces(SMOOTHERS["none"])
rows = []
for label, smooth in SMOOTHERS.items():
    tr = raw_tr if label == "none" else traces(smooth)
    # 1. The step: size relative to unsmoothed, share of pinches rising, unseen-session rule.
    ratios, rising, slopes_start, slopes_rest, retained, lags = [], [], [], [], [], []
    for key, items in tr.items():
        name, gesture, kind, channel = key
        for i, (z, dz) in enumerate(items):
            z0, dz0 = raw_tr[key][i]
            zr, dzr = reference[key][i]
            if kind == "start" and gesture == "pinch":
                s0 = step(z0)
                if abs(s0) > 0.5:
                    ratios.append(step(z) / s0)
                rising.append(step(z) > 0)
            peak = float(np.max(dz[RISE]))
            (slopes_start if kind == "start" else slopes_rest).append(peak)
            if kind == "start" and gesture == "pinch":
                retained.append(peak / max(float(np.max(dz0[RISE])), 1e-9))
                lags.append(grid[RISE][np.argmax(dz[RISE])] - grid[RISE][np.argmax(dzr[RISE])])
    auc_med, auc_worst, n = loso_step_auc(tr)
    slope_auc = study.auc(slopes_start, slopes_rest)
    rows.append((label, np.median(ratios), np.mean(rising), auc_med, auc_worst, slope_auc, np.median(retained), np.median(lags), n))

lines = ["smoother                       step kept   pinches rising   unseen-session AUC (worst)   steepest-rise AUC   steepest rise kept   lag vs zero-phase"]
for label, ratio, up, a, w, sa, kept, lag, n in rows:
    lines.append(f"{label:30s} {ratio:8.0%}   {up:13.0%}   {a:16.2f} ({w:.2f})   {sa:17.2f}   {kept:17.0%}   {lag:+12.0f} ms")
lines.append(f"\n(pinch sessions judged by the unseen-session rule: {rows[0][-1]}; 'steepest rise' over all gestures' starts vs rest)")
text = "\n".join(lines)
print(text)
(OUT / "smoothing-report.txt").write_text(text + "\n")

# Figure: the average pinch start (green) unsmoothed and through each smoother, and the average derivative.
import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

fig, axes = plt.subplots(1, 2, figsize=(14, 4.8))
show = ["none", "moving average 5 (200 ms)", "exponential a=0.3", "Butterworth 4 Hz", "Butterworth 2.5 Hz", "Savitzky-Golay 7/2 causal"]
for label in show:
    tr = raw_tr if label == "none" else traces(SMOOTHERS[label])
    z = np.array([item[0] for (n, g, k, c), items in tr.items() if g == "pinch" and k == "start" and c == "ppg_green" for item in items])
    dz = np.array([item[1] for (n, g, k, c), items in tr.items() if g == "pinch" and k == "start" and c == "ppg_green" for item in items])
    style = {"lw": 2.4, "color": "black"} if label == "none" else {"lw": 1.3}
    axes[0].plot(grid, z.mean(axis=0), label=label, **style)
    axes[1].plot(grid, dz.mean(axis=0), label=label, **style)
for ax, title, unit in ((axes[0], "average pinch start, green", "spreads vs past 2 s"), (axes[1], "its first derivative", "spreads per second")):
    ax.axvline(0, color="grey", lw=0.8); ax.axhline(0, color="grey", lw=0.5)
    ax.set_title(title); ax.set_xlabel("ms from the marked start"); ax.set_ylabel(unit)
axes[0].legend(fontsize=8)
fig.suptitle("Does smoothing keep the pinch step? Unsmoothed in black; the step should survive, the derivative should lose noise, not the rise.")
fig.tight_layout()
fig.savefig(OUT / "smoothing_pinch_start.png", dpi=110)
print(f"figure: {OUT / 'smoothing_pinch_start.png'}")
