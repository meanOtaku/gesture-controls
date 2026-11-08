"""Replay the checked-in hand-labelled pinch-in model over its listed evaluation recordings.

Recovers the event log the bundle lacks: per-recording catches, repeats, late and false activations, emitted detection
times, latencies and eligible no-gesture exposure. It reuses the trainer's own input building (`cnn_input`, median
scaling), detection rule (`events.detect`) and event accounting (`label_train.detections`), so it counts exactly as the
trainer and Model Lab do.

The original training spec was not saved, so the label roles are reconstructed from the project's documented defaults
(docs/architecture/pinch-models.md). The script replays every combination of the uncertain settings and reports which
ones reproduce the manifest's stored event recall and false-activation rate. A match supports the reconstruction; it
does not make these recordings an untouched test.

Run from the repository root:
    tools/label-trainer/.venv/bin/python docs/paper/revision-assets/replay_hand_labelled.py
"""
from __future__ import annotations

import hashlib
import itertools
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/label-trainer/src"))

import numpy as np  # noqa: E402

from label_trainer import cnn, label_train  # noqa: E402
from label_trainer.events import summarise  # noqa: E402

BUNDLE = ROOT / "trained-models/pinch_in-hand-labeled"
RECORDINGS = ROOT / "data/recordings/Hand labeled"
OUT = Path(__file__).resolve().parent / "hand-labelled-replay.json"

# Documented defaults for a pinch_in spec (pinch-models.md). Uncertain choices are varied below.
NEGATIVES = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
EXCLUDE_OPTIONS = {"left_out": ["left_out"], "none": []}
STEADY_OPTIONS = {"off": False, "on": True}


def main() -> int:
    manifest = json.loads((BUNDLE / "manifest.json").read_text())
    model_bytes = (BUNDLE / "model.cnn").read_bytes()
    digest = hashlib.sha256(model_bytes).hexdigest()
    if digest != manifest["model"]["sha256"]:
        print(f"model bytes do not match the manifest: {digest}", file=sys.stderr)
        return 1
    prov, thresholds = manifest["provenance"], manifest["thresholds"]
    evaluation = prov["evaluationRecordings"]
    missing = [rid for rid in evaluation if not (RECORDINGS / rid).is_dir()]
    if missing:
        print(f"evaluation recordings not found: {missing}", file=sys.stderr)
        return 1

    variants = []
    scored_cache: dict[str, tuple[np.ndarray, np.ndarray] | None] = {}
    for (ex_name, excludes), (steady_name, steady) in itertools.product(EXCLUDE_OPTIONS.items(), STEADY_OPTIONS.items()):
        spec = label_train.parse_spec({
            "version": 1, "target": manifest["targetLabel"], "negatives": NEGATIVES, "excludes": excludes,
            "recordings": {rid: str(RECORDINGS / rid) for rid in evaluation}, "train": [], "evaluation": evaluation,
            "sources": list(label_train.MOTION_SOURCES), "backend": label_train.CNN_BACKEND,
            "seed": prov["seed"], "steadyStarts": steady,
        })
        recordings = label_train.load_spec_recordings(spec)
        policy = label_train.policy_for(thresholds["activation"], spec.trigger)
        assert (policy.release, policy.cooldown_ms, policy.trigger) == (thresholds["release"], thresholds["cooldownMs"], thresholds["trigger"])
        per_recording = []
        for rid in sorted(evaluation):
            if rid not in scored_cache:  # scores do not depend on the label roles
                scored_cache[rid] = label_train.timeline(spec, recordings[rid], lambda x: cnn.predict(model_bytes, x))
            scored = scored_cache[rid]
            if scored is None:
                continue
            times, scores = scored
            result = label_train.detections(spec, recordings[rid], times, scores, policy)
            per_recording.append((rid, {
                **result,
                "decisions": int(len(times)),
                "firstDecisionNs": int(times[0]), "lastDecisionNs": int(times[-1]),
                "maxScore": float(scores.max()),
                "falseRisesNs": [int(t) for t in result["falseRisesNs"]],
            }))
        totals = summarise([r for _, r in per_recording])
        stored = (prov["evaluationGestureRecall"], prov["evaluationFalseActivationsPerHour"])
        reproduces = bool(np.isclose(totals.get("gestureRecall", -1), stored[0]) and np.isclose(totals.get("falseActivationsPerHour", -1), stored[1]))
        variants.append({"excludes": ex_name, "steadyStarts": steady_name, "totals": totals,
                         "reproducesStored": reproduces, "perRecording": dict(per_recording)})
        print(f"excludes={ex_name:8s} steady={steady_name:3s} -> {json.dumps({k: totals[k] for k in sorted(totals) if not isinstance(totals[k], (list, dict))})} reproduces={reproduces}")

    OUT.write_text(json.dumps({
        "model": {"id": manifest["modelId"], "sha256": digest, "preprocessing": manifest["preprocessing"]["kind"],
                  "thresholds": thresholds},
        "stored": {"recall": prov["evaluationGestureRecall"], "falseActivationsPerHour": prov["evaluationFalseActivationsPerHour"],
                   "thresholdSource": prov["thresholdSource"]},
        "reconstruction": {"negatives": NEGATIVES, "labelTiming": "none (manifest cohort 'all')",
                           "note": "original spec not saved; label roles reconstructed from documented defaults"},
        "evaluationRecordings": evaluation,
        "variants": variants,
    }, indent=1, default=lambda v: v.item() if hasattr(v, "item") else str(v)) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
