"""Does a pinch leave a consistent mark in the pulse signal, and does taking the heart beat out make it easier to see?

The pulse sensor's light signal holds the heart beat, slow drift, motion and, perhaps, a pinch's squeeze of the tissue under
the sensor. This study removes the heart beat and looks at what is left around pinch starts. The filters are causal (they
use only samples up to each moment, as a live model would), so nothing after a pinch can leak into the signal before it:

1. Each recording's channels go onto a regular 25 Hz grid and are detrended with a causal 0.3 Hz high-pass.
2. Heart beats are found in the green channel's causal 0.7-3.5 Hz band (42 to 210 beats a minute). Each whole beat is
   taken away once it is complete: its shape is the median of the previous eight beats' shapes, aligned on their peaks,
   scaled to the beat's own size. That leaves the residual, which at any moment depends on up to about half a beat
   (about 0.5 s) after it: still in time for a live decision, which waits 880 ms. (Subtracting only the part of each beat
   after its peak, strictly causal, left a step at every peak and removed nothing.) Red and infrared use the green channel's beats. A colour difference is also made: green less infrared scaled
   to cancel the heart beat (the scale is the least-squares fit of green's cardiac band on infrared's, over the recording).
3. Every signal is put in units of its own recording's spread (median absolute deviation), so recordings weigh alike, and
   each window is taken relative to its own level over the second before the moment.

Two questions:

* **Is there a consistent shape?** The signal from 2 s before to 3 s after each pinch start is averaged per recording, then
  across recordings, against the same for other gestures' starts and for random moments (every half second through the
  recording with no pinch start within 2.5 s: other gestures, holds and quiet time alike). Each recording's pinch average is correlated with the average of
  the other recordings (leave one recording out).
* **Does removing the heart beat make single pinches easier to see?** Each window from -0.5 to +1.5 s is scored by its
  correlation with the pinch average of the *other* recordings, and the scores of pinch starts are compared with those of
  random moments (ROC AUC, pooled over recordings). If removal helps, the residual scores higher than the detrended signal.

A recorded label is often a few hundred milliseconds late (label-lag audit), which smears any shape and lowers both.

    uv run --project tools/label-trainer --with matplotlib python docs/research/artifacts/ppg-benchmark-2026-10/cardiac_residual_check.py

Run from the repository root (about a minute). Writes cardiac-residual/results.json, results.md and, with matplotlib,
event-averages.png.
"""
import importlib.util, json, sys, time
from dataclasses import replace
from pathlib import Path
import numpy as np
from scipy.signal import butter, lfilter, find_peaks, welch
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("reproduce", HERE / "reproduce.py")
R = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(R)
sys.path.insert(0, str(HERE.parents[3] / "tools/label-trainer/src"))
from label_trainer import label_train as lt, ppg_onset as P  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402

MS = 1_000_000
RATE = 25.0                      # Hz, after resampling onto a regular grid
BEFORE_S, AFTER_S = 2.0, 3.0     # window around each moment, for the averages
SCORE_FROM_S, SCORE_TO_S = -0.5, 1.5   # the part of a window scored against the template
PREVIOUS_BEATS = 8               # beats whose median shape is a beat's template
RANDOM_EVERY_S = 0.5             # random moments: points this far apart through the recording
RANDOM_CLEAR_S = 2.5             # with no pinch start within this
SIGNALS = ("green", "red", "ir", "green_minus_ir")
STAGES = ("detrended", "residual")
KINDS = ("pinch", "other", "random")
TARGET = "pinch"


def causal_band(x, lo, hi):
    b, a = butter(2, [lo / (RATE / 2), hi / (RATE / 2)], btype="band")
    return lfilter(b, a, x)


def causal_highpass(x, cut):
    b, a = butter(2, cut / (RATE / 2), btype="high")
    return lfilter(b, a, x - x[0])


def regular(ts, values):
    """The samples on a regular 25 Hz grid (linear interpolation) and which grid points sit in a gap over 0.5 s."""
    grid = np.arange(ts[0], ts[-1], int(1e9 / RATE), dtype=np.int64)
    out = np.column_stack([np.interp(grid, ts, values[:, c]) for c in range(values.shape[1])])
    after = np.clip(np.searchsorted(ts, grid), 1, len(ts) - 1)
    return grid, out, (ts[after] - ts[after - 1]) > 500 * MS


