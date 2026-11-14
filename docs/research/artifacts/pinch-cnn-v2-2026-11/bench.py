"""Fixed benchmark for pinch-start model variants (phase 1: offline only; Model Lab is not touched).

One train/test split by session (`SPLIT`), the trainer's own examples, inputs, detection rule and event accounting, and one
report: pinches caught per test group and false activations per hour, over a sweep of activation thresholds, plus the
threshold chosen without the test set (out of fold on the training recordings, the trainer's budget rule).

The trainer is imported from TRAINER_SRC (default: this checkout's tools/label-trainer/src), so a model trained by an older
trainer is scored with the inputs it was trained on.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, os.environ.get("TRAINER_SRC", str(ROOT / "tools/label-trainer/src")))

import numpy as np  # noqa: E402

from label_trainer import label_train, ppg_onset  # noqa: E402

HERE = Path(__file__).resolve().parent
HL = ROOT / "data/recordings/Hand labeled"
CACHE = Path(os.environ.get("BENCH_CACHE", Path.home() / "Library/Caches/gesture-controls-pinch-bench"))
NEGATIVES = ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"]
THRESHOLDS = [0.999, 0.998, 0.995, 0.99, 0.98, 0.97, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5]
P = "gesture-dataset-"

AE0A22BF_TRAIN = [P + n for n in (
    "everyday_noise-2026-11-04T03-44-21.667Z", "pinch-2026-10-14T01-13-08.108Z",
    "pinch_hold-2026-11-03T01-05-59.434Z", "pinch_hold-2026-11-03T01-11-04.170Z", "pinch_hold-2026-11-03T01-14-58.817Z",
    "pinch_hold-2026-11-03T12-37-53.427Z", "pinch_hold-2026-11-04T04-47-01.331Z", "pinch_hold-2026-11-06T05-30-51.772Z",
    "pinch_hold-2026-11-06T05-46-24.047Z", "pinch_hold-2026-11-06T07-08-33.250Z", "pinch_hold-2026-11-06T08-41-12.292Z",
    "pinch_hold-2026-11-06T08-44-16.477Z", "still-2026-11-06T07-11-20.266Z", "still-2026-11-06T07-14-43.573Z",
    "supported-2026-11-04T04-03-55.246Z", "supported-2026-11-04T04-10-07.238Z", "supported-2026-11-04T04-15-37.172Z",
    "supported-2026-11-04T04-21-36.838Z", "supported-2026-11-06T06-16-23.565Z", "supported-2026-11-06T06-23-39.358Z")]

# Train: ae0a22bf's training recordings, the second 13 Nov live session and the first 14 Nov noise session. Test: every
# group below, none of which ae0a22bf trained on either. Left out: live windows that overlap a test window (13 Nov
# 07:29:39-07:30:03, 08:11:45) and the 4 Nov `new/` session, which has only its automatic labels.
SPLIT = {
    "train": AE0A22BF_TRAIN + [P + "pinch_hold-2026-11-13T08-12-02.014Z", P + "unlabeled-2026-11-14T09-58-34.967Z"],
    "test": {
        "live": [P + "pinch_hold-2026-11-13T07-29-29.795Z", P + "pinch_hold-2026-11-13T07-30-09.372Z"],
        "moving": [P + f"pinch_hold-2026-11-09T{t}Z" for t in
                   ("10-59-34.843", "12-00-11.890", "13-48-35.709", "13-51-14.408", "13-54-14.793")],
        "resting": [P + f"pinch_hold-{t}Z" for t in
                    ("2026-11-03T01-08-34.844", "2026-11-04T04-50-33.518", "2026-11-06T08-10-50.079")],
        "everyday": [P + "unlabeled-2026-11-14T10-29-35.618Z", P + "everyday_noise-2026-11-04T04-27-35.286Z"],
        "still": [P + f"{t}Z" for t in ("still-2026-11-04T04-00-31.075", "still-2026-11-06T07-13-21.030",
                                         "supported-2026-11-06T06-27-29.681", "supported-2026-11-06T06-33-21.079")],
    },
}
GROUPS = list(SPLIT["test"])
# BENCH_TRAIN=ae0a22bf trains on ae0a22bf's recordings only (to separate the data from the method).
# BENCH_TRAIN=ae0a22bf+live or ae0a22bf+noise add only the live session or only the noise session to those.
_TRAIN = os.environ.get("BENCH_TRAIN", "")
if _TRAIN.startswith("ae0a22bf"):
    SPLIT["train"] = list(AE0A22BF_TRAIN) + (
        [P + "pinch_hold-2026-11-13T08-12-02.014Z"] if _TRAIN == "ae0a22bf+live" else
        [P + "unlabeled-2026-11-14T09-58-34.967Z"] if _TRAIN == "ae0a22bf+noise" else [])


def test_ids() -> list[str]:
    return [rid for g in GROUPS for rid in SPLIT["test"][g]]


def spec_for(ids: list[str], hz: int | None = None, seed: int = 17, evaluation: list[str] | None = None):
    raw = {"version": 1, "target": "pinch_in", "negatives": NEGATIVES, "excludes": ["left_out"],
           "recordings": {rid: str(HL / rid) for rid in ids}, "train": [r for r in ids if r not in (evaluation or [])],
           "evaluation": evaluation or [], "sources": list(label_train.MOTION_SOURCES),
           "backend": label_train.CNN_BACKEND, "seed": seed, "steadyStarts": False, "hardNegatives": True}
    if hz:
        raw["motionHz"] = hz
    return label_train.parse_spec(raw)


_RECS: dict[str, object] = {}


def recording(rid: str):
    if rid not in _RECS:
        _RECS[rid] = label_train.load_spec_recordings(spec_for([rid]))[rid]
    return _RECS[rid]


# An input builder: (spec, recording, decision times) -> (decisions, features) array, NaN rows where there are none.
Inputs = Callable[[object, object, np.ndarray], np.ndarray]


def decided(spec, rid, d):
    """The moments a recording's own (the old trainer has no sessions: all of them)."""
    return spec.decided(rid, d) if hasattr(spec, "decided") else np.ones(len(d), dtype=bool)


