"""The CNN trained on every camera-timed pinch session and the everyday noise of 4 Nov, each day held out in turn.

Recordings, all in `data/recordings/` (the same data as Model Lab's, so this runs from a clone of the repo):

* camera-timed pinch sessions: 14 Oct (9), 17 Oct (5), 3 Nov (5), 4 Nov (3: 04:46, 04:49 and 04:53);
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
| 4 Nov | 4 Nov (3) | support angled 04:15 |

Each fold through the app's trainer (`label_train.run`: the CNN, still-hand gate on, threshold chosen within 30 false
activations an hour on the training recordings only), with and without `hardNegatives` (learning from its own false
activations, found at the lowest cut-off). The live CNN ("Pinch in tree", trained on most of the 14/17 Oct sessions) is
replayed on the same held-out recordings for comparison; on 14 and 17 Oct it is not being tested on unseen data.

"pretrained" is "anytime" with `pretraining.py` first. "wide" is "anytime" on a 2 s window ending at the same moment, with a
fourth convolution (dilation 8) so the filters reach 1.2 s; `widen` changes the constants for that run, here only, so its
bundles are for this comparison and the app cannot run them. "anytime" trains without the gate, so the model also sees the moments the hand was moving, and is replayed both without
the gate and with it (the second as "all moments, gate when running", at the same threshold).

    tools/label-trainer/.venv/bin/python docs/research/artifacts/cnn-all-days-2026-11/all_days_check.py hard|plain|anytime|pretrained|wide

Each mode adds to results.json and rewrites results.md here, skipping a day already in
results.json. Bundles go under runs/. The live CNN comes from the app's `model-lab` folder (`MODEL_LAB_DIR` for a copy of
it); without it, that comparison is left out.
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
sys.path.insert(0, str(Path(__file__).resolve().parent))

from label_trainer import cnn, cnn_input, label_train as lt  # noqa: E402
import pretraining  # noqa: E402
from new_on_old_check import LIVE_MODEL, NEGATIVES, headline, replay  # noqa: E402

HERE = Path(__file__).resolve().parent
BUDGET = lt.FALSE_ACTIVATIONS_BUDGET_PER_HOUR

RELABELLED = "pinch-relabelled/2026-10-downloads/gesture-dataset-pinch-"
FIST = "old/2026-10-downloads/gesture-dataset-fist-2026-10-14T"
PINCH = "new/gesture-dataset-pinch_in-2026-11-0"
NOISE = "new/gesture-dataset-unlabeled-2026-11-04T"
# (path under data/recordings, what it is, the day whose fold holds it out, label timing). Model Lab holds the same data.
RECORDINGS = [
    *[(f"{RELABELLED}2026-10-14T{t}.csv", "pinch", "14 Oct", "camera") for t in ["00-54-06.988Z", "00-55-38.245Z", "00-57-01.701Z", "00-58-20.761Z", "00-59-37.623Z", "01-00-54.801Z", "01-04-14.013Z", "01-05-31.133Z", "01-13-08.108Z"]],
    *[(f"{FIST}{t}.csv", "fist", "14 Oct", "noGesture") for t in ["01-02-50.880Z", "01-06-46.525Z", "01-10-16.565Z", "01-11-31.499Z"]],
    *[(f"{RELABELLED}2026-10-17T{t}", "pinch", "17 Oct", "camera") for t in ["12-21-44.346Z", "12-23-03.399Z.csv", "12-25-10.832Z.csv", "12-26-46.748Z.csv", "12-40-50.602Z"]],
    *[(f"{PINCH}3T{t}", "pinch", "3 Nov", "camera") for t in ["01-08-16.560Z", "01-10-50.957Z", "01-13-19.283Z", "01-17-14.928Z", "12-40-05.547Z"]],
    (f"{PINCH}4T04-46-55.110Z", "pinch", "4 Nov", "camera"),
    (f"{PINCH}4T04-49-21.416Z", "pinch", "4 Nov", "camera"),
    (f"{PINCH}4T04-53-02.645Z", "pinch", "4 Nov", "camera"),
    (f"{NOISE}03-54-31.816Z", "noise: active", "14 Oct", "noGesture"),
    (f"{NOISE}04-37-45.372Z", "noise: active", "17 Oct", "noGesture"),
    (f"{NOISE}04-03-41.167Z", "noise: still", "3 Nov", "noGesture"),
    (f"{NOISE}04-09-05.352Z", "noise: support, flat", "3 Nov", "noGesture"),
    (f"{NOISE}04-15-17.305Z", "noise: support, angled", "4 Nov", "noGesture"),
    (f"{NOISE}04-20-47.293Z", "noise: support, angled", None, "noGesture"),
    (f"{NOISE}04-26-46.986Z", "noise: support, angled", None, "noGesture"),
]
DAYS = ["14 Oct", "17 Oct", "3 Nov", "4 Nov"]
SEED = int(os.environ.get("SEED", "17"))   # another seed adds its own models and runs, for how much a result is chance


def resolve() -> tuple[dict[str, Path], dict[str, str], dict[str, str | None], dict[str, str]]:
    """Each recording's path, what it is, the fold that holds it out and its label timing, keyed by its name."""
    paths, kind, fold, timing = {}, {}, {}, {}
    for relative, what, day, when in RECORDINGS:
        path = ROOT / "data" / "recordings" / relative
        if not path.exists():
            raise SystemExit(f"no recording at {path}")
        rid = path.stem if path.is_file() else path.name
        paths[rid], kind[rid], fold[rid], timing[rid] = path, what, day, when
    return paths, kind, fold, timing