def beats(green_detrended):
    """Peak indices of the heart beats in the causal cardiac band."""
    cardiac = causal_band(green_detrended, 0.7, 3.5)
    spread = np.median(np.abs(cardiac - np.median(cardiac))) + 1e-9
    peaks, _ = find_peaks(cardiac, distance=int(RATE * 60 / 210), prominence=spread)
    return peaks


def remove_heart_beat(x, peaks):
    """`x` less each whole beat's shape: the median of the previous beats' shapes, aligned on their peaks, scaled to the
    beat's own size (least squares, kept between 0 and 2). A beat is complete about half an interval after its peak, so the
    residual at a moment depends on up to about 0.5 s after it, well within the 880 ms a decision waits."""
    out = x.copy()
    if len(peaks) < PREVIOUS_BEATS + 2:
        return out, 0
    removed = 0
    for k in range(PREVIOUS_BEATS, len(peaks)):
        previous = peaks[k - PREVIOUS_BEATS:k]
        ibi = int(np.median(np.diff(previous)))
        lo, hi = int(0.5 * ibi), ibi - int(0.5 * ibi)
        p = peaks[k]
        if p - lo < 0 or p + hi > len(x) or previous[0] - lo < 0:
            continue
        template = np.median(np.stack([x[q - lo:q + hi] for q in previous]), axis=0)
        template = template - template.mean()
        beat = x[p - lo:p + hi]
        scale = float(np.clip(np.dot(beat - beat.mean(), template) / (np.dot(template, template) + 1e-12), 0.0, 2.0))
        out[p - lo:p + hi] -= scale * template
        removed += 1
    return out, removed


def robust_scale(x, ok):
    finite = x[ok]
    spread = np.median(np.abs(finite - np.median(finite))) * 1.4826
    return (x - np.median(finite)) / (spread + 1e-12)


def windows(signal, ok, grid, moments_ns):
    """The signal from BEFORE_S before to AFTER_S after each moment (rows), relative to its own level over the second
    before; windows leaving the recording or touching a gap are dropped."""
    n0, n1, base = int(BEFORE_S * RATE), int(AFTER_S * RATE), int(RATE)
    rows = []
    for t in moments_ns:
        i = int(np.searchsorted(grid, t))
        if i - n0 >= 0 and i + n1 <= len(signal) and ok[i - n0:i + n1].all():
            w = signal[i - n0:i + n1]
            rows.append(w - np.mean(w[n0 - base:n0]))
    return np.array(rows).reshape(-1, n0 + n1)


