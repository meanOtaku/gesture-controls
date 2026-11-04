"""The CNN trained on every camera-timed pinch session and the everyday noise of 4 Nov, each day held out in turn.

Recordings (Model Lab's, and `data/recordings/new/` for the 3 Nov 12:40 session and the 4 Nov sessions):

* camera-timed pinch sessions: 14 Oct (9), 17 Oct (5), 3 Nov (5), 4 Nov (2: 04:49 and 04:53);
* the 14 Oct fist sessions (4): no pinch;
* everyday noise of 4 Nov (7): active (03:54, 04:37), hand still (04:03), on a support flat (04:09) and angled (04:15,
  04:20, 04:26).

The motion-estimated sessions are left out: their timings come from the signal the model detects.

Folds, each holding out one day's pinch sessions and some noise, and training on everything else:

| held out | pinch | noise and no-pinch |
|---|---|---|
| 14 Oct | 14 Oct (9) | active 03:54, the fist sessions |
| 17 Oct | 17 Oct (5) | active 04:37 |
| 3 Nov | 3 Nov (5) | still 04:03, support flat 04:09 |
| 4 Nov | 4 Nov (2) | support angled 04:15 |

Each fold through the app's trainer (`label_train.run`: the CNN, still-hand gate on, threshold chosen within 30 false
activations an hour on the training recordings only), with and without `hardNegatives` (learning from its own false
activations, found at the lowest cut-off). The live CNN ("Pinch in tree", trained on most of the 14/17 Oct sessions) is
replayed on the same held-out recordings for comparison; on 14 and 17 Oct it is not being tested on unseen data.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/cnn-all-days-2026-11/all_days_check.py hard|plain

Run "hard" first, then "plain"; each adds to results.json and rewrites results.md here. Bundles go under runs/. Set
`MODEL_LAB_DIR` to a copy of the app's `model-lab` folder on another machine (the steps are in
`docs/architecture/pinch-models.md`); without its `label-models/` the live CNN is left out.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))
sys.path.insert(0, str(ROOT / "docs" / "research" / "artifacts" / "cnn-new-on-old-2026-11"))

from label_trainer import cnn, label_train as lt  # noqa: E402
from new_on_old_check import DATASETS, LIVE_MODEL, NEGATIVES, NEW, headline, replay  # noqa: E402

HERE = Path(__file__).resolve().parent
BUDGET = lt.FALSE_ACTIVATIONS_BUDGET_PER_HOUR

# (Model Lab id prefix or data/recordings/new folder, what it is, the day whose fold holds it out, label timing)
RECORDINGS = [
    *[(p, "pinch", "14 Oct", "camera") for p in ["82ee8162", "60ef94c6", "827be2d1", "35af4113", "6d6f7b3c", "c6c2a72c", "20a4372a", "b2fcf81f", "aad37c5c"]],
    *[(p, "fist", "14 Oct", "noGesture") for p in ["08f918d8", "6a12cac7", "3942decb", "12c09140"]],
    *[(p, "pinch", "17 Oct", "camera") for p in ["833eba84", "6a0d166e", "08d6dfbf", "7b445f79", "ca87d8fd"]],
    *[(p, "pinch", "3 Nov", "camera") for p in ["8ed9fd23", "9d150228", "a842ec17", "5be1c51f", "gesture-dataset-pinch_in-2026-11-03T12-40-05.547Z"]],
    ("gesture-dataset-pinch_in-2026-11-04T04-49-21.416Z", "pinch", "4 Nov", "camera"),
    ("gesture-dataset-pinch_in-2026-11-04T04-53-02.645Z", "pinch", "4 Nov", "camera"),
    ("gesture-dataset-unlabeled-2026-11-04T03-54-31.816Z", "noise: active", "14 Oct", "noGesture"),
    ("gesture-dataset-unlabeled-2026-11-04T04-37-45.372Z", "noise: active", "17 Oct", "noGesture"),
    ("gesture-dataset-unlabeled-2026-11-04T04-03-41.167Z", "noise: still", "3 Nov", "noGesture"),
    ("gesture-dataset-unlabeled-2026-11-04T04-09-05.352Z", "noise: support, flat", "3 Nov", "noGesture"),
    ("gesture-dataset-unlabeled-2026-11-04T04-15-17.305Z", "noise: support, angled", "4 Nov", "noGesture"),
    ("gesture-dataset-unlabeled-2026-11-04T04-20-47.293Z", "noise: support, angled", None, "noGesture"),
    ("gesture-dataset-unlabeled-2026-11-04T04-26-46.986Z", "noise: support, angled", None, "noGesture"),
]
DAYS = ["14 Oct", "17 Oct", "3 Nov", "4 Nov"]


def resolve() -> tuple[dict[str, Path], dict[str, str], dict[str, str | None], dict[str, str]]:
    """Each recording's path, what it is, the fold that holds it out and its label timing, keyed by id."""
    ids = [p.name for p in DATASETS.iterdir() if p.is_dir()]
    paths, kind, fold, timing = {}, {}, {}, {}
    for key, what, day, when in RECORDINGS:
        if key.startswith("gesture-dataset"):
            rid, path = key, NEW / key
        else:
            match = [i for i in ids if i.startswith(key)]
            if len(match) != 1:
                raise SystemExit(f"no single Model Lab recording starts with {key}")
            rid, path = match[0], DATASETS / match[0]
        paths[rid], kind[rid], fold[rid], timing[rid] = path, what, day, when
    return paths, kind, fold, timing


