"""Says what this machine will train the CNN on, and how fast: run it first on a new machine.

    python -m label_trainer.gpu_check

Prints the PyTorch build, the GPU it sees, and the device `cnn.device` picks, then times one pass of a real network over
40,000 moments of random data, and scoring them, on that device and on the CPU. A full training run is about 12 such passes
for each of 3 networks, then the same again for each of 5 threshold folds, so about 200 passes in all.
"""

from __future__ import annotations

import os
import platform
import time

import numpy as np

from . import cnn, cnn_input


def timed(rows: int) -> tuple[float, float]:
    """Seconds for one training pass over `rows` moments, and for scoring them, on the current device."""
    rng = np.random.default_rng(0)
    x = rng.random((rows, cnn_input.FEATURE_COUNT), dtype=np.float32)
    y = (rng.random(rows) < 0.02).astype(int)
    epochs, cnn.EPOCHS = cnn.EPOCHS, 1
    try:
        started = time.perf_counter()
        net = cnn._fit_one(x, y, 0)
        trained = time.perf_counter() - started
    finally:
        cnn.EPOCHS = epochs
    started = time.perf_counter()
    cnn.Model([net]).predict_proba(x)
    return trained, time.perf_counter() - started


def main(rows: int = 40_000) -> str:
    """Prints the report; returns the device the trainer will use."""
    import torch

    print(f"Python {platform.python_version()}, PyTorch {torch.__version__}, on {platform.system()}")
    if torch.cuda.device_count() > 0:
        print(f"CUDA {torch.version.cuda}: {torch.cuda.get_device_name(0)}, {torch.cuda.get_device_properties(0).total_memory / 2**30:.1f} GB, "
              f"this build has code for {' '.join(torch.cuda.get_arch_list())}")
    elif torch.version.cuda is None and not torch.backends.mps.is_available():
        print("This PyTorch build has no GPU support (a CPU-only build)")
    where = cnn.device()
    print(f"The trainer will use: {where}")
    train, score = timed(rows)
    print(f"{where}: one training pass over {rows:,} moments {train:.1f} s, scoring them {score:.1f} s")
    if where != "cpu":
        os.environ["LABEL_TRAINER_DEVICE"] = "cpu"
        try:
            train_cpu, score_cpu = timed(rows)
        finally:
            del os.environ["LABEL_TRAINER_DEVICE"]
        print(f"cpu: one training pass {train_cpu:.1f} s, scoring {score_cpu:.1f} s; the GPU is {train_cpu / train:.1f}x and {score_cpu / score:.1f}x faster")
    return where


if __name__ == "__main__":
    main()
