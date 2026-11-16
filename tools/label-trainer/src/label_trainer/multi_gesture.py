"""One v2 CNN for several gestures (`Spec.classes`): an output for nothing and one for each gesture, through a softmax.

The gestures compete, so two cannot both be likely at the same moment. Each gesture still gets what a one-gesture run
gives it: its own cut-off (chosen as `label_train.v2_threshold` chooses one, on the training recordings, each scored by a
network that did not see it), its own test numbers and replay on the held-out recordings, and its own bundle
(`gestures/<label>/`), whose manifest reads its output of the shared network (`positiveIndex`). The desktop registers
each as a model of that gesture, so it is activated, rolled back and given its cut-off on its own.

What a one-gesture run cannot show is which gesture is mistaken for which, so the run also counts the two confusion
matrices (`confusion`):

- `events`: the held-out recordings played through as the runtime runs them, each gesture's model at its own cut-off.
  For each start of a gesture, which models caught it (its own, another's, or none: missed), and with no gesture under
  way, how often each went off (false activations, and an hour).
- `moments`: each held-out decision, by what it is (nothing, or a gesture's start) and what the network says at the
  cut-offs: the gesture whose score passes its cut-off (the highest if more than one), or nothing.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np

from . import cnn_input, cnn_v2, ppg_onset
from . import label_train as lt


def for_gesture(spec: lt.Spec, gesture: str) -> lt.Spec:
    """The spec as one gesture's model sees it: that gesture the target, the others' holds left out of its replay (a
    detection during another gesture is counted in the confusion matrix, not as a false activation)."""
    others = [g for g in spec.classes if g != gesture]
    return replace(spec, target=gesture, excludes=[*spec.excludes, *others])


class _Output:
    """One output of a multi-gesture network, with the `predict_proba` the one-gesture evaluation reads."""

    def __init__(self, scores, index: int):
        self.scores, self.index = scores, index

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        p = self.scores(x)[:, self.index]
        return np.stack([1.0 - p, p], axis=1)


def all_timelines(spec: lt.Spec, recording, scores) -> tuple[np.ndarray, np.ndarray] | None:
    """`label_train.timeline` for every output at once: each decided PPG sample and the network's outputs there, the
    gestures' scored 0 where the v2 gate is shut. None when the recording has none."""
    ts, _ = lt.pulse_of(recording)
    x = lt.inputs(spec, recording, ts)
    ok = np.isfinite(x).all(axis=1) & spec.decided(recording.session_id, ts)
    if not ok.any():
        return None
    p = np.array(scores(x[ok]), dtype=np.float64)
    if spec.gate_min_jerk is not None:
        motion_ts, axes = lt.motion_of(recording)
        shut = cnn_input.spike(motion_ts, axes, ts[ok]) < spec.gate_min_jerk
        p[shut, 1:] = 0.0
    return ts[ok], p


def check_enough(spec: lt.Spec, train: lt.Examples, held_out: lt.Examples) -> None:
    """`label_train.check_enough` for each gesture, against everything else."""
    for i, gesture in enumerate(spec.classes, 1):
        try:
            lt.check_enough(replace(train, y=(train.y == i).astype(np.int64)), replace(held_out, y=(held_out.y == i).astype(np.int64)),
                            spec.steady_starts)
        except lt.TrainingRefused as refusal:
            raise lt.TrainingRefused(f"{gesture}: {refusal}") from None


def fold_thresholds(spec: lt.Spec, train: lt.Examples, recordings, say) -> dict[str, tuple[float, str, dict[str, Any] | None]]:
    """Each gesture's cut-off, chosen without the held-out recordings (`label_train.out_of_fold_threshold`): networks trained
    on all but a group of sessions replay the group, and each gesture's cut-off is chosen on those replays."""
    groups = sorted(set(train.groups.tolist()))
    sessions = sorted({spec.session_of(g) for g in groups})
    default = {g: (lt.ACTIVATION, "default", None) for g in spec.classes}
    if len(sessions) < 2:
        return default
    folds = min(lt.MAX_THRESHOLD_FOLDS, len(sessions))
    fold_of_session = {session: index % folds for index, session in enumerate(sessions)}
    fold_of = {group: fold_of_session[spec.session_of(group)] for group in groups}
    fold = np.array([fold_of[g] for g in train.groups.tolist()])
    timelines: list[tuple[Any, np.ndarray, np.ndarray]] = []
    say(f"Choosing each gesture's cut-off on the training recordings: training {folds} more times, each without some of them")
    for k in range(folds):
        test = fold == k
        kept = train.y[~test]
        if any(int((kept == i).sum()) < lt.MIN_POSITIVE_TRAIN for i in range(len(spec.classes) + 1)):
            continue
        model = cnn_v2.fit(train.x[~test], kept, spec.seed, classes=spec.classes)
        for group in (g for g in groups if fold_of[g] == k):
            scored = all_timelines(spec, recordings[group], model.predict_proba)
            if scored is not None:
                timelines.append((recordings[group], *scored))
    if not timelines:
        return default
    chosen = {}
    for i, gesture in enumerate(spec.classes, 1):
        threshold, events = lt.v2_threshold(for_gesture(spec, gesture), [(r, t, p[:, i]) for r, t, p in timelines])
        chosen[gesture] = (threshold, "trainingRecordings", events)
    return chosen


