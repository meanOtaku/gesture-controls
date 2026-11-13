"""`pinch_in` and `pinch_out` trained by the trainer as it now is (the loop and batch changes of `cnn._train`), on the
recordings the live `-motion` models trained on, and checked on the 11 they never saw (see `experiment.py`).

Unlike `experiment.py`, this is the app's whole training run (`label_train.run`): the cut-off is chosen on the training
recordings only, by models that did not see each one, and the held-out recordings are replayed once at that cut-off. So
its numbers are what such a model would do, not a best case.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/training-improvements-2026-11/final_models.py

Bundles go to `runs/final-<target>/bundle`, the folder to give Model Lab's "Import a model folder". Nothing is imported or
activated by this script.
"""
from __future__ import annotations

import dataclasses
import json
import os

from experiment import HERE, ROOT, spec_for
from label_trainer import label_train as lt


def main() -> None:
    os.chdir(ROOT)
    lines = ["# The trainer's new loop, run as the app runs it", "",
             "Cut-off chosen on the training recordings only; the 11 held-out recordings replayed once at it. See",
             "`final_models.py`.", "",
             "| model | outcome | cut-off | caught | false activations an hour | median delay |", "|---|---|---:|---|---:|---:|"]
    for target in ("pinch_in", "pinch_out"):
        spec = spec_for(target)
        raw = {"version": 1, "target": spec.target, "negatives": list(spec.negatives), "excludes": list(spec.excludes),
               "recordings": {rid: str(path) for rid, path in spec.recordings.items()}, "train": list(spec.train),
               "evaluation": list(spec.evaluation), "sources": list(lt.MOTION_SOURCES), "backend": lt.CNN_BACKEND, "seed": 17,
               "research": False, "labelOffsetMs": 0, "labelTiming": dict(spec.label_timing), "steadyStarts": False,
               "hardNegatives": False}
        out = HERE / "runs" / f"final-{target}"
        lt.run(raw, out)
        result = json.loads((out / "result.json").read_text())
        metrics = result.get("metrics") or {}
        events = metrics.get("heldOutEvents") or metrics.get("events") or {}
        per_hour = events.get("falseActivationsPerHour")
        lines.append(f"| {target} | {result['outcome']} | {metrics.get('activationThreshold')} | "
                     f"{events.get('caught')}/{events.get('gestures')} | "
                     f"{'-' if per_hour is None else f'{per_hour:.1f}'} | {events.get('medianLatencyMs')} ms |")
        print(lines[-1], result.get("message"), flush=True)
        (HERE / "final-models.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
