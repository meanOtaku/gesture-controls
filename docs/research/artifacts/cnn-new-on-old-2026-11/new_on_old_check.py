"""The CNN trained on the new sessions of 4 Nov (pinches and everyday noise) and tested on every older recording.

Training (4 Nov 2026, `data/recordings/new/`):

* pinch in / out, marked by the camera: the 04:49 and 04:53 sessions (19 pinch-ins each). The 04:46 session is left out:
  its camera saw 20 pinches but never the fingers closer than 0.35 hand sizes, so nothing was marked (`mark_from_camera.py`);
* everyday noise, labelled as a whole with the standard labels: active (2 sessions, `everyday_noise`), hand still (1,
  `still`) and hand on a support (1 flat, 3 angled, `supported`).

Testing, every older recording in Model Lab (and the 3 Nov 12:40 session from `data/recordings/new/`), reported apart:

* camera-timed pinch sessions: 14 Oct (9), 17 Oct (5) and 3 Nov (5);
* the 14 Oct fist sessions (4), which hold no pinch: no-gesture time, where every firing is a false activation;
* the motion-estimated pinch sessions (11), shown but never judged on (their timings come from the signal the model
  detects).

Models, each through the app's trainer (`label_train.run`: the CNN, still-hand gate on, threshold chosen within 30 false
activations an hour on the training recordings only):

* **new**: the CNN trained on the new sessions;
* **new, hard negatives**: the same, trained again with the moments it fired by mistake (`hardNegatives`);
* **live CNN**: the model in the app ("Pinch in tree", trained on 14/17 Oct), replayed as it is, for comparison. It trained
  on most of the 14 and 17 Oct sessions, so on those it is not being tested on unseen data.

Each test recording is replayed at the model's own threshold (`label_train.detections`). As a diagnostic only, the best
threshold on the judged test recordings within the budget is also given.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/cnn-new-on-old-2026-11/new_on_old_check.py

Writes results.json and results.md here, and each run's bundle (importable in Model Lab) under runs/.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))

from label_trainer import cnn, label_train as lt  # noqa: E402
from label_trainer.events import summarise  # noqa: E402

HERE = Path(__file__).resolve().parent
NEW = ROOT / "data" / "recordings" / "new"
# The app's Model Lab folder (`datasets/`, `label-models/`), or a copy of it on another machine.
MODEL_LAB = Path(os.environ.get("MODEL_LAB_DIR", Path.home() / "Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab"))
DATASETS = MODEL_LAB / "datasets"
LIVE_MODEL = MODEL_LAB / "label-models" / "pinch_in-c0cb37c1273a"
BUDGET = lt.FALSE_ACTIVATIONS_BUDGET_PER_HOUR

TRAIN = {
    "gesture-dataset-pinch_in-2026-11-04T04-49-21.416Z": ("4 Nov 04:49 pinch", "camera"),
    "gesture-dataset-pinch_in-2026-11-04T04-53-02.645Z": ("4 Nov 04:53 pinch", "camera"),
    "gesture-dataset-unlabeled-2026-11-04T03-54-31.816Z": ("4 Nov noise: active", "noGesture"),
    "gesture-dataset-unlabeled-2026-11-04T04-37-45.372Z": ("4 Nov noise: active", "noGesture"),
    "gesture-dataset-unlabeled-2026-11-04T04-03-41.167Z": ("4 Nov noise: still", "noGesture"),
    "gesture-dataset-unlabeled-2026-11-04T04-09-05.352Z": ("4 Nov noise: support, flat", "noGesture"),
    "gesture-dataset-unlabeled-2026-11-04T04-15-17.305Z": ("4 Nov noise: support, angled", "noGesture"),
    "gesture-dataset-unlabeled-2026-11-04T04-20-47.293Z": ("4 Nov noise: support, angled", "noGesture"),
    "gesture-dataset-unlabeled-2026-11-04T04-26-46.986Z": ("4 Nov noise: support, angled", "noGesture"),
}
# Model Lab ids (first 8 characters) of the older recordings, with the group each is reported in.
OLD = {
    **{p: "14 Oct pinch" for p in ["82ee8162", "60ef94c6", "827be2d1", "35af4113", "6d6f7b3c", "c6c2a72c", "20a4372a", "b2fcf81f", "aad37c5c"]},
    **{p: "17 Oct pinch" for p in ["833eba84", "6a0d166e", "08d6dfbf", "7b445f79", "ca87d8fd"]},
    **{p: "3 Nov pinch" for p in ["8ed9fd23", "9d150228", "a842ec17", "5be1c51f"]},
    **{p: "14 Oct fist (no pinch)" for p in ["08f918d8", "6a12cac7", "3942decb", "12c09140"]},
    **{p: "estimated pinch (no camera)" for p in ["22baaf00", "de86b647", "480f964e", "1a42119f", "596f7944", "473bd1d6", "499d80a5", "e2aa5f89", "33f4d1b4", "70d6d9a8", "370482fd"]},
}
OLD_FOLDER = {"gesture-dataset-pinch_in-2026-11-03T12-40-05.547Z": "3 Nov pinch"}
TIMING = {"14 Oct pinch": "camera", "17 Oct pinch": "camera", "3 Nov pinch": "camera", "14 Oct fist (no pinch)": "noGesture",
          "estimated pinch (no camera)": "estimated"}
NEGATIVES = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]


def recordings() -> tuple[dict[str, Path], dict[str, str], dict[str, str]]:
    """Every recording's path, the group it is reported in, and its label timing, keyed by id."""
    paths, group, timing = {}, {}, {}
    for name, (title, kind) in TRAIN.items():
        paths[name], group[name], timing[name] = NEW / name, title, kind
    ids = [p.name for p in DATASETS.iterdir() if p.is_dir()]
    for prefix, title in OLD.items():
        match = [i for i in ids if i.startswith(prefix)]
        if len(match) != 1:
            raise SystemExit(f"no single Model Lab recording starts with {prefix}")
        paths[match[0]], group[match[0]], timing[match[0]] = DATASETS / match[0], title, TIMING[title]
    for name, title in OLD_FOLDER.items():
        paths[name], group[name], timing[name] = NEW / name, title, TIMING[title]
    return paths, group, timing


