"""Writes crates/label-inference/tests/fixtures/ppg_onset_bundle and ppg_imu_onset_bundle: a bundle of each kind this
trainer made, and what it must answer.

The runtime's tests load each bundle through the full validation and feed `expected.json`'s trace (pinches and fists for
15 s, then 9 s of quiet: the PPG, and for the PPG + IMU model the motion too) through the live pipeline; every score must
be the probability the trainer gives the same decision. Regenerate after changing the models or their inputs on purpose:

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

FIXTURES = Path(__file__).resolve().parents[3] / "crates/label-inference/tests/fixtures"


def write(name: str, motion: bool) -> None:
    out = FIXTURES / name
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        lt.MIN_NEGATIVE_SECONDS, lt.MAX_FALSE_ACTIVATIONS_PER_HOUR, lt.MIN_GESTURE_RECALL = 0.0, float("inf"), 0.0
        lt.MIN_BALANCED_ACCURACY, lt.MAX_FALSE_ACTIVATION_RATE = 0.0, 1.0
        # Gestures 5 s apart leave quiet time between them, so the model learns that quiet is not a start.
        raw = spec_for(tmp, seconds=60.0, every_s=5.0, motion=motion)
        result = lt.run(raw, tmp / "run")
        assert result["outcome"] == "deployable", result["message"]
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        for file in ("manifest.json", "model.trees"):
            shutil.copy(tmp / "run" / "bundle" / file, out / file)
        data = (out / "model.trees").read_bytes()
        trace = load_recording(write_pulse_recording(tmp, "live", seed=99, seconds=24.0, gestures_until_s=15.0, motion=motion))
        ts, values = lt.pulse_of(trace)
        x = lt.inputs(lt.parse_spec(raw), trace, ts)
        ok = np.isfinite(x).all(axis=1)
        probability = np.full(len(ts), np.nan)
        probability[ok] = trees.predict(data, x[ok])
        expected = {
            "samples": [[int(t), float(g), float(r), float(i)] for t, (g, r, i) in zip(ts, values)],
            "probabilities": [None if np.isnan(p) else float(p) for p in probability],
        }
        if motion:
            motion_ts, axes = lt.motion_of(trace)
            expected["motion"] = [[int(t), *map(float, a)] for t, a in zip(motion_ts, axes)]
        (out / "expected.json").write_text(json.dumps(expected) + "\n")
    print(f"wrote {out} ({len(data) / 1e6:.1f} MB model, {int(ok.sum())} scored decisions)")


def main() -> None:
    write("ppg_onset_bundle", motion=False)
    write("ppg_imu_onset_bundle", motion=True)


if __name__ == "__main__":
    main()
