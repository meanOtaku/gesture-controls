"""Trees against CNN for `pinch_in`, trained on the camera-timed old and new sessions, judged by the event standard.

The standard is `docs/research/gesture-detector-evaluation-metrics.md`: each detection a catch, a repeat, late, or a false
activation; TAR, Miss Rate and false activations per hour with no gesture under way (budget 30 an hour); old and new
sessions reported apart, never blended.

Recordings (Model Lab's, all labelled by the camera):

* **old**: 14 Oct (9 pinch sessions) and 17 Oct (5), plus four 14 Oct fist sessions used only for training;
* **new**: the four sessions of 3 Nov.

Two old sessions are always held out: 14 Oct 00:57 and 17 Oct 12:26, which the app's live CNN ("Pinch in tree", trained on
the old sessions only) did not train on either, so it can be replayed on them as a baseline.

Conditions, each trained with the app's own trainer (`label_train.run`: the same features, threshold chosen within the
budget on the training recordings only, still-hand gate on as the app's setting is):

* **old + new** (4 folds): each fold holds out one 3 Nov session (and the two old ones) and trains on everything else.
  Each new session is held out exactly once, so the new-session totals cover all four.
* **old only** (1 run): trained on the old sessions only, tested on all four new ones and the two old ones.
* **old + new, hard negatives** (trees, 4 folds): as old + new, trained a second time with the moments the model fired with
  no gesture under way on its training recordings (`hardNegatives`, the app's "Learn from its own false alarms").
* **live CNN**: the model in the app, replayed as it is (threshold 0.75, peak trigger).

Each held-out recording is replayed at the model's own threshold (`label_train.detections`). As a diagnostic only, it also
reports the best TAR any threshold reaches within the budget on the held-out recordings ("oracle"): it says how well the
model ranks, apart from how well its threshold was chosen, and must never be used to choose one.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/camera-old-new-2026-11/old_new_check.py [DATASETS_DIR]

Run from the repository root (about an hour: the CNN trains several times per run). Writes results.json and results.md
next to this file, and each run's bundle (importable in Model Lab) under runs/.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))

from label_trainer import cnn, label_train as lt, trees  # noqa: E402
from label_trainer.events import summarise  # noqa: E402

HERE = Path(__file__).resolve().parent
DATASETS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab/datasets"
LIVE_MODEL = DATASETS.parent / "label-models" / "pinch_in-c0cb37c1273a"

OLD = {
    "82ee8162-4b3a-42a6-8a2e-bd4942a40a9e": "14 Oct 00:54", "60ef94c6-1779-4a55-9856-870eb76fab84": "14 Oct 00:55",
    "827be2d1-6ca3-4865-8155-3773db495a7f": "14 Oct 00:57", "35af4113-a8a1-438f-bef5-258b9738d015": "14 Oct 00:58",
    "6d6f7b3c-98b3-46ad-b256-20ef1035a5b0": "14 Oct 00:59", "c6c2a72c-d0cc-4591-a9b6-700200219f91": "14 Oct 01:00",
    "20a4372a-3273-45ae-8816-f84dfe00bdbf": "14 Oct 01:04", "b2fcf81f-7b06-4aeb-80b5-95f9f408ff06": "14 Oct 01:05",
    "aad37c5c-f4e5-44ba-a9c5-4ae1faf89b4a": "14 Oct 01:13",
    "833eba84-1490-430d-bc08-d45d86ae0355": "17 Oct 12:21", "6a0d166e-72aa-43c6-9a1a-ee0331309200": "17 Oct 12:23",
    "08d6dfbf-bc2f-460e-8dea-84b483153344": "17 Oct 12:25", "7b445f79-cd38-41a6-a6f4-afac8c9b1971": "17 Oct 12:26",
    "ca87d8fd-7fe2-4353-b797-4c08ec654e3d": "17 Oct 12:40",
}
FIST = ["08f918d8-c3df-40d5-a268-d0004257d759", "6a12cac7-8132-4af8-ae9d-a18f3e0e2fa6",
        "3942decb-4943-4625-8ba6-ee2522189be3", "12c09140-6c00-423c-84c0-54fe82dddaa1"]
NEW = {"8ed9fd23-5216-4642-8705-feea39125ba4": "3 Nov a", "9d150228-fb00-4533-a7a4-82801c4a864e": "3 Nov b", "a842ec17-bfe1-4b93-9719-43f452e302d5": "3 Nov c", "5be1c51f-6c3d-499d-82aa-34f938a69157": "3 Nov d"}
HELD_OLD = ["14 Oct 00:57", "17 Oct 12:26"]
NEGATIVES = ["pinch_hold", "pinch_out", "fist", "hand_open"]
BUDGET = lt.FALSE_ACTIVATIONS_BUDGET_PER_HOUR


def resolve(prefixes: dict[str, str]) -> dict[str, str]:
    """Model Lab ids from the (possibly shortened) ones above, so a typo fails loudly."""
    ids = {p.name for p in DATASETS.iterdir() if p.is_dir()}
    out = {}
    for prefix, name in prefixes.items():
        match = [i for i in ids if i.startswith(prefix[:12])]
        if len(match) != 1:
            raise SystemExit(f"no single recording starts with {prefix[:12]} in {DATASETS}")
        out[match[0]] = name
    return out


def spec_for(backend: str, train: list[str], evaluation: list[str], hard: bool = False) -> dict:
    ids = train + evaluation
    return {
        "version": 1, "target": "pinch_in", "negatives": NEGATIVES, "excludes": ["left_out"],
        "recordings": {rid: str(DATASETS / rid) for rid in ids}, "train": train, "evaluation": evaluation,
        "sources": list(lt.MOTION_SOURCES), "backend": backend, "seed": 17, "research": False, "labelOffsetMs": 0,
        "labelTiming": {rid: "camera" for rid in ids}, "steadyStarts": True, "hardNegatives": hard,
    }


def scorer(bundle: Path, cnn_model: bool):
    data = (bundle / ("model.cnn" if cnn_model else "model.trees")).read_bytes()
    return (lambda x: cnn.predict(data, x)) if cnn_model else (lambda x: trees.predict(data, x))


def replay_each(spec: lt.Spec, predict, recordings: dict, ids: list[str], thresholds: tuple[float, ...]) -> dict[str, dict[float, dict]]:
    """Each recording's counted detections at each threshold."""
    out = {}
    for rid in ids:
        scored = lt.timeline(spec, recordings[rid], predict)
        if scored is None:
            continue
        out[rid] = {t: lt.detections(spec, recordings[rid], *scored, lt.policy_for(t, spec.trigger)) for t in thresholds}
    return out


