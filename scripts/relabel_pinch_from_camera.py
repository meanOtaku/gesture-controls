"""Relabels the old pinch recordings as pinch_in, pinch_hold and pinch_out, from their saved camera landmarks.

The recordings in data/recordings/old/ label each pinch "pinch", from a button pressed about a reaction time after the
fingers met. Those made with the camera on have the camera's hand landmarks saved beside them in the app's recording
bundles. This finds each recording's bundle (by its start time), measures the thumb-to-index distance in every camera
frame exactly as the app does (`landmarkMath.ts`: tip to tip over wrist to middle knuckle, the closest hand), puts the
frames on the watch clock (the smallest arrival delay in clock_sync.csv, as `recording_bundle::landmarks_on_watch_clock`),
and finds the touches and releases with the app's live rule (`pinchEdgeMarker.ts`): a touch where the distance falls below
0.35 hand sizes once it has been open (0.45 or more), a release timed where it rose back past 0.35 and counted at 0.45,
and no edge from the first reading after the hand was lost for 400 ms.

Each labelled pinch then becomes, from the first touch from 1 s before it to its end and the first release after that
touch (until 1 s after its end):

    pinch_in    0.3 s from the touch (or until the release, if that is sooner)
    pinch_hold  from the end of pinch_in to the release
    pinch_out   0.3 s from the release

A pinch the camera saw no touch in becomes left_out (always excluded from training, so it is not taken for "not a
pinch"); without a release, pinch_hold runs to the last frame that saw the fingers together. These camera-placed labels
take precedence over any button label they overlap (those trail the movement, so the end of the gesture before, often
hand_open, can still be on at the touch). Rows that said "pinch" and fall in none of them lose the label; other labels
(fist, hand_open, ...) are otherwise kept. Only recordings that hold a pinch and
have a camera bundle are written; the rest cannot be relabelled and are listed.

    python3 scripts/relabel_pinch_from_camera.py

Writes data/recordings/pinch-relabelled/ (the same file layout as each source) and its README.md. data/recordings/old/
is not changed.
"""

from __future__ import annotations

import csv
import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "recordings" / "old"
OUT = ROOT / "data" / "recordings" / "pinch-relabelled"
BUNDLES = Path(os.environ.get(
    "CAMERA_RECORDINGS",
    Path.home() / "Library/Application Support/dev.meanotaku.spatial-gesture-control/recording",
))

CONTACT = 0.35
RELEASE = CONTACT + 0.1
MARK_NS = 300_000_000
LOST_MS = 400.0
BEFORE_NS, AFTER_NS = 1_000_000_000, 1_000_000_000
WRIST, MIDDLE_MCP, THUMB_TIP, INDEX_TIP = 0, 9, 4, 8
PINCH_IN, PINCH_HOLD, PINCH_OUT, LEFT_OUT = "pinch_in", "pinch_hold", "pinch_out", "left_out"


def started_at(path: Path) -> datetime | None:
    source = path / "imu.csv" if path.is_dir() else path
    with open(source) as f:
        for line in f:
            if line.startswith("# started_at:"):
                return datetime.fromisoformat(line.split(":", 1)[1].strip().replace("Z", "+00:00"))
            if not line.startswith("#"):
                return None
    return None


def bundles() -> dict[datetime, Path]:
    """The app's recording bundles with hand landmarks and clock pairs, by their requested start."""
    out = {}
    if not BUNDLES.exists():
        return out
    for d in BUNDLES.iterdir():
        if (d / "hand_landmarks.csv").exists() and (d / "clock_sync.csv").exists() and (d / "recording.json").exists():
            meta = json.loads((d / "recording.json").read_text())
            out[datetime.fromisoformat(meta["requested_start_at"].replace("Z", "+00:00"))] = d
    return out


def camera_distances(path: Path) -> list[tuple[float, float | None]]:
    """(capture ms, closest thumb-to-index distance in hand sizes, or None with no hand) per frame, in time order."""
    frames: dict[int, list] = {}
    with open(path) as f:
        reader = csv.reader(f)
        header = next(reader)
        w0 = header.index("wx0")
        for row in reader:
            if len(row) != len(header):
                continue
            entry = frames.setdefault(int(row[0]), [float(row[1]), None])
            if row[2] == "":
                continue
            try:
                world = [[float(row[w0 + 3 * i + k]) for k in range(3)] for i in range(21)]
            except ValueError:
                continue
            size = math.dist(world[WRIST], world[MIDDLE_MCP])
            if not size > 1e-6:
                continue
            d = math.dist(world[THUMB_TIP], world[INDEX_TIP]) / size
            entry[1] = d if entry[1] is None else min(entry[1], d)
    return sorted((ms, d) for ms, d in frames.values())


def watch_offset_ms(path: Path) -> float | None:
    """Camera ms less this is watch ms: the smallest arrival delay among the clock pairs."""
    delays = []
    with open(path) as f:
        next(f)
        for line in f:
            parts = line.strip().split(",")
            if len(parts) == 2 and parts[0] and parts[1]:
                delays.append(float(parts[1]) - float(parts[0]) / 1e6)
    return min(delays) if len(delays) >= 5 else None


