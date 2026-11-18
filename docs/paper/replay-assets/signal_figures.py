"""Data and plots for two figures: what the watch records around a pinch, and the motion blind spot step by step.

`fig-event-locked`: every pinch-in and pinch-out start in the 22 training recordings of the motion-filtered models
(`trained-models/pinch_in-motion`), hand labels as the trainer reads them. Around each start: the gyroscope's magnitude,
the change in the accelerometer from one 10 ms tick to the next, and the green PPG scaled as the model scales it (against
the median and 1.4826 x MAD of the 10 s before). Median and interquartile band across starts, and the same quantities at
random no-gesture moments of the same recordings.

`fig-blind-spot`: the first model (`trained-models/pinch_in-hand-labeled`, 50 Hz, 0.99 threshold) on one held-out pinch-in,
with 6 s of the held-out everyday-activity recording's most intense motion spliced in to end 1 s before it, exactly as in
`docs/research/cnn-motion-hangover-2026-11.md`. Its score every 40 ms with the scale taken from the whole 11 s history
and with fast-turning moments left out, and the gyroscope scale each uses.

    tools/label-trainer/.venv/bin/python docs/paper/replay-assets/signal_figures.py
    docs/paper/codex-assets/.venv/bin/python docs/paper/replay-assets/signal_figures.py --plot

The first writes `signal-figures.json`; the second draws `event-locked.pdf/png`, its one-column
`event-locked-compact.pdf/png` and `blind-spot.pdf/png` from it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
DATA = HERE / "signal-figures.json"
RECORDINGS = ROOT / "data" / "recordings" / "Hand labeled"
S = 1_000_000_000
BEFORE_S, AFTER_S, STEP_MS = 1.0, 1.5, 10
NOISE = "gesture-dataset-everyday_noise-2026-11-04T04-27-35.286Z"


# ---------------------------------------------------------------------------------------------------- data (trainer venv)

def _trainer():
    sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))
    sys.path.insert(0, str(ROOT / "docs" / "research" / "artifacts" / "readiness-2026-11"))
    from label_trainer import cnn, cnn_input, label_train as lt, ppg_onset
    from readiness import busiest, splice
    return cnn, cnn_input, lt, ppg_onset, busiest, splice


def _spec(lt, train: list[str], evaluation: list[str]):
    ids = train + evaluation
    return lt.parse_spec({
        "version": 1, "target": "pinch_in", "negatives": ["pinch_out"], "excludes": ["left_out"],
        "recordings": {rid: str(RECORDINGS / rid) for rid in ids}, "train": train, "evaluation": evaluation,
        "sources": list(lt.MOTION_SOURCES), "backend": lt.CNN_BACKEND, "seed": 17, "research": False,
        "labelOffsetMs": 0, "motionHz": 50,
    })


def _traces(m_ts, motion, p_ts, pulse, at: int, offsets_ns: np.ndarray) -> np.ndarray:
    """(3, len(offsets)): gyroscope magnitude, accelerometer change per tick, green PPG scaled against the 10 s before."""
    t = at + offsets_ns
    mi = np.clip(np.searchsorted(m_ts, t, side="right") - 1, 0, len(m_ts) - 1)
    gyro = np.linalg.norm(motion[mi, 3:6], axis=1)
    accel = motion[mi, 0:3]
    delta = np.concatenate([[0.0], np.linalg.norm(np.diff(accel, axis=0), axis=1)])
    history = (p_ts >= at - 10 * S) & (p_ts < at)
    green = pulse[history, 0]
    centre = np.median(green)
    spread = 1.4826 * np.median(np.abs(green - centre)) + 1e-3 * (abs(centre) + 1)
    pi = np.clip(np.searchsorted(p_ts, t, side="right") - 1, 0, len(p_ts) - 1)
    return np.stack([gyro, delta, (pulse[pi, 0] - centre) / spread])


def event_locked() -> dict:
    cnn, cnn_input, lt, ppg_onset, _, _ = _trainer()
    provenance = json.loads((ROOT / "trained-models" / "pinch_in-motion" / "manifest.json").read_text())["provenance"]
    train = list(provenance["trainRecordings"])
    recordings = lt.load_spec_recordings(_spec(lt, train, []))
    offsets = np.arange(-BEFORE_S * 1000, AFTER_S * 1000 + 1, STEP_MS).astype(np.int64) * 1_000_000
    rng = np.random.default_rng(17)
    out: dict = {"offsets_ms": (offsets // 1_000_000).tolist(), "recordings": len(train)}
    stacks: dict[str, list] = {"pinch_in": [], "pinch_out": [], "none": []}
    in_to_out: list[float] = []  # seconds from each pinch-in start to the next pinch-out start
    for rid in train:
        rec = recordings[rid]
        m_ts, motion = lt.motion_of(rec)
        p_ts, pulse = lt.pulse_of(rec)
        held = ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
        lo, hi = max(m_ts[0], p_ts[0]) + 11 * S, min(m_ts[-1], p_ts[-1]) - 2 * S
        outs = [s for s, _, label in held if label == "pinch_out"]
        in_to_out += [(min(o for o in outs if o > s) - s) / S for s, _, label in held
                      if label == "pinch_in" and any(o > s for o in outs)]
        for start, _, label in held:
            if label in ("pinch_in", "pinch_out") and lo <= start <= hi:
                stacks[label].append(_traces(m_ts, motion, p_ts, pulse, start, offsets))
        # No-gesture moments: nothing labelled within 2 s either side.
        busy = [(s - 2 * S, e + 2 * S) for s, e, label in held if label]
        candidates = rng.uniform(lo, hi, 400).astype(np.int64) if hi > lo else []
        for at in candidates:
            if not any(a <= at <= b for a, b in busy):
                stacks["none"].append(_traces(m_ts, motion, p_ts, pulse, int(at), offsets))
    for key, rows in stacks.items():
        arr = np.array(rows)  # (events, 3, ticks)
        out[key] = {"n": len(rows), **{q: np.percentile(arr, p, axis=0).round(4).tolist()
                                       for q, p in (("p25", 25), ("p50", 50), ("p75", 75))}}
        print(f"{key}: {len(rows)}", flush=True)
    out["in_to_out_s"] = {q: round(float(np.percentile(in_to_out, p)), 2) for q, p in (("p25", 25), ("p50", 50), ("p75", 75))}
    print(f"pinch in to pinch out: {out['in_to_out_s']}", flush=True)
    return out


def blind_spot() -> dict:
    cnn, cnn_input, lt, ppg_onset, busiest, splice = _trainer()
    bundle = ROOT / "trained-models" / "pinch_in-hand-labeled"
    manifest = json.loads((bundle / "manifest.json").read_text())
    model_bytes = (bundle / manifest["model"]["file"]).read_bytes()
    threshold = manifest["thresholds"]["activation"]
    pinches = [r for r in manifest["provenance"]["evaluationRecordings"] if "pinch" in r]
    recordings = lt.load_spec_recordings(_spec(lt, [], pinches + [NOISE]))
    noise = recordings[NOISE]
    n_ts, n_motion = lt.motion_of(noise)
    p_n_ts, p_n = lt.pulse_of(noise)
    duration, gap = 6.0, 1.0
    sources = busiest(n_ts, np.sum(n_motion[:, 3:6] ** 2, axis=1), duration, 3)
    g = cnn_input.grid_of(50)
    real_moving = cnn_input.moving_ticks

    def scores(mt, mv, pt, pv, decisions, filtered: bool):
        cnn_input.moving_ticks = real_moving if filtered else (lambda grid, g=g: np.zeros(grid.shape[:2], dtype=bool))
        try:
            x = cnn_input.inputs(mt, mv, pt, pv, decisions, hz=50)
        finally:
            cnn_input.moving_ticks = real_moving
        ok = np.isfinite(x).all(axis=1)
        out = np.full(len(decisions), np.nan)
        out[ok] = cnn.predict(model_bytes, x[ok])
        return out

    def gyro_scale(mt, mv, decisions, filtered: bool):
        grid = cnn_input._held(mt, mv, decisions, g)[:, :, 3:6]
        left = real_moving(cnn_input._held(mt, mv, decisions, g), g) if filtered else np.zeros(grid.shape[:2], bool)
        kept = np.where(left[:, :, None], np.nan, grid)
        centre = np.nanmedian(kept, axis=1, keepdims=True)
        return (1.4826 * np.nanmedian(np.abs(kept - centre), axis=1)).mean(axis=1)

    candidates = []
    k = 0
    for rid in pinches:
        rec = recordings[rid]
        m_ts, motion = lt.motion_of(rec)
        q_ts, pulse = lt.pulse_of(rec)
        held = ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
        for start, _, label in held:
            if label != "pinch_in" or start - 25 * S <= q_ts[0]:
                continue
            at = start - int((gap + duration) * S)
            source = sources[k % len(sources)]
            k += 1
            mt, mv = splice(m_ts, motion, n_ts, n_motion, at, source, int(duration * S), level=False)
            pt, pv = splice(q_ts, pulse, p_n_ts, p_n, at, source, int(duration * S), level=True)
            window = (pt >= start + S // 10) & (pt <= start + S)
            plain_w = (q_ts >= start + S // 10) & (q_ts <= start + S)
            clean = np.nanmax(scores(m_ts, motion, q_ts, pulse, q_ts[plain_w], True))
            before = np.nanmax(scores(mt, mv, pt, pv, pt[window], False))
            after = np.nanmax(scores(mt, mv, pt, pv, pt[window], True))
            candidates.append({"recording": rid, "start": int(start), "source": int(source), "clean": float(clean),
                               "all_history": float(before), "filtered": float(after)})
    caught = lambda c, key: c[key] >= threshold  # noqa: E731
    counts = {key: sum(caught(c, key) for c in candidates) for key in ("clean", "all_history", "filtered")}
    print(f"{len(candidates)} pinches: {counts}", flush=True)
    # The example: caught without motion, missed with all-history scaling, caught with motion-filtered scaling; of those,
    # the one whose filtered peak is the median, so it is typical rather than the best.
    shown = sorted([c for c in candidates if caught(c, "clean") and not caught(c, "all_history") and caught(c, "filtered")],
                   key=lambda c: c["filtered"])
    pick = shown[len(shown) // 2]
    rec = recordings[pick["recording"]]
    m_ts, motion = lt.motion_of(rec)
    q_ts, pulse = lt.pulse_of(rec)
    start, at = pick["start"], pick["start"] - int((gap + duration) * S)
    mt, mv = splice(m_ts, motion, n_ts, n_motion, at, pick["source"], int(duration * S), level=False)
    pt, pv = splice(q_ts, pulse, p_n_ts, p_n, at, pick["source"], int(duration * S), level=True)
    decisions = pt[(pt >= start - 12 * S) & (pt <= start + 3 * S)]  # a decision at each pulse sample, as counted above
    span = (mt >= start - 12 * S) & (mt <= start + 3 * S)
    return {
        "threshold": threshold, "duration_s": duration, "gap_s": gap, "counts": counts, "pinches": len(candidates),
        "example": {k: v for k, v in pick.items() if k != "source"}, "examples_of_kind": len(shown),
        "t_s": ((decisions - start) / S).round(3).tolist(),
        "gyro_t_s": ((mt[span] - start) / S).round(3).tolist(),
        "gyro": np.linalg.norm(mv[span, 3:6], axis=1).round(4).tolist(),
        "score_all_history": scores(mt, mv, pt, pv, decisions, False).round(5).tolist(),
        "score_filtered": scores(mt, mv, pt, pv, decisions, True).round(5).tolist(),
        "scale_all_history": gyro_scale(mt, mv, decisions, False).round(5).tolist(),
        "scale_filtered": gyro_scale(mt, mv, decisions, True).round(5).tolist(),
    }


# ---------------------------------------------------------------------------------------------------- plots (codex venv)

def plot() -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 8, "axes.titlesize": 8.5, "axes.labelsize": 8, "legend.fontsize": 7,
                         "xtick.labelsize": 7, "ytick.labelsize": 7, "font.family": "DejaVu Sans",
                         "axes.spines.top": False, "axes.spines.right": False, "pdf.fonttype": 42, "svg.fonttype": "none"})
    data = json.loads(DATA.read_text())
    _plot_event_locked(plt, data["event_locked"])
    _plot_event_locked_compact(plt, data["event_locked"])
    _plot_blind_spot(plt, data["blind_spot"])


INK, GREY = "#222222", "#9a9a9a"
COLOURS = {"pinch_in": "#1f6fb4", "pinch_out": "#c4571a"}


def _plot_event_locked(plt, d: dict) -> None:
    t = np.array(d["offsets_ms"])[1:] / 1000  # the first tick has no accelerometer change
    rows = (("Gyroscope |ω| (rad/s)", 0), ("Accelerometer change\nper 10 ms (m/s²)", 1), ("Green PPG, scaled\nas the model sees it", 2))
    fig, axes = plt.subplots(3, 2, figsize=(7.0, 4.4), sharex=True, sharey="row")
    for col, (key, title) in enumerate((("pinch_in", "Pinch in"), ("pinch_out", "Pinch out"))):
        for r, (label, i) in enumerate(rows):
            ax = axes[r, col]
            none = d["none"]
            ax.fill_between(t, np.array(none["p25"])[i, 1:], np.array(none["p75"])[i, 1:], color=GREY, alpha=0.25, lw=0)
            ax.plot(t, np.array(none["p50"])[i, 1:], color=GREY, lw=0.9, ls="--")
            ax.fill_between(t, np.array(d[key]["p25"])[i, 1:], np.array(d[key]["p75"])[i, 1:], color=COLOURS[key], alpha=0.25, lw=0)
            ax.plot(t, np.array(d[key]["p50"])[i, 1:], color=COLOURS[key], lw=1.4)
            ax.axvline(0, color=INK, lw=0.6)
            if col == 0:
                ax.set_ylabel(label)
            if r == 0:
                ax.set_title(f"{title} (n = {d[key]['n']} starts)")
        axes[2, col].set_xlabel("Time from labelled start (s)")
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    fig.legend(handles=[Line2D([], [], color=COLOURS["pinch_in"], lw=1.4, label="pinch in, median"),
                        Line2D([], [], color=COLOURS["pinch_out"], lw=1.4, label="pinch out, median"),
                        Patch(color="#888888", alpha=0.3, label="interquartile range"),
                        Line2D([], [], color=GREY, lw=0.9, ls="--", label=f"no gesture (n = {d['none']['n']})")],
               loc="lower center", ncol=4, frameon=False, bbox_to_anchor=(0.5, -0.01))
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    for ext in ("pdf", "png"):
        fig.savefig(HERE / f"event-locked.{ext}", dpi=300, bbox_inches="tight")
    plt.close(fig)


def _plot_event_locked_compact(plt, d: dict) -> None:
    """One column wide, pinch-in only, gyroscope and PPG: the version for a two-column paper."""
    t = np.array(d["offsets_ms"])[1:] / 1000
    rows = (("Gyroscope\n|ω| (rad/s)", 0), ("Green PPG\n(scaled)", 2))
    fig, axes = plt.subplots(2, 1, figsize=(3.45, 2.0), sharex=True)
    for ax, (label, i) in zip(axes, rows):
        none, key = d["none"], d["pinch_in"]
        ax.fill_between(t, np.array(none["p25"])[i, 1:], np.array(none["p75"])[i, 1:], color=GREY, alpha=0.25, lw=0)
        ax.plot(t, np.array(none["p50"])[i, 1:], color=GREY, lw=0.9, ls="--", label=f"no gesture (n = {none['n']})")
        ax.fill_between(t, np.array(key["p25"])[i, 1:], np.array(key["p75"])[i, 1:], color=COLOURS["pinch_in"], alpha=0.25, lw=0)
        ax.plot(t, np.array(key["p50"])[i, 1:], color=COLOURS["pinch_in"], lw=1.4, label=f"pinch in (n = {key['n']})")
        ax.axvline(0, color=INK, lw=0.6)
        ax.set_ylabel(label)
    axes[0].legend(loc="upper right", frameon=False, fontsize=6.5)
    axes[-1].set_xlabel("Time from labelled pinch-in start (s)")
    fig.tight_layout(h_pad=0.4)
    for ext in ("pdf", "png"):
        fig.savefig(HERE / f"event-locked-compact.{ext}", dpi=300, bbox_inches="tight")
    plt.close(fig)


def _plot_blind_spot(plt, d: dict) -> None:
    t = np.array(d["t_s"])
    gap, dur = d["gap_s"], d["duration_s"]
    burst = (-(gap + dur), -gap)
    fig, axes = plt.subplots(3, 1, figsize=(7.0, 4.3), sharex=True, gridspec_kw={"height_ratios": [1, 1, 1.25]})
    a, b, c = axes
    for ax in axes:
        ax.axvspan(*burst, color="#f4cccc", alpha=0.5, lw=0)
        ax.axvline(0, color=INK, lw=0.6)
    a.plot(d["gyro_t_s"], d["gyro"], color=INK, lw=0.6)
    a.set_ylabel("Gyroscope\n|ω| (rad/s)")
    a.text(np.mean(burst), 0.95, f"{dur:.0f} s of everyday arm motion (spliced)", transform=a.get_xaxis_transform(),
           ha="center", va="top", fontsize=7)
    a.text(0.05, 0.95, "pinch\nstarts", transform=a.get_xaxis_transform(), ha="left", va="top", fontsize=7)
    b.semilogy(t, d["scale_all_history"], color="#b03a2e", lw=1.3, label="all 11 s of history")
    b.semilogy(t, d["scale_filtered"], color="#1f6fb4", lw=1.3, label="fast turning left out")
    b.set_ylabel("Gyroscope scale\n1.4826·MAD (rad/s)")
    b.legend(loc="upper left", frameon=False, ncol=2)
    c.text(-7.75, 0.55, "an earlier real pinch:\nthe same with both", fontsize=7, ha="right", color=INK)
    c.plot(t, d["score_all_history"], color="#b03a2e", lw=1.3, label="all 11 s of history")
    c.plot(t, d["score_filtered"], color="#1f6fb4", lw=1.3, label="fast turning left out")
    c.axhline(d["threshold"], color=INK, lw=0.7, ls=":")
    c.text(t[0], d["threshold"], f" threshold {d['threshold']:g}", va="bottom", fontsize=7)
    c.axvspan(0.1, 1.0, color="#f1c232", alpha=0.25, lw=0)
    c.set_ylim(-0.03, 1.08)
    c.set_ylabel("Pinch-in score")
    c.set_xlabel("Time from labelled pinch-in start (s)")
    i_all, i_f = int(np.nanargmax(np.where((t >= 0.1) & (t <= 1), d["score_all_history"], np.nan))), \
        int(np.nanargmax(np.where((t >= 0.1) & (t <= 1), d["score_filtered"], np.nan)))
    c.annotate(f"missed (peak {d['score_all_history'][i_all]:.2f})", (t[i_all], d["score_all_history"][i_all]),
               xytext=(1.25, 0.45), fontsize=7, color="#b03a2e", arrowprops={"arrowstyle": "-", "color": "#b03a2e", "lw": 0.6})
    c.annotate(f"caught (peak {d['score_filtered'][i_f]:.3f})", (t[i_f], d["score_filtered"][i_f]),
               xytext=(1.25, 0.8), fontsize=7, color="#1f6fb4", arrowprops={"arrowstyle": "-", "color": "#1f6fb4", "lw": 0.6})
    for ax, letter in zip(axes, "abc"):
        ax.text(-0.15, 1.02, f"({letter})", transform=ax.transAxes, fontsize=8, fontweight="bold", va="bottom")
    a.set_xlim(-12, 3)
    fig.tight_layout()
    for ext in ("pdf", "png"):
        fig.savefig(HERE / f"blind-spot.{ext}", dpi=300, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    if "--plot" in sys.argv:
        plot()
    else:
        DATA.write_text(json.dumps({"event_locked": event_locked(), "blind_spot": blind_spot()}) + "\n")
        print(f"wrote {DATA.relative_to(ROOT)}")
