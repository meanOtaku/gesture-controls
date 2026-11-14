"""Extract the data behind the report's data figures (score timeline, sensor timing) to JSON.

Uses the trainer's own input building, scoring, detection rule and event accounting, exactly as
replay_hand_labelled.py does (that script reproduced the model's stored metrics), so the timeline
shows what the trainer and Model Lab count. Latencies come from hand-labelled-replay.json.

The stored model was trained with the trainer as it was at commit c924661 (50 Hz CNN inputs). Later trainer
versions build different inputs (c1b5815 moved the CNN to 100 Hz), so run against that version's source:

    git archive c924661 tools/label-trainer/src | tar -x -C /tmp/trainer-c924661
    TRAINER_SRC=/tmp/trainer-c924661/tools/label-trainer/src \
        tools/label-trainer/.venv/bin/python docs/paper/revision-assets/report_figure_data.py

The script checks its result against hand-labelled-replay.json and stops if they differ.
Then plot with report_figures.py.
"""
from __future__ import annotations

import csv
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
import os  # noqa: E402
sys.path.insert(0, os.environ.get("TRAINER_SRC", str(ROOT / "tools/label-trainer/src")))

import numpy as np  # noqa: E402

from label_trainer import cnn, label_train, ppg_onset  # noqa: E402
from label_trainer.events import detect  # noqa: E402

BUNDLE = ROOT / "trained-models/pinch_in-hand-labeled"
RECORDINGS = ROOT / "data/recordings/Hand labeled"
OUT = Path(__file__).resolve().parent / "report-figure-data.json"
# The pinch recording with catches, a late event and undetected starts (17/21 caught, 2 late).
TIMELINE_RECORDING = "gesture-dataset-pinch_hold-2026-11-04T04-50-33.518Z"
# Same reconstructed label roles as the replay variant that reproduced the stored metrics.
NEGATIVES = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]


def timestamps(path: Path) -> np.ndarray:
    with path.open() as f:
        rows = csv.DictReader(line for line in f if not line.startswith("#"))
        return np.array([int(r["timestamp_ns"]) for r in rows], dtype=np.int64)


def main() -> int:
    manifest = json.loads((BUNDLE / "manifest.json").read_text())
    model_bytes = (BUNDLE / "model.cnn").read_bytes()
    assert hashlib.sha256(model_bytes).hexdigest() == manifest["model"]["sha256"]
    prov, thresholds = manifest["provenance"], manifest["thresholds"]

    spec = label_train.parse_spec({
        "version": 1, "target": manifest["targetLabel"], "negatives": NEGATIVES, "excludes": ["left_out"],
        "recordings": {TIMELINE_RECORDING: str(RECORDINGS / TIMELINE_RECORDING)}, "train": [],
        "evaluation": [TIMELINE_RECORDING], "sources": list(label_train.MOTION_SOURCES),
        "backend": label_train.CNN_BACKEND, "seed": prov["seed"], "steadyStarts": False,
    })
    recording = label_train.load_spec_recordings(spec)[TIMELINE_RECORDING]
    policy = label_train.policy_for(thresholds["activation"], spec.trigger)
    times, scores = label_train.timeline(spec, recording, lambda x: cnn.predict(model_bytes, x))
    result = label_train.detections(spec, recording, times, scores, policy)

    # Rebuild the matching the same way detections() does, to label each start and each emitted event.
    held = ppg_onset.holds(recording.timestamps_ns, recording.raw_labels)
    earliest_ms, _ = ppg_onset.match_window_ms(spec.decision_delay_ms)
    starts = [s for s, _, label in held if label == spec.target and times[0] <= s + earliest_ms * 1_000_000 <= times[-1]]
    rises = [rise for rise, _ in detect(times, scores, policy)]
    pairs = ppg_onset.match_pairs(rises, starts, spec.decision_delay_ms)
    caught_rises, caught_starts = {i for i, _ in pairs}, {j for _, j in pairs}
    assert len(starts) == result["gestures"] and len(pairs) == result["caught"]
    # Must match the stored replay (which reproduced the model's manifest metrics) for this recording.
    stored = json.loads((Path(__file__).resolve().parent / "hand-labelled-replay.json").read_text())
    ref = next(v for v in stored["variants"] if v["reproducesStored"])["perRecording"][TIMELINE_RECORDING]
    got = {"gestures": result["gestures"], "caught": result["caught"], "late": result["late"], "decisions": int(len(times))}
    want = {k: ref[k] for k in got}
    if got != want:
        print(f"does not match the stored replay: got {got}, stored {want}; wrong trainer version?", file=sys.stderr)
        return 1

    t0 = int(times[0])
    timeline = {
        "recording": TIMELINE_RECORDING,
        "t_s": ((times - t0) / 1e9).round(3).tolist(),
        "score": scores.round(5).tolist(),
        "starts": [{"t_s": round((s - t0) / 1e9, 3), "caught": j in caught_starts} for j, s in enumerate(starts)],
        "events": [{"t_s": round((r - t0) / 1e9, 3), "matched": i in caught_rises} for i, r in enumerate(rises)],
        "holds": [{"start_s": round((s - t0) / 1e9, 3), "end_s": round((e - t0) / 1e9, 3), "label": label}
                  for s, e, label in held if e >= t0],
        "activation": thresholds["activation"], "release": thresholds["release"],
        "totals": {k: result[k] for k in ("gestures", "caught", "late", "repeats", "falseActivations")},
    }

    # Inter-sample intervals of the watch streams, over the model's 28 distinct training + evaluation recordings.
    ids = prov["trainRecordings"] + prov["evaluationRecordings"]
    timing = {"recordings": len(ids)}
    for stream in ("ppg", "imu"):
        gaps = np.concatenate([np.diff(timestamps(RECORDINGS / rid / f"{stream}.csv")) / 1e6 for rid in ids])
        gaps = gaps[gaps > 0]
        timing[stream] = {
            "n": int(gaps.size), "median_ms": float(np.median(gaps)),
            "p99_ms": float(np.percentile(gaps, 99)), "max_ms": float(gaps.max()),
            "over_250ms": int((gaps > 250).sum()),
            # Histogram on fixed bins so the JSON stays small.
            "bins_ms": np.arange(0, 101, 1).tolist(),
            "counts": np.histogram(np.clip(gaps, 0, 100), bins=np.arange(0, 101, 1))[0].tolist(),
        }

    OUT.write_text(json.dumps({"model": manifest["modelId"], "timeline": timeline, "timing": timing}) + "\n")
    print(f"timeline: {timeline['totals']}; events {len(rises)}")
    for s in ("ppg", "imu"):
        t = timing[s]
        print(f"{s}: n={t['n']} median={t['median_ms']:.2f} ms p99={t['p99_ms']:.2f} max={t['max_ms']:.1f} >250ms={t['over_250ms']}")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
