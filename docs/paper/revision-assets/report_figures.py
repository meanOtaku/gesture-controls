"""Draw the report's data figures from saved, real results (no invented data).

Inputs:
  report-figure-data.json   score timeline and sensor timing (from report_figure_data.py)
  hand-labelled-replay.json per-start latencies of the replay that reproduced the stored metrics
  crates/interaction-engine defaults (copied below) for the wrist mapping

Run from the repository root:
  uv run --isolated --no-project --with matplotlib --with numpy python docs/paper/revision-assets/report_figures.py
Writes vector PDFs into docs/paper/manuscript/figures/.
"""
from pathlib import Path
import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

HERE = Path(__file__).resolve().parent
FIG = HERE.parent / "manuscript" / "figures"

# Reference palette (dataviz skill), validated: slots 1-2, status good/critical, neutral inks.
BLUE, ORANGE = "#2a78d6", "#eb6834"
GOOD, CRITICAL = "#0ca30c", "#d03b3b"
INK, MUTED, GRID, AXIS = "#1a1a19", "#6b6a63", "#e1e0d9", "#c3c2b7"

plt.rcParams.update({
    "font.family": "serif", "font.size": 9, "axes.titlesize": 9, "axes.labelsize": 9,
    "xtick.labelsize": 8, "ytick.labelsize": 8, "legend.fontsize": 8,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK, "xtick.color": MUTED, "ytick.color": MUTED,
    "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": GRID,
    "grid.linewidth": 0.6, "legend.frameon": False, "savefig.bbox": "tight", "pdf.fonttype": 42,
})


def save(fig, name):
    fig.savefig(FIG / f"{name}.pdf", metadata={"CreationDate": None})  # no timestamp: reruns give identical files
    plt.close(fig)
    print(f"wrote {name}.pdf")


def score_timeline(tl, name="score-timeline", size=(6.3, 4.4), hspace=0.6, ncol=3, legend_y=0.0):
    t, s = np.array(tl["t_s"]), np.array(tl["score"])
    starts, events = tl["starts"], tl["events"]
    missed = [x["t_s"] for x in starts if not x["caught"]]
    # Zoom on a stretch that holds a miss and its neighbours.
    centre = missed[len(missed) // 2] if missed else t[len(t) // 2]
    lo, hi = centre - 9, centre + 9

    fig, axes = plt.subplots(2, 1, figsize=size, gridspec_kw={"height_ratios": [1, 1.15], "hspace": hspace})
    for ax, (a, b), title in ((axes[0], (t[0], t[-1]), "Whole recording"),
                              (axes[1], (lo, hi), "Detail around an undetected pinch")):
        m = (t >= a) & (t <= b)
        for h in tl["holds"]:
            if h["label"].startswith("pinch") and h["end_s"] >= a and h["start_s"] <= b:
                ax.axvspan(h["start_s"], h["end_s"], color=BLUE, alpha=0.08, lw=0)
        ax.plot(t[m], s[m], color=BLUE, lw=1.2, label="Model score")
        ax.axhline(tl["activation"], color=INK, lw=0.8, ls="--", label=f"Activation {tl['activation']}")
        ax.axhline(tl["release"], color=MUTED, lw=0.8, ls=":", label=f"Release {tl['release']}")
        cs = [x["t_s"] for x in starts if x["caught"] and a <= x["t_s"] <= b]
        ms = [x for x in missed if a <= x <= b]
        ax.scatter(cs, [-0.09] * len(cs), marker="^", s=28, color=GOOD, zorder=3, clip_on=False,
                   label="Annotated start, caught")
        ax.scatter(ms, [-0.09] * len(ms), marker="X", s=34, color=CRITICAL, zorder=3, clip_on=False,
                   label="Annotated start, missed")
        em = [e["t_s"] for e in events if e["matched"] and a <= e["t_s"] <= b]
        eu = [e["t_s"] for e in events if not e["matched"] and a <= e["t_s"] <= b]
        ax.scatter(em, [1.06] * len(em), marker="v", s=28, color=INK, zorder=3, clip_on=False,
                   label="Emitted event, matched")
        ax.scatter(eu, [1.06] * len(eu), marker="v", s=30, facecolor="white", edgecolor=ORANGE, lw=1.3,
                   zorder=3, clip_on=False, label="Emitted event, outside match window")
        ax.set_xlim(a, b)
        ax.set_ylim(-0.02, 1.0)
        ax.tick_params(axis="x", pad=11)
        ax.set_ylabel("Score")
        ax.set_title(title, loc="left", color=INK, pad=16)
    axes[1].set_xlabel("Time from first decision (s)")
    axes[0].axvspan(lo, hi, color=MUTED, alpha=0.10, lw=0)
    handles, labels = axes[1].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=ncol, bbox_to_anchor=(0.5, legend_y))
    save(fig, name)