def edges(frames: list[tuple[float, float | None]]) -> list[tuple[str, float]]:
    """("in" | "out", camera ms) by the app's live rule (`PinchEdges`)."""
    out, state, rose, last_seen = [], "unknown", None, -math.inf
    for ms, d in frames:
        if d is None:
            if ms - last_seen > LOST_MS:
                state, rose = "unknown", None
            continue
        if ms - last_seen > LOST_MS:
            state = "unknown"
        last_seen = ms
        if state == "unknown":
            state = "closed" if d < CONTACT else "open" if d >= RELEASE else "unknown"
            rose = None
        elif state == "open":
            if d < CONTACT:
                state, rose = "closed", None
                out.append(("in", ms))
        elif d < CONTACT:
            rose = None
        else:
            rose = ms if rose is None else rose
            if d >= RELEASE:
                state = "open"
                out.append(("out", rose))
                rose = None
    return out


class Table:
    """One CSV file of a recording: its comment lines, header, rows, and where the timestamp and label are."""

    def __init__(self, path: Path):
        self.path = path
        lines = path.read_text().splitlines()
        self.comments = [line for line in lines if line.startswith("#")]
        body = [line for line in lines if line and not line.startswith("#")]
        self.header = body[0]
        columns = self.header.split(",")
        self.ts, self.label = columns.index("timestamp_ns"), columns.index("label")
        self.rows = [line.split(",") for line in body[1:]]

    def write(self, path: Path) -> None:
        path.write_text("\n".join([*self.comments, self.header, *(",".join(row) for row in self.rows)]) + "\n")


def holds(stamped: list[tuple[int, str]], label: str) -> list[tuple[int, int]]:
    """(first, last) timestamp of each run of rows labelled `label`, in time order."""
    out, start, last = [], None, None
    for ts, value in sorted(stamped):
        if value == label:
            start = ts if start is None else start
            last = ts
        elif start is not None:
            out.append((start, last))
            start = None
    if start is not None:
        out.append((start, last))
    return out


def relabel(source: Path, bundle: Path) -> dict:
    files = [source / "imu.csv", source / "ppg.csv"] if source.is_dir() else [source]
    tables = [Table(f) for f in files if f.exists()]
    stamped = [(int(row[t.ts]), row[t.label]) for t in tables for row in t.rows]
    pinches = holds(stamped, "pinch")
    offset = watch_offset_ms(bundle / "clock_sync.csv")
    frames = camera_distances(bundle / "hand_landmarks.csv")
    if offset is None or not frames:
        return {"written": False, "reason": "no usable camera frames or clock pairs"}
    to_ns = lambda ms: round((ms - offset) * 1e6)  # noqa: E731
    found = [(kind, to_ns(ms)) for kind, ms in edges(frames)]
    closed_frames = [to_ns(ms) for ms, d in frames if d is not None and d < CONTACT]
    intervals: list[tuple[int, int, str]] = []
    marked = left_out = 0
    for start, end in pinches:
        touch = next((t for kind, t in found if kind == "in" and start - BEFORE_NS <= t <= end), None)
        if touch is None:
            intervals.append((start, end + 1, LEFT_OUT))
            left_out += 1
            continue
        release = next((t for kind, t in found if kind == "out" and touch < t <= end + AFTER_NS), None)
        hold_end = release if release is not None else max([t for t in closed_frames if touch <= t <= end + AFTER_NS], default=touch + MARK_NS)
        in_end = min(touch + MARK_NS, hold_end)
        intervals.append((touch, in_end, PINCH_IN))
        if hold_end > in_end:
            intervals.append((in_end, hold_end, PINCH_HOLD))
        if release is not None:
            intervals.append((release, release + MARK_NS, PINCH_OUT))
        marked += 1

    def label_at(ts: int, old: str) -> str:
        # The camera's moments win over a button label they overlap: those trail the movement, so the tail of the
        # gesture before (often hand_open) can still be on when the fingers touch.
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
    return {"written": True, "pinches": len(pinches), "marked": marked, "left_out": left_out, "bundle": bundle.name}


def main() -> int:
    found = bundles()
    report = []
    for source in sorted(p for p in SOURCE.rglob("*") if (p.suffix == ".csv" and p.parent.parent == SOURCE) or (p.is_dir() and (p / "imu.csv").exists())):
        files = [source / "imu.csv", source / "ppg.csv"] if source.is_dir() else [source]
        if not any("pinch" in {row[Table(f).label] for row in Table(f).rows} for f in files if f.exists()):
            continue
        start = started_at(source)
        bundle = next((b for t, b in found.items() if start and abs((t - start).total_seconds()) < 5), None)
        name = str(source.relative_to(SOURCE))
        if bundle is None:
            report.append((name, {"written": False, "reason": "no camera recording saved with it"}))
            continue
        report.append((name, relabel(source, bundle)))
    written = [(n, r) for n, r in report if r["written"]]
    skipped = [(n, r) for n, r in report if not r["written"]]
    lines = [
        "# Old pinch recordings, relabelled from the camera",
        "",
        "Made by `scripts/relabel_pinch_from_camera.py` from `data/recordings/old/` (unchanged) and the camera landmarks saved",
        "with each recording. Each labelled `pinch` the camera saw is `pinch_in` (0.3 s from the touch), `pinch_hold` (to the",
        "release) and `pinch_out` (0.3 s from the release); one it saw no touch in is `left_out`. Other labels are kept.",
        "",
        "| Recording | Pinches | Relabelled | Left out |",
        "|---|---:|---:|---:|",
        *(f"| {n} | {r['pinches']} | {r['marked']} | {r['left_out']} |" for n, r in written),
        "",
        f"Total: {sum(r['marked'] for _, r in written)} of {sum(r['pinches'] for _, r in written)} pinches relabelled.",
        "",
        "Not relabelled (no camera data, so their timing cannot be recovered):",
        "",
        *(f"- {n}: {r['reason']}" for n, r in skipped),
    ]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "README.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
