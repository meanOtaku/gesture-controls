"""Splits the old pinch recordings that have no camera data into pinch_in, pinch_hold and pinch_out, from the watch's motion.

`relabel_pinch_from_camera.py` placed each touch and release from the camera; these recordings were made with the camera
off, so only their button labels (`pinch`, pressed and let go about a reaction time from the movement) and the watch's
motion are left. How far a recording's labels sit from its movement differs from session to session (by up to a second),
so each recording is calibrated on its own:

1. The jolt: per motion row, how far the accelerometer and the gyroscope are from their mean over the 150 ms either side,
   each scaled by its median over the recording, added.
2. Averaged over the recording's pinches, the jolt peaks at some offset from the label's start (and from its end).
3. The real touch comes `TOUCH_GAP` after that peak, and the release `RELEASE_GAP`: the median gaps on the recordings the
   camera split, where the touch and the release are known.

Each pinch's touch is then its label's start plus the recording's offset plus TOUCH_GAP, and its release likewise from the
label's end. The same rule, tried on each camera-split recording with the gaps learned from the others, put the touch
within 200 ms of the camera's for most pinches and the release less often (the numbers are in the README this writes).
A label too short to have been held (a mark, not a press), or one that ends before its touch could have been let go (a
prompt of fixed length, not a press), gives no release: the 3 s after its touch become `left_out`, so its release is never
taken for "not a pinch" (nor "not a release"). Label edges are read from the motion rows: a folder's pulse rows can be
timed a little apart from them. A recording whose pinches do not jolt clearly, or whose motion rows repeat samples a
few nanoseconds apart (the oldest export format), is not written.

    python3 scripts/split_pinch_from_motion.py

Writes data/recordings/pinch-motion-split/ (the same file layout as each source) and its README.md. data/recordings/old/
is not changed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from statistics import median

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from relabel_pinch_from_camera import (  # noqa: E402
    LEFT_OUT, MARK_NS, PINCH_HOLD, PINCH_IN, PINCH_OUT, SOURCE, Table, holds,
)

ROOT = Path(__file__).resolve().parent.parent
CAMERA_SPLIT = ROOT / "data" / "recordings" / "pinch-relabelled"
OUT = ROOT / "data" / "recordings" / "pinch-motion-split"
MS = 1_000_000
HALF_SPAN_NS = 150 * MS
LAGS_MS = np.arange(-1000, 1001, 20)
MIN_PRESS_NS = 400 * MS          # a shorter label is a mark: it says when, not how long
NO_RELEASE_LEFT_OUT_NS = 3_000 * MS
MAX_REPEATED_SHARE = 0.05       # more motion rows than this under 1 ms apart: repeated samples, so no usable timing
MIN_PROMINENCE = 1.5             # the averaged jolt's peak over its median, below which the recording has no clear jolt
MOTION = ("accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z")


def tables_of(source: Path) -> list[Table]:
    files = [source / "imu.csv", source / "ppg.csv"] if source.is_dir() else [source]
    return [Table(f) for f in files if f.exists()]


def motion(tables: list[Table]) -> tuple[np.ndarray, np.ndarray, list[tuple[int, str]]]:
    """(timestamps, jolt) of the motion rows, in time order, and each motion row's (timestamp, label)."""
    stamps, values, labels = [], [], []
    for table in tables:
        columns = table.header.split(",")
        if not all(c in columns for c in MOTION):
            continue
        at = [columns.index(c) for c in MOTION]
        for row in table.rows:
            if len(row) > max(at) and all(row[i] != "" for i in at):
                stamps.append(int(row[table.ts]))
                values.append([float(row[i]) for i in at])
                labels.append((int(row[table.ts]), row[table.label]))
    order = np.argsort(stamps)
    t, x = np.array(stamps, dtype=np.int64)[order], np.array(values)[order]
    lo, hi = np.searchsorted(t, t - HALF_SPAN_NS), np.searchsorted(t, t + HALF_SPAN_NS, side="right")
    sums = np.vstack([np.zeros(6), np.cumsum(x, axis=0)])
    deviation = x - (sums[hi] - sums[lo]) / (hi - lo)[:, None]
    accel, gyro = np.linalg.norm(deviation[:, :3], axis=1), np.linalg.norm(deviation[:, 3:], axis=1)
    return t, accel / max(np.median(accel), 1e-9) + gyro / max(np.median(gyro), 1e-9), labels


def stamped(tables: list[Table]) -> list[tuple[int, str]]:
    return [(int(row[t.ts]), row[t.label]) for t in tables for row in t.rows]