def main():
    t0 = time.time()
    out_dir = HERE / "cardiac-residual"; out_dir.mkdir(exist_ok=True)
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    per_rec = {}   # sid -> kind -> stage -> signal -> windows (rows)
    heart_rates, removed_share, cardiac_share, cardiac_left = [], [], [], []
    for sid, r in inv.items():
        recording = lt.repair_millisecond_ppg_timestamps(load_recording(R.RECORDINGS / Path(r["path"]).name))
        recording = replace(recording, raw_labels=np.where(recording.raw_labels == "pinching", "pinch", recording.raw_labels))
        ts, values = lt.pulse_of(recording)
        if len(ts) < RATE * 30:
            continue
        grid, reg, gap = regular(ts, values.astype(float))
        ok = ~gap
        detrended = np.column_stack([causal_highpass(reg[:, c], 0.3) for c in range(3)])
        peaks = beats(detrended[:, 0])
        heart_rates.append(len(peaks) / (len(grid) / RATE / 60))
        g_card, ir_card = causal_band(detrended[:, 0], 0.7, 3.5), causal_band(detrended[:, 2], 0.7, 3.5)
        alpha = float(np.dot(g_card, ir_card) / (np.dot(ir_card, ir_card) + 1e-12))
        stages = {"detrended": {}, "residual": {}}
        for c, name in enumerate(("green", "red", "ir")):
            stages["detrended"][name] = detrended[:, c]
            residual, removed = remove_heart_beat(detrended[:, c], peaks)
            stages["residual"][name] = residual
            if name == "green":
                removed_share.append(removed / max(1, len(peaks)))
                # How big the heart beat is, and how much of it is left: the power within 0.12 Hz of the heart rate, as a
                # share of the 0.7-3.5 Hz band's, and after removal against before (from the first beat removed on).
                first = peaks[min(PREVIOUS_BEATS, len(peaks) - 1)] + int(RATE)
                f, before = welch(detrended[first:, c], fs=RATE, nperseg=512)
                _, after_removal = welch(residual[first:], fs=RATE, nperseg=512)
                rate_hz = len(peaks) / (len(grid) / RATE)
                near, band_mask = (f > rate_hz - 0.12) & (f < rate_hz + 0.12), (f > 0.7) & (f < 3.5)
                cardiac_share.append(float(before[near].sum() / before[band_mask].sum()))
                cardiac_left.append(float(after_removal[near].sum() / before[near].sum()))
        for stage in STAGES:
            stages[stage]["green_minus_ir"] = stages[stage]["green"] - alpha * stages[stage]["ir"]
            for name in SIGNALS:
                stages[stage][name] = robust_scale(stages[stage][name], ok)

        held = P.holds(recording.timestamps_ns, recording.raw_labels)
        pinch = np.array([s for s, _, label in held if label == TARGET], dtype=np.int64)
        moments = {"pinch": pinch, "other": np.array([s for s, _, label in held if label != TARGET], dtype=np.int64)}
        points = np.arange(grid[0], grid[-1], int(RANDOM_EVERY_S * 1e9), dtype=np.int64)
        moments["random"] = np.array([t for t in points if not len(pinch) or np.min(np.abs(pinch - t)) > RANDOM_CLEAR_S * 1e9], dtype=np.int64)
        per_rec[sid] = {kind: {stage: {name: windows(stages[stage][name], ok, grid, moments[kind]) for name in SIGNALS} for stage in STAGES} for kind in KINDS}

    n0 = int(BEFORE_S * RATE)
    times = (np.arange(n0 + int(AFTER_S * RATE)) - n0) / RATE
    scored = (times >= SCORE_FROM_S) & (times <= SCORE_TO_S)
    after = times >= 0
    counts = {kind: int(sum(len(e[kind]["residual"]["green"]) for e in per_rec.values())) for kind in KINDS}
    summary = {"recordings": len(per_rec), "moments": counts, "median_heart_rate_bpm": round(float(np.median(heart_rates)), 1),
               "beats_removed_share": round(float(np.median(removed_share)), 3),
               "cardiac_share_of_band": round(float(np.median(cardiac_share)), 3),
               "cardiac_power_left": round(float(np.median(cardiac_left)), 3), "averages": {}, "consistency": {}, "single": {}}

    def rec_means(kind, stage, name):
        return {sid: e[kind][stage][name].mean(0) for sid, e in per_rec.items() if len(e[kind][stage][name])}

    for stage in STAGES:
        for name in SIGNALS:
            pinch_means = rec_means("pinch", stage, name)
            for kind in KINDS:
                means = rec_means(kind, stage, name)
                if len(means) < 3:
                    continue
                mat = np.array(list(means.values()))
                mean, sem = mat.mean(0), mat.std(0, ddof=1) / np.sqrt(len(mat))
                peak_i = int(np.argmax(np.abs(mean) * after))
                key = f"{kind}/{stage}/{name}"
                summary["averages"][key] = {"recordings": len(mat), "mean": [round(float(v), 4) for v in mean], "sem": [round(float(v), 4) for v in sem],
                                            "peak_time_s": round(float(times[peak_i]), 2), "peak_value": round(float(mean[peak_i]), 3),
                                            "peak_over_sem": round(float(abs(mean[peak_i]) / (sem[peak_i] + 1e-12)), 2)}
                # Does each recording's average for these moments match the other recordings' pinch average?
                corr = []
                for sid, m in means.items():
                    others = [v for s, v in pinch_means.items() if s != sid]
                    if len(others) >= 2:
                        rest = np.mean(others, axis=0)
                        a, b = m[after], rest[after]
                        if a.std() > 0 and b.std() > 0:
                            corr.append(float(np.corrcoef(a, b)[0, 1]))
                summary["consistency"][key] = {"median_r": round(float(np.median(corr)), 3), "share_positive": round(float(np.mean(np.array(corr) > 0)), 3)}
            # Single moments: each window's match with the other recordings' pinch average.
            scores = {kind: [] for kind in KINDS}
            for sid, e in per_rec.items():
                others = [v for s, v in pinch_means.items() if s != sid]
                if len(others) < 2:
                    continue
                template = np.mean(others, axis=0)[scored]
                template = (template - template.mean()) / (template.std() + 1e-12)
                for kind in KINDS:
                    for w in e[kind][stage][name]:
                        seg = w[scored]
                        seg = (seg - seg.mean()) / (seg.std() + 1e-12)
                        scores[kind].append(float(np.mean(seg * template)))
            single = {}
            for kind in ("random", "other"):
                y = np.r_[np.ones(len(scores["pinch"])), np.zeros(len(scores[kind]))]
                single[f"pinch_vs_{kind}_auc"] = round(float(roc_auc_score(y, np.r_[scores["pinch"], scores[kind]])), 3)
            summary["single"][f"{stage}/{name}"] = single
    summary["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(summary, indent=1))

    lines = [
        "# A pinch in the pulse signal, with the heart beat removed (causal)",
        "",
        f"{summary['recordings']} recordings; median heart rate {summary['median_heart_rate_bpm']:.0f} beats a minute; "
        f"{summary['beats_removed_share']:.0%} of beats removed. In the green channel the heart beat (power within 0.12 Hz of "
        f"the heart rate) is {summary['cardiac_share_of_band']:.0%} of the 0.7-3.5 Hz band, and removal leaves "
        f"{summary['cardiac_power_left']:.0%} of it (medians per recording). Moments: {counts}.",
        "",
        "## Single moments: does a window look like a pinch?",
        "",
        "ROC AUC of each window's match (-0.5 to +1.5 s) with the other recordings' pinch average: pinch starts against random",
        "moments, and against other gestures' starts. 0.5 is no better than chance.",
        "",
        "| Signal | Pinch vs random, detrended | with heart beat removed | Pinch vs other, detrended | with heart beat removed |",
        "|---|---:|---:|---:|---:|",
    ]
    for name in SIGNALS:
        d, rr = summary["single"][f"detrended/{name}"], summary["single"][f"residual/{name}"]
        lines.append(f"| {name} | {d['pinch_vs_random_auc']:.3f} | {rr['pinch_vs_random_auc']:.3f} | {d['pinch_vs_other_auc']:.3f} | {rr['pinch_vs_other_auc']:.3f} |")
    lines += [
        "",
        "## Averages",
        "",
        "Peak of the average (in units of each recording's spread) from 0 to 3 s after the moment, how many standard errors it",
        "stands from zero, and how each recording's average matches the other recordings' pinch average (median correlation,",
        "share positive).",
        "",
        "| Moments | Signal | Stage | Peak at | Peak | Peak / SE | Median r | Share r > 0 |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ]
    for kind in KINDS:
        for name in SIGNALS:
            for stage in STAGES:
                key = f"{kind}/{stage}/{name}"
                if key in summary["averages"]:
                    a, c = summary["averages"][key], summary["consistency"][key]
                    lines.append(f"| {kind} | {name} | {stage} | {a['peak_time_s']:+.2f} s | {a['peak_value']:+.3f} | {a['peak_over_sem']:.1f} | {c['median_r']:+.2f} | {c['share_positive']:.0%} |")
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed: no figure (run with --with matplotlib)")
        return
    fig, axes = plt.subplots(2, len(SIGNALS), figsize=(4 * len(SIGNALS), 6), sharex=True, sharey="row")
    colors = {"pinch": "#d62728", "other": "#1f77b4", "random": "#7f7f7f"}
    for row, stage in enumerate(STAGES):
        for col, name in enumerate(SIGNALS):
            ax = axes[row, col]
            for kind in KINDS:
                a = summary["averages"].get(f"{kind}/{stage}/{name}")
                if a:
                    m, s = np.array(a["mean"]), np.array(a["sem"])
                    ax.plot(times, m, color=colors[kind], label=f"{kind} ({a['recordings']} rec.)")
                    ax.fill_between(times, m - s, m + s, color=colors[kind], alpha=0.2)
            ax.axvline(0, color="black", lw=0.6)
            ax.set_title(f"{name}, {stage}", fontsize=9)
            if col == 0:
                ax.set_ylabel("spread units")
            if row == 1:
                ax.set_xlabel("s from the moment")
    axes[0, 0].legend(fontsize=7)
    fig.suptitle("Pulse signal around pinch starts, other gestures' starts and random moments (causal; mean ± SE across recordings)")
    fig.tight_layout()
    fig.savefig(out_dir / "event-averages.png", dpi=120)
    print(f"figure: {out_dir / 'event-averages.png'}")


if __name__ == "__main__":
    main()
