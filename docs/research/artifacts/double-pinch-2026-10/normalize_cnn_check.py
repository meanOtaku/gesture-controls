"""Does putting each axis on a 0-1 scale before the high-pass help the spike CNN, and especially on a new session?

Sessions differ in strap, pinch force and arm (steps 2b and 3), and a new day is where every model has failed. Scaling
each axis by its own recent level before the CNN sees it could remove some of that difference. Each pipeline runs the
same way in training and in testing, causally (only past samples), on all six axes, and feeds `spike_cnn_check.py`'s CNN
the ±0.2 s window around each candidate spike (the same candidates, folds, training and scoring as step 7):

* **raw, high-passed** and **raw**: step 7's two ±0.2 s variants, rerun as the reference;
* **z-score, sigmoid, high-pass** (the proposed pipeline): each axis less its trailing 10 s mean, over its trailing 10 s
  standard deviation, through the sigmoid 1 / (1 + e^-z) to 0-1, then the 8 Hz high-pass;
* **z-score, sigmoid** (no high-pass);
* **z-score, high-pass** (no sigmoid: whether the squashing matters);
* **min-max, high-pass**: each axis scaled to 0-1 between its trailing 10 s minimum and maximum, then the high-pass.

The standard deviation has a floor (0.02 m/s², 0.01 rad/s) so a perfectly still axis does not blow up.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/normalize_cnn_check.py

Run from the repository root (about 10 minutes). Writes normalize-cnn/results.json and results.md.
"""
import importlib.util
from pathlib import Path
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import sosfilt

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("spike_cnn_check", HERE / "spike_cnn_check.py")
SC = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(SC)
M = SC.M

RECENT = 500                     # 10 s at 50 Hz
STD_FLOOR = np.array([0.02] * 3 + [0.01] * 3)
VARIANTS = {"raw, high-passed": ("hp", 10), "raw": ("x", 10),
            "z-score, sigmoid, high-pass": ("z_sig_hp", 10), "z-score, sigmoid": ("z_sig", 10),
            "z-score, high-pass": ("z_hp", 10), "min-max, high-pass": ("mm_hp", 10)}


def trailing_extreme(x, n, fn):
    padded = np.concatenate([np.repeat(x[:1], n - 1, axis=0), x])
    return fn(sliding_window_view(padded, n, axis=0), axis=2)


def add_streams(r):
    x = r["x"]
    mean = M.trailing_mean(x, RECENT)
    std = np.sqrt(np.maximum(M.trailing_mean(x * x, RECENT) - mean * mean, 0)) + STD_FLOOR
    z = (x - mean) / std
    sig = 1 / (1 + np.exp(-z))
    lo, hi = trailing_extreme(x, RECENT, np.min), trailing_extreme(x, RECENT, np.max)
    mm = (x - lo) / (hi - lo + 1e-6)
    r.update(z_sig_hp=sosfilt(SC.HP, sig, axis=0), z_sig=sig, z_hp=sosfilt(SC.HP, z, axis=0), mm_hp=sosfilt(SC.HP, mm, axis=0))


if __name__ == "__main__":
    SC.main(VARIANTS, "normalize-cnn", "# The spike CNN after scaling each axis to 0-1", add_streams)
