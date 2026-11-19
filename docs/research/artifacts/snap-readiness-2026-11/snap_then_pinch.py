"""Does a finger snap spoil a pinch made right after it, as heavy arm motion does?

A snap trips the readiness light's "wrist moving" rule (gyroscope RMS over 0.3 s above 1 rad/s) for about 0.3 s, so the
light says "Wrist moving" then "Hold still" for about 1.3 s after every snap. That rule was set from heavy arm motion,
which does spoil a following pinch (`../readiness-2026-11`). Here the real motion and pulse of a snap (0.2 s before its
labelled start to 0.5 s after, from the hand-labelled snap recordings) are spliced in to end a gap before each pinch-in
start of the three long held-out pinch recordings of the application's current model, and the pinch counts as caught
when its gated pinch-in score 0.1-1 s after the start reaches the model's own cut-off (as in `../post-motion-2026-11`).

    tools/label-trainer/.venv/bin/python docs/research/artifacts/snap-readiness-2026-11/snap_then_pinch.py

Needs the application's current model's run (`../post-motion-2026-11/runs/app-current`). Writes `results.json`.
"""
from __future__ import annotations

import glob
import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE.parent / "post-motion-2026-11"))

import experiment as ex  # noqa: E402
from label_trainer import cnn_input, cnn_v2, label_train as lt, ppg_onset  # noqa: E402
from label_trainer.csv_io import load_recording, repair_millisecond_ppg_timestamps  # noqa: E402

S = 1_000_000_000
BEFORE, AFTER = int(0.2 * S), int(0.5 * S)
GAPS = (0.1, 0.25, 0.5, 1.0)


def main() -> None:
    run = HERE.parent / "post-motion-2026-11" / "runs" / "app-current"
    bundle = run / "gestures" / "pinch_in" / "bundle"
    manifest = json.loads((bundle / "manifest.json").read_text())
    model = (bundle / "model.cnn").read_bytes()
    cutoff = json.loads((run / "gestures" / "pinch_in" / "evaluation.json").read_text())["activationThreshold"]
    raw = ex.raw_spec()
    held_out = raw["evaluation"]
    spec = lt.parse_spec({**raw, "train": [], "recordings": {r: raw["recordings"][r] for r in held_out},
                          "sessions": {r: s for r, s in raw.get("sessions", {}).items() if r in held_out},
                          "decideFromNs": {r: t for r, t in raw.get("decideFromNs", {}).items() if r in held_out}})
    spec = replace(spec, gate_min_jerk=manifest["preprocessing"]["gate"]["minJerk"])
    recordings = lt.load_spec_recordings(spec)
    pinches = [r for r, rec in recordings.items()
               if [l for _, _, l in ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)].count("pinch_in") >= 20]

    snaps = []  # (recording, start of the stretch)
    for folder in sorted(glob.glob(str(ROOT / "data/recordings/Hand labeled/gesture-dataset-snap_fingers-*"))):
        rec = repair_millisecond_ppg_timestamps(load_recording(folder))
        for s, _, label in ppg_onset.holds(rec.timestamps_ns, rec.raw_labels):
            if label == "snap_fingers" and s - BEFORE > rec.timestamps_ns[0]:
                snaps.append((rec, int(s) - BEFORE))

    def peak(recording, start: int) -> float:
        ts, _ = lt.pulse_of(recording)
        d = ts[(ts >= start + S // 10) & (ts <= start + S)]
        x = lt.inputs(spec, recording, d)
        ok = np.isfinite(x).all(axis=1)
        if not ok.any():
            return float("nan")
        p = np.asarray(cnn_v2.predict(model, x[ok]))[:, 1]
        m_ts, axes = lt.motion_of(recording)
        p = np.where(cnn_input.spike(m_ts, axes, d[ok]) >= spec.gate_min_jerk, p, 0.0)
        return float(p.max())

    rows = []
    k = 0
    for rid in pinches:
        rec = recordings[rid]
        starts = [s for s, _, label in ppg_onset.holds(rec.timestamps_ns, rec.raw_labels)
                  if label == "pinch_in" and s - 25 * S > rec.timestamps_ns[0]]
        for start in starts:
            rows.append({"gap": None, "peak": peak(rec, start)})
            for gap in GAPS:
                source, source_at = snaps[k % len(snaps)]
                k += 1
                at = start - int(gap * S) - (BEFORE + AFTER)
                copy = ex.splice(rec, source, at, source_at, BEFORE + AFTER)
                rows.append({"gap": gap, "peak": peak(copy, start)})
    out = {"cutoff": cutoff, "snaps": len(snaps), "rows": rows, "caught": {}}
    for gap in (None, *GAPS):
        sel = [r["peak"] for r in rows if r["gap"] == gap]
        out["caught"][str(gap)] = f"{sum(p >= cutoff for p in sel)}/{len(sel)}"
    (HERE / "results.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out["caught"]), "cutoff", cutoff, "snaps", len(snaps))


if __name__ == "__main__":
    main()
