"""Writes crates/label-inference/tests/fixtures/ppg_onset_bundle, ppg_imu_onset_bundle and ppg_imu_cnn_median_bundle: a
bundle of each kind this trainer makes (the motion ones at 100 Hz, `_100hz`), and what it must answer. The 50 Hz motion
and CNN bundles are kept as they were, for the models people already have. ppg_imu_cnn_bundle is the earlier rolling-scaled CNN, which
this trainer no longer makes: it is kept as it is, so the runtime stays tested on the models people already have.

The runtime's tests load each bundle through the full validation and feed `expected.json`'s trace (pinches and fists for
15 s, then 9 s of quiet: the PPG, and for the PPG + IMU models the motion too) through the live pipeline; every score
must be the probability the trainer gives the same decision. The CNN needs the `cnn` extra (PyTorch). Regenerate after changing the models or their inputs on purpose:

    uv run --project tools/label-trainer python tools/label-trainer/tests/make_runtime_bundle.py
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from label_trainer import cnn, cnn_input, cnn_v2, label_train as lt, ppg_onset, trees  # noqa: E402
from label_trainer.csv_io import load_recording  # noqa: E402
from tests.pulse_data import spec_for, write_pulse_recording  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "crates/label-inference/tests/fixtures"
# The v2 fixture's gate level (m/s^3): about the median spike of its trace, so the runtime test sees both sides of it.
V2_FIXTURE_GATE = 10.0


def write(name: str, motion: bool, backend: str = lt.BACKEND, motion_hz: int | None = None, data_hz: int | None = None) -> None:
    """`motion_hz` is the rate the model reads; `data_hz` the rate of the recorded motion (the watch's 100 Hz for a model
    that reads 25), `motion_hz` when not named."""
    data_hz = data_hz or motion_hz or 50
    out = FIXTURES / name
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        lt.MIN_NEGATIVE_SECONDS, lt.MAX_FALSE_ACTIVATIONS_PER_HOUR, lt.MIN_GESTURE_RECALL = 0.0, float("inf"), 0.0
        lt.MIN_BALANCED_ACCURACY, lt.MAX_FALSE_ACTIVATION_RATE = 0.0, 1.0
        # Gestures 5 s apart leave quiet time between them, so the model learns that quiet is not a start.
        raw = spec_for(tmp, seconds=60.0, every_s=5.0, motion=motion, motion_hz=data_hz)
        raw["backend"] = backend
        if motion_hz:
            raw["motionHz"] = motion_hz
        result = lt.run(raw, tmp / "run")
        assert result["outcome"] == "deployable", result["message"]
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        model_file = "model.cnn" if backend in (lt.CNN_BACKEND, lt.CNN_V2_BACKEND) else "model.trees"
        for file in ("manifest.json", model_file):
            shutil.copy(tmp / "run" / "bundle" / file, out / file)
        data = (out / model_file).read_bytes()
        trace = load_recording(write_pulse_recording(tmp, "live", seed=99, seconds=24.0, gestures_until_s=15.0, motion=motion,
                                                     motion_hz=data_hz))
        ts, values = lt.pulse_of(trace)
        x = lt.inputs(lt.parse_spec(raw), trace, ts)
        ok = np.isfinite(x).all(axis=1)
        probability = np.full(len(ts), np.nan)
        module = {lt.CNN_BACKEND: cnn, lt.CNN_V2_BACKEND: cnn_v2}.get(backend, trees)
        probability[ok] = module.predict(data, x[ok])
        ungated = probability.copy()
        if backend == lt.CNN_V2_BACKEND:
            # The runtime gates the v2 CNN's score as the trainer's replay does (`label_train.timeline`). The synthetic
            # pinches are smoother than real ones, so the level the trainer set gates every scored decision of this trace;
            # the fixture's manifest lowers it to V2_FIXTURE_GATE so that the test sees decisions on both sides of it.
            manifest = json.loads((out / "manifest.json").read_text())
            manifest["preprocessing"]["gate"]["minJerk"] = V2_FIXTURE_GATE
            (out / "manifest.json").write_text(json.dumps(manifest) + "\n")
            gate = manifest["preprocessing"]["gate"]
            motion_ts, axes = lt.motion_of(trace)
            spikes = cnn_input.spike(motion_ts, axes, ts[ok], gate["windowMs"])
            probability[ok] = np.where(spikes >= gate["minJerk"], probability[ok], 0.0)
        expected = {
            "samples": [[int(t), float(g), float(r), float(i)] for t, (g, r, i) in zip(ts, values)],
            "probabilities": [None if np.isnan(p) else float(p) for p in probability],
        }
        if backend == lt.CNN_V2_BACKEND:
            expected["ungated"] = [None if np.isnan(p) else float(p) for p in ungated]
        if motion:
            motion_ts, axes = lt.motion_of(trace)
            expected["motion"] = [[int(t), *map(float, a)] for t, a in zip(motion_ts, axes)]
        (out / "expected.json").write_text(json.dumps(expected) + "\n")
    print(f"wrote {out} ({len(data) / 1e6:.1f} MB model, {int(ok.sum())} scored decisions)")


def write_multi_gesture() -> None:
    """A small multi-gesture v2 network (one member, trained one pass on random inputs) and its outputs for a few inputs,
    from the file alone: the runtime must give each gesture's output as the trainer does."""
    cnn_v2_members = cnn_v2.MEMBERS
    cnn_v2.MEMBERS = 1
    try:
        rng = np.random.default_rng(5)
        x = rng.random((200, cnn_v2.CHANNELS * cnn_v2.LENGTH)).astype(np.float32)
        y = rng.choice([0, 0, 1, 2], 200)
        data = cnn_v2.to_bytes(cnn_v2.fit(x, y, 17, epochs=1, classes=("pinch_in", "pinch_out")))
    finally:
        cnn_v2.MEMBERS = cnn_v2_members
    out = FIXTURES / "cnn_v2_multi_gesture"
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.cnn").write_bytes(data)
    inputs = x[:4].astype(np.float64)
    (out / "expected.json").write_text(json.dumps({"inputs": inputs.tolist(), "outputs": cnn_v2.predict(data, inputs).tolist()}) + "\n")
    print(f"wrote {out} ({len(data) / 1e6:.1f} MB model)")