def moment_confusion(spec: lt.Spec, y: np.ndarray, p: np.ndarray, thresholds: dict[str, float]) -> dict[str, Any]:
    """Held-out decisions by what they are (rows: nothing, then each gesture's start) and what the network says at the
    cut-offs (columns, the same): the gesture whose score passes its cut-off, the highest if several, else nothing."""
    names = [cnn_v2.NOTHING, *spec.classes]
    cut = np.array([np.inf, *[thresholds[g] for g in spec.classes]])
    passing = np.where(p >= cut[None, :], p, -1.0)
    said = np.where(passing.max(axis=1) >= 0, passing.argmax(axis=1), 0)
    counts = np.zeros((len(names), len(names)), dtype=np.int64)
    np.add.at(counts, (np.asarray(y, dtype=np.int64), said), 1)
    return {"labels": names, "counts": counts.tolist()}


def event_confusion(spec: lt.Spec, evaluation: list[tuple[str, Any, np.ndarray, np.ndarray]],
                    thresholds: dict[str, float]) -> dict[str, Any]:
    """The held-out recordings played through, each gesture's model at its own cut-off. Rows: each gesture's starts, then
    the time with no gesture under way. Columns: each gesture's model. A start is caught by a model when that model rises
    in its match window (`label_train.detections`); one no model caught is missed. With no gesture under way, each
    model's false activations (and an hour)."""
    gestures = list(spec.classes)
    caught = {g: {c: 0 for c in gestures} for g in gestures}
    starts_of = {g: 0 for g in gestures}
    missed = {g: 0 for g in gestures}
    false = {c: 0 for c in gestures}
    quiet_ns = {c: 0 for c in gestures}
    for _, recording, times, p in evaluation:
        for g in gestures:
            as_g = for_gesture(spec, g)
            union: set[int] = set()
            total = 0
            for c in gestures:
                d = lt.detections(as_g, recording, times, p[:, gestures.index(c) + 1], lt.policy_for(thresholds[c], spec.trigger))
                caught[g][c] += len(d["caughtStartsNs"])
                union |= set(d["caughtStartsNs"])
                total = d["gestures"]
            starts_of[g] += total
            missed[g] += total - len(union)
        for c in gestures:
            d = lt.detections(for_gesture(spec, c), recording, times, p[:, gestures.index(c) + 1], lt.policy_for(thresholds[c], spec.trigger))
            false[c] += d["falseActivations"]
            quiet_ns[c] += d["negativeNs"]
    hours = {c: quiet_ns[c] / 3.6e12 for c in gestures}
    return {
        "gestures": gestures,
        "rows": [{"gesture": g, "starts": starts_of[g], "caughtBy": caught[g], "missed": missed[g]} for g in gestures],
        "noGesture": {"falseActivations": false, "hours": hours,
                      "falseActivationsPerHour": {c: (false[c] / hours[c] if hours[c] else None) for c in gestures}},
    }


