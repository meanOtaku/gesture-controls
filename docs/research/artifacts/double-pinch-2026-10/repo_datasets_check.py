"""What do the repository's recordings say about a double pinch found from the motion sensors alone?

The recordings in `data/recordings/` hold single pinches, other gestures (fist, thumbs up, hand open, wrist twist) and
everyday activity, but no double pinches. A double pinch is two pinch contacts in quick succession, so these recordings can
still answer the two questions a detector depends on:

* **Does each pinch show?** The "jolt" (each accelerometer and gyroscope axis less its 0.3 s moving mean, as the magnitude
  over the three axes, in units of the recording's own spread; the accelerometer's and the gyroscope's averaged) has a
  peak at a contact (`imu_contact_check.py`). A pinch counts as found when the jolt peaks above a threshold from 0.5 s
  before to 1.0 s after its labelled start (labels are often a few hundred milliseconds late). Two pinches each found
  with chance p make a double pinch found with chance about p squared; the pairs of real pinches in each recording give
  that figure directly (both of the pair found).
* **What else looks like one?** The double-pinch rule: two jolt peaks 0.15 to 0.6 s apart, with no other peak in the
  0.5 s before the first or after the second (a double pinch is a short burst in stillness; walking or typing is a run of
  peaks). It is counted over everyday stretches (the everything_else and unlabelled recordings, and the time in gesture
  recordings 1.5 s or more from any labelled gesture), as false double pinches per minute, and over each other gesture's
  holds and each single pinch, as the share that would set it off.

Peaks are local maxima of the jolt above the threshold, at least 0.1 s apart. Motion is put on a 50 Hz grid (the
recordings' rate). Recordings whose clock is broken (under 10 samples a second) are left out.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/repo_datasets_check.py

Run from the repository root (under a minute). Writes repo-datasets/results.json and results.md.
"""
import json, sys, time
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools/label-trainer/src"))
from label_trainer import label_train as lt, ppg_onset as P  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402

FOLDERS = ("data/recordings/old/2026-10-downloads", "data/recordings/old/31oct")
GRID_HZ = 50.0
HIGHPASS_S = 0.3
AROUND_S = (-0.5, 1.0)           # where a pinch's peak is looked for, from its labelled start
PEAK_GAP_S = 0.1
DOUBLE_GAP_S = (0.15, 0.6)
QUIET_S = 0.5
CLEAR_S = 1.5                    # everyday time is this far from any labelled gesture
THRESHOLDS = (2.0, 3.0, 4.0, 5.0, 6.0, 8.0)
PAIR_GAP_S = 6.0                 # pinches this close in one recording are paired