def main() -> None:
    write("ppg_onset_bundle", motion=False)
    # ppg_imu_onset_bundle is the first motion models', on the 50 Hz grid with no rate named: kept as it is, as the runtime
    # must keep running the models people already have. The trainer now makes them at 100 Hz.
    write("ppg_imu_onset_100hz_bundle", motion=True, motion_hz=100)
    # Likewise ppg_imu_cnn_median_bundle, the 50 Hz CNNs': kept as it is. The trainer now makes the CNN at 100 Hz too.
    write("ppg_imu_cnn_median_100hz_bundle", motion=True, backend=lt.CNN_BACKEND, motion_hz=100)
    # The v2 CNN: branches, the jerk envelope and the peak gate (its expected scores are gated, as the runtime's are).
    write("ppg_imu_cnn_v2_bundle", motion=True, backend=lt.CNN_V2_BACKEND, motion_hz=100)
    # A v2 CNN trained at 25 Hz, fed the watch's 100 Hz motion as in use.
    write("ppg_imu_cnn_v2_25hz_bundle", motion=True, backend=lt.CNN_V2_BACKEND, motion_hz=25, data_hz=100)
    write_multi_gesture()


if __name__ == "__main__":
    if sys.argv[1:] == ["cnn"]:
        write("ppg_imu_cnn_median_100hz_bundle", motion=True, backend=lt.CNN_BACKEND, motion_hz=100)
    elif sys.argv[1:] == ["multi-gesture"]:
        write_multi_gesture()
    elif sys.argv[1:] == ["cnn-v2-25"]:
        write("ppg_imu_cnn_v2_25hz_bundle", motion=True, backend=lt.CNN_V2_BACKEND, motion_hz=25, data_hz=100)
    elif sys.argv[1:] == ["cnn-v2"]:
        write("ppg_imu_cnn_v2_bundle", motion=True, backend=lt.CNN_V2_BACKEND, motion_hz=100)
    else:
        main()