def run_multi(spec: lt.Spec, out: Path) -> dict[str, Any]:
    """`label_train.run` for a multi-gesture spec: trains the network once and writes, for each gesture, what a one-gesture
    run writes (under `gestures/<label>/`), and the confusion matrices. Returns the result (also `result.json`)."""
    result: dict[str, Any] = {"outcome": "failed", "message": ""}
    try:
        say = lambda line: print(line, flush=True)  # noqa: E731
        recordings = lt.load_spec_recordings(spec)
        lt.check_labels(spec, recordings)
        train = lt.examples(spec, recordings, spec.train)
        held_out = lt.examples(spec, recordings, spec.evaluation)
        check_enough(spec, train, held_out)
        spec = replace(spec, gate_min_jerk=lt.gate_level(spec, recordings))
        if spec.gate_min_jerk is not None:
            say(f"Peak gate: a decision may fire only after an accelerometer jerk of {spec.gate_min_jerk:.0f} m/s^3 in the last "
                f"{cnn_input.GATE_WINDOW_MS} ms (90% of the training gesture moments have one)")
        train = lt.overlay_copies(spec, recordings, train, say)
        counts = ", ".join(f"{int((train.y == i).sum())} starts of {g}" for i, g in enumerate(spec.classes, 1))
        say(f"Training one v2 CNN for {len(spec.classes)} gestures on {lt.cnn_device()}: {train.y.shape[0]} moments ({counts}) "
            f"from {len(spec.train)} recordings")
        model = cnn_v2.fit(train.x, train.y, spec.seed, classes=spec.classes)
        chosen = fold_thresholds(spec, train, recordings, say)
        thresholds = {g: chosen[g][0] for g in spec.classes}
        probability = model.predict_proba(held_out.x)
        model_bytes = cnn_v2.to_bytes(model)
        exported = cnn_v2.predict(model_bytes, held_out.x)
        parity = float(np.max(np.abs(exported - probability))) if probability.size else 0.0
        if parity > cnn_v2.PARITY_TOLERANCE:
            raise lt.TrainingRefused(f"the exported model differs from the trained one by {parity:.2e} (the limit is "
                                     f"{cnn_v2.PARITY_TOLERANCE}), so it is not shipped")
        say("Replaying the held-out recordings as the runtime would, for each gesture")
        evaluation = []
        for rid in sorted(spec.evaluation):
            scored = all_timelines(spec, recordings[rid], model.predict_proba)
            if scored is not None:
                evaluation.append((rid, recordings[rid], *scored))
        confusion = {"events": event_confusion(spec, evaluation, thresholds),
                     "moments": moment_confusion(spec, held_out.y, probability, thresholds)}
        gestures: dict[str, Any] = {}
        for i, gesture in enumerate(spec.classes, 1):
            one = for_gesture(spec, gesture)
            truth = (held_out.y == i).astype(np.int64)
            metrics = lt.evaluate(probability[:, i], truth, thresholds[gesture], chosen[gesture][1])
            if chosen[gesture][2] is not None:
                metrics["crossCheckEvents"] = chosen[gesture][2]
            metrics["events"] = lt.replay(one, _Output(model.predict_proba, i), recordings, thresholds[gesture])
            metrics["steadyStarts"] = spec.steady_starts
            metrics["gestures"] = list(spec.classes)
            folder = out / "gestures" / gesture
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "evaluation.json").write_text(json.dumps(metrics, indent=2) + "\n")
            (folder / "parity.json").write_text(json.dumps({"maxAbsDifference": parity, "tolerance": cnn_v2.PARITY_TOLERANCE,
                                                           "windows": int(held_out.y.shape[0])}, indent=2) + "\n")
            sha = lt.write_bundle(one, folder, model_bytes, metrics, train.x)
            inspection = {
                "version": 2, "kind": "cnn", "backend": spec.backend, "target": gesture,
                "inputCount": len(spec.feature_names), "trees": 0, "sources": list(spec.sources), "trigger": spec.trigger,
                "importance": [],
                "evaluation": {"threshold": thresholds[gesture], "recordings": held_out.groups.tolist(), "labels": truth.tolist(),
                               "probabilities": [round(float(v), 6) for v in probability[:, i]],
                               "kinds": ["start" if v == 1 else "other" for v in truth.tolist()], "metrics": metrics},
                "examples": {"train": int(train.y.shape[0]), "trainStarts": int((train.y == i).sum()),
                             "evaluation": int(held_out.y.shape[0]), "evaluationStarts": int(truth.sum())},
                "research": None,
                "multiGesture": {"gestures": list(spec.classes), "thresholds": thresholds, "confusion": confusion},
            }
            (folder / "inspection.json").write_text(json.dumps(inspection) + "\n")
            poor = lt.verdict(metrics)
            gestures[gesture] = {"outcome": "evaluationOnly" if poor is not None else "deployable", "message": poor or "",
                                 "bundleDir": f"gestures/{gesture}/bundle", "modelSha256": sha, "metrics": metrics}
        first = gestures[spec.target]
        result = {
            "outcome": first["outcome"], "message": first["message"], "bundleDir": first["bundleDir"],
            "modelSha256": first["modelSha256"], "backend": spec.backend, "features": list(spec.feature_names),
            "trainWindows": int(train.y.shape[0]), "evaluationWindows": int(held_out.y.shape[0]),
            "metrics": first["metrics"], "parityMaxAbsDifference": parity,
            "gestures": gestures, "confusion": confusion,
        }
    except lt.TrainingRefused as refusal:
        result["message"] = str(refusal)
    except Exception as error:  # noqa: BLE001 - any failure must be reported, not crash without a result
        result["message"] = f"{type(error).__name__}: {error}"
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result
