"""Synthetic recordings for the trainer's tests: 25 Hz PPG, with gestures that change it, and (with `motion`) 50 Hz motion.

Every row is generated from simple formulas (a pulse wave, slow drift and noise), never real captures. A `pinch` hold starts
with the green channel stepping up; a `fist` hold starts with it stepping down, so the two starts differ only in shape, as
the model must learn. With `motion`, the accelerometer and gyroscope carry noise and a slow sway, a pinch adds a short sharp
tap to the accelerometer and a fist a slower turn of the gyroscope, on rows of their own as the recorder writes them. Rows
between holds have no label.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy.special import expit

from label_trainer.schema import HEADER_COLUMNS

TICK_NS = 40_000_000
S = 1_000_000_000


def write_pulse_recording(
    folder: Path,
    name: str,
    *,
    seed: int,
    seconds: float = 60.0,
    gestures: tuple[str, ...] = ("pinch", "fist"),
    every_s: float = 3.0,
    hold_s: float = 1.2,
    lag_ms: int = 0,
    step: float = 2500.0,
    gestures_until_s: float | None = None,
    motion: bool = False,
) -> Path:
    """Writes a recording and returns its path. Values are whole numbers, as the watch sends them. Holds start every `every_s` seconds from 3 s, cycling through `gestures`;
    their labels are `lag_ms` later than the signal shows them (a camera that marks late). With `gestures_until_s`, none
    starts after that, and the rest of the recording is quiet."""
    rng = np.random.default_rng(seed)
    n = int(seconds * 25)
    t = 1_000 * S + np.cumsum(np.full(n, TICK_NS) + rng.integers(-2_000_000, 2_000_001, n))
    k = np.arange(n)
    pulse = np.sin(2 * np.pi * k / 21.0)
    green = -150_000 + 700 * pulse + np.cumsum(rng.normal(0, 8, n)) + rng.normal(0, 30, n)
    red = 1_693_000 + 100 * pulse + rng.normal(0, 12, n)
    ir = 2_224_000 + 60 * np.cos(2 * np.pi * k / 21.0) + rng.normal(0, 8, n)
    labels = np.array([""] * n, dtype=object)
    starts = np.arange(3 * S, ((gestures_until_s or seconds) - 3) * S + 1, every_s * S)
    for index, start in enumerate(starts):
        gesture = gestures[index % len(gestures)]
        onset = t[0] + int(start)
        rise = expit((t - onset - 150_000_000) / 60_000_000)                     # over about 300 ms
        fall = expit(-(t - onset - int(hold_s * S)) / 60_000_000)
        green = green + (step if gesture == "pinch" else -step) * rise * fall
        marked = (t >= onset + lag_ms * 1_000_000) & (t <= onset + int(hold_s * S) + lag_ms * 1_000_000)
        labels[marked] = gesture
    rows = [(int(t[i]), ",".join([str(int(t[i])), str(i), f"{green[i]:.0f}", f"{red[i]:.0f}", f"{ir[i]:.0f}", *([""] * 10), "0", labels[i]]))
            for i in range(n)]
    if motion:
        m = int(seconds * 50)
        tm = t[0] + 7_000_000 + np.cumsum(np.full(m, TICK_NS // 2) + rng.integers(-1_000_000, 1_000_001, m))
        sway = 0.04 * np.sin(2 * np.pi * np.arange(m) / 120.0)
        accel = np.stack([sway + rng.normal(0, 0.02, m), rng.normal(0, 0.02, m), rng.normal(0, 0.02, m)], axis=1)
        gyro = np.stack([rng.normal(0, 0.01, m), sway / 2 + rng.normal(0, 0.01, m), rng.normal(0, 0.01, m)], axis=1)
        for index, start in enumerate(starts):
            since = (tm - t[0] - int(start)) / S
            if gestures[index % len(gestures)] == "pinch":
                accel[:, 0] += np.where((since > 0.1) & (since < 0.25), 0.6 * np.sin(np.pi * (since - 0.1) / 0.15), 0.0)
            else:
                gyro[:, 2] += np.where((since > 0.0) & (since < 0.6), 0.5 * np.sin(np.pi * since / 0.6), 0.0)
        label_at = labels[np.clip(np.searchsorted(t, tm, side="right") - 1, 0, n - 1)]
        rows += [(int(tm[j]), ",".join([str(int(tm[j])), str(n + j), "", "", "", *(f"{v:.6f}" for v in (*accel[j], *gyro[j])), "1", "0", "0", "0", "", label_at[j]]))
                 for j in range(m)]
        rows.sort(key=lambda row: row[0])
    lines = ["# gesture-dataset-export: 1", ",".join(HEADER_COLUMNS), *(line for _, line in rows)]
    path = folder / f"{name}.csv"
    path.write_text("\n".join(lines) + "\n")
    return path


def spec_for(folder: Path, *, train: int = 4, evaluation: int = 2, research: bool = False, lag_ms: int = 0, seconds: float = 60.0, step: float = 2500.0, every_s: float = 3.0, motion: bool = False) -> dict:
    """A spec training a `pinch` model, with `fist` as a negative, on fresh synthetic recordings: the PPG-only model, or with
    `motion` the PPG + IMU one."""
    recordings = {f"r{i}": str(write_pulse_recording(folder, f"r{i}", seed=i, lag_ms=lag_ms, seconds=seconds, step=step, every_s=every_s, motion=motion)) for i in range(train + evaluation)}
    ids = sorted(recordings)
    return {
        "version": 1,
        "target": "pinch",
        "negatives": ["fist"],
        "excludes": [],
        "recordings": recordings,
        "train": ids[:train],
        "evaluation": ids[train:],
        "backend": "ppg-onset-trees",
        "sources": ["watchPpg", "watchOrientation"] if motion else ["watchPpg"],
        "seed": 17,
        "research": research,
    }
