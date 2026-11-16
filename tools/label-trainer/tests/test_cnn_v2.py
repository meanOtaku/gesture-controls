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


def test_a_saved_model_loads_back_scoring_as_its_file_does(monkeypatch):
    monkeypatch.setattr(cnn_v2, "MEMBERS", 2)
    rng = np.random.default_rng(2)
    x = rng.random((300, 1000)).astype(np.float32)
    y = (rng.random(300) < 0.2).astype(int)
    data = cnn_v2.to_bytes(cnn_v2.fit(x, y, 17, epochs=1))
    loaded = cnn_v2.Model(cnn_v2.load(data))
    assert abs(loaded.predict_proba(x[:40])[:, 1] - cnn_v2.predict(data, x[:40])).max() < cnn_v2.PARITY_TOLERANCE
    # Saved again untrained, it is the same model.
    assert abs(cnn_v2.predict(cnn_v2.to_bytes(loaded), x[:40]) - cnn_v2.predict(data, x[:40])).max() < 1e-6


def test_continuing_trains_on_from_the_saved_model_not_from_scratch(monkeypatch):
    monkeypatch.setattr(cnn_v2, "MEMBERS", 2)
    rng = np.random.default_rng(3)
    x = rng.random((300, 1000)).astype(np.float32)
    y = (rng.random(300) < 0.2).astype(int)
    data = cnn_v2.to_bytes(cnn_v2.fit(x, y, 17, epochs=2))
    continued = cnn_v2.fit(x, y, 17, epochs=1, start=data)
    assert len(continued.nets) == 2
    out = cnn_v2.to_bytes(continued)
    before, after, fresh = cnn_v2.predict(data, x[:60]), cnn_v2.predict(out, x[:60]), cnn_v2.predict(cnn_v2.to_bytes(cnn_v2.fit(x, y, 99, epochs=1)), x[:60])
    assert 0 < abs(after - before).max()                       # it trained
    assert abs(after - before).mean() < abs(fresh - before).mean()  # but stayed nearer where it began than a new model
    assert abs(cnn_v2.predict(out, x[:40]) - continued.predict_proba(x[:40])[:, 1]).max() < cnn_v2.PARITY_TOLERANCE


def test_only_a_v2_spec_continues_from_a_model_that_is_there(tmp_path):
    model = tmp_path / "model.cnn"
    model.write_text("{}")
    raw = {"version": 1, "target": "pinch_in", "recordings": {}, "train": [], "evaluation": [], "backend": lt.CNN_V2_BACKEND,
           "startFrom": {"model": str(model), "threshold": 0.99, "gateMinJerk": 40.0, "name": "pinch v2"}}
    start = lt.parse_spec(raw).start_from
    assert start == lt.StartFrom(model, "pinch v2", 0.99, 40.0)
    with pytest.raises(lt.TrainingRefused):
        lt.parse_spec({**raw, "backend": lt.CNN_BACKEND})
    with pytest.raises(lt.TrainingRefused):
        lt.parse_spec({**raw, "startFrom": {**raw["startFrom"], "model": str(tmp_path / "missing.cnn")}})
    with pytest.raises(lt.TrainingRefused):
        lt.parse_spec({**raw, "startFrom": {**raw["startFrom"], "threshold": 1.5}})
    with pytest.raises(ValueError):
        cnn_v2.load(b'{"format": "ppg-imu-cnn", "version": 1}')


def test_a_continued_run_is_compared_with_the_model_it_began_from_on_the_same_recordings(tmp_path, monkeypatch):
    import json

    from label_trainer import cnn

    from .pulse_data import spec_for

    monkeypatch.setattr(cnn_v2, "MEMBERS", 1)
    monkeypatch.setattr(cnn, "EPOCHS", 1)
    monkeypatch.setattr(cnn_v2, "CONTINUE_EPOCHS", 1)
    monkeypatch.setattr(lt, "OVERLAY_COPIES", 0, raising=False)
    spec = {**spec_for(tmp_path, motion=True, every_s=5.0, motion_hz=100), "backend": lt.CNN_V2_BACKEND, "motionHz": 100}
    first = lt.run(spec, tmp_path / "first")
    assert first["outcome"] in ("deployable", "evaluationOnly"), first["message"]
    model = tmp_path / "first" / "bundle" / "model.cnn"
    again = lt.run({**spec, "startFrom": {"model": str(model), "threshold": first["metrics"]["activationThreshold"], "name": "first"}},
                   tmp_path / "again")
    assert again["outcome"] in ("deployable", "evaluationOnly"), again["message"]
    before = again["metrics"]["startedFrom"]
    assert before["name"] == "first" and before["threshold"] == first["metrics"]["activationThreshold"]
    # The same held-out recordings, scored by both.
    assert before["events"]["gestures"] == again["metrics"]["events"]["gestures"] > 0
    provenance = json.loads((tmp_path / "again" / "bundle" / "manifest.json").read_text())["provenance"]
    assert provenance["continuedFrom"]["sha256"] == first["modelSha256"]


def test_a_multi_gesture_network_scores_each_gesture_and_its_file_reproduces_it(monkeypatch):
    monkeypatch.setattr(cnn_v2, "MEMBERS", 2)
    rng = np.random.default_rng(4)
    x = rng.random((400, 1000)).astype(np.float32)
    y = rng.choice([0, 0, 0, 1, 2], 400)
    model = cnn_v2.fit(x, y, 17, epochs=1, classes=("pinch_in", "pinch_out"))
    p = model.predict_proba(x[:50])
    assert p.shape == (50, 3) and np.allclose(p.sum(axis=1), 1.0)
    data = cnn_v2.to_bytes(model)
    import json
    assert json.loads(data)["outputs"] == ["nothing", "pinch_in", "pinch_out"]
    assert abs(cnn_v2.predict(data, x[:50]) - p).max() < cnn_v2.PARITY_TOLERANCE
    with pytest.raises(ValueError):
        cnn_v2.load(data)
