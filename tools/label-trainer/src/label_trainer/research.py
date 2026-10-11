"""Research checks: retraining the same model on less data, and on all but one recording, to see how far its score can be trusted.

* **Learning curve.** The same model is trained on a quarter, a half, three quarters and all of the training windows
  (chosen at random from each class, three different draws each, the full set once) and scored on the same held-out
  windows. A curve that is still rising at the end says more recordings would help; one that went flat early says they would
  not.
* **Leave one recording out.** For each recording, a model is trained on all the others and scores that one, so every
  recording is scored by a model that never saw it. The scores of every fold are pooled into one ROC AUC, and each
  recording is reported on its own. This uses all the recordings, the training and the held-out ones, and is the fairest
  single number when there are few recordings.

Both only watch: nothing here changes the model that was trained and shipped.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np

LEARNING_FRACTIONS = (0.25, 0.5, 0.75, 1.0)
LEARNING_REPEATS = 3
MIN_PER_CLASS = 10


def _auc(y: np.ndarray, probability: np.ndarray) -> float | None:
    from sklearn.metrics import roc_auc_score

    return float(roc_auc_score(y, probability)) if 0 < int(y.sum()) < y.shape[0] else None


def learning_curve(fit: Callable, x_train: np.ndarray, y_train: np.ndarray, x_eval: np.ndarray, y_eval: np.ndarray, seed: int, progress: Callable[[str], None] = lambda _: None) -> list[dict[str, Any]]:
    """The held-out ROC AUC of the model trained on growing shares of the training windows."""
    rows: list[dict[str, Any]] = []
    positive, negative = np.flatnonzero(y_train == 1), np.flatnonzero(y_train == 0)
    for fraction in LEARNING_FRACTIONS:
        repeats = 1 if fraction == 1.0 else LEARNING_REPEATS
        aucs: list[float] = []
        windows = 0
        for repeat in range(repeats):
            rng = np.random.default_rng(seed * 1000 + repeat)
            take_p = max(1, int(np.ceil(fraction * positive.size)))
            take_n = max(1, int(np.ceil(fraction * negative.size)))
            if min(take_p, take_n) < MIN_PER_CLASS:
                break
            chosen = np.concatenate([rng.choice(positive, take_p, replace=False), rng.choice(negative, take_n, replace=False)])
            windows = int(chosen.size)
            progress(f"Learning curve: {int(fraction * 100)}% of the training windows, draw {repeat + 1} of {repeats}")
            model = fit(x_train[chosen], y_train[chosen])
            auc = _auc(y_eval, model.predict_proba(x_eval)[:, 1])
            if auc is not None:
                aucs.append(auc)
        if aucs:
            rows.append({"fraction": fraction, "windows": windows, "aucMean": float(np.mean(aucs)), "aucStd": float(np.std(aucs)), "draws": len(aucs)})
    return rows


def leave_one_recording_out(fit: Callable, x: np.ndarray, y: np.ndarray, groups: np.ndarray, progress: Callable[[str], None] = lambda _: None) -> dict[str, Any]:
    """Each recording scored by a model trained on all the others, and the scores of every fold pooled."""
    ids = [str(g) for g in dict.fromkeys(groups.tolist())]
    folds: list[dict[str, Any]] = []
    pooled_p: list[np.ndarray] = []
    pooled_y: list[np.ndarray] = []
    for number, recording in enumerate(ids, start=1):
        test = groups == recording
        train = ~test
        positives, negatives = int(y[train].sum()), int((y[train] == 0).sum())
        fold: dict[str, Any] = {"recording": recording, "windows": int(test.sum()), "gestureWindows": int(y[test].sum()), "otherWindows": int((y[test] == 0).sum())}
        if min(positives, negatives) < MIN_PER_CLASS:
            fold["skipped"] = f"without it there are only {positives} windows of the gesture and {negatives} of something else to train on"
            folds.append(fold)
            continue
        progress(f"Leave one out: recording {number} of {len(ids)}")
        probability = fit(x[train], y[train]).predict_proba(x[test])[:, 1]
        fold["meanScore"] = float(probability.mean())
        fold["auc"] = _auc(y[test], probability)
        pooled_p.append(probability)
        pooled_y.append(y[test])
        folds.append(fold)
    pooled = _auc(np.concatenate(pooled_y), np.concatenate(pooled_p)) if pooled_y else None
    return {"folds": folds, "pooledAuc": pooled, "pooledWindows": int(sum(len(v) for v in pooled_y))}


def run_research(fit: Callable, x_all: np.ndarray, y_all: np.ndarray, groups: np.ndarray, train_groups: list[str], eval_groups: list[str], seed: int, progress: Callable[[str], None] = lambda _: None) -> dict[str, Any]:
    train = np.isin(groups, train_groups)
    held = np.isin(groups, eval_groups)
    return {
        "learningCurve": learning_curve(fit, x_all[train], y_all[train], x_all[held], y_all[held], seed, progress),
        "leaveOneOut": leave_one_recording_out(fit, x_all, y_all, groups, progress),
    }