def spec_for(paths: dict[str, Path], timing: dict[str, str], hard: bool) -> dict:
    train = list(TRAIN)
    evaluation = [rid for rid in paths if rid not in TRAIN]
    return {
        "version": 1, "target": "pinch_in", "negatives": NEGATIVES, "excludes": ["left_out"],
        "recordings": {rid: str(p) for rid, p in paths.items()}, "train": train, "evaluation": evaluation,
        "sources": list(lt.MOTION_SOURCES), "backend": lt.CNN_BACKEND, "seed": 17, "research": False, "labelOffsetMs": 0,
        "labelTiming": timing, "steadyStarts": True, "hardNegatives": hard,
    }


def headline(per: list[dict]) -> dict:
    s = summarise(per)
    keep = ("recordings", "gestures", "caught", "gestureRecall", "repeats", "late", "medianLatencyMs", "falseActivations",
            "negativeSeconds", "falseActivationsPerHour")
    return {k: s[k] for k in keep}


def replay(spec: lt.Spec, predict, recs: dict, ids: list[str], thresholds: tuple[float, ...]) -> dict[str, dict[float, dict]]:
    out = {}
    for rid in ids:
        scored = lt.timeline(spec, recs[rid], predict)
        if scored is not None:
            out[rid] = {t: lt.detections(spec, recs[rid], *scored, lt.policy_for(t, spec.trigger)) for t in thresholds}
    return out


def report(name: str, threshold: float, replays: dict, group: dict[str, str], timing: dict[str, str]) -> dict:
    groups = {}
    for title in [*dict.fromkeys(group[r] for r in replays)]:
        groups[title] = headline([replays[r][threshold] for r in replays if group[r] == title])
    judged = [r for r in replays if timing[r] in ("camera", "noGesture")]
    best = None
    for t in next(iter(replays.values())):
        s = headline([replays[r][t] for r in judged])
        if s["falseActivationsPerHour"] is not None and s["falseActivationsPerHour"] <= BUDGET:
            if best is None or (s["caught"], t) > (best["caught"], best["threshold"]):
                best = {**s, "threshold": t}
    return {"model": name, "threshold": threshold, "judged": headline([replays[r][threshold] for r in judged]),
            "byGroup": groups, "bestWithinBudget": best,
            "perRecording": {r: {**headline([replays[r][threshold]]), "group": group[r]} for r in replays}}


