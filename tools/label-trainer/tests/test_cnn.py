import json

import numpy as np
import pytest

from label_trainer import cnn, cnn_input, gpu_check, label_train as lt
from tests.make_cnn_input_cases import FIXTURE, build
from tests.pulse_data import spec_for

torch = pytest.importorskip("torch")  # the `cnn` extra


def test_the_shared_cases_are_what_the_inputs_give_now():
    # Keeps the Rust runtime's cases (`crates/pinch-inference/src/cnn_input.rs`) equal to this module's inputs.
    stored, now = json.loads(FIXTURE.read_text()), json.loads(json.dumps(build()))
    assert stored["feature_names"] == now["feature_names"]
    for a, b in zip(stored["cases"], now["cases"], strict=True):
        assert a["decisions"] == b["decisions"]
        for key in ("expected", "expected_median"):
            for row_a, row_b in zip(a[key], b[key], strict=True):
                assert (row_a is None) == (row_b is None)
                if row_a is not None:
                    assert np.allclose(row_a, row_b, rtol=0, atol=1e-12)


def test_each_input_is_in_zero_to_one_and_a_gap_or_too_little_history_gives_none():
    ms = 1_000_000
    t = 1_000_000_000_000 + np.arange(1200) * 10 * ms
    motion = np.column_stack([np.sin(np.arange(1200) / 7.0)] * 6)
    pulse_t = t[::4]
    pulse = np.column_stack([200_000 + 100 * np.sin(np.arange(len(pulse_t)) / 3.0)] * 3)
    x = cnn_input.inputs(t, motion, pulse_t, pulse, np.array([t[-1], t[500]]))
    assert np.isfinite(x[0]).all() and ((x[0] > 0) & (x[0] < 1)).all()
    assert not np.isfinite(x[1]).any(), "5 s of history, less than the 10.98 s it reads"
    keep = (pulse_t < t[1100]) | (pulse_t > t[1140])
    assert not np.isfinite(cnn_input.inputs(t, motion, pulse_t[keep], pulse[keep], np.array([t[-1]]))).any()


def test_a_burst_of_motion_barely_moves_median_scaling_but_squashes_rolling_scaling():
    ms = 1_000_000
    rng = np.random.default_rng(3)
    t = 1_000_000_000_000 + np.arange(1300) * 10 * ms
    quiet = rng.normal(0, 0.03, (1300, 6))
    tap = np.zeros((1300, 6))
    tap[1250:1255] = 0.5                                                       # 0.5 s before the decision
    burst = np.zeros((1300, 6))
    burst[500:700] = rng.normal(0, 4.0, (200, 6))                              # 2 s of hard motion, 6 s before the decision
    pulse_t = t[::4]
    pulse = 200_000 + rng.normal(0, 50, (len(pulse_t), 3))
    def tap_size(motion, scaling):
        x = cnn_input.inputs(t, motion, pulse_t, pulse, t[-1:], scaling=scaling).reshape(9, 50)
        return x[3, 25:30].max() - 0.5                                         # gyro_x, around the tap, above "nothing"
    assert tap_size(quiet + tap + burst, cnn_input.MEDIAN) > 0.45
    assert tap_size(quiet + tap + burst, cnn_input.ROLLING) < 0.2
    assert tap_size(quiet + tap, cnn_input.ROLLING) > 0.45


