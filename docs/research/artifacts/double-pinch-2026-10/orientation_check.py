"""Is a pinch's jolt sharper with the arm in one pose than in another?

The watch's rotation vector (`quat_*`) gives its orientation at every motion sample, so the direction of "up" in the
watch's own axes is known at each pinch. Each pinch in the repository's recordings is put in a pose by the watch axis
"up" lies closest to: the face (arm flat, face up), the y axis (arm on its side), or the x axis (forearm upright). For
each pinch, from 0.5 s before to 1.0 s after its labelled start:

* the jolt's peak: each axis less its 0.3 s moving mean, as the magnitude over the three axes, in m/s² (the recordings'
  accelerometer is Android's linear acceleration, gravity removed) and rad/s, not rescaled, so recordings compare;
* its width at half height above the stillness before the pinch (3 to 1 s before), and the peak over that stillness.

Poses are compared over all pinches (medians), and then within the recordings that hold pinches in more than one pose,
since a recording's own conditions (strap, pinch firmness, day) can differ more than poses do.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/orientation_check.py

Run from the repository root (a few seconds). Writes orientation/results.json and results.md.
"""
import json, sys, time
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools/label-trainer/src"))
from label_trainer import label_train as lt, ppg_onset as P  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402

FOLDERS = ("data/recordings/2026-10-downloads", "data/recordings/31oct")
GRID_HZ = 50.0
HIGHPASS_S = 0.3
AROUND_S = (-0.5, 1.0)
STILL_S = (-3.0, -1.0)
MIN_PER_POSE = 3                 # pinches a recording needs in a pose to count in the within-recording comparison
POSES = {(2, 1): "face up (arm flat)", (2, -1): "face down", (1, 1): "y up", (1, -1): "y down (arm on its side)",
         (0, 1): "x up (forearm upright)", (0, -1): "x down"}


def moving_mean(x, n):
    c = np.concatenate([[0.0], np.cumsum(x)])
    i = np.arange(len(x))
    lo, hi = np.maximum(0, i - n // 2), np.minimum(len(x), i + n // 2 + 1)
    return (c[hi] - c[lo]) / (hi - lo)


def up_in_watch_axes(q):
    """World up in the watch's axes, from a (w, x, y, z) rotation vector quaternion (watch to world)."""
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)])


def spike(j, grid, start):
    """(peak, width in s at half height above the stillness, peak over the stillness) around one pinch, or None."""
    m = (grid >= start + AROUND_S[0] * 1e9) & (grid <= start + AROUND_S[1] * 1e9)
    still = (grid >= start + STILL_S[0] * 1e9) & (grid < start + STILL_S[1] * 1e9)
    if m.sum() < 10:
        return None
    seg = j[m]
    i = int(np.argmax(seg))
    base = float(np.median(j[still])) if still.sum() > 5 else float(np.median(j))
    above = seg >= base + (seg[i] - base) / 2
    a = b = i
    while a > 0 and above[a - 1]:
        a -= 1
    while b < len(seg) - 1 and above[b + 1]:
        b += 1
    return float(seg[i]), (b - a + 1) / GRID_HZ, float(seg[i] / (base + 1e-12))


