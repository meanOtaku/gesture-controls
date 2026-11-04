"""The pinch in and pinch out CNNs to use: every camera-timed session and the everyday noise, trained without the still-hand
gate (results.md: the moments the hand was moving are what teach it not to fire on movement).

One pinch session (4 Nov 04:53) and one noise session (support, angled 04:26) stay out as the trainer's held-out check.
Bundles go to runs/final-<target>/bundle, the folder to give Model Lab's "Import a model folder".

    tools/label-trainer/.venv/bin/python docs/research/artifacts/cnn-all-days-2026-11/final_models.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from all_days_check import HERE, NEGATIVES, ROOT, lt, resolve, spec_for

HELD_OUT = ("pinch_in-2026-11-04T04-53-02.645Z", "unlabeled-2026-11-04T04-26-46.986Z")


def main() -> None:
    os.chdir(ROOT)
    paths, _, _, timing = resolve()
    evaluation = [r for r in paths if r.endswith(HELD_OUT)]
    train = [r for r in paths if r not in evaluation]
    assert len(evaluation) == len(HELD_OUT)
    for target in ("pinch_in", "pinch_out"):
        negatives = ["pinch_in" if label == "pinch_out" else label for label in NEGATIVES] if target == "pinch_out" else NEGATIVES
        spec = {**spec_for(paths, timing, train, evaluation, False, False), "target": target, "negatives": negatives}
        out = HERE / "runs" / f"final-{target}"
        lt.run(spec, out)
        result = json.loads((out / "result.json").read_text())
        metrics = result.get("metrics") or {}
        print(target, result["outcome"], result.get("message"), metrics.get("activationThreshold"), metrics.get("heldOutEvents") or metrics.get("events"), metrics.get("crossCheckEvents"), flush=True)


if __name__ == "__main__":
    main()