def spec_for(paths: dict[str, Path], timing: dict[str, str], train: list[str], evaluation: list[str], hard: bool) -> dict:
    ids = train + evaluation
    return {
        "version": 1, "target": "pinch_in", "negatives": NEGATIVES, "excludes": ["left_out"],
        "recordings": {rid: str(paths[rid]) for rid in ids}, "train": train, "evaluation": evaluation,
        "sources": list(lt.MOTION_SOURCES), "backend": lt.CNN_BACKEND, "seed": 17, "research": False, "labelOffsetMs": 0,
        "labelTiming": {rid: timing[rid] for rid in ids}, "steadyStarts": True, "hardNegatives": hard,
    }


def scored(name: str, threshold: float, replays: dict, kind: dict[str, str]) -> dict:
    pinch = [r for r in replays if kind[r] == "pinch"]
    quiet = [r for r in replays if kind[r] != "pinch"]
    return {
        "model": name, "threshold": threshold,
        "all": headline([replays[r][threshold] for r in replays]),
        "pinch": headline([replays[r][threshold] for r in pinch]),
        "noise": headline([replays[r][threshold] for r in quiet]) if quiet else None,
        "perRecording": {r: {**headline([replays[r][threshold]]), "kind": kind[r]} for r in replays},
    }


def main(mode: str) -> None:
    hard = mode == "hard"
    paths, kind, fold, timing = resolve()
    results_path = HERE / "results.json"
    results = json.loads(results_path.read_text()) if results_path.exists() else {"budgetPerHour": BUDGET, "folds": {}}
    for day in DAYS:
        evaluation = [r for r in paths if fold[r] == day]
        train = [r for r in paths if fold[r] != day]
        entry = results["folds"].setdefault(day, {"heldOut": [kind[r] for r in evaluation], "models": {}})
        name = "all days + noise, hard negatives" if hard else "all days + noise"
        if name in entry["models"]:
            continue
        out = HERE / "runs" / f"{'hard' if hard else 'plain'}-{day.replace(' ', '-')}"
        raw = spec_for(paths, timing, train, evaluation, hard)
        started = time.time()
        if not (out / "result.json").exists() or json.loads((out / "result.json").read_text())["outcome"] == "failed":
            print(f"== {day}: {name}", flush=True)
            lt.run(raw, out)
        result = json.loads((out / "result.json").read_text())
        if result["outcome"] == "failed":
            entry["models"][name] = {"failed": result["message"]}
        else:
            spec = lt.parse_spec(raw)
            recs = lt.load_spec_recordings(spec)
            threshold = result["metrics"]["activationThreshold"]
            data = (out / "bundle" / "model.cnn").read_bytes()
            replays = replay(spec, lambda x: cnn.predict(data, x), recs, evaluation, (threshold,))
            entry["models"][name] = {**scored(name, threshold, replays, kind), "hardNegatives": result["metrics"].get("hardNegatives"),
                                     "crossCheck": {k: (result["metrics"].get("crossCheckEvents") or {}).get(k) for k in ("gestures", "caught", "falseActivationsPerHour")},
                                     "minutes": round((time.time() - started) / 60)}
            if "live CNN" not in entry["models"] and LIVE_MODEL.exists():
                live = (LIVE_MODEL / "model.cnn").read_bytes()
                live_threshold = json.loads((LIVE_MODEL / "manifest.json").read_text())["thresholds"]["activation"]
                live_replays = replay(spec, lambda x: cnn.predict(live, x), recs, evaluation, (live_threshold,))
                entry["models"]["live CNN"] = scored("live CNN", live_threshold, live_replays, kind)
            m = entry["models"][name]
            print(f"   {day}: threshold {threshold}, pinch {m['pinch']['caught']}/{m['pinch']['gestures']}, noise {m['noise'] and m['noise']['falseActivationsPerHour']}/h, mined {m['hardNegatives']}", flush=True)
        results_path.write_text(json.dumps(results, indent=2) + "\n")
        write_markdown(results)