def latency_histogram(replay):
    v = next(v for v in replay["variants"] if v["reproducesStored"])
    lat = np.array([x for r in v["perRecording"].values() for x in r["latenciesMs"]])
    fig, ax = plt.subplots(figsize=(5.2, 2.6))
    ax.axvspan(300, 900, color=BLUE, alpha=0.07, lw=0)
    ax.text(895, 0.97, "Match window (300–900 ms)", transform=ax.get_xaxis_transform(), ha="right", va="top", color=MUTED, fontsize=8)
    ax.hist(lat, bins=np.arange(300, 925, 25), color=BLUE, edgecolor="white", linewidth=1.0)
    med = float(np.median(lat))
    ax.axvline(med, color=INK, lw=1.0, ls="--")
    ax.text(med + 8, 0.80, f"Median {med:.0f} ms", transform=ax.get_xaxis_transform(), color=INK, fontsize=8)
    ax.set_xlim(280, 920)
    ax.set_xlabel("Latency from annotated start to emitted event (ms)")
    ax.set_ylabel("Caught pinches")
    ax.grid(axis="x", visible=False)
    ax.set_title(f"n = {lat.size} caught pinch-in starts, eight evaluation recordings", loc="left", color=INK)
    save(fig, "latency-histogram")
    return lat


def sensor_timing(timing):
    fig, axes = plt.subplots(1, 2, figsize=(6.3, 2.5), sharey=True)
    for ax, key, name, nominal, colour in ((axes[0], "imu", "IMU (accelerometer, gyroscope)", 10, BLUE),
                                           (axes[1], "ppg", "PPG (green, red, infrared)", 40, ORANGE)):
        d = timing[key]
        edges = np.array(d["bins_ms"])
        counts = np.array(d["counts"], dtype=float)
        ax.bar(edges[:-1] + 0.5, np.where(counts > 0, counts, np.nan), width=0.9, color=colour, linewidth=0)
        ax.set_yscale("log")
        ax.axvline(nominal, color=INK, lw=0.8, ls="--")
        ax.set_xlim(0, 100)
        ax.set_title(name, loc="left", color=INK)
        ax.set_xlabel("Interval between samples (ms)")
        ax.text(0.97, 0.95, f"median {d['median_ms']:.1f} ms\np99 {d['p99_ms']:.1f} ms\nmax {d['max_ms']:.1f} ms\n"
                f"{d['n']:,} intervals", transform=ax.transAxes, ha="right", va="top", fontsize=7.5, color=INK)
        ax.grid(axis="x", visible=False)
    axes[0].set_ylabel("Count (log scale)")
    save(fig, "sensor-timing")


def wrist_mapping():
    # crates/interaction-engine/src/lib.rs, WristRotationConfig::default()
    dead_zone, pts_per_deg, max_pts_per_s = 3.0, 1.0 / 3.0, 30.0
    fig, axes = plt.subplots(1, 2, figsize=(6.3, 2.6))
    roll = np.linspace(-45, 45, 901)
    dz = np.where(np.abs(roll) <= dead_zone, 0.0, roll - np.sign(roll) * dead_zone)
    ax = axes[0]
    ax.axvspan(-dead_zone, dead_zone, color=MUTED, alpha=0.12, lw=0)
    ax.text(0, 13.5, "dead zone\n±3°", ha="center", va="top", fontsize=7.5, color=MUTED)
    ax.plot(roll, dz * pts_per_deg, color=BLUE, lw=1.6)
    ax.set_xlabel("Wrist roll relative to grab (°)")
    ax.set_ylabel("Volume change (points)")
    ax.set_title("Roll to volume", loc="left", color=INK)
    ax.set_xlim(-45, 45)

    # A 60° turn made in 0.4 s (150°/s, under the 360°/s plausibility limit), sampled at 50 Hz, from volume 50.
    dt = 0.02
    t = np.arange(0, 1.4 + dt / 2, dt)
    r = np.clip(t / 0.4, 0, 1) * 60.0
    desired = 50 + np.where(np.abs(r) <= dead_zone, 0, r - dead_zone) * pts_per_deg
    target = np.empty_like(desired)
    prev = 50.0
    for i, want in enumerate(desired):
        step = max_pts_per_s * (dt if i else 0.0)
        prev = prev + float(np.clip(want - prev, -step, step))
        target[i] = prev
    ax = axes[1]
    ax.plot(t, desired, color=MUTED, lw=1.2, ls="--", label="No rate limit")
    ax.plot(t, target, color=BLUE, lw=1.6, label="30 points/s limit")
    ax.set_xlabel("Time from start of turn (s)")
    ax.set_ylabel("Volume (%)")
    ax.set_title("A 60° turn in 0.4 s", loc="left", color=INK)
    ax.legend(loc="lower right")
    fig.tight_layout(w_pad=2.0)
    save(fig, "wrist-mapping")


def main():
    data = json.loads((HERE / "report-figure-data.json").read_text())
    replay = json.loads((HERE / "hand-labelled-replay.json").read_text())
    score_timeline(data["timeline"])
    # Compact variant for the conference papers (spans both IEEE columns).
    score_timeline(data["timeline"], "score-timeline-compact", size=(7.1, 3.3), hspace=0.75, ncol=4, legend_y=-0.05)
    lat = latency_histogram(replay)
    print(f"latencies: n={lat.size} median={np.median(lat):.1f} IQR={np.percentile(lat,25):.0f}-{np.percentile(lat,75):.0f} p95={np.percentile(lat,95):.0f}")
    sensor_timing(data["timing"])
    wrist_mapping()


if __name__ == "__main__":
    main()