def widen() -> None:
    """The window and the network for the "wide" run."""
    cnn_input.WINDOW_TICKS = 100
    cnn_input.GRID_TICKS = cnn_input.WINDOW_TICKS + cnn_input.HISTORY_TICKS - 1
    cnn_input.SPAN_NS = (cnn_input.GRID_TICKS - 1) * cnn_input.TICK_NS
    cnn_input.FEATURE_NAMES = tuple(f"cnn_{c}_t{t:03d}" for c in cnn_input.CHANNELS for t in range(cnn_input.WINDOW_TICKS))
    cnn_input.FEATURE_COUNT = len(cnn_input.FEATURE_NAMES)
    cnn.LENGTH = cnn_input.WINDOW_TICKS
    cnn.CONVOLUTIONS = (*cnn.CONVOLUTIONS, (64, 8))


def spec_for(paths: dict[str, Path], timing: dict[str, str], train: list[str], evaluation: list[str], hard: bool, steady: bool = True) -> dict:
    ids = train + evaluation
    return {
        "version": 1, "target": "pinch_in", "negatives": NEGATIVES, "excludes": ["left_out"],
        "recordings": {rid: str(paths[rid]) for rid in ids}, "train": train, "evaluation": evaluation,
        "sources": list(lt.MOTION_SOURCES), "backend": lt.CNN_BACKEND, "seed": SEED, "research": False, "labelOffsetMs": 0,
        "labelTiming": {rid: timing[rid] for rid in ids}, "steadyStarts": steady, "hardNegatives": hard,
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
    hard, pretrain, wide, steady = mode == "hard", mode == "pretrained", mode == "wide", mode not in ("anytime", "pretrained", "wide")
    if wide:
        widen()
    paths, kind, fold, timing = resolve()
    results_path = HERE / "results.json"
    results = json.loads(results_path.read_text()) if results_path.exists() else {"budgetPerHour": BUDGET, "folds": {}}
    for day in DAYS:
        evaluation = [r for r in paths if fold[r] == day]
        train = [r for r in paths if fold[r] != day]
        entry = results["folds"].setdefault(day, {"heldOut": [kind[r] for r in evaluation], "models": {}})
        name = "all days + noise, hard negatives" if hard else "all days + noise" if steady else "all moments, pretrained" if pretrain else "all moments, 2 s window" if wide else "all moments, no still-hand gate"
        name += "" if SEED == 17 else f" (seed {SEED})"
        if name in entry["models"]:
            continue
        out = HERE / "runs" / f"{mode}-{day.replace(' ', '-')}{'' if SEED == 17 else f'-seed{SEED}'}"
        raw = spec_for(paths, timing, train, evaluation, hard, steady)
        started = time.time()
        if not (out / "result.json").exists() or json.loads((out / "result.json").read_text())["outcome"] == "failed":
            print(f"== {day}: {name}", flush=True)
            restore = pretraining.install(lt.parse_spec(raw), lt.load_spec_recordings(lt.parse_spec(raw))) if pretrain else None
            lt.run(raw, out)
            if restore:
                restore()
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
            if not steady and not pretrain and not wide and SEED == 17:
                gated = lt.parse_spec({**raw, "steadyStarts": True})
                both = replay(gated, lambda x: cnn.predict(data, x), recs, evaluation, (threshold,))
                entry["models"]["all moments, gate when running"] = scored("all moments, gate when running", threshold, both, kind)
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
