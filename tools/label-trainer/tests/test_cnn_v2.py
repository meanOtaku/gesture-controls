"""The v2 CNN: its inputs, gate, network file and spec checks (the runtime's side is tested on the shared fixtures)."""
import numpy as np
import pytest

from label_trainer import cnn_input, cnn_v2, label_train as lt


def streams(seed=0, seconds=14.0):
    rng = np.random.default_rng(seed)
    n = int(seconds * 100)
    mts = 1_000_000_000_000 + np.arange(n, dtype=np.int64) * 10_000_000
    motion = rng.normal(0, 0.02, (n, 6))
    motion[1200:1205, 0] += 0.8                               # a sharp tap 12 s in
    pts = 1_000_000_000_000 + np.arange(int(seconds * 25), dtype=np.int64) * 40_000_000
    pulse = 200_000 + rng.normal(0, 20, (len(pts), 3))
    return mts, motion, pts, pulse


def test_v2_inputs_are_the_cnn_s_nine_channels_and_the_jerk_envelope():
    mts, motion, pts, pulse = streams()
    d = pts[-3:]
    first = cnn_input.inputs(mts, motion, pts, pulse, d, hz=100)
    v2 = cnn_input.inputs(mts, motion, pts, pulse, d, hz=100, envelope=True)
    assert v2.shape == (3, 1000)
    np.testing.assert_array_equal(v2[:, :900], first)
    assert cnn_input.feature_names(100, envelope=True)[-1] == "cnn_accel_jerk_env_t99"
    with pytest.raises(ValueError):
        cnn_input.inputs(mts, motion, pts, pulse, d, hz=100, envelope=True, scaling=cnn_input.ROLLING)


def test_the_gate_sees_a_spike_only_inside_its_window():
    mts, motion, _, _ = streams()
    tap = mts[1200]                                           # the first tap sample
    s = cnn_input.spike(mts, motion, np.array([tap - 1, tap + 500_000_000, tap + 700_000_000]))
    assert s[1] > 50 and s[1] > 5 * s[0] and s[1] > 5 * s[2]


def test_the_exported_file_reproduces_the_trained_networks(monkeypatch):
    monkeypatch.setattr(cnn_v2, "MEMBERS", 2)
    rng = np.random.default_rng(1)
    x = rng.random((300, 1000)).astype(np.float32)
    y = (rng.random(300) < 0.2).astype(int)
    model = cnn_v2.fit(x, y, 17, epochs=1)
    data = cnn_v2.to_bytes(model)
    assert abs(cnn_v2.predict(data, x[:40]) - model.predict_proba(x[:40])[:, 1]).max() < cnn_v2.PARITY_TOLERANCE


def test_a_v2_spec_reads_motion_at_100_hz():
    raw = {"version": 1, "target": "pinch_in", "recordings": {}, "train": [], "evaluation": [], "backend": lt.CNN_V2_BACKEND}
    assert lt.parse_spec(raw).cnn and lt.parse_spec(raw).cnn_v2
    with pytest.raises(lt.TrainingRefused):
        lt.parse_spec({**raw, "motionHz": 50})
    with pytest.raises(lt.TrainingRefused):
        lt.parse_spec({**raw, "sources": ["watchPpg"]})