def main():
    t0 = time.time()
    out_dir = HERE / "orientation"; out_dir.mkdir(exist_ok=True)
    pinches = []
    for path in [p for f in FOLDERS for p in sorted((ROOT / f).iterdir()) if p.suffix == ".csv" or p.is_dir()]:
        recording = load_recording(path)
        ts, imu = lt.motion_of(recording)
        rows = recording.orient_observed if recording.orient_observed is not None else np.ones(len(recording.timestamps_ns), dtype=bool)
        quat = np.stack([recording.channels[c][rows] for c in ("quat_w", "quat_x", "quat_y", "quat_z")], axis=1)
        ok = np.isfinite(imu).all(1) & np.isfinite(quat).all(1)
        ts, imu, quat = ts[ok], imu[ok], quat[ok]
        if len(ts) < 200 or len(ts) / ((ts[-1] - ts[0]) / 1e9) < 10:
            continue
        grid = np.arange(ts[0], ts[-1], int(1e9 / GRID_HZ), dtype=np.int64)
        n = max(3, int(HIGHPASS_S * GRID_HZ))
        jolts = {}
        for sensor, first in (("accelerometer", 0), ("gyroscope", 3)):
            cols = [np.interp(grid, ts, imu[:, c]) for c in range(first, first + 3)]
            jolts[sensor] = np.linalg.norm(np.stack([c - moving_mean(c, n) for c in cols], axis=1), axis=1)
        labels = np.where(recording.raw_labels == "pinching", "pinch", recording.raw_labels)
        for s, _, label in P.holds(recording.timestamps_ns, labels):
            if label != "pinch":
                continue
            got = {sensor: spike(j, grid, s) for sensor, j in jolts.items()}
            if any(v is None for v in got.values()):
                continue
            up = up_in_watch_axes(quat[min(np.searchsorted(ts, s), len(ts) - 1)])
            axis = int(np.argmax(np.abs(up)))
            pinches.append({"recording": path.name, "pose": POSES[(axis, int(np.sign(up[axis])))], **got})

    def summary(group):
        out = {"pinches": len(group), "recordings": len({p["recording"] for p in group})}
        for sensor in ("accelerometer", "gyroscope"):
            out[sensor] = {
                "peak": float(np.median([p[sensor][0] for p in group])),
                "width_s": float(np.median([p[sensor][1] for p in group])),
                "over_stillness": float(np.median([p[sensor][2] for p in group])),
            }
        return out

    by_pose = defaultdict(list)
    by_recording = defaultdict(list)
    for p in pinches:
        by_pose[p["pose"]].append(p)
        by_recording[p["recording"]].append(p)
    within = []
    for rec, group in sorted(by_recording.items()):
        counts = Counter(p["pose"] for p in group)
        poses = [pose for pose, c in counts.items() if c >= MIN_PER_POSE]
        if len(poses) >= 2:
            within.append({"recording": rec, "poses": {pose: summary([p for p in group if p["pose"] == pose]) for pose in poses}})
    results = {
        "pinches": len(pinches),
        "by_pose": {pose: summary(group) for pose, group in by_pose.items()},
        "within_recordings": within,
        "seconds": round(time.time() - t0, 1),
    }
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    lines = [
        "# Is a pinch's jolt sharper in one arm pose than another?",
        "",
        f"{len(pinches)} pinches in the repository's recordings, each put in a pose by the watch axis world up lies closest to.",
        "Medians; peaks are of the jolt (each axis less its 0.3 s moving mean), not rescaled.",
        "",
        "## All pinches by pose",
        "",
        "| Pose | Pinches | Recordings | Accel peak (m/s²) | Accel width | Accel / stillness | Gyro peak (rad/s) | Gyro width | Gyro / stillness |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for pose, s in sorted(results["by_pose"].items(), key=lambda kv: -kv[1]["pinches"]):
        a, g = s["accelerometer"], s["gyroscope"]
        lines.append(f"| {pose} | {s['pinches']} | {s['recordings']} | {a['peak']:.3f} | {a['width_s'] * 1000:.0f} ms | {a['over_stillness']:.1f}× "
                     f"| {g['peak']:.3f} | {g['width_s'] * 1000:.0f} ms | {g['over_stillness']:.1f}× |")
    lines += [
        "",
        f"## Within recordings that hold at least {MIN_PER_POSE} pinches in more than one pose",
        "",
        "| Recording | Pose | Pinches | Accel peak (m/s²) | Gyro peak (rad/s) |",
        "|---|---|---:|---:|---:|",
    ]
    for w in within:
        for pose, s in w["poses"].items():
            lines.append(f"| {w['recording']} | {pose} | {s['pinches']} | {s['accelerometer']['peak']:.3f} | {s['gyroscope']['peak']:.3f} |")
    if not within:
        lines.append("| (none) | | | | |")
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
