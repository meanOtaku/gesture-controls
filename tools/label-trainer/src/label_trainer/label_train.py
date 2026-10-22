"""Trains one label's pinch-start model from PPG and motion and writes a bundle the desktop can import.

The model (research: `docs/research/ppg-imu-fusion-and-triggers-2026-10.md`):

    PPG (green, red, IR) -> causal z-score against the previous 1, 2 and 4 s -> causal slope, curvature and jerk
    -> 1,701 window summaries (`ppg_onset.py`)
    + accelerometer and gyroscope -> 1,032 window summaries of the last 0.3-1.3 s (`imu_onset.py`)
    -> ExtraTrees (300 trees) -> a detection at the top of the score's climb (the peak trigger)

The cut-off is the one that, replayed over training recordings the model did not see, catches the most starts while firing
by mistake at most `TARGET_FALSE_ACTIVATIONS_PER_MINUTE`. A spec whose sources are the pulse sensor alone trains the earlier
PPG-only model instead (its cut-off from Youden's J, the edge trigger), so its runs can be repeated.

It fires about 0.9 s after a gesture starts. The desktop owns the decisions that must be recorded and cannot change
afterwards, so this script does not make them: which recordings train and which evaluate (never the same one), and what
each label means (the target, negatives, or excluded). It receives them in a `spec.json`, trains, evaluates on the
held-out recordings, writes the model as `model.trees` (see `trees.py`), checks the file reproduces the trained model,
and writes:

    <out>/bundle/manifest.json   what the desktop's bundle validator reads
    <out>/bundle/model.trees
    <out>/evaluation.json        metrics on the held-out recordings: per decision, and as a detector over whole recordings
    <out>/result.json            the outcome: deployable, evaluationOnly or failed, and why

A model that is not good enough to go live (`verdict`) is still written, as evaluationOnly: the desktop can run it in
Monitor, where it only reports.

    uv run label-classifier-train --spec spec.json --out run-dir
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import warnings
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import numpy as np

from . import imu_onset, ppg_onset, trees
from .csv_io import Recording, load_recording, repair_millisecond_ppg_timestamps, shift_labels
from .events import Policy, detect, summarise

# scikit-learn 1.9 warns once per parallel task while ExtraTrees trains and scores its trees on every core: harmless, and it
# buries the progress lines the desktop shows.
warnings.filterwarnings("ignore", message=r".*sklearn\.utils\.parallel\.delayed.* should be used with .*", category=UserWarning)

SPEC_VERSION = 1
BACKEND = "ppg-onset-trees"
BACKENDS = (BACKEND,)
PPG_SOURCES = ("watchPpg",)
MOTION_SOURCES = ("watchPpg", "watchOrientation")
SOURCES = MOTION_SOURCES                # what a spec that names none trains
PREPROCESSING = {PPG_SOURCES: "ppg_multiscale_onset", MOTION_SOURCES: "ppg_imu_onset"}
# The trees: frozen in the research and not tuned here.
TREES = 300
MIN_SAMPLES_LEAF = 3
MAX_FEATURES = 0.7
# The exported file must reproduce the trained model this closely, or it is not shipped (its leaves are single precision).
PARITY_TOLERANCE = 1e-6
MIN_POSITIVE_TRAIN = 10
MIN_PER_CLASS_EVAL = 3
ACTIVATION = 0.5
MAX_THRESHOLD_FOLDS = 5
MAX_LABEL_OFFSET_MS = 1500
# The runtime's release threshold sits this far under the activation threshold, and after a detection ends the next one
# waits this long (the research's refractory time).
RELEASE_GAP = 0.15
MIN_RELEASE = 0.05
COOLDOWN_MS = ppg_onset.COOLDOWN_MS
# What the runtime keeps of the pulse stream for a decision, and how often it decides.
WINDOW_MS = ppg_onset.GRID_TICKS * ppg_onset.TICK_NS // 1_000_000
STRIDE_MS = ppg_onset.TICK_NS // 1_000_000
MIN_WINDOW_SAMPLES = 100
# The PPG + IMU model's cut-off: the most starts caught, replayed over training recordings each scored by a model that did not
# see it, while firing by mistake at most this often per minute of recording (the operating point the research compared
# rules at, counted as it counts them).
TARGET_FALSE_ACTIVATIONS_PER_MINUTE = 2.0
THRESHOLD_CANDIDATES = tuple(round(t, 2) for t in np.arange(0.30, 0.951, 0.05))


class TrainingRefused(Exception):
    """Training cannot go ahead, for a reason a person can act on."""


@dataclass(frozen=True)
class Spec:
    target: str
    negatives: list[str]
    excludes: list[str]
    recordings: dict[str, Path]
    train: list[str]
    evaluation: list[str]
    research: bool
    seed: int
    label_offset_ms: int = 0
    sources: tuple[str, ...] = SOURCES

    @property
    def motion(self) -> bool:
        """Whether the model reads motion as well as the pulse."""
        return self.sources == MOTION_SOURCES

    @property
    def feature_names(self) -> tuple[str, ...]:
        return ppg_onset.FEATURE_NAMES + imu_onset.FEATURE_NAMES if self.motion else ppg_onset.FEATURE_NAMES

    @property
    def trigger(self) -> str:
        return "peak" if self.motion else "edge"


def parse_spec(raw: dict[str, Any]) -> Spec:
    if raw.get("version") != SPEC_VERSION:
        raise TrainingRefused(f"unsupported spec version {raw.get('version')!r}; expected {SPEC_VERSION}")
    backend = raw.get("backend", BACKEND)
    if backend not in BACKENDS:
        raise TrainingRefused(f"unknown backend {backend!r}; this trainer makes only {BACKEND!r}")
    sources = tuple(raw.get("sources", SOURCES))
    if sources not in PREPROCESSING:
        raise TrainingRefused(f"the model reads the pulse sensor and motion {list(MOTION_SOURCES)}, or the pulse sensor alone {list(PPG_SOURCES)}, not {list(sources)}")
    recordings = {rid: Path(path) for rid, path in raw.get("recordings", {}).items()}
    train, evaluation = list(raw.get("train", [])), list(raw.get("evaluation", []))
    if set(train) & set(evaluation):
        raise TrainingRefused("a recording is in both the training and the evaluation set")
    if set(train) | set(evaluation) != set(recordings):
        raise TrainingRefused("every recording must be in exactly one of the training and evaluation sets")
    label_offset_ms = raw.get("labelOffsetMs", 0) or 0
    if isinstance(label_offset_ms, bool) or not isinstance(label_offset_ms, int) or abs(label_offset_ms) > MAX_LABEL_OFFSET_MS:
        raise TrainingRefused(f"the label offset must be a whole number of milliseconds from -{MAX_LABEL_OFFSET_MS} to {MAX_LABEL_OFFSET_MS}, got {label_offset_ms!r}")
    target = raw.get("target")
    if not target:
        raise TrainingRefused("the spec has no target label")
    return Spec(
        target=target,
        negatives=list(raw.get("negatives", [])),
        excludes=list(raw.get("excludes", [])),
        recordings=recordings,
        train=train,
        evaluation=evaluation,
        research=bool(raw.get("research", False)),
        seed=int(raw.get("seed", 17)),
        label_offset_ms=int(label_offset_ms),
        sources=sources,
    )


def load_spec_recordings(spec: Spec) -> dict[str, Recording]:
    """Every recording the spec names, as training reads it: repaired if needed, labels moved by the chosen offset."""
    return {
        rid: replace(shift_labels(repair_millisecond_ppg_timestamps(load_recording(path)), spec.label_offset_ms), session_id=rid)
        for rid, path in spec.recordings.items()
    }


def pulse_of(recording: Recording) -> tuple[np.ndarray, np.ndarray]:
    """The recording's real PPG samples: their timestamps and (green, red, IR)."""
    rows = recording.ppg_observed if recording.ppg_observed is not None else np.ones(len(recording.timestamps_ns), dtype=bool)
    values = np.stack([recording.channels[c][rows] for c in ("ppg_green", "ppg_red", "ppg_ir")], axis=1)
    return recording.timestamps_ns[rows].astype(np.int64), values


