"""Does the moment thumb and index touch show as a sharp, consistent jolt in the watch's motion sensors?

A double-pinch detector led by the motion sensors needs each contact to be visible on its own. This study takes the Recorder
recordings that kept the camera's hand landmarks, finds every moment the thumb and index fingertips close (the distance
between them, in hand sizes, falling below 0.35 from at or above it: the app's rule, `cameraTrack.ts`), puts those moments
on the watch's clock (`alignClocks`: the smallest arrival delay of the clock samples), and looks at the motion sensors
around them:

* the "jolt": each accelerometer and gyroscope axis less its 0.3 s moving mean (what is left is quick change), as the
  magnitude over the three axes of each sensor, in units of the recording's own spread;
* averaged from 1 s before to 1 s after each contact, per recording and across recordings, against the same around
  random moments (no contact within 1.5 s) and around releases (the distance rising back to 0.35);
* one contact at a time: the largest jolt within 150 ms of the contact (the clock alignment's spread) against the same
  around random moments, as a ROC AUC (0.5 is chance, 1.0 perfect).

The clocks line up only to within the recording's jitter (reported), and the camera runs at about 30 frames a second, so a
jolt lasting tens of milliseconds is smeared in the averages; the per-contact window allows for it.

The recordings are the app's own (`<app data>/recording/<id>/`, with `hand_landmarks.csv` and `clock_sync.csv`), not in the
repository; set CAMERA_RECORDINGS to another folder of them.

    uv run --project tools/label-trainer --with matplotlib python docs/research/artifacts/double-pinch-2026-10/imu_contact_check.py

Run from the repository root (under a minute). Writes imu-contact/results.json, results.md and, with matplotlib,
contact-averages.png.
"""
import csv, json, os, time
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
DEFAULT = Path.home() / "Library/Application Support/dev.meanotaku.spatial-gesture-control/recording"
SOURCE = Path(os.environ.get("CAMERA_RECORDINGS", DEFAULT))
THRESHOLD = 0.35                 # the app's default contact threshold (hand sizes)
HIGHPASS_S = 0.3                 # the jolt is what is left after this moving mean
WINDOW_S = 1.0                   # averages from this long before to after
NEAR_S = 0.15                    # a contact's jolt is looked for this close to it
RANDOM_CLEAR_S = 1.5
RANDOM_EVERY_S = 0.25
GRID_HZ = 50.0
WRIST, MIDDLE_MCP, THUMB_TIP, INDEX_TIP = 0, 9, 4, 8


def camera_frames(path):
    """(capture ms, closest thumb-to-index distance in hand sizes or NaN) per frame, in time order."""
    frames = {}
    with open(path) as f:
        reader = csv.reader(f)
        header = next(reader)
        w0 = header.index("wx0")
        for row in reader:
            if len(row) != len(header):
                continue
            key = int(row[0])
            ms = float(row[1])
            if row[2] == "":
                frames.setdefault(key, [ms, np.nan])
                continue
            try:
                world = np.array(row[w0:w0 + 63], dtype=float).reshape(21, 3)
            except ValueError:
                continue
            size = np.linalg.norm(world[WRIST] - world[MIDDLE_MCP])
            if not size > 1e-6:
                continue
            d = np.linalg.norm(world[THUMB_TIP] - world[INDEX_TIP]) / size
            current = frames.setdefault(key, [ms, np.nan])
            current[1] = d if np.isnan(current[1]) else min(current[1], d)
    out = np.array(sorted(frames.values()))
    return out[:, 0], out[:, 1]


def align(path):
    """Camera ms less this is the watch's ms (the smallest arrival delay), and the 90th-percentile spread above it."""
    delays = []
    with open(path) as f:
        next(f)
        for line in f:
            parts = line.strip().split(",")
            if len(parts) == 2 and parts[0] and parts[1]:
                delays.append(float(parts[1]) - float(parts[0]) / 1e6)
    if len(delays) < 5:
        return None
    delays.sort()
    return delays[0], delays[min(len(delays) - 1, int(len(delays) * 0.9))] - delays[0]


def crossings(times, dist):
    """Moments the distance falls below THRESHOLD from at or above it (contacts), and rises back (releases)."""
    contacts, releases = [], []
    state = None  # True open, False closed
    for t, d in zip(times, dist):
        if np.isnan(d):
            continue
        is_open = bool(d >= THRESHOLD)
        if state is True and not is_open:
            contacts.append(t)
        elif state is False and is_open:
            releases.append(t)
        state = is_open
    return np.array(contacts), np.array(releases)