def offset_ms(t: np.ndarray, jolt: np.ndarray, edges: list[int]) -> tuple[int, float]:
    """Where, from these label edges, the recording's averaged jolt peaks, and how clearly (peak over median)."""
    profile = np.mean([np.interp(edge + LAGS_MS * MS, t, jolt) for edge in edges], axis=0)
    return int(LAGS_MS[np.argmax(profile)]), float(profile.max() / np.median(profile))


def camera_examples() -> list[dict]:
    """Per camera-split recording: its pinch label edges, the camera's touch and release for each, and its offsets."""
    out = []
    for split in sorted(p for p in CAMERA_SPLIT.rglob("gesture-dataset-pinch-*") if not p.parent.name.startswith("gesture-dataset")):
        source = SOURCE / split.relative_to(CAMERA_SPLIT)
        if not source.exists():
            continue
        tables = tables_of(source)
        t, jolt, motion_labels = motion(tables)
        truth = stamped(tables_of(split))
        touches = [s for s, _ in holds(truth, PINCH_IN)]
        releases = [s for s, _ in holds(truth, PINCH_OUT)]
        pinches = []
        for start, end in holds(motion_labels, "pinch"):
            near = [s for s in touches if start - 1_500 * MS <= s <= end]
            if not near:
                continue
            touch = min(near, key=lambda s: abs(s - start))
            later = [s for s in releases if touch < s <= end + 1_500 * MS]
            pinches.append((start, end, touch, min(later, key=lambda s: abs(s - end)) if later else None))
        if pinches:
            out.append({"name": str(source.relative_to(SOURCE)), "pinches": pinches,
                        "start": offset_ms(t, jolt, [p[0] for p in pinches])[0],
                        "end": offset_ms(t, jolt, [p[1] for p in pinches])[0]})
    return out


def gap(examples: list[dict], edge: int, truth: int, key: str) -> float:
    """The median, over recordings, of each recording's median of (camera time - (label edge + its offset)), in ms."""
    return float(median(median((p[truth] - p[edge]) / MS - e[key] for p in e["pinches"] if p[truth] is not None)
                        for e in examples if any(p[truth] is not None for p in e["pinches"])))


def blind_test(examples: list[dict]) -> dict[str, list[float]]:
    """Each camera-split recording placed with the gaps learned from the others: the error of each touch and release, ms."""
    errors: dict[str, list[float]] = {"touch": [], "release": []}
    for i, e in enumerate(examples):
        others = examples[:i] + examples[i + 1:]
        touch_gap, release_gap = gap(others, 0, 2, "start"), gap(others, 1, 3, "end")
        for start, end, touch, release in e["pinches"]:
            errors["touch"].append((start / MS + e["start"] + touch_gap) - touch / MS)
            if release is not None:
                errors["release"].append((end / MS + e["end"] + release_gap) - release / MS)
    return errors


def split(source: Path, touch_gap: float, release_gap: float) -> dict:
    tables = tables_of(source)
    t, jolt, motion_labels = motion(tables)
    pinches = holds(motion_labels, "pinch")
    if not pinches or len(t) == 0:
        return {"written": False, "reason": "no pinch with motion"}
    repeated = float(np.mean(np.diff(t) < MS))
    if repeated > MAX_REPEATED_SHARE:
        return {"written": False, "reason": f"{repeated:.0%} of its motion rows repeat a sample under 1 ms later, so its timing cannot be used"}
    start_offset, prominence = offset_ms(t, jolt, [s for s, _ in pinches])
    if prominence < MIN_PROMINENCE:
        return {"written": False, "reason": f"its pinches do not jolt clearly (peak {prominence:.1f}x the usual)"}
    pressed = [(s, e) for s, e in pinches if e - s >= MIN_PRESS_NS]
    end_offset = offset_ms(t, jolt, [e for _, e in pressed])[0] if pressed else None
    touches = [round(start + (start_offset + touch_gap) * MS) for start, _ in pinches]
    intervals: list[tuple[int, int, str]] = []
    released = 0
    for k, ((start, end), touch) in enumerate(zip(pinches, touches)):
        # Pinches can follow each other closely: nothing of one runs into the next one's touch.
        until = touches[k + 1] if k + 1 < len(touches) else None
        release = (round(end + (end_offset + release_gap) * MS)
                   if end_offset is not None and end - start >= MIN_PRESS_NS else None)
        if release is not None and (release <= touch + MARK_NS or (until is not None and release >= until)):
            release = None
        clip = (lambda ns: ns) if until is None else (lambda ns: min(ns, until))  # noqa: E731
        intervals.append((touch, clip(touch + MARK_NS), PINCH_IN))
        if release is None:
            intervals.append((touch + MARK_NS, clip(touch + NO_RELEASE_LEFT_OUT_NS), LEFT_OUT))
            continue
        intervals.append((touch + MARK_NS, release, PINCH_HOLD))
        intervals.append((release, clip(release + MARK_NS), PINCH_OUT))
        released += 1

    def label_at(ts: int, old: str) -> str:
        for a, b, label in intervals:
            if a <= ts < b:
                return label
        return "" if old == "pinch" else old

    labels: set[str] = set()
    for table in tables:
        for row in table.rows:
            row[table.label] = label_at(int(row[table.ts]), row[table.label])
            if row[table.label]:
                labels.add(row[table.label])
    target = OUT / source.relative_to(SOURCE)
    if source.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        for table in tables:
            table.write(target / table.path.name)
        for extra in source.iterdir():
            if extra.name == "dataset.json":
                meta = json.loads(extra.read_text())
                meta["labels"] = sorted(labels)
                (target / extra.name).write_text(json.dumps(meta, indent=2) + "\n")
            elif extra.name not in ("imu.csv", "ppg.csv"):
                (target / extra.name).write_bytes(extra.read_bytes())
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        tables[0].write(target)
    return {"written": True, "pinches": len(pinches), "released": released, "offset": start_offset,
            "prominence": prominence}