def trainer_inputs(spec, rec, decisions):
    return label_train.inputs(spec, rec, decisions)


def _cached(name: str, rid: str, build):
    key = hashlib.sha1(f"{os.environ.get('TRAINER_SRC', '')}|{name}|{rid}".encode()).hexdigest()[:16]
    path = CACHE / f"{key}.npz"
    if path.exists():
        z = np.load(path)
        return tuple(z[k] for k in sorted(z.files))
    out = build()
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez(path, **{f"a{i}": a for i, a in enumerate(out)})
    return out


@dataclass
class Data:
    x: np.ndarray        # (examples, features) float32
    y: np.ndarray        # 1 at a pinch start's moments, 0 otherwise
    groups: np.ndarray   # the recording each example comes from


def training_data(inputs: Inputs = trainer_inputs, name: str = "trainer", hz: int | None = None) -> Data:
    """The trainer's CNN training moments (`label_train.cnn_examples`) of every training recording, with `inputs`."""
    spec = spec_for(SPLIT["train"], hz)
    xs, ys, gs = [], [], []
    for rid in SPLIT["train"]:
        def build():
            rec = recording(rid)
            d, y, _ = label_train.cnn_examples(spec, rec)
            x = inputs(spec, rec, d)
            ok = np.isfinite(x).all(axis=1) & decided(spec, rid, d)
            return x[ok].astype(np.float32), y[ok].astype(np.int8)
        x, y = _cached(f"train|{name}|{hz}", rid, build)
        xs.append(x); ys.append(y); gs += [rid] * len(y)
    return Data(np.concatenate(xs), np.concatenate(ys), np.array(gs))


def timeline(spec, rec, rid: str, predict, inputs: Inputs, name: str):
    """Every pulse sample the runtime would decide on, and `predict`'s score for each (as `label_train.timeline`)."""
    def build():
        ts, _ = label_train.pulse_of(rec)
        x = inputs(spec, rec, ts)
        ok = np.isfinite(x).all(axis=1) & decided(spec, getattr(rec, "session_id", rid), ts)
        return ts[ok], x[ok].astype(np.float32)
    ts, x = _cached(f"timeline|{name}|{getattr(spec, 'motion_hz', 50)}", rid, build)
    return ts, np.asarray(predict(x), dtype=np.float64)


