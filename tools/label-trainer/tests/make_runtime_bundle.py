"""Writes crates/label-inference/tests/fixtures/ppg_onset_bundle: a bundle this trainer made, and what it must answer.

The runtime's tests load the bundle through the full validation and feed `expected.json`'s PPG trace (pinches and fists
for 15 s, then 9 s of quiet) through the live pipeline; every score must be the probability the trainer gives the same
decision. Regenerate after changing the model or its inputs on purpose:

    uv run --project tools/label-trainer python tools/label-trainer/tests/make_runtime_bundle.py
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from label_trainer import label_train as lt, ppg_onset, trees  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402
from tests.pulse_data import spec_for, write_pulse_recording  # noqa: E402

OUT = Path(__file__).resolve().parents[3] / "crates/label-inference/tests/fixtures/ppg_onset_bundle"


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        lt.MIN_NEGATIVE_SECONDS, lt.MAX_FALSE_ACTIVATIONS_PER_HOUR, lt.MIN_GESTURE_RECALL = 0.0, float("inf"), 0.0
        # Gestures 5 s apart leave quiet time between them, so the model learns that quiet is not a start.
        result = lt.run(spec_for(tmp, seconds=60.0, every_s=5.0), tmp / "run")
        assert result["outcome"] == "deployable", result["message"]
        if OUT.exists():
            shutil.rmtree(OUT)
        OUT.mkdir(parents=True)
        for name in ("manifest.json", "model.trees"):
            shutil.copy(tmp / "run" / "bundle" / name, OUT / name)
        data = (OUT / "model.trees").read_bytes()
        trace = load_recording(write_pulse_recording(tmp, "live", seed=99, seconds=24.0, gestures_until_s=15.0))
        ts, values = lt.pulse_of(trace)
        x = ppg_onset.features(ts, values, ts)
        ok = np.isfinite(x).all(axis=1)
        probability = np.full(len(ts), np.nan)
        probability[ok] = trees.predict(data, x[ok])
        (OUT / "expected.json").write_text(json.dumps({
            "samples": [[int(t), float(g), float(r), float(i)] for t, (g, r, i) in zip(ts, values)],
            "probabilities": [None if np.isnan(p) else float(p) for p in probability],
        }) + "\n")
    print(f"wrote {OUT} ({len(data) / 1e6:.1f} MB model, {int(ok.sum())} scored decisions)")


if __name__ == "__main__":
    main()
