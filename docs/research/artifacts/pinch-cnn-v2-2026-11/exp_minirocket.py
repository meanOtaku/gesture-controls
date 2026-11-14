"""Experiment 1: MiniRocket (fixed random convolution kernels + a linear classifier) on the trainer's CNN inputs.

The fastest model type to test: no learned convolutions, no GPU. If it does as well as the CNN on live pinches, the CNN's
problem is in what it learns, not in the information the inputs carry.

Options:
  --hz 100|50|multi   the trainer's inputs at 100 Hz, 50 Hz, or both (one MiniRocket per rate, features joined)
  --hard              a second fit with the training negatives the first fit scored highest (hard negatives)
  --jerk              add the accelerometer's change per tick (a jerk on the scaled signal) and its magnitude as channels
  --kernels N         MiniRocket kernels per rate (default 4000)

Run (aeon needs Python <= 3.13):
  uv run --isolated --no-project --python 3.13 --with aeon --with torch --with scikit-learn \
      python docs/research/artifacts/pinch-cnn-v2-2026-11/exp_minirocket.py --hz multi --hard --jerk
"""
import argparse
import dataclasses
import time
import warnings

import numpy as np
from aeon.transformations.collection.convolution_based import MiniRocket
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import bench
from label_trainer import label_train

warnings.filterwarnings("ignore", message="Data seen by instance of MiniRocket")

NEG_PER_POS = 8          # negatives kept per positive (a random subset, all positives kept)
HARD_PER_POS = 2         # hard negatives added per positive in the second fit
CHANNELS = 9
ACCEL = slice(0, 3)


def multi_inputs(spec, rec, d):
    """The trainer's inputs at 50 Hz and at 100 Hz for the same decisions, side by side (450 + 900 columns)."""
    return np.concatenate([label_train.inputs(dataclasses.replace(spec, motion_hz=hz), rec, d) for hz in (50, 100)], axis=1)


def split_rates(x: np.ndarray, rates: tuple[int, ...]) -> list[np.ndarray]:
    """(examples, channels, ticks) per rate, from columns laid out as `multi_inputs` (or one rate) writes them."""
    out, start = [], 0
    for hz in rates:
        width = CHANNELS * hz  # 1 s of ticks
        out.append(x[:, start:start + width].reshape(len(x), CHANNELS, hz).astype(np.float64))
        start += width
    return out


def with_jerk(series: np.ndarray) -> np.ndarray:
    """Adds 4 channels: the accelerometer's change per tick on each axis, and the size of that change."""
    d = np.diff(series[:, ACCEL, :], axis=2, prepend=series[:, ACCEL, :1])
    return np.concatenate([series, d, np.linalg.norm(d, axis=1, keepdims=True)], axis=1)


def make_fit(rates: tuple[int, ...], kernels: int, jerk: bool, hard: bool):
    def features(rockets, x):
        parts = split_rates(x, rates)
        if jerk:
            parts = [with_jerk(p) for p in parts]
        return np.concatenate([r.transform(p).astype(np.float32) for r, p in zip(rockets, parts)], axis=1)

    def fit_once(x, y, seed):
        parts = split_rates(x, rates)
        if jerk:
            parts = [with_jerk(p) for p in parts]
        rockets = [MiniRocket(n_kernels=kernels, random_state=seed + i).fit(p) for i, p in enumerate(parts)]
        f = np.concatenate([r.transform(p).astype(np.float32) for r, p in zip(rockets, parts)], axis=1)
        scaler = StandardScaler().fit(f)
        clf = LogisticRegression(C=0.05, max_iter=3000).fit(scaler.transform(f), y)

        def predict(xx):
            out = np.empty(len(xx))
            for s in range(0, len(xx), 8192):
                out[s:s + 8192] = clf.predict_proba(scaler.transform(features(rockets, xx[s:s + 8192])))[:, 1]
            return out
        return predict

    def fit(data: bench.Data, seed: int = 17):
        t0 = time.time()
        rng = np.random.default_rng(seed)
        pos = np.flatnonzero(data.y == 1)
        neg_all = np.flatnonzero(data.y == 0)
        neg = rng.choice(neg_all, size=min(len(neg_all), NEG_PER_POS * len(pos)), replace=False)
        idx = np.concatenate([pos, neg])
        predict = fit_once(data.x[idx], data.y[idx], seed)
        if hard:
            rest = np.setdiff1d(neg_all, neg)
            scores = predict(data.x[rest])
            top = rest[np.argsort(scores)[::-1][:HARD_PER_POS * len(pos)]]
            idx = np.concatenate([idx, top])
            predict = fit_once(data.x[idx], data.y[idx], seed)
        print(f"  fit on {len(idx)} moments ({len(pos)} positive), {time.time() - t0:.0f} s", flush=True)
        return predict
    return fit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hz", default="100", choices=["100", "50", "multi"])
    ap.add_argument("--hard", action="store_true")
    ap.add_argument("--jerk", action="store_true")
    ap.add_argument("--kernels", type=int, default=4000)
    a = ap.parse_args()
    rates = (50, 100) if a.hz == "multi" else (int(a.hz),)
    inputs, input_name, hz = ((multi_inputs, "multi", None) if a.hz == "multi"
                              else (bench.trainer_inputs, "trainer", int(a.hz)))
    name = f"minirocket-{a.kernels}-{a.hz}hz" + ("-hard" if a.hard else "") + ("-jerk" if a.jerk else "")
    fit = make_fit(rates, a.kernels, a.jerk, a.hard)
    data = bench.training_data(inputs, input_name, hz)
    print(f"{name}: {len(data.y)} training moments, {int(data.y.sum())} positive", flush=True)
    chosen, replay = bench.choose_threshold_oof(fit, data, inputs, input_name, hz)
    print(f"  threshold chosen out of fold: {chosen} (training replay caught {replay['caught']}/{replay['gestures']}, "
          f"{replay['falseActivations']} false)", flush=True)
    predict = fit(data)
    res = bench.score(predict, inputs, input_name, hz)
    what = {"100": "100 Hz", "50": "50 Hz", "multi": "50 Hz and 100 Hz (one MiniRocket each, features joined)"}[a.hz]
    bench.save(name, res, chosen, {"kernels": a.kernels, "hz": a.hz, "hard": a.hard, "jerk": a.jerk, "negPerPos": NEG_PER_POS},
               notes=f"MiniRocket ({a.kernels} kernels per rate) + logistic regression on the trainer's {what} CNN inputs"
                     + ("; accelerometer jerk channels added" if a.jerk else "")
                     + ("; refitted with hard negatives" if a.hard else "")
                     + f"; negatives subsampled to {NEG_PER_POS} per positive. Threshold chosen out of fold on the training recordings.")


if __name__ == "__main__":
    main()