def motion_of(recording: Recording) -> tuple[np.ndarray, np.ndarray]:
    """The recording's real motion samples: their timestamps and (accelerometer x/y/z, gyroscope x/y/z)."""
    rows = recording.orient_observed if recording.orient_observed is not None else np.ones(len(recording.timestamps_ns), dtype=bool)
    values = np.stack([recording.channels[c][rows] for c in imu_onset.AXES], axis=1)
    return recording.timestamps_ns[rows].astype(np.int64), values


def inputs(spec: Spec, recording: Recording, decisions_ns: np.ndarray) -> np.ndarray:
    """The model's inputs at each decision: the PPG features, then (for a motion model) the motion features; a row of NaN
    where either has none."""
    ts, values = pulse_of(recording)
    x = ppg_onset.features(ts, values, decisions_ns)
    if not spec.motion:
        return x
    motion_ts, axes = motion_of(recording)
    return np.concatenate([x, imu_onset.features(motion_ts, axes, decisions_ns)], axis=1)


def check_labels(spec: Spec, recordings: dict[str, Recording]) -> None:
    present = {label for recording in recordings.values() for label in recording.raw_labels.tolist() if label}
    known = {spec.target, *spec.negatives, *spec.excludes}
    unmapped = sorted(present - known)
    if unmapped:
        raise TrainingRefused(
            "the following label(s) in the recordings have no training role (target, negative or excluded): "
            f"{', '.join(unmapped)}. Assign a role for each before training; a label is never silently treated as negative."
        )


