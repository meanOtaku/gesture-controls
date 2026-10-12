"""Pre-training a motion encoder on MicroDPad-shaped data, and a convolutional model starting from it."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

h5py = pytest.importorskip("h5py")
torch = pytest.importorskip("torch")
pytest.importorskip("onnxruntime")

from label_trainer import label_train as lt  # noqa: E402
from label_trainer import pretrain as pt  # noqa: E402

from .test_label_train import spec_for  # noqa: E402


def _write_session(path: Path, seed: int) -> None:
    """A session in MicroDPad's layout: 112 Hz motion (gravity on z, gyroscope in degrees per second), with "fast pinch"
    windows that shake and "nothing" windows that do not."""
    rng = np.random.default_rng(seed)
    rate, seconds = 112.3, 40.0
    t = np.arange(0, seconds, 1 / rate)
    acc = rng.normal(0, 0.05, (t.size, 3)) + np.array([0, 0, 9.81])
    gyro = rng.normal(0, 2.0, (t.size, 3))
    labels = []
    for k, start in enumerate(np.arange(2.0, seconds - 3, 2.0)):
        code = "p" if k % 2 == 0 else "o"
        inside = (t >= start) & (t < start + 1.3)
        if code == "p":
            acc[inside] += rng.normal(0, 2.0, (inside.sum(), 3))
            gyro[inside] += rng.normal(0, 90.0, (inside.sum(), 3))
        index = np.flatnonzero(inside)
        labels.append((f"{code}_{k:04d}", code, int(index[0]), int(index[-1]) + 1, float(start), float(start + 1.3)))
    path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(path, "w") as f:
        data = f.create_group("data")
        data["timestamp"] = t
        for i, axis in enumerate("xyz"):
            data[f"acc_{axis}"] = acc[:, i]
            data[f"gyro_{axis}"] = gyro[:, i]
        for name, code, first, last, start, end in labels:
            group = f.create_group(name)
            group["label"] = code.encode()
            group["start_index"], group["end_index"] = first, last
            group["start_time"], group["end_time"] = start, end


@pytest.fixture
def microdpad(tmp_path: Path) -> Path:
    root = tmp_path / "microdpad"
    for person in range(1, 5):
        _write_session(root / "sensor_data" / f"P{person:02d}" / "S1" / f"P{person:02d}_S1.hdf5", seed=person)
    return root


def test_windows_are_the_grid_a_convolutional_model_reads_in_the_watchs_units(microdpad: Path) -> None:
    x, y, people = pt.microdpad_windows(microdpad, window_ms=1000, steps=32, smoothed_share=0.0)
    assert x.shape[1] == 6 * 32 and len(y) == len(people) == x.shape[0]
    assert set(y.tolist()) == {pt.CLASSES.index("o"), pt.CLASSES.index("p")}
    grid = x.reshape(-1, 6, 32)
    nothing = grid[y == pt.CLASSES.index("o")]
    assert abs(float(nothing[:, 2].mean()) - 9.81) < 0.1  # m/s^2, gravity still in: windows are centred later
    assert float(nothing[:, 3:].std()) < 0.1  # 2 degrees per second of noise is 0.035 rad/s
    smoothed, _, _ = pt.microdpad_windows(microdpad, window_ms=1000, steps=32, smoothed_share=1.0)
    assert float(np.diff(smoothed.reshape(-1, 6, 32)[:, 3], axis=1).std()) < float(np.diff(grid[:, 3], axis=1).std())


def test_an_encoder_is_trained_saved_and_used_to_start_a_convolutional_model(microdpad: Path, tmp_path: Path) -> None:
    x, y, people = pt.microdpad_windows(microdpad, window_ms=500, steps=16, smoothed_share=0.5)
    network = replace(pt.ENCODER_NETWORK, epochs=40, batch_size=16)
    model, metrics = pt.train_encoder(x, y, people, steps=16, network=network, say=lambda _: None)
    assert metrics["gestureVsNothingAuc"] > 0.9  # the toy pinch shakes; nothing does not
    path = tmp_path / "encoder.pt"
    pt.save_encoder(model, metrics, network, window_ms=500, steps=16, out=path)
    assert path.with_suffix(".json").is_file()

    raw = spec_for(tmp_path, "cnn1d", gridSteps=16, pretrained=str(path), pretrainedFreeze=True)
    spec = lt.parse_spec(raw)
    assert spec.movement_only is True and spec.network.conv == network.conv  # the encoder's layers, its centring
    x_train, y_train, *_ = lt.build_matrices(spec)
    trained = lt.fit(spec, x_train, y_train)
    for name, value in trained.net.state_dict().items():
        assert torch.equal(value, model.net.state_dict()[name]), name  # frozen: exactly the encoder's
    result = lt.run(raw, tmp_path / "run")
    assert result["outcome"] == "deployable", result["message"]
    import json

    manifest = json.loads((tmp_path / "run" / "bundle" / "manifest.json").read_text())
    assert manifest["provenance"]["pretrained"]["frozen"] is True and len(manifest["provenance"]["pretrained"]["sha256"]) == 64


def test_a_model_that_does_not_match_the_encoder_is_refused(microdpad: Path, tmp_path: Path) -> None:
    x, y, people = pt.microdpad_windows(microdpad, window_ms=500, steps=16)
    network = replace(pt.ENCODER_NETWORK, epochs=1)
    model, metrics = pt.train_encoder(x, y, people, steps=16, network=network, say=lambda _: None)
    path = tmp_path / "encoder.pt"
    pt.save_encoder(model, metrics, network, window_ms=500, steps=16, out=path)
    for over, reason in (
        ({"backend": "torch-mlp"}, "only the convolutional network"),
        ({"gridSteps": 32}, "16 steps"),
        ({"gridSteps": 16, "sources": ["watchAcceleration"]}, "acceleration and gyroscope only"),
        ({"gridSteps": 16, "pretrained": str(tmp_path / "missing.pt")}, "is not there"),
    ):
        raw = {**spec_for(tmp_path, "cnn1d", pretrained=str(path)), **over}
        with pytest.raises(lt.TrainingRefused, match=reason):
            lt.parse_spec(raw)