def motion(path):
    """Watch-clock ms and (accel x/y/z, gyro x/y/z) of the rows that carry motion."""
    with open(path) as f:
        reader = csv.reader(f)
        header = next(reader)
        cols = [header.index(c) for c in ("accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z")]
        ts_col = header.index("timestamp_ns")
        ts, vals = [], []
        for row in reader:
            try:
                v = [float(row[c]) for c in cols]
            except (ValueError, IndexError):
                continue
            ts.append(int(row[ts_col]) / 1e6)
            vals.append(v)
    ts, vals = np.array(ts), np.array(vals)
    order = np.argsort(ts)
    return ts[order], vals[order]


def jolts(ms, values):
    """On a regular 50 Hz grid: the accelerometer and gyroscope jolt magnitudes, each in units of its recording's spread."""
    grid = np.arange(ms[0], ms[-1], 1000 / GRID_HZ)
    reg = np.column_stack([np.interp(grid, ms, values[:, c]) for c in range(6)])
    n = max(3, int(HIGHPASS_S * GRID_HZ))
    kernel = np.ones(n) / n
    quick = reg - np.column_stack([np.convolve(reg[:, c], kernel, mode="same") for c in range(6)])
    out = {}
    for name, cols in (("accelerometer", slice(0, 3)), ("gyroscope", slice(3, 6))):
        m = np.linalg.norm(quick[:, cols], axis=1)
        out[name] = (m - np.median(m)) / (np.median(np.abs(m - np.median(m))) * 1.4826 + 1e-12)
    # Samples further than a quarter second from any real motion sample are gaps.
    nearest = np.minimum(np.abs(grid - ms[np.clip(np.searchsorted(ms, grid), 0, len(ms) - 1)]),
                         np.abs(grid - ms[np.clip(np.searchsorted(ms, grid) - 1, 0, len(ms) - 1)]))
    return grid, out, nearest < 250


def windows(grid, signal, ok, moments):
    n = int(WINDOW_S * GRID_HZ)
    rows = []
    for t in moments:
        i = int(np.searchsorted(grid, t))
        if i - n >= 0 and i + n < len(grid) and ok[i - n:i + n + 1].all():
            rows.append(signal[i - n:i + n + 1])
    return np.array(rows).reshape(-1, 2 * n + 1)


def near_peak(grid, signal, ok, moments):
    vals = []
    for t in moments:
        m = (grid >= t - NEAR_S * 1000) & (grid <= t + NEAR_S * 1000)
        if m.sum() >= 3 and ok[m].all():
            vals.append(float(signal[m].max()))
    return vals


