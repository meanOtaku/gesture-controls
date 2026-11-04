"""Marks pinch in, pinch hold and pinch out in an exported Recorder folder whose camera landmarks were saved but whose
pinches were not marked (camera marking was off), with the app's live rule (`pinchEdgeMarker.ts`, as
`scripts/relabel_pinch_from_camera.py` applies it): a touch where the thumb-to-index distance falls below 0.35 hand sizes
once it has been open (0.45 or more), a release timed where it rose back past 0.35 and counted at 0.45, nothing from the
first reading after the hand was lost for 400 ms. Each touch becomes pinch_in (0.3 s, or until the release if sooner),
then pinch_hold to the release, then pinch_out (0.3 s).

The export's hand_landmarks.csv already carries each frame's watch time (`watch_timestamp_ns`), so no clock alignment is
needed. Writes a labelled copy (ppg.csv, imu.csv, dataset.json) to OUT; the source folder is not changed.

    python3 mark_from_camera.py SOURCE_FOLDER OUT_FOLDER
"""
from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "scripts"))
from relabel_pinch_from_camera import INDEX_TIP, MARK_NS, MIDDLE_MCP, THUMB_TIP, WRIST, edges  # noqa: E402


def distances(path: Path) -> list[tuple[float, float | None]]:
    """(watch ms, closest thumb-to-index distance in hand sizes, or None with no hand) per frame, in time order."""
    frames: dict[int, list] = {}
    with open(path) as f:
        reader = csv.reader(f)
        header = next(reader)
        w0 = header.index("wx0")
        for row in reader:
            if len(row) != len(header) or not row[0]:
                continue
            entry = frames.setdefault(int(row[0]), [None])
            try:
                world = [[float(row[w0 + 3 * i + k]) for k in range(3)] for i in range(21)]
            except ValueError:
                continue
            size = math.dist(world[WRIST], world[MIDDLE_MCP])
            if size > 1e-6:
                d = math.dist(world[THUMB_TIP], world[INDEX_TIP]) / size
                entry[0] = d if entry[0] is None else min(entry[0], d)
    return sorted((ns / 1e6, v[0]) for ns, v in frames.items())


def spans(found: list[tuple[str, float]]) -> list[tuple[int, int, str]]:
    out = []
    for i, (kind, ms) in enumerate(found):
        if kind != "in":
            continue
        touch = int(ms * 1e6)
        release = next((int(m * 1e6) for k, m in found[i + 1:] if k == "out"), None)
        nxt = next((int(m * 1e6) for k, m in found[i + 1:] if k == "in"), None)
        if release is None or (nxt is not None and nxt < release):
            continue
        out.append((touch, min(touch + MARK_NS, release), "pinch_in"))
        if touch + MARK_NS < release:
            out.append((touch + MARK_NS, release, "pinch_hold"))
        out.append((release, release + MARK_NS, "pinch_out"))
    return out


def relabel(path: Path, marks: list[tuple[int, int, str]], out: Path) -> None:
    lines = path.read_text().splitlines()
    body = [i for i, line in enumerate(lines) if line and not line.startswith("#")]
    header = lines[body[0]].split(",")
    ts, lab = header.index("timestamp_ns"), header.index("label")
    for i in body[1:]:
        row = lines[i].split(",")
        t = int(row[ts])
        row[lab] = next((label for s, e, label in marks if s <= t < e), "")
        lines[i] = ",".join(row)
    out.write_text("\n".join(lines) + "\n")


def main(source: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    found = edges(distances(source / "hand_landmarks.csv"))
    marks = spans(found)
    for name in ("ppg.csv", "imu.csv"):
        relabel(source / name, marks, out / name)
    meta = json.loads((source / "dataset.json").read_text())
    meta["labels"] = sorted({label for _, _, label in marks})
    (out / "dataset.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"{sum(1 for _, _, l in marks if l == 'pinch_in')} pinches marked ({len(found)} edges)")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
