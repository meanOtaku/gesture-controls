"""The variants of `paper_experiments.py` worth keeping, as the app's training would judge them: the cut-off chosen on the
training recordings only (`label_train.out_of_fold_threshold`: models that did not see each recording score it), and the 11
held-out recordings replayed once at that cut-off (`label_train.replay`). So its numbers are what such a model would do,
not a best case. The CNN's, the same way, are in `../training-improvements-2026-11/final-models.md`.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/paper-rylo-2022/as_trained.py [variant...]

Results go to `as-trained.json` and `as-trained.md`.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from dataclasses import replace

from paper_experiments import HERE, setup, spec_for
from experiment import spec_for as cnn_spec_for
from label_trainer import label_train as lt

VARIANTS = ("trees", "trees+spectral", "trees@100", "trees+spectral@100")
TARGETS = ("pinch_in", "pinch_out")


def one(target: str, variant: str, seed: int) -> dict:
    if variant.startswith("cnn"):
        # The CNN as the trainer makes it, on the 50 Hz grid or (`cnn@100`) the 100 Hz one (the trainer's `cnn_input.GRIDS`,
        # the same as `experiment.py`'s `at_100_hz` it was first run with).
        spec = replace(cnn_spec_for(target), seed=seed, motion_hz=100 if variant.endswith("@100") else 50)
    else:
        _, hz = setup(variant)
        spec = replace(spec_for(target, hz), seed=seed)
    recordings = lt.load_spec_recordings(spec)
    started = time.time()
    train = lt.examples(spec, recordings, spec.train)
    threshold, source, _, cross = lt.out_of_fold_threshold(spec, train, recordings)
    model = lt.fit(train.x, train.y, seed, backend=spec.backend)
    events = lt.replay(spec, model, recordings, threshold)
    return {"threshold": threshold, "thresholdSource": source, "caught": events["caught"], "gestures": events["gestures"],
            "falseActivations": events["falseActivations"], "perHour": events["falseActivationsPerHour"],
            "medianLatencyMs": events.get("medianLatencyMs"), "repeats": events["repeats"], "falseOn": events.get("falseOn", {}),
            "seconds": round(time.time() - started)}


def main() -> None:
    variants = sys.argv[1:] or list(VARIANTS)
    path = HERE / "as-trained.json"
    results = json.loads(path.read_text()) if path.exists() else {}
    seeds = [int(s) for s in __import__("os").environ.get("SEEDS", "17").split(",")]
    for target in TARGETS:
        for variant in variants:
          for seed in seeds:
            key = f"{target} {variant}" + ("" if seed == 17 else f" seed {seed}")
            if key in results:
                continue
            print(f"{key}...", flush=True)
            done = subprocess.run([sys.executable, __file__, "--one", target, variant, str(seed)], capture_output=True, text=True)
            if done.returncode != 0:
                print(done.stderr[-3000:], flush=True)
                continue
            results[key] = json.loads(done.stdout.strip().splitlines()[-1])
            path.write_text(json.dumps(results, indent=1))
            r = results[key]
            print(f"  {r['caught']}/{r['gestures']} at {r['threshold']}, {r['perHour']:.1f} an hour", flush=True)
            write_report(results)
    write_report(results)


def write_report(results: dict) -> None:
    lines = ["# The variants as the app's training judges them", "",
             "Cut-off chosen on the training recordings only; the 11 held-out recordings replayed once at it (seed 17). See",
             "`as_trained.py`.", "",
             "| model | variant | cut-off | caught | false activations an hour | median delay | false activations on |",
             "|---|---|---:|---|---:|---:|---|"]
    for key, r in results.items():
        target, variant = key.split(" ", 1)
        variant = variant.replace(" seed ", ", seed ")
        on = ", ".join(f"{label} {n}" for label, n in sorted(r["falseOn"].items(), key=lambda kv: -kv[1])) or "-"
        delay = "-" if r["medianLatencyMs"] is None else f"{r['medianLatencyMs']:.0f} ms"
        lines.append(f"| {target} | {variant} | {r['threshold']} | {r['caught']}/{r['gestures']} | {r['perHour']:.1f} | {delay} | {on} |")
    (HERE / "as-trained.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--one":
        print(json.dumps(one(sys.argv[2], sys.argv[3], int(sys.argv[4]))))
    else:
        main()