@dataclass
class Examples:
    x: np.ndarray
    y: np.ndarray
    groups: np.ndarray
    kinds: list[str]
    decisions: np.ndarray


def examples(spec: Spec, recordings: dict[str, Recording], ids: list[str]) -> Examples:
    """The decisions each recording gives (`ppg_onset.sample_decisions`) and their features; one without features (a gap
    or too little history before it) is left out, as the runtime would not score it."""
    xs, ys, groups, kinds, decisions = [], [], [], [], []
    for rid in ids:
        recording = recordings[rid]
        ts, values = pulse_of(recording)
        held = ppg_onset.holds(recording.timestamps_ns, recording.raw_labels)
        d, y, k = ppg_onset.sample_decisions(ts, held, spec.target, set(spec.excludes))
        x = inputs(spec, recording, d)
        ok = np.isfinite(x).all(axis=1)
        xs.append(x[ok]); ys.append(y[ok]); groups += [rid] * int(ok.sum())
        kinds += [kind for kind, keep in zip(k, ok.tolist()) if keep]; decisions.append(d[ok])
    width = len(spec.feature_names)
    return Examples(
        np.concatenate(xs) if xs else np.zeros((0, width)), np.concatenate(ys) if ys else np.zeros(0, dtype=np.int64),
        np.array(groups), kinds, np.concatenate(decisions) if decisions else np.zeros(0, dtype=np.int64),
    )


def check_enough(train: Examples, held_out: Examples) -> None:
    if int(train.y.sum()) < MIN_POSITIVE_TRAIN:
        raise TrainingRefused(
            f"only {int(train.y.sum())} starts of the target label are in the training recordings "
            f"(at least {MIN_POSITIVE_TRAIN} are needed). Record more of it"
        )
    if int((train.y == 0).sum()) < MIN_POSITIVE_TRAIN:
        raise TrainingRefused("the training recordings have too few moments of anything else for the model to learn the difference")
    positives, negatives = int(held_out.y.sum()), int((held_out.y == 0).sum())
    if positives < MIN_PER_CLASS_EVAL or negatives < MIN_PER_CLASS_EVAL:
        raise TrainingRefused(
            f"the held-out recordings have {positives} starts of the target and {negatives} other moments; each needs at "
            f"least {MIN_PER_CLASS_EVAL} to be tested fairly. Record more sessions"
        )


def fit(x: np.ndarray, y: np.ndarray, seed: int, n_trees: int = TREES):
    from sklearn.ensemble import ExtraTreesClassifier

    return ExtraTreesClassifier(n_estimators=n_trees, min_samples_leaf=MIN_SAMPLES_LEAF, max_features=MAX_FEATURES,
                                n_jobs=-1, random_state=seed).fit(x, y)