def main():
    t0 = time.time()
    out_dir = HERE / "imu-contact"; out_dir.mkdir(exist_ok=True)
    recs = sorted(d for d in SOURCE.iterdir() if (d / "hand_landmarks.csv").exists() and (d / "clock_sync.csv").exists() and (d / "raw.csv").exists())
    per = {}       # sensor -> kind -> [recording mean window]
    singles = {}   # sensor -> kind -> [values]
    info = []
    for d in recs:
        alignment = align(d / "clock_sync.csv")
        if alignment is None:
            continue
        offset, jitter = alignment
        cam_ms, dist = camera_frames(d / "hand_landmarks.csv")
        contacts, releases = crossings(cam_ms - offset, dist)
        ms, values = motion(d / "raw.csv")
        if len(contacts) < 3 or len(ms) < 200:
            continue
        grid, signals, ok = jolts(ms, values)
        contacts = contacts[(contacts > grid[0]) & (contacts < grid[-1])]
        if len(contacts) < 3:
            continue
        points = np.arange(grid[0] + 2000, grid[-1] - 2000, RANDOM_EVERY_S * 1000)
        random = points[np.min(np.abs(points[:, None] - contacts[None, :]), axis=1) > RANDOM_CLEAR_S * 1000]
        fps = (len(cam_ms) - 1) / ((cam_ms[-1] - cam_ms[0]) / 1000)
        motion_hz = (len(ms) - 1) / ((ms[-1] - ms[0]) / 1000)
        info.append({"recording": d.name, "contacts": int(len(contacts)), "releases": int(len(releases)), "random": int(len(random)),
                     "clock_jitter_ms": round(jitter, 1), "camera_fps": round(fps, 1), "motion_hz": round(motion_hz, 1)})
        for sensor, signal in signals.items():
            for kind, moments in (("contact", contacts), ("release", releases), ("random", random)):
                w = windows(grid, signal, ok, moments)
                if len(w):
                    per.setdefault(sensor, {}).setdefault(kind, []).append(w.mean(0))
                singles.setdefault(sensor, {}).setdefault(kind, []).extend(near_peak(grid, signal, ok, moments))

    n = int(WINDOW_S * GRID_HZ)
    times = (np.arange(2 * n + 1) - n) / GRID_HZ
    results = {"recordings": info, "averages": {}, "single": {}}
    for sensor, kinds in per.items():
        for kind, rows in kinds.items():
            mat = np.array(rows)
            mean, sem = mat.mean(0), mat.std(0, ddof=1) / np.sqrt(len(mat))
            near = np.abs(times) <= 0.3
            peak_i = int(np.argmax(np.where(near, mean, -np.inf)))
            # How much of each recording's average peaks near the moment (within 0.3 s), against its own baseline.
            base = (np.abs(times) >= 0.6)
            share = float(np.mean([row[near].max() > row[base].mean() + 2 * row[base].std() for row in mat]))
            results["averages"][f"{sensor}/{kind}"] = {"recordings": len(mat), "mean": [round(float(v), 3) for v in mean], "sem": [round(float(v), 3) for v in sem],
                                                       "peak_time_s": round(float(times[peak_i]), 3), "peak": round(float(mean[peak_i]), 3),
                                                       "peak_over_sem": round(float(mean[peak_i] / (sem[peak_i] + 1e-12)), 1),
                                                       "share_with_a_clear_peak": round(share, 3)}
        s = singles[sensor]
        for kind in ("contact", "release"):
            pos, neg = s.get(kind, []), s.get("random", [])
            results["single"][f"{sensor}/{kind}_vs_random"] = round(float(roc_auc_score(np.r_[np.ones(len(pos)), np.zeros(len(neg))], np.r_[pos, neg])), 3) if len(pos) > 2 else None
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    jit = [r["clock_jitter_ms"] for r in info]
    lines = [
        "# Does a pinch contact show as a jolt in the motion sensors?",
        "",
        f"{len(info)} recordings with camera hand tracking; {sum(r['contacts'] for r in info)} contacts, {sum(r['releases'] for r in info)} releases, "
        f"{sum(r['random'] for r in info)} random moments. Motion at {np.median([r['motion_hz'] for r in info]):.0f} Hz, camera at "
        f"{np.median([r['camera_fps'] for r in info]):.0f} frames a second; the clocks line up to within {np.median(jit):.0f} ms (median of the recordings' 90th-percentile spread; "
        f"{min(jit):.0f} to {max(jit):.0f} ms).",
        "",
        "## One moment at a time",
        "",
        f"ROC AUC of the largest jolt within {int(NEAR_S * 1000)} ms of the moment, against random moments (0.5 is chance).",
        "",
        "| Sensor | Contact vs random | Release vs random |",
        "|---|---:|---:|",
    ]
    for sensor in per:
        lines.append(f"| {sensor} | {results['single'][f'{sensor}/contact_vs_random']:.3f} | {results['single'][f'{sensor}/release_vs_random']:.3f} |")
    lines += [
        "",
        "## Averages",
        "",
        "The jolt (in units of each recording's spread) averaged around each kind of moment: its peak within 0.3 s, how many",
        "standard errors that stands above zero, and the share of recordings whose own average peaks clearly (two standard",
        "deviations above its level 0.6-1 s away).",
        "",
        "| Sensor | Moment | Peak at | Peak | Peak / SE | Recordings with a clear peak |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for sensor in per:
        for kind in ("contact", "release", "random"):
            a = results["averages"].get(f"{sensor}/{kind}")
            if a:
                lines.append(f"| {sensor} | {kind} | {a['peak_time_s']:+.2f} s | {a['peak']:+.2f} | {a['peak_over_sem']:.1f} | {a['share_with_a_clear_peak']:.0%} ({a['recordings']}) |")
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.6), sharey=True)
    colors = {"contact": "#d62728", "release": "#1f77b4", "random": "#7f7f7f"}
    for ax, sensor in zip(axes, per):
        for kind in ("contact", "release", "random"):
            a = results["averages"].get(f"{sensor}/{kind}")
            if a:
                m, s = np.array(a["mean"]), np.array(a["sem"])
                ax.plot(times, m, color=colors[kind], label=f"{kind} ({a['recordings']} rec.)")
                ax.fill_between(times, m - s, m + s, color=colors[kind], alpha=0.2)
        ax.axvline(0, color="black", lw=0.6)
        ax.set_title(f"{sensor} jolt", fontsize=10)
        ax.set_xlabel("s from the moment (camera, on the watch clock)")
    axes[0].set_ylabel("spread units")
    axes[0].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out_dir / "contact-averages.png", dpi=120)
    print(f"figure: {out_dir / 'contact-averages.png'}")


if __name__ == "__main__":
    main()