def moving_mean(x, n):
    c = np.concatenate([[0.0], np.cumsum(x)])
    i = np.arange(len(x))
    lo, hi = np.maximum(0, i - n // 2), np.minimum(len(x), i + n // 2 + 1)
    return (c[hi] - c[lo]) / (hi - lo)


def robust(x):
    spread = np.median(np.abs(x - np.median(x))) * 1.4826
    return (x - np.median(x)) / (spread + 1e-12)


def jolt(recording):
    """(grid timestamps in ns, jolt) or None when the motion is unusable."""
    ts, imu = lt.motion_of(recording)
    ok = np.isfinite(imu).all(1)
    ts, imu = ts[ok], imu[ok]
    if len(ts) < 200:
        return None
    span = (ts[-1] - ts[0]) / 1e9
    if len(ts) / span < 10:
        return None
    grid = np.arange(ts[0], ts[-1], int(1e9 / GRID_HZ), dtype=np.int64)
    n = max(3, int(HIGHPASS_S * GRID_HZ))
    parts = []
    for axes in (slice(0, 3), slice(3, 6)):
        cols = [np.interp(grid, ts, imu[:, c]) for c in range(axes.start, axes.stop)]
        quick = np.stack([c - moving_mean(c, n) for c in cols], axis=1)
        parts.append(robust(np.linalg.norm(quick, axis=1)))
    return grid, (parts[0] + parts[1]) / 2


def peaks(t, j, threshold):
    """Times (ns) of local maxima above the threshold, at least PEAK_GAP_S apart (the larger kept)."""
    i = np.flatnonzero((j[1:-1] > threshold) & (j[1:-1] >= j[:-2]) & (j[1:-1] > j[2:])) + 1
    kept = []
    for k in i[np.argsort(-j[i])]:
        if all(abs(t[k] - t[m]) >= PEAK_GAP_S * 1e9 for m in kept):
            kept.append(k)
    return np.sort(t[np.array(kept, dtype=int)]) if kept else np.array([], dtype=np.int64)


def doubles(p):
    """Start times of double-pinch triggers among the peak times `p` (sorted, ns)."""
    out = []
    for a in range(len(p) - 1):
        gap = (p[a + 1] - p[a]) / 1e9
        if not (DOUBLE_GAP_S[0] <= gap <= DOUBLE_GAP_S[1]):
            continue
        before_ok = a == 0 or (p[a] - p[a - 1]) / 1e9 > QUIET_S
        after_ok = a + 2 >= len(p) or (p[a + 2] - p[a + 1]) / 1e9 > QUIET_S
        if before_ok and after_ok:
            out.append(p[a])
    return np.array(out, dtype=np.int64)


def main():
    t0 = time.time()
    out_dir = HERE / "repo-datasets"; out_dir.mkdir(exist_ok=True)
    paths = [p for f in FOLDERS for p in sorted((ROOT / f).iterdir()) if p.suffix == ".csv" or p.is_dir()]
    used, skipped = [], []
    tallies = {th: {"pinches": 0, "found": 0, "pairs": 0, "pairs_found": 0, "single_triggers": 0,
                    "everyday_s": 0.0, "everyday_triggers": 0, "gestures": {},
                    "chance_windows": 0, "chance_found": 0} for th in THRESHOLDS}
    for path in paths:
        recording = load_recording(path)
        got = jolt(recording)
        if got is None:
            skipped.append(path.name); continue
        used.append(path.name)
        t, j = got
        labels = np.where(recording.raw_labels == "pinching", "pinch", recording.raw_labels)
        held = P.holds(recording.timestamps_ns, labels)
        busy = np.zeros(len(t), dtype=bool)
        for s, e, _ in held:
            busy |= (t >= s - CLEAR_S * 1e9) & (t <= e + CLEAR_S * 1e9)
        # Everyday stretches: runs of grid points far from any gesture, 2 s or longer.
        runs, start = [], None
        for k, b in enumerate(np.r_[busy, True]):
            if not b and start is None:
                start = k
            elif b and start is not None:
                if (k - start) / GRID_HZ >= 2.0:
                    runs.append((start, k))
                start = None
        pinch_starts = [s for s, _, label in held if label == "pinch"]
        for th in THRESHOLDS:
            tl = tallies[th]
            p = peaks(t, j, th)
            trig = doubles(p)
            found = []
            for s in pinch_starts:
                near = p[(p >= s + AROUND_S[0] * 1e9) & (p <= s + AROUND_S[1] * 1e9)]
                found.append(len(near) > 0)
            tl["pinches"] += len(pinch_starts); tl["found"] += sum(found)
            for a in range(len(pinch_starts) - 1):
                if (pinch_starts[a + 1] - pinch_starts[a]) / 1e9 <= PAIR_GAP_S:
                    tl["pairs"] += 1; tl["pairs_found"] += found[a] and found[a + 1]
            for s, e, label in held:
                hit = bool(((trig >= s + AROUND_S[0] * 1e9) & (trig <= e + 0.5e9)).any())
                if label == "pinch":
                    tl["single_triggers"] += hit
                else:
                    g = tl["gestures"].setdefault(label, [0, 0]); g[0] += 1; g[1] += hit
            for a, b in runs:
                tl["everyday_s"] += (b - a) / GRID_HZ
                tl["everyday_triggers"] += int(((trig >= t[a]) & (trig < t[b - 1])).sum())
                # Chance: the same window as a pinch's, every half second along the stretch.
                width = (AROUND_S[1] - AROUND_S[0]) * 1e9
                for w in np.arange(t[a], t[b - 1] - width, 0.5e9):
                    tl["chance_windows"] += 1
                    tl["chance_found"] += bool(((p >= w) & (p <= w + width)).any())

    results = {"recordings": len(used), "skipped": skipped, "thresholds": {}}
    for th, tl in tallies.items():
        p = tl["found"] / max(1, tl["pinches"])
        results["thresholds"][str(th)] = {
            "pinch_found": p,
            "pinch_found_squared": p * p,
            "chance_found": tl["chance_found"] / max(1, tl["chance_windows"]),
            "pairs_both_found": tl["pairs_found"] / max(1, tl["pairs"]),
            "pairs": tl["pairs"],
            "single_pinches_triggering": tl["single_triggers"] / max(1, tl["pinches"]),
            "everyday_minutes": tl["everyday_s"] / 60,
            "everyday_false_per_minute": tl["everyday_triggers"] / max(1e-9, tl["everyday_s"] / 60),
            "everyday_false": tl["everyday_triggers"],
            "other_gestures_triggering": {k: {"holds": v[0], "share": v[1] / max(1, v[0])} for k, v in tl["gestures"].items()},
            "pinches": tl["pinches"],
        }
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    r = results["thresholds"]
    gestures = sorted({g for v in r.values() for g in v["other_gestures_triggering"]})
    first = r[str(THRESHOLDS[0])]
    lines = [
        "# A double pinch from the motion sensors: what the repository's recordings say",
        "",
        f"{results['recordings']} recordings ({len(skipped)} left out for a broken clock), {first['pinches']} single pinches,"
        f" {first['pairs']} pairs of pinches within {PAIR_GAP_S:.0f} s, {first['everyday_minutes']:.1f} minutes of everyday time."
        " No recording holds a real double pinch.",
        "",
        "Threshold is the jolt peak height, in units of the recording's spread.",
        "",
        "## Each pinch, and pairs of pinches",
        "",
        "| Threshold | Pinch found | Same window, everyday (chance) | Squared | Both of a real pair found |",
        "|---:|---:|---:|---:|---:|",
    ]
    for th in THRESHOLDS:
        v = r[str(th)]
        lines.append(f"| {th:g} | {v['pinch_found']:.0%} | {v['chance_found']:.0%} | {v['pinch_found_squared']:.0%} | {v['pairs_both_found']:.0%} |")
    lines += [
        "",
        f"## What sets off the double-pinch rule (two peaks {DOUBLE_GAP_S[0]}-{DOUBLE_GAP_S[1]} s apart, quiet {QUIET_S} s either side)",
        "",
        "| Threshold | Everyday: false per minute | Single pinches | " + " | ".join(gestures) + " |",
        "|---:|---:|---:|" + "---:|" * len(gestures),
    ]
    for th in THRESHOLDS:
        v = r[str(th)]
        og = v["other_gestures_triggering"]
        lines.append(f"| {th:g} | {v['everyday_false_per_minute']:.2f} ({v['everyday_false']}) | {v['single_pinches_triggering']:.0%} | "
                     + " | ".join(f"{og[g]['share']:.0%} of {og[g]['holds']}" if g in og else "–" for g in gestures) + " |")
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