def _rates(probability: np.ndarray, y: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = probability >= threshold
    tp = int(((predicted == 1) & (y == 1)).sum())
    fp = int(((predicted == 1) & (y == 0)).sum())
    fn = int(((predicted == 0) & (y == 1)).sum())
    tn = int(((predicted == 0) & (y == 0)).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "threshold": threshold, "precision": precision, "recall": recall, "f1": f1,
        "accuracy": (tp + tn) / max(y.shape[0], 1),
        "falseActivationRate": fp / max(fp + tn, 1),
        "confusion": {"truePositive": tp, "falsePositive": fp, "falseNegative": fn, "trueNegative": tn},
    }


def choose_threshold(probability: np.ndarray, y: np.ndarray) -> float:
    """The cut-off that best tells starts from other moments: the highest share of starts found less the share of others
    flagged (Youden's J; ties go to fewer false alarms, then the higher cut-off)."""
    best = (-2.0, 0.0, 0.0)
    for threshold in np.round(np.arange(0.05, 0.96, 0.01), 2):
        rates = _rates(probability, y, float(threshold))
        key = (rates["recall"] - rates["falseActivationRate"], -rates["falseActivationRate"], float(threshold))
        if key > best:
            best = key
    return best[2]


def out_of_fold_threshold(spec: Spec, train: Examples, recordings: dict[str, Recording], say=lambda _: None) -> tuple[float, str, float | None, dict[str, Any] | None]:
    """The cut-off, chosen without looking at the held-out recordings: models trained on all but a group of the training
    recordings score the group left out, and the cut-off is chosen on those scores. For a motion model, those models also
    replay the recordings they left out as the runtime would, and the cut-off is the one that catches the most starts while
    firing by mistake at most TARGET_FALSE_ACTIVATIONS_PER_MINUTE (`budget_threshold`); for a PPG-only model it is Youden's J
    on the left-out decisions. Returns it, where it came from ("trainingRecordings", or "default" when the training
    recordings are too few to judge each other), the ROC AUC of the left-out decisions, and (motion) the replay at the
    chosen cut-off."""
    from sklearn.metrics import roc_auc_score

    groups = sorted(set(train.groups.tolist()))
    if len(groups) < 2:
        return ACTIVATION, "default", None, None
    folds = min(MAX_THRESHOLD_FOLDS, len(groups))
    fold_of = {group: index % folds for index, group in enumerate(groups)}
    fold = np.array([fold_of[g] for g in train.groups.tolist()])
    held_out = np.full(train.y.shape[0], np.nan)
    timelines: list[tuple[Recording, np.ndarray, np.ndarray]] = []
    say(f"Choosing the cut-off on the training recordings: training {folds} more times, each without some of them")
    for k in range(folds):
        test = fold == k
        if int(train.y[~test].sum()) < MIN_POSITIVE_TRAIN or int((train.y[~test] == 0).sum()) < MIN_POSITIVE_TRAIN:
            continue
        model = fit(train.x[~test], train.y[~test], spec.seed)
        held_out[test] = model.predict_proba(train.x[test])[:, 1]
        if spec.motion:
            for group in (g for g in groups if fold_of[g] == k):
                scored = timeline(spec, recordings[group], lambda x: model.predict_proba(x)[:, 1])
                if scored is not None:
                    timelines.append((recordings[group], *scored))
    judged = ~np.isnan(held_out)
    if not judged.any() or not 0 < int(train.y[judged].sum()) < int(judged.sum()):
        return ACTIVATION, "default", None, None
    scores, truth = held_out[judged], train.y[judged]
    auc = float(roc_auc_score(truth, scores))
    if not spec.motion:
        return choose_threshold(scores, truth), "trainingRecordings", auc, None
    if not timelines:
        return ACTIVATION, "default", auc, None
    threshold, events = budget_threshold(spec, timelines)
    return threshold, "trainingRecordings", auc, events


def budget_threshold(spec: Spec, timelines: list[tuple[Recording, np.ndarray, np.ndarray]]) -> tuple[float, dict[str, Any]]:
    """Of THRESHOLD_CANDIDATES, the cut-off whose replay of `timelines` (each recording's decision times and the scores a
    model that did not see it gave them) catches the most starts with at most TARGET_FALSE_ACTIVATIONS_PER_MINUTE false
    activations per minute of recording, as the research counts them (ties: the higher cut-off). When none stays within
    it, the one that catches the most starts for its false activations (caught less false; ties: the higher cut-off), never
    simply the highest: on recordings packed with gestures that would catch almost none. Returns it and its replay."""
    minutes = sum((times[-1] - times[0]) / 60e9 for _, times, _ in timelines)
    replays = {}
    for t in THRESHOLD_CANDIDATES:
        replay_ = summarise([detections(spec, r, times, scores, policy_for(t, spec.trigger)) for r, times, scores in timelines])
        replays[t] = {**replay_, "recordingMinutes": minutes,
                      "falseActivationsPerMinute": replay_["falseActivations"] / minutes if minutes > 0 else 0.0}
    within = [t for t, e in replays.items() if e["falseActivationsPerMinute"] <= TARGET_FALSE_ACTIVATIONS_PER_MINUTE]
    if within:
        best = max(within, key=lambda t: (replays[t]["caught"], t))
    else:
        best = max(replays, key=lambda t: (replays[t]["caught"] - replays[t]["falseActivations"], t))
    return float(best), {**replays[best], "targetFalseActivationsPerMinute": TARGET_FALSE_ACTIVATIONS_PER_MINUTE,
                         "withinTarget": bool(within)}


CALIBRATION_BINS = 10


def calibration(probability: np.ndarray, y: np.ndarray) -> dict[str, float]:
    probability = np.asarray(probability, dtype=np.float64)
    bins = np.minimum((probability * CALIBRATION_BINS).astype(int), CALIBRATION_BINS - 1)
    gap = 0.0
    for b in range(CALIBRATION_BINS):
        members = bins == b
        if members.any():
            gap += float(members.mean()) * abs(float(probability[members].mean()) - float(y[members].mean()))
    return {"brierScore": float(np.mean((probability - y) ** 2)), "expectedCalibrationError": gap}


def evaluate(probability: np.ndarray, y: np.ndarray, threshold: float, threshold_source: str) -> dict[str, Any]:
    """The held-out decisions' numbers at `threshold`, which was not chosen on them."""
    from sklearn.metrics import roc_auc_score

    chosen = _rates(probability, y, threshold)
    return {
        "windows": int(y.shape[0]),
        "positiveWindows": int(y.sum()),
        "negativeWindows": int((y == 0).sum()),
        "rocAuc": float(roc_auc_score(y, probability)),
        "activationThreshold": threshold,
        "thresholdSource": threshold_source,
        "thresholdChosenOnEvaluationRecordings": threshold_source == "evaluationRecordings",
        **{k: v for k, v in chosen.items() if k != "threshold"},
        "balancedAccuracy": (chosen["recall"] + 1.0 - chosen["falseActivationRate"]) / 2.0,
        "atDefaultThreshold": _rates(probability, y, ACTIVATION),
        **calibration(probability, y),
    }


def policy_for(threshold: float, trigger: str = "edge") -> Policy:
    """What the manifest gives the runtime: release a little under activation, the cooldown after a detection, and the
    trigger."""
    return Policy(activation=threshold, release=round(max(MIN_RELEASE, threshold - RELEASE_GAP), 2), cooldown_ms=COOLDOWN_MS,
                  trigger=trigger)


def timeline(spec: Spec, recording: Recording, predict) -> tuple[np.ndarray, np.ndarray] | None:
    """Every PPG sample of the recording the runtime would decide on (those with inputs), and `predict`'s score for each;
    None when it has none."""
    ts, _ = pulse_of(recording)
    x = inputs(spec, recording, ts)
    ok = np.isfinite(x).all(axis=1)
    if not ok.any():
        return None
    return ts[ok], predict(x[ok])


def detections(spec: Spec, recording: Recording, times: np.ndarray, scores: np.ndarray, policy: Policy) -> dict[str, Any]:
    """One recording's scores through the runtime's detection rule (`events.detect`). A detection catches a start of the
    target label when it rises ppg_onset.MATCH_EARLIEST_MS..MATCH_LATEST_MS after it (`ppg_onset.match`); any other is a
    false activation, unless it is inside an excluded label's hold. Time inside the target's holds, and an excluded
    label's, cannot hold one."""
    held = ppg_onset.holds(recording.timestamps_ns, recording.raw_labels)
    starts = [s for s, _, label in held if label == spec.target and times[0] <= s + ppg_onset.MATCH_EARLIEST_MS * 1_000_000 <= times[-1]]
    ignored = [(s, e) for s, e, label in held if label in set(spec.excludes)]
    rises = [rise for rise, _ in detect(times, scores, policy) if not any(s <= rise <= e for s, e in ignored)]
    caught, latencies = ppg_onset.match(rises, starts)
    busy = [(s, e + ppg_onset.MATCH_LATEST_MS * 1_000_000) for s, e, label in held if label == spec.target or label in set(spec.excludes)]
    observed = int(times[-1] - times[0])
    covered = sum(max(0, min(e, times[-1]) - max(s, times[0])) for s, e in busy)
    return {
        "gestures": len(starts), "caught": caught, "repeats": 0,
        "falseActivations": len(rises) - caught,
        "latenciesMs": [latency / 1e6 for latency in latencies],
        "negativeNs": max(observed - covered, 0),
    }


def replay(spec: Spec, model, recordings: dict[str, Recording], threshold: float) -> dict[str, Any]:
    """The model as a detector over each held-out recording, as the runtime runs it: scored at every PPG sample, through the
    runtime's detection rule (see `detections`)."""
    policy = policy_for(threshold, spec.trigger)
    per_recording = []
    for rid in sorted(spec.evaluation):
        scored = timeline(spec, recordings[rid], lambda x: model.predict_proba(x)[:, 1])
        if scored is not None:
            per_recording.append(detections(spec, recordings[rid], *scored, policy))
    return {**summarise(per_recording), "policy": {"activation": policy.activation, "release": policy.release,
                                                   "cooldownMs": COOLDOWN_MS, "trigger": policy.trigger}}


MIN_AUC = 0.7
MIN_BALANCED_ACCURACY = 0.7
MAX_FALSE_ACTIVATION_RATE = 0.1
MAX_FALSE_ACTIVATIONS_PER_HOUR = 30.0
MIN_NEGATIVE_SECONDS = 60.0
MIN_GESTURE_RECALL = 0.5
MORE_DATA = ". Record more sessions of the gesture (at least three, in different positions)"


def verdict(metrics: dict[str, Any]) -> str | None:
    """Why a model may not go live, in words; None when it is good enough to review. A model that fails can still run
    in Monitor, where it only reports."""
    auc = metrics["rocAuc"]
    if auc < 0.5:
        return f"It scored the gesture's starts *lower* than other moments on recordings it had not seen (AUC {auc:.2f}; 0.5 is chance)" + MORE_DATA
    if auc < MIN_AUC:
        return f"It could barely tell the gesture's starts from other moments on recordings it had not seen (AUC {auc:.2f}; at least {MIN_AUC} is needed)" + MORE_DATA
    cross = metrics.get("crossCheckRocAuc")
    if cross is not None and cross < MIN_AUC:
        return (
            f"The training recordings do not agree with each other: trained on some of them, it could not tell the starts "
            f"apart in the others (AUC {cross:.2f}; at least {MIN_AUC} is needed), so doing well on the test recordings was luck"
            + MORE_DATA
        )
    threshold = metrics["activationThreshold"]
    if metrics["balancedAccuracy"] < MIN_BALANCED_ACCURACY:
        return (
            f"At its cut-off ({threshold:.2f}) it found {metrics['recall']:.0%} of the starts and wrongly flagged "
            f"{metrics['falseActivationRate']:.0%} of the other moments on recordings it had not seen (balanced accuracy "
            f"{metrics['balancedAccuracy']:.2f}; at least {MIN_BALANCED_ACCURACY} is needed)" + MORE_DATA
        )
    if metrics["falseActivationRate"] > MAX_FALSE_ACTIVATION_RATE:
        return (
            f"At its cut-off ({threshold:.2f}) it wrongly flagged {metrics['falseActivationRate']:.0%} of the other moments "
            f"on recordings it had not seen (at most {MAX_FALSE_ACTIVATION_RATE:.0%} is allowed)" + MORE_DATA
        )
    events = metrics.get("events")
    if events is None:
        return None
    if events["negativeSeconds"] < MIN_NEGATIVE_SECONDS:
        return (
            f"The held-out recordings hold only {events['negativeSeconds']:.0f} s without the gesture, too little to tell how "
            f"often it would fire by mistake (at least {MIN_NEGATIVE_SECONDS:.0f} s is needed). Record a few minutes of "
            "ordinary activity, in sessions of its own"
        )
    per_hour = events["falseActivationsPerHour"]
    if per_hour is not None and per_hour > MAX_FALSE_ACTIVATIONS_PER_HOUR:
        return (
            f"Replayed over the held-out recordings it fired {events['falseActivations']} times without the gesture, about "
            f"{per_hour:.0f} times an hour (at most {MAX_FALSE_ACTIVATIONS_PER_HOUR:.0f} is allowed). Record more ordinary "
            "activity and other gestures, so it learns what to ignore"
        )
    recall = events["gestureRecall"]
    if recall is not None and recall < MIN_GESTURE_RECALL:
        return f"Replayed over the held-out recordings it caught {events['caught']} of {events['gestures']} starts (at least {MIN_GESTURE_RECALL:.0%} is needed)" + MORE_DATA
    return None


RANGE_LOW_PERCENT = 1
RANGE_HIGH_PERCENT = 99
RANGE_MIN_WINDOWS = 20


def training_range(x_train: np.ndarray) -> dict[str, list[float]] | None:
    """Per input, its usual low and high in the training decisions (1st to 99th percentile), so the app can tell when live
    data is unlike anything the model trained on."""
    if x_train.shape[0] < RANGE_MIN_WINDOWS:
        return None
    round_ = lambda value: float(f"{value:.8g}")  # noqa: E731
    low, high = np.percentile(x_train, RANGE_LOW_PERCENT, axis=0), np.percentile(x_train, RANGE_HIGH_PERCENT, axis=0)
    return {"low": [round_(v) for v in low], "high": [round_(v) for v in high]}


def write_bundle(spec: Spec, out: Path, model_bytes: bytes, metrics: dict[str, Any], x_train: np.ndarray) -> str:
    import sklearn

    bundle = out / "bundle"
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "model.trees").write_bytes(model_bytes)
    sha = hashlib.sha256(model_bytes).hexdigest()
    policy = policy_for(metrics["activationThreshold"], spec.trigger)
    names = list(spec.feature_names)
    pipeline = ("PPG -> causal z-score (1 s, 2 s, 4 s) -> causal cubic slope, curvature, jerk -> 1701 summaries"
                + (" + accelerometer and gyroscope -> 1032 summaries (0.3-1.3 s) -> ExtraTrees -> peak trigger" if spec.motion else " -> ExtraTrees"))
    manifest = {
        "schemaVersion": 1,
        "modelId": f"{spec.target}-{sha[:8]}",
        "targetLabel": spec.target,
        "model": {"file": "model.trees", "sha256": sha, "format": "trees", "opset": 0},
        "framework": {"name": "scikit-learn", "version": sklearn.__version__},
        "input": {"name": "X", "shape": [None, len(names)], "dtype": "float32", "features": names},
        "output": {"name": "probabilities", "shape": [None, 2], "dtype": "float32", "positiveIndex": 1},
        "sources": list(spec.sources),
        "window": {"durationMs": WINDOW_MS, "strideMs": STRIDE_MS, "maxGapMs": ppg_onset.MAX_GAP_MS, "minSamples": MIN_WINDOW_SAMPLES},
        "quality": {"maxContactQuality": 0.0, "minSampleCount": 3},
        "thresholds": {"activation": policy.activation, "release": policy.release, "cooldownMs": COOLDOWN_MS,
                       **({"trigger": policy.trigger} if spec.motion else {})},
        "preprocessing": {"kind": PREPROCESSING[spec.sources]},
        "provenance": {
            "backend": BACKEND,
            "pipeline": pipeline,
            "trees": TREES, "minSamplesLeaf": MIN_SAMPLES_LEAF, "maxFeatures": MAX_FEATURES,
            "trainRecordings": sorted(spec.train),
            "evaluationRecordings": sorted(spec.evaluation),
            "seed": spec.seed,
            "evaluationRocAuc": metrics["rocAuc"],
            "evaluationBalancedAccuracy": metrics["balancedAccuracy"],
            "evaluationFalseActivationRate": metrics["falseActivationRate"],
            "evaluationF1": metrics["f1"],
            "evaluationFalseActivationsPerHour": (metrics.get("events") or {}).get("falseActivationsPerHour"),
            "evaluationGestureRecall": (metrics.get("events") or {}).get("gestureRecall"),
            "thresholdSource": metrics["thresholdSource"],
            "thresholdChosenOnEvaluationRecordings": metrics["thresholdChosenOnEvaluationRecordings"],
            **({"targetFalseActivationsPerMinute": TARGET_FALSE_ACTIVATIONS_PER_MINUTE} if spec.motion else {}),
            "labelOffsetMs": spec.label_offset_ms,
        },
    }
    usual = training_range(x_train)
    if usual is not None:
        manifest["input"]["trainingRange"] = usual
    (bundle / "manifest.json").write_text(json.dumps(manifest) + "\n")
    return sha