def share(errors: list[float], ms: int) -> str:
    return f"{np.mean(np.abs(errors) <= ms):.0%}"


def main() -> int:
    examples = camera_examples()
    touch_gap, release_gap = gap(examples, 0, 2, "start"), gap(examples, 1, 3, "end")
    errors = blind_test(examples)
    split_by_camera = {str(p.relative_to(CAMERA_SPLIT)) for p in CAMERA_SPLIT.rglob("gesture-dataset-pinch-*")}
    report = []
    for source in sorted(p for p in SOURCE.rglob("*") if (p.suffix == ".csv" and p.parent.parent == SOURCE) or (p.is_dir() and (p / "imu.csv").exists())):
        name = str(source.relative_to(SOURCE))
        if name in split_by_camera or "pinch" not in {label for _, label in stamped(tables_of(source))}:
            continue
        report.append((name, split(source, touch_gap, release_gap)))
    written = [(n, r) for n, r in report if r["written"]]
    skipped = [(n, r) for n, r in report if not r["written"]]
    lines = [
        "# Old pinch recordings without camera data, split from the watch's motion",
        "",
        "Made by `scripts/split_pinch_from_motion.py` from `data/recordings/old/` (unchanged). Each `pinch` label is",
        "`pinch_in` (0.3 s from the touch), `pinch_hold` (to the release) and `pinch_out` (0.3 s from the release), placed",
        "from the recording's own motion (see the script). A label that cannot say when the fingers parted gives no release:",
        "the 3 s after its touch are `left_out`. Other labels are kept. These are estimates: prefer the camera-split recordings",
        "(`../pinch-relabelled/`) where both exist.",
        "",
        f"Learned on {len(examples)} camera-split recordings: the touch comes {touch_gap:+.0f} ms from the averaged jolt, "
        f"the release {release_gap:+.0f} ms.",
        "",
        "Tried on each camera-split recording with the gaps learned from the others:",
        "",
        "| | Within 100 ms of the camera | Within 200 ms | Within 300 ms |",
        "|---|---:|---:|---:|",
        f"| Touch ({len(errors['touch'])}) | {share(errors['touch'], 100)} | {share(errors['touch'], 200)} | {share(errors['touch'], 300)} |",
        f"| Release ({len(errors['release'])}) | {share(errors['release'], 100)} | {share(errors['release'], 200)} | {share(errors['release'], 300)} |",
        "",
        "| Recording | Pinches | With a release | Jolt from label start | Jolt clarity |",
        "|---|---:|---:|---:|---:|",
        *(f"| {n} | {r['pinches']} | {r['released']} | {r['offset']:+d} ms | {r['prominence']:.1f}x |" for n, r in written),
        "",
        f"Total: {sum(r['pinches'] for _, r in written)} pinches split.",
        "",
        "Not split:",
        "",
        *(f"- {n}: {r['reason']}" for n, r in skipped),
        *([] if skipped else ["- none"]),
    ]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "README.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