def main() -> None:
    paths, group, timing = recordings()
    results = {"budgetPerHour": BUDGET, "train": {k: v[0] for k, v in TRAIN.items()}, "models": []}
    for hard in (False, True):
        name = "new, hard negatives" if hard else "new"
        out = HERE / "runs" / ("cnn-new-hard-negatives" if hard else "cnn-new")
        raw = spec_for(paths, timing, hard)
        started = time.time()
        if not (out / "result.json").exists() or json.loads((out / "result.json").read_text())["outcome"] == "failed":
            print(f"== {name}", flush=True)
            lt.run(raw, out)
        result = json.loads((out / "result.json").read_text())
        if result["outcome"] == "failed":
            results["models"].append({"model": name, "failed": result["message"]})
            (HERE / "results.json").write_text(json.dumps(results, indent=2) + "\n")
            continue
        spec = lt.parse_spec(raw)
        recs = lt.load_spec_recordings(spec)
        threshold = result["metrics"]["activationThreshold"]
        data = (out / "bundle" / "model.cnn").read_bytes()
        candidates = tuple(sorted(set(lt.CNN_THRESHOLD_CANDIDATES + (threshold,))))
        replays = replay(spec, lambda x: cnn.predict(data, x), recs, spec.evaluation, candidates)
        entry = report(name, threshold, replays, group, timing)
        entry.update({"outcome": result["outcome"], "verdict": result["message"], "hardNegatives": result["metrics"].get("hardNegatives"),
                      "crossCheck": {k: (result["metrics"].get("crossCheckEvents") or {}).get(k) for k in ("gestures", "caught", "falseActivationsPerHour")},
                      "minutes": round((time.time() - started) / 60)})
        results["models"].append(entry)
        (HERE / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(f"   {name}: threshold {threshold}, judged {entry['judged']['caught']}/{entry['judged']['gestures']}, {entry['judged']['falseActivationsPerHour']}/h", flush=True)
    # The live CNN, as it is, on the same test recordings.
    raw = spec_for(paths, timing, False)
    spec = lt.parse_spec(raw)
    recs = lt.load_spec_recordings(spec)
    threshold = json.loads((LIVE_MODEL / "manifest.json").read_text())["thresholds"]["activation"]
    data = (LIVE_MODEL / "model.cnn").read_bytes()
    candidates = tuple(sorted(set(lt.CNN_THRESHOLD_CANDIDATES + (threshold,))))
    replays = replay(spec, lambda x: cnn.predict(data, x), recs, spec.evaluation, candidates)
    results["models"].append(report("live CNN (trained on 14/17 Oct)", threshold, replays, group, timing))
    (HERE / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    write_markdown(results)


def write_markdown(results: dict) -> None:
    def cell(s: dict) -> str:
        far = "–" if s["falseActivationsPerHour"] is None else f"{s['falseActivationsPerHour']:.0f}"
        if not s["gestures"]:
            return f"– · {far}/h"
        return f"{s['caught']}/{s['gestures']} ({100 * s['caught'] / s['gestures']:.0f}%) · {far}/h"

    models = [m for m in results["models"] if "failed" not in m]
    groups = [*dict.fromkeys(g for m in models for g in m["byGroup"])]
    lines = [
        "# The CNN trained on 4 Nov (pinches and everyday noise), tested on every older recording (pinch_in)",
        "",
        f"Each cell: pinches caught / pinches (TAR) · false activations an hour with no gesture under way. Budget {results['budgetPerHour']:.0f}/h."
        " Each model at its own threshold. Judged = the camera-timed sessions and the fist sessions together.",
        "",
        "| Model | Threshold | Judged | " + " | ".join(groups) + " |",
        "|---|---|---|" + "---|" * len(groups),
    ]
    for m in models:
        lines.append(f"| {m['model']} | {m['threshold']:.2f} | {cell(m['judged'])} | " + " | ".join(cell(m['byGroup'][g]) if g in m["byGroup"] else "" for g in groups) + " |")
    lines += ["", "Median latency (ms from a pinch's start to its catch), judged: " + "; ".join(
        f"{m['model']} {m['judged']['medianLatencyMs']:.0f}" for m in models if m["judged"]["medianLatencyMs"] is not None) + ".", "",
              "Diagnostic (never used to choose a threshold): the best threshold on the judged test recordings within the budget.", ""]
    for m in models:
        b = m["bestWithinBudget"]
        lines.append(f"- {m['model']}: " + ("none within the budget" if b is None else f"{b['caught']}/{b['gestures']} at {b['threshold']:.2f} ({b['falseActivationsPerHour']:.0f}/h)"))
    failed = [m for m in results["models"] if "failed" in m]
    if failed:
        lines += ["", "Failed: " + "; ".join(f"{m['model']}: {m['failed']}" for m in failed)]
    (HERE / "results.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