def write_markdown(results: dict) -> None:
    def cell(s: dict | None, pinches: bool) -> str:
        if s is None:
            return "–"
        far = "–" if s["falseActivationsPerHour"] is None else f"{s['falseActivationsPerHour']:.0f}/h"
        if not pinches:
            return f"{far} ({s['negativeSeconds'] / 60:.0f} min)"
        return f"{s['caught']}/{s['gestures']} ({100 * s['caught'] / max(s['gestures'], 1):.0f}%) · {far}"

    lines = [
        "# The CNN trained on every camera-timed pinch day and the 4 Nov everyday noise, each day held out (pinch_in)",
        "",
        f"Budget {results['budgetPerHour']:.0f} false activations an hour with no gesture under way. Pinch: caught / pinches · false"
        " activations an hour on the held-out pinch sessions. Noise: false activations an hour on the held-out noise (and fist)"
        " sessions, which hold no pinch. Each model at its own threshold.",
        "",
        "| Held out | Model | Threshold | Pinch | Noise | Learnt from |",
        "|---|---|---|---|---|---|",
    ]
    totals: dict[str, dict] = {}
    for day, entry in results["folds"].items():
        for name, m in entry["models"].items():
            if "failed" in m:
                lines.append(f"| {day} | {name} | – | failed: {m['failed'][:80]} | | |")
                continue
            mined = m.get("hardNegatives")
            lines.append(f"| {day} | {name} | {m['threshold']:.2f} | {cell(m['pinch'], True)} | {cell(m['noise'], False)} | {'' if mined is None else f'{mined} false activations'} |")
            t = totals.setdefault(name, {"caught": 0, "gestures": 0, "pinchFalse": 0, "pinchSeconds": 0.0, "noiseFalse": 0, "noiseSeconds": 0.0})
            t["caught"] += m["pinch"]["caught"]; t["gestures"] += m["pinch"]["gestures"]
            t["pinchFalse"] += m["pinch"]["falseActivations"]; t["pinchSeconds"] += m["pinch"]["negativeSeconds"]
            if m["noise"]:
                t["noiseFalse"] += m["noise"]["falseActivations"]; t["noiseSeconds"] += m["noise"]["negativeSeconds"]
    lines += ["", "Over every fold (each pinch and noise session tested once, by a model that did not train on it):", "",
              "| Model | Pinch caught | False an hour, pinch sessions | False an hour, noise |", "|---|---|---|---|"]
    for name, t in totals.items():
        per = lambda n, s: "–" if s <= 0 else f"{n / (s / 3600):.0f}"  # noqa: E731
        lines.append(f"| {name} | {t['caught']}/{t['gestures']} ({100 * t['caught'] / max(t['gestures'], 1):.0f}%) | {per(t['pinchFalse'], t['pinchSeconds'])} | {per(t['noiseFalse'], t['noiseSeconds'])} |")
    lines += ["", "The live CNN trained on most of the 14 and 17 Oct sessions: its numbers on those folds are not on unseen data."]
    (HERE / "results.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    os.chdir(ROOT)
    main(sys.argv[1] if len(sys.argv) > 1 else "hard")