def run_research_checks(spec: Spec, recordings: dict[str, Recording]) -> dict[str, Any] | None:
    """The learning curve and leave-one-recording-out (see `research.py`). An extra: if it fails the model still ships."""
    try:
        from .research import run_research

        everything = examples(spec, recordings, sorted(spec.recordings))
        print("Running the research checks: they retrain the model several times, so this takes a while", flush=True)
        return run_research(lambda xs, ys: fit(xs, ys, spec.seed), everything.x, everything.y, everything.groups,
                            spec.train, spec.evaluation, spec.seed, lambda line: print(line, flush=True))
    except Exception as error:  # noqa: BLE001 - an extra must never stop a model being shipped
        print(f"could not run the research checks: {type(error).__name__}: {error}", flush=True)
        return None


def feature_importance(model, names: tuple[str, ...], top: int = 25) -> list[dict[str, Any]]:
    """The inputs the trees lean on most (mean decrease in impurity), for the Inspect view."""
    order = np.argsort(model.feature_importances_)[::-1][:top]
    return [{"name": names[i], "importance": float(model.feature_importances_[i])} for i in order]


def run(raw_spec: dict[str, Any], out: Path) -> dict[str, Any]:
    """Trains and writes everything under `out`. Returns the result (also written as `result.json`)."""
    out.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {"outcome": "failed", "message": ""}
    try:
        spec = parse_spec(raw_spec)
        recordings = load_spec_recordings(spec)
        check_labels(spec, recordings)
        say = lambda line: print(line, flush=True)  # noqa: E731
        train = examples(spec, recordings, spec.train)
        held_out = examples(spec, recordings, spec.evaluation)
        check_enough(train, held_out)
        say(f"Training {TREES} trees on {train.y.shape[0]} moments ({int(train.y.sum())} starts) from {len(spec.train)} recordings")
        model = fit(train.x, train.y, spec.seed)
        threshold, source, cross_check, cross_events = out_of_fold_threshold(spec, train, recordings, say)
        probability = model.predict_proba(held_out.x)[:, 1]
        metrics = evaluate(probability, held_out.y, threshold, source)
        metrics["crossCheckRocAuc"] = cross_check
        if cross_events is not None:
            # The replay the cut-off was chosen on: training recordings, each scored by a model that had not seen it.
            metrics["crossCheckEvents"] = cross_events
        say("Replaying the held-out recordings as the runtime would")
        metrics["events"] = replay(spec, model, recordings, threshold)
        (out / "evaluation.json").write_text(json.dumps(metrics, indent=2) + "\n")

        model_bytes = trees.to_bytes(model, len(spec.feature_names))
        exported = trees.predict(model_bytes, held_out.x)
        parity = float(np.max(np.abs(exported - probability))) if probability.size else 0.0
        (out / "parity.json").write_text(json.dumps({"maxAbsDifference": parity, "tolerance": PARITY_TOLERANCE, "windows": int(held_out.y.shape[0])}, indent=2) + "\n")
        if parity > PARITY_TOLERANCE:
            raise TrainingRefused(f"the exported model differs from the trained one by {parity:.2e} (the limit is {PARITY_TOLERANCE}), so it is not shipped")
        sha = write_bundle(spec, out, model_bytes, metrics, train.x)
        research = run_research_checks(spec, recordings) if spec.research else None
        inspection = {
            "version": 2, "kind": "trees", "backend": BACKEND, "target": spec.target,
            "inputCount": len(spec.feature_names), "trees": TREES, "sources": list(spec.sources), "trigger": spec.trigger,
            "importance": feature_importance(model, spec.feature_names),
            # Every held-out decision's score, for the Inspect view's curves: its recording, whether it is a start, the score.
            "evaluation": {"threshold": threshold, "recordings": held_out.groups.tolist(), "labels": held_out.y.tolist(),
                           "probabilities": [round(float(p), 6) for p in probability], "kinds": held_out.kinds, "metrics": metrics},
            "examples": {"train": int(train.y.shape[0]), "trainStarts": int(train.y.sum()),
                         "evaluation": int(held_out.y.shape[0]), "evaluationStarts": int(held_out.y.sum())},
            "research": research,
        }
        (out / "inspection.json").write_text(json.dumps(inspection) + "\n")
        poor = verdict(metrics)
        result = {
            "outcome": "evaluationOnly" if poor is not None else "deployable",
            "message": poor or "",
            "bundleDir": "bundle",
            "modelSha256": sha,
            "backend": BACKEND,
            "features": list(spec.feature_names),
            "trainWindows": int(train.y.shape[0]),
            "evaluationWindows": int(held_out.y.shape[0]),
            "metrics": metrics,
            "parityMaxAbsDifference": parity,
        }
    except TrainingRefused as refusal:
        result["message"] = str(refusal)
    except Exception as error:  # noqa: BLE001 - any failure must be reported, not crash without a result
        result["message"] = f"{type(error).__name__}: {error}"
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