def headline(per: list[dict]) -> dict:
    s = summarise(per)
    keep = ("recordings", "gestures", "caught", "gestureRecall", "repeats", "late", "repeatsPer100Gestures", "medianLatencyMs",
            "falseActivations", "negativeSeconds", "falseActivationsPerHour")
    return {k: s[k] for k in keep}


def oracle(replays: dict[str, dict[float, dict]], ids: list[str]) -> dict | None:
    """The best TAR within the budget at any one threshold over `ids` (diagnostic: chosen on the held-out recordings)."""
    best = None
    for t in next(iter(replays.values())).keys():
        s = headline([replays[r][t] for r in ids if r in replays])
        rate = s["falseActivationsPerHour"]
        if (rate is None and s["falseActivations"] == 0) or (rate is not None and rate <= BUDGET):
            if best is None or (s["caught"], t) > (best["caught"], best["threshold"]):
                best = {**s, "threshold": t}
    return best


def main() -> None:
    old, new, fist = resolve(OLD), resolve(NEW), list(resolve({f: "fist" for f in FIST}))
    name = {**old, **new, **{f: "14 Oct fist" for f in fist}}
    held_old = [rid for rid, n in old.items() if n in HELD_OLD]
    train_old = [rid for rid in old if rid not in held_old] + fist
    runs_dir = HERE / "runs"
    conditions = []
    for backend in (lt.BACKEND, lt.CNN_BACKEND):
        conditions.append((backend, "old only", train_old, held_old + list(new), False))
        for rid in new:
            conditions.append((backend, f"old + new, {new[rid]} held out", train_old + [r for r in new if r != rid], held_old + [rid], False))
    # The trees again, trained a second time with the moments they fired by mistake (`label_train.reinforce`).
    for rid in new:
        conditions.append((lt.BACKEND, f"old + new, hard negatives, {new[rid]} held out", train_old + [r for r in new if r != rid], held_old + [rid], True))
    results = {"recordings": name, "heldOld": held_old, "budgetPerHour": BUDGET, "runs": []}
    for backend, label, train, evaluation, hard in conditions:
        kind = "cnn" if backend == lt.CNN_BACKEND else "trees"
        out = runs_dir / f"{kind}-{label.replace(' ', '-').replace(',', '').replace('+', 'and')}"
        started = time.time()
        if not (out / "result.json").exists() or json.loads((out / "result.json").read_text())["outcome"] == "failed":
            print(f"== {kind}: {label}", flush=True)
            lt.run(spec_for(backend, train, evaluation, hard), out)
        result = json.loads((out / "result.json").read_text())
        if result["outcome"] == "failed":
            results["runs"].append({"model": kind, "condition": label, "failed": result["message"]})
            continue
        spec = lt.parse_spec(spec_for(backend, train, evaluation, hard))
        recordings = lt.load_spec_recordings(spec)
        threshold = result["metrics"]["activationThreshold"]
        candidates = tuple(sorted(set((lt.CNN_THRESHOLD_CANDIDATES if spec.cnn else lt.THRESHOLD_CANDIDATES) + (threshold,))))
        replays = replay_each(spec, scorer(out / "bundle", spec.cnn), recordings, evaluation, candidates)
        results["runs"].append({
            "model": kind, "condition": label, "threshold": threshold, "hardNegatives": result["metrics"].get("hardNegatives"), "outcome": result["outcome"], "verdict": result["message"],
            "train": [name[r] for r in train], "seconds": round(time.time() - started),
            "crossCheck": {k: result["metrics"].get("crossCheckEvents", {}).get(k) for k in ("gestures", "caught", "falseActivationsPerHour")},
            "perRecording": {rid: {**headline([replays[rid][threshold]]), "name": name[rid]} for rid in replays},
            "oracleNew": oracle(replays, [r for r in evaluation if r in new]),
            "oracleOld": oracle(replays, held_old),
        })
        (HERE / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    # The live CNN, as it is.
    manifest = json.loads((LIVE_MODEL / "manifest.json").read_text())
    live_ids = held_old + list(new)
    spec = lt.parse_spec(spec_for(lt.CNN_BACKEND, train_old, live_ids))
    recordings = lt.load_spec_recordings(spec)
    threshold = manifest["thresholds"]["activation"]
    candidates = tuple(sorted(set(lt.CNN_THRESHOLD_CANDIDATES + (threshold,))))
    replays = replay_each(spec, scorer(LIVE_MODEL, True), recordings, live_ids, candidates)
    results["runs"].append({
        "model": "live cnn", "condition": "in the app (old sessions only)", "threshold": threshold,
        "perRecording": {rid: {**headline([replays[rid][threshold]]), "name": name[rid]} for rid in replays},
        "oracleNew": oracle(replays, list(new)), "oracleOld": oracle(replays, held_old),
    })
    (HERE / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    write_markdown(results, new)


def write_markdown(results: dict, new: dict[str, str]) -> None:
    def pooled(runs: list[dict], which: str) -> dict:
        per = [{**r, "latenciesMs": [], "negativeNs": r["negativeSeconds"] * 1e9} for run in runs for rid, r in run["perRecording"].items()
               if (rid in new) == (which == "new")]
        # summarise wants latencies; pool the medians by weight instead.
        s = headline(per)
        lat = [r["medianLatencyMs"] for run in runs for rid, r in run["perRecording"].items() if (rid in new) == (which == "new") and r["medianLatencyMs"] is not None]
        s["medianLatencyMs"] = float(np.median(lat)) if lat else None
        return s

    def cell(s: dict) -> str:
        far = "–" if s["falseActivationsPerHour"] is None else f"{s['falseActivationsPerHour']:.0f}"
        tar = "–" if not s["gestures"] else f"{100 * s['caught'] / s['gestures']:.0f}%"
        rep = "–" if not s["gestures"] else f"{100 * s['repeats'] / s['gestures']:.0f}"
        lat = "–" if s["medianLatencyMs"] is None else f"{s['medianLatencyMs']:.0f}"
        return f"{s['caught']}/{s['gestures']} ({tar}) | {far} | {rep} | {s['late']} | {lat}"

    groups: dict[tuple[str, str], list[dict]] = {}
    for run in results["runs"]:
        if "failed" in run:
            continue
        folds = "old + new, hard negatives (4 folds)" if "hard negatives" in run["condition"] else "old + new (4 folds)"
        key = (run["model"], folds if run["condition"].startswith("old + new") else run["condition"])
        groups.setdefault(key, []).append(run)
    lines = [
        "# Trees vs CNN on camera-timed old and new sessions (pinch_in)",
        "",
        f"Budget: {results['budgetPerHour']:.0f} false activations an hour with no gesture under way. Each model at its own threshold"
        " (chosen on its training recordings). TAR = caught / pinches; FAR per hour with no gesture under way; repeats per 100"
        " pinches; late = fired during a pinch it missed; latency = median ms from the pinch's start to its catch.",
        "",
        "| Model | Trained on | Threshold | New sessions (3 Nov): TAR | FAR/h | rep/100 | late | ms | Old held-out (14, 17 Oct): TAR | FAR/h | rep/100 | late | ms |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for (model, condition), runs in groups.items():
        thresholds = ", ".join(f"{r['threshold']:.2f}" for r in runs)
        lines.append(f"| {model} | {condition} | {thresholds} | {cell(pooled(runs, 'new'))} | {cell(pooled(runs, 'old'))} |")
    lines += ["", "Old held-out totals of the 4-fold runs add the same two recordings once per fold.", "",
              "## Diagnostic: the best threshold on the held-out recordings (never used to choose one)", "",
              "| Model | Trained on | New: best TAR within budget (threshold) | Old: best TAR within budget (threshold) |", "|---|---|---|---|"]
    for (model, condition), runs in groups.items():
        def best(key: str) -> str:
            parts = [r[key] for r in runs]
            if any(p is None for p in parts):
                return "none within budget" if all(p is None for p in parts) else "some folds none"
            caught, gestures = sum(p["caught"] for p in parts), sum(p["gestures"] for p in parts)
            return f"{caught}/{gestures} ({100 * caught / max(gestures, 1):.0f}%) at {', '.join(f'{p['threshold']:.2f}' for p in parts)}"
        lines.append(f"| {model} | {condition} | {best('oracleNew')} | {best('oracleOld')} |")
    failed = [r for r in results["runs"] if "failed" in r]
    if failed:
        lines += ["", "Failed: " + "; ".join(f"{r['model']} {r['condition']}: {r['failed']}" for r in failed)]
    (HERE / "results.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
