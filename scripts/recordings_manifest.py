#!/usr/bin/env python3
"""Records exactly which recordings an analysis used.

The recordings live in data/recordings/. This writes data/recordings.manifest.json: for every file its size, SHA-256,
gesture, label counts and whether the PPG step study used it. `check` confirms the files are byte-for-byte the ones the
manifest describes, so an analysis rerun later, or elsewhere, can be trusted to be on the same data.

    python3 scripts/recordings_manifest.py write
    python3 scripts/recordings_manifest.py check

Standard library only.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORDINGS = ROOT / "data" / "recordings"
MANIFEST = ROOT / "data" / "recordings.manifest.json"

# Why the PPG step study (docs/research/ppg-step-findings-2026-10.md) left a recording out, beyond having no marks.
STUDY = "ppg-step-2026-10"
STUDY_EXCLUDED = {
    "gesture-dataset-pinch-2026-09-22T13-39-36.998Z.csv": "its timestamps span 5 million seconds and cannot be placed in time",
}
STUDY_SKIPPED_GESTURES = {
    "unlabeled": "no gesture marked",
    "pinch_open": "not part of the study",
    "hand_twit_clockwise_and_anti_clockwise": "a single session",
}


def describe(path: Path) -> dict:
    data = path.read_bytes()
    name = path.name
    match = re.match(r"gesture-dataset-(.+)-(\d{4}-\d\d-\d\dT[\d-]+\.\d+Z)\.csv$", name)
    gesture, recorded = (match.group(1), match.group(2)) if match else (None, None)
    lines = [line for line in data.decode("utf-8").splitlines() if not line.startswith("#")]
    rows = list(csv.reader(lines))
    header, body = rows[0], rows[1:]
    label_at = header.index("label") if "label" in header else len(header) - 1
    green_at = header.index("ppg_green") if "ppg_green" in header else None
    labels = Counter(row[label_at] if len(row) > label_at else "" for row in body)
    entry = {
        "file": str(path.relative_to(RECORDINGS)),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "gesture": gesture,
        "recordedAt": recorded,
        "rows": len(body),
        "ppgRows": sum(1 for row in body if green_at is not None and len(row) > green_at and row[green_at] != ""),
        "labels": {(label or "(unmarked)"): count for label, count in sorted(labels.items())},
    }
    marked = any(label for label in labels)
    if name in STUDY_EXCLUDED:
        entry["studies"] = {STUDY: f"excluded: {STUDY_EXCLUDED[name]}"}
    elif gesture in STUDY_SKIPPED_GESTURES:
        entry["studies"] = {STUDY: f"skipped: {STUDY_SKIPPED_GESTURES[gesture]}"}
    elif not marked:
        entry["studies"] = {STUDY: "skipped: no gesture marked"}
    else:
        entry["studies"] = {STUDY: "used"}
    return entry


def files() -> list[Path]:
    return sorted(p for p in RECORDINGS.rglob("*.csv") if p.is_file())


def write() -> int:
    entries = [describe(p) for p in files()]
    MANIFEST.write_text(json.dumps({
        "about": "Our own recordings, in data/recordings/. Regenerate with scripts/recordings_manifest.py write.",
        "recordings": entries,
    }, indent=1) + "\n")
    used = sum(1 for e in entries if e["studies"].get(STUDY) == "used")
    print(f"wrote {MANIFEST.relative_to(ROOT)}: {len(entries)} recordings, {used} used by {STUDY}")
    return 0


def check() -> int:
    manifest = json.loads(MANIFEST.read_text())
    problems = []
    for entry in manifest["recordings"]:
        path = RECORDINGS / entry["file"]
        if not path.is_file():
            problems.append(f"missing: {entry['file']}")
            continue
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        if sha != entry["sha256"]:
            problems.append(f"changed: {entry['file']}")
    known = {entry["file"] for entry in manifest["recordings"]}
    extra = [str(p.relative_to(RECORDINGS)) for p in files() if str(p.relative_to(RECORDINGS)) not in known]
    for problem in problems:
        print(problem)
    if extra:
        print(f"not in the manifest (fine, but not part of any recorded analysis): {', '.join(extra)}")
    print("ok: every recording in the manifest is here and unchanged" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    sys.exit({"write": write, "check": check}.get(command, lambda: (print(__doc__), 2)[1])())