def score(predict, inputs: Inputs = trainer_inputs, name: str = "trainer", hz: int | None = None,
          ids: list[str] | None = None) -> dict[str, dict[float, dict[str, float]]]:
    """Per test group and threshold: gestures, caught, false activations and hours without the gesture."""
    out = {g: {t: dict(gestures=0, caught=0, fa=0, neg_h=0.0) for t in THRESHOLDS} for g in GROUPS}
    for g in GROUPS:
        for rid in SPLIT["test"][g]:
            if ids is not None and rid not in ids:
                continue
            spec = spec_for([rid], hz, evaluation=[rid])
            rec = recording(rid)
            t, s = timeline(spec, rec, rid, predict, inputs, name)
            for th in THRESHOLDS:
                r = label_train.detections(spec, rec, t, s, label_train.policy_for(th, spec.trigger))
                a = out[g][th]
                a["gestures"] += r["gestures"]; a["caught"] += r["caught"]
                a["fa"] += r["falseActivations"]; a["neg_h"] += r["negativeNs"] / 3.6e12
    return out


def choose_threshold_oof(fit, data: Data, inputs: Inputs = trainer_inputs, name: str = "trainer",
                         hz: int | None = None, folds: int = 4, seed: int = 17) -> tuple[float, dict]:
    """The activation chosen without the test set: `folds` models each trained without some training recordings score
    those recordings' timelines, and the trainer's budget rule (`label_train.budget_threshold`) picks the cut-off."""
    rng = np.random.default_rng(seed)
    ids = list(SPLIT["train"]); rng.shuffle(ids)
    timelines = []
    for k in range(folds):
        held = ids[k::folds]
        keep = ~np.isin(data.groups, held)
        predict = fit(Data(data.x[keep], data.y[keep], data.groups[keep]))
        for rid in held:
            spec = spec_for([rid], hz, evaluation=[rid])
            rec = recording(rid)
            t, s = timeline(spec, rec, rid, predict, inputs, name)
            timelines.append((rec, t, s))
    spec = spec_for(SPLIT["train"], hz)
    return label_train.budget_threshold(spec, timelines)


def report(name: str, results: dict, chosen: float | None = None, notes: str = "") -> str:
    lines = [f"## {name}", ""]
    if notes:
        lines += [notes, ""]
    lines.append("| Activation | Live | Moving (9 Nov) | Resting | Everyday FA | Still/supported FA |")
    lines.append("|---|---|---|---|---|---|")
    for th in THRESHOLDS:
        r = {g: results[g][th] for g in GROUPS}
        mark = " **(chosen)**" if chosen is not None and abs(th - chosen) < 1e-9 else ""
        ev = r["everyday"]
        lines.append(f"| {th:g}{mark} | {r['live']['caught']}/{r['live']['gestures']} | {r['moving']['caught']}/{r['moving']['gestures']} | "
                     f"{r['resting']['caught']}/{r['resting']['gestures']} | {ev['fa']} ({ev['fa'] / max(ev['neg_h'], 1e-9):.1f}/h) | "
                     f"{r['still']['fa']} |")
    if chosen is not None and all(abs(chosen - t) > 1e-9 for t in THRESHOLDS):
        lines.append(f"\nChosen activation {chosen:g} is not in the sweep.")
    return "\n".join(lines) + "\n"


def save(name: str, results: dict, chosen: float | None = None, extra: dict | None = None, notes: str = "") -> None:
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    (out / f"{name}.json").write_text(json.dumps({"name": name, "chosen": chosen, "results": {
        g: {str(t): v for t, v in r.items()} for g, r in results.items()}, **(extra or {})}, indent=1) + "\n")
    (out / f"{name}.md").write_text(report(name, results, chosen, notes))
    print(report(name, results, chosen, notes))
