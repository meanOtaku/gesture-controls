"""The multi-gesture CNN (pinch in, hold, out and snap) before and after the snap recordings were relabelled more tightly.

Both models are replayed, gate included, over the same 19 held-out recordings with the labels as they are now (hand
labels throughout), so the old one is judged against the new, tighter snap labels too. For each gesture: starts caught,
false activations an hour with no gesture under way, and median latency, at the model's own cut-off and at a sweep of
cut-offs; and the event confusion (which detector fired for each labelled start).

    tools/label-trainer/.venv/bin/python docs/research/artifacts/snap-multi-2026-11/compare.py OLD_RUN NEW_RUN

Writes `results.json` and `results.md` here.
"""
from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))

from label_trainer import cnn_v2, label_train as lt, multi_gesture as mg  # noqa: E402
from label_trainer.events import summarise  # noqa: E402

SWEEP = (0.999, 0.995, 0.99, 0.98, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5)
KEYS = ("gestures", "caught", "late", "repeats", "falseActivations", "negativeSeconds", "falseActivationsPerHour", "medianLatencyMs")


def replay(run: Path, spec_raw: dict) -> dict:
    bundle = run / "gestures" / "pinch_in" / "bundle"
    manifest = json.loads((bundle / "manifest.json").read_text())
    model = (bundle / "model.cnn").read_bytes()
    held_out = spec_raw["evaluation"]
    raw = {**spec_raw, "train": [], "recordings": {r: spec_raw["recordings"][r] for r in held_out},
           "sessions": {r: s for r, s in spec_raw.get("sessions", {}).items() if r in held_out},
           "decideFromNs": {r: t for r, t in spec_raw.get("decideFromNs", {}).items() if r in held_out}}
    raw.pop("labelTiming", None)
    spec = replace(lt.parse_spec(raw), gate_min_jerk=manifest["preprocessing"]["gate"]["minJerk"])
    recordings = lt.load_spec_recordings(spec)
    cutoffs = {g: json.loads((run / "gestures" / g / "evaluation.json").read_text())["activationThreshold"] for g in spec.classes}
    timelines = []
    for rid in sorted(held_out):
        t = mg.all_timelines(spec, recordings[rid], lambda x: cnn_v2.predict(model, x))
        if t is not None:
            timelines.append((rid, recordings[rid], *t))
    out = {"cutoffs": cutoffs, "recordings": len(timelines), "gestures": {}, "confusion": mg.event_confusion(spec, timelines, cutoffs)}
    for i, gesture in enumerate(spec.classes, 1):
        one = mg.for_gesture(spec, gesture)
        rows = []
        for threshold in sorted(set(SWEEP) | {cutoffs[gesture]}, reverse=True):
            s = summarise([lt.detections(one, rec, ts, p[:, i], lt.policy_for(threshold, one.trigger)) for _, rec, ts, p in timelines])
            rows.append({"threshold": threshold, **{k: s[k] for k in KEYS}})
        out["gestures"][gesture] = rows
    return out


def report(results: dict) -> str:
    names = list(results)
    lines = ["# Multi-gesture CNN with snap: before and after the tighter snap labels", "",
             "Replayed over the same held-out recordings, current hand labels. See `compare.py`.", "",
             "## At each model's own cut-off", "",
             "| gesture | " + " | ".join(f"{n} cut-off | {n} caught | {n} false/h | {n} latency" for n in names) + " |",
             "|---|" + "---|---|---|---|" * len(names)]
    for gesture in results[names[0]]["gestures"]:
        cells = []
        for n in names:
            cut = results[n]["cutoffs"][gesture]
            row = next(r for r in results[n]["gestures"][gesture] if r["threshold"] == cut)
            cells += [f"{cut:g}", f"{row['caught']}/{row['gestures']}", f"{row['falseActivationsPerHour']:.1f}",
                      f"{row['medianLatencyMs']:.0f} ms" if row["medianLatencyMs"] is not None else "-"]
        lines.append(f"| {gesture} | " + " | ".join(cells) + " |")
    for gesture in results[names[0]]["gestures"]:
        lines += ["", f"## {gesture}, by threshold", "", "| threshold | " + " | ".join(f"{n} caught | {n} false/h" for n in names) + " |",
                  "|---|" + "---|---|" * len(names)]
        for threshold in SWEEP:
            cells = []
            for n in names:
                row = next((r for r in results[n]["gestures"][gesture] if r["threshold"] == threshold), None)
                cells += [f"{row['caught']}/{row['gestures']}", f"{row['falseActivationsPerHour']:.1f}"] if row else ["", ""]
            lines.append(f"| {threshold:g} | " + " | ".join(cells) + " |")
    for n in names:
        lines += ["", f"## Event confusion, {n}", "", "```", json.dumps(results[n]["confusion"], indent=1), "```"]
    return "\n".join(lines) + "\n"


def main() -> None:
    old, new = Path(sys.argv[1]), Path(sys.argv[2])
    spec_raw = json.loads((new / "spec.json").read_text()) if (new / "spec.json").exists() else json.loads((old / "spec.json").read_text())
    results = {"before": replay(old, spec_raw), "after": replay(new, spec_raw)}
    (HERE / "results.json").write_text(json.dumps(results, indent=1))
    (HERE / "results.md").write_text(report(results))
    print((HERE / "results.md").read_text())


if __name__ == "__main__":
    main()