# The label offsets (milliseconds) tried when looking for the timing that fits the recordings best.
OFFSET_CANDIDATES_MS: tuple[int, ...] = (-1000, -750, -500, -250, 0, 250, 500, 750, 1000, 1250, 1500)
OFFSET_TREES = 100


def suggest_label_offset(raw_spec: dict[str, Any], candidates: tuple[int, ...] | None = None) -> list[dict[str, Any]]:
    """How well the recordings separate the gesture's starts from other moments at each label offset: for each candidate
    the labels are moved that far, then every recording is scored by trees trained on all the others, and the score is
    the ROC AUC over all of them together. (Chosen using all of them, so the score at the chosen offset is a little
    optimistic.)"""
    from sklearn.metrics import roc_auc_score

    results: list[dict[str, Any]] = []
    for offset in candidates or OFFSET_CANDIDATES_MS:
        spec = parse_spec({**raw_spec, "labelOffsetMs": offset, "research": False})
        recordings = load_spec_recordings(spec)
        everything = examples(spec, recordings, sorted(spec.recordings))
        held_out = np.full(everything.y.shape[0], np.nan)
        for group in sorted(set(everything.groups.tolist())):
            test = everything.groups == group
            if int(everything.y[~test].sum()) < MIN_POSITIVE_TRAIN or int((everything.y[~test] == 0).sum()) < MIN_POSITIVE_TRAIN:
                continue
            held_out[test] = fit(everything.x[~test], everything.y[~test], spec.seed, OFFSET_TREES).predict_proba(everything.x[test])[:, 1]
        judged = ~np.isnan(held_out)
        scoreable = bool(judged.any()) and 0 < int(everything.y[judged].sum()) < int(judged.sum())
        results.append({
            "offsetMs": offset,
            "auc": round(float(roc_auc_score(everything.y[judged], held_out[judged])), 4) if scoreable else None,
            "windows": int(judged.sum()),
            "positives": int(everything.y[judged].sum()),
        })
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", type=Path, required=True, help="the training spec the desktop wrote")
    parser.add_argument("--out", type=Path, help="directory for the results")
    parser.add_argument("--suggest-offset", action="store_true", help="try label offsets and say how well each fits the recordings, instead of training")
    args = parser.parse_args(argv)
    if args.suggest_offset:
        try:
            scores = suggest_label_offset(json.loads(args.spec.read_text()))
            print(json.dumps({"outcome": "ok", "scores": scores}), flush=True)
            return 0
        except TrainingRefused as refusal:
            print(json.dumps({"outcome": "refused", "message": str(refusal)}), flush=True)
            return 2
    if args.out is None:
        parser.error("--out is required to train")
    result = run(json.loads(args.spec.read_text()), args.out)
    print(json.dumps({"outcome": result["outcome"], "message": result["message"]}), flush=True)
    return 0 if result["outcome"] in ("deployable", "evaluationOnly") else 2


def cli() -> None:
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    cli()