def test_labels_mark_the_moments_after_a_start_and_leave_out_those_around_it():
    ms = 1_000_000
    d = np.arange(0, 4000, 40, dtype=np.int64) * ms
    y = cnn.labels(d, [1000 * ms], [(3000 * ms, 3100 * ms)])
    at = lambda t: y[t // 40]  # noqa: E731
    assert at(1400) == 1 and at(1600) == 1
    assert at(1200) == -1 and at(800) == -1 and at(2200) == -1, "around the start, but not its moment"
    assert at(760) == 0 and at(2240) == 0, "clear of the start"
    assert at(3050) == -1 and at(3600) == -1, "inside an excluded hold, and just after"


def test_the_exported_file_reproduces_the_trained_networks(monkeypatch):
    monkeypatch.setattr(cnn, "EPOCHS", 2)
    rng = np.random.default_rng(0)
    x = rng.random((300, cnn_input.FEATURE_COUNT))
    y = (x[:, :50].mean(axis=1) > 0.5).astype(int)
    model = cnn.fit(x, y, 1)
    assert len(model.nets) == cnn.MEMBERS
    exported = cnn.predict(cnn.to_bytes(model), x[:40])
    assert np.max(np.abs(exported - model.predict_proba(x[:40])[:, 1])) < cnn.PARITY_TOLERANCE


@pytest.mark.parametrize("where", ["cpu", "gpu"])
def test_trained_on_the_gpu_or_the_cpu_the_file_reproduces_it_and_the_networks_come_back_to_the_cpu(monkeypatch, where):
    if where == "gpu":
        if not (torch.backends.mps.is_available() or torch.cuda.is_available()):
            pytest.skip("no GPU here")
        monkeypatch.delenv("LABEL_TRAINER_DEVICE", raising=False)
    else:
        monkeypatch.setenv("LABEL_TRAINER_DEVICE", "cpu")
    monkeypatch.setattr(cnn, "EPOCHS", 2)
    rng = np.random.default_rng(0)
    x = rng.random((300, cnn_input.FEATURE_COUNT))
    y = (x[:, :50].mean(axis=1) > 0.5).astype(int)
    model = cnn.fit(x, y, 1)
    assert all(p.device.type == "cpu" for net in model.nets for p in net.parameters())
    exported = cnn.predict(cnn.to_bytes(model), x[:40])
    assert np.max(np.abs(exported - model.predict_proba(x[:40])[:, 1])) < cnn.PARITY_TOLERANCE


def test_a_gpu_the_build_sees_but_cannot_run_is_left_for_the_cpu(monkeypatch, capsys):
    monkeypatch.delenv("LABEL_TRAINER_DEVICE", raising=False)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)   # an old card: seen, but the build has no code for it
    monkeypatch.setattr(cnn, "_runs", {})

    def no_kernel(*args, **kwargs):
        raise RuntimeError("CUDA error: no kernel image is available for execution on the device\nmore detail")
    monkeypatch.setattr(torch.nn, "Conv1d", no_kernel)
    assert cnn.device() == "cpu" and cnn.device() == "cpu"
    assert capsys.readouterr().out.count("no kernel image") == 1        # said once
    # Asking for it by name fails loudly instead.
    monkeypatch.setenv("LABEL_TRAINER_DEVICE", "cuda")
    assert cnn.device() == "cuda"


def test_the_gpu_check_says_what_it_will_use_and_times_it(capsys):
    assert gpu_check.main(rows=300) in ("cpu", "mps", "cuda")
    out = capsys.readouterr().out
    assert "The trainer will use:" in out and "one training pass over 300 moments" in out


def test_the_rows_it_must_keep_are_never_left_out_to_stay_within_its_negatives(monkeypatch):
    monkeypatch.setattr(cnn, "EPOCHS", 1)
    monkeypatch.setattr(cnn, "MAX_NEGATIVES", 20)
    seen = []
    real_net = cnn._net

    def recording_net():
        net = real_net()
        original = net.forward
        net.forward = lambda x: (seen.append(x.detach().cpu().numpy().copy()), original(x))[1]
        return net
    monkeypatch.setattr(cnn, "_net", recording_net)
    rng = np.random.default_rng(1)
    x = rng.random((200, cnn_input.FEATURE_COUNT))
    y = np.zeros(200, dtype=int)
    y[:10] = 1
    keep = np.zeros(200, dtype=bool)
    keep[-5:] = True                                  # five false activations to learn from
    x[-5:, 0] = 7.0                                   # marked so they can be found among the batches
    cnn._fit_one(x, y, 3, keep)
    trained = np.concatenate([batch.reshape(len(batch), -1) for batch in seen])
    assert int((trained[:, 0] == 7.0).sum()) == 5     # every one of them, in the one epoch
    assert len(trained) == 10 + 20                     # the positives, and 20 negatives in all


def test_a_cnn_spec_trains_a_cnn_bundle(tmp_path, monkeypatch):
    monkeypatch.setattr(cnn, "EPOCHS", 3)
    monkeypatch.setattr(cnn, "MEMBERS", 1)
    for name, value in (("MIN_NEGATIVE_SECONDS", 0.0), ("MAX_FALSE_ACTIVATIONS_PER_HOUR", float("inf")), ("MIN_GESTURE_RECALL", 0.0)):
        monkeypatch.setattr(lt, name, value)
    raw = spec_for(tmp_path, seconds=40.0, every_s=5.0, motion=True)
    raw["backend"] = lt.CNN_BACKEND
    result = lt.run(raw, tmp_path / "run")
    assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
    assert result["backend"] == lt.CNN_BACKEND
    manifest = json.loads((tmp_path / "run" / "bundle" / "manifest.json").read_text())
    assert manifest["model"]["format"] == "cnn" and manifest["preprocessing"]["kind"] == "ppg_imu_cnn_median"
    assert manifest["window"]["durationMs"] == 11_000 and manifest["thresholds"]["decisionDelayMs"] == cnn.DECISION_DELAY_MS
    assert manifest["input"]["features"] == list(cnn_input.FEATURE_NAMES)
    assert (tmp_path / "run" / "bundle" / "model.cnn").exists()


def test_a_cnn_reads_the_pulse_and_motion_only():
    raw = {"version": 1, "target": "pinch", "recordings": {}, "train": [], "evaluation": [], "backend": lt.CNN_BACKEND,
           "sources": ["watchPpg"]}
    with pytest.raises(lt.TrainingRefused, match="the CNN reads the pulse sensor and motion"):
        lt.parse_spec(raw)
