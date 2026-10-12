"""The convolutional network's augmentation varies windows the ways a real one could vary, and no other way."""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from label_trainer.nets import CnnModel, _random_rotations  # noqa: E402

NAMES = ["ppg_green", "accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z"]
STEPS = 16


def _model(names=NAMES) -> CnnModel:
    model = CnnModel(len(names), STEPS, seed=1, params={}, centre_windows=False, names=names)
    model.std = torch.ones(1, len(names), 1)
    return model


def _windows(count: int = 64) -> torch.Tensor:
    rng = np.random.default_rng(0)
    grid = rng.normal(0.0, 1.0, (count, len(NAMES), STEPS))
    grid[:, 0, :] += 50_000.0  # a pulse level
    return torch.tensor(grid.reshape(count, -1), dtype=torch.float32)


def test_rotations_are_rotations_and_stay_small() -> None:
    rotations = _random_rotations(torch, 200, torch.Generator().manual_seed(0), 15.0)
    identity = torch.eye(3).expand(200, 3, 3)
    assert torch.allclose(torch.bmm(rotations, rotations.transpose(1, 2)), identity, atol=1e-5)
    assert torch.allclose(torch.linalg.det(rotations), torch.ones(200), atol=1e-5)
    angles = torch.rad2deg(torch.arccos(((rotations.diagonal(dim1=1, dim2=2).sum(1) - 1) / 2).clamp(-1, 1)))
    assert float(angles.max()) <= 15.0 + 1e-3


def _only(monkeypatch, keep: str) -> None:
    """Switches off every augmentation but `keep`."""
    import label_trainer.nets as nets

    for name, off in (("ROTATION_DEG", 0.0), ("STRETCH", 0.0), ("SHIFT_STEPS", 0), ("SCALE", 0.0), ("NOISE", 0.0)):
        if name != keep:
            monkeypatch.setattr(nets, name, off)


def test_a_rotation_turns_each_sensors_axes_together_and_keeps_its_strength(monkeypatch) -> None:
    _only(monkeypatch, "ROTATION_DEG")
    model = _model()
    before = _windows()
    after = model._augment(before, torch.Generator().manual_seed(3))
    grid_before = before.reshape(-1, len(NAMES), STEPS)
    grid_after = after.reshape(-1, len(NAMES), STEPS)
    assert model.triplets == [[1, 2, 3], [4, 5, 6]]
    for triplet in model.triplets:
        assert torch.allclose(grid_before[:, triplet].norm(dim=1), grid_after[:, triplet].norm(dim=1), atol=1e-4)
    assert not torch.allclose(grid_before[:, 1:4], grid_after[:, 1:4])
    assert torch.equal(grid_before[:, 0], grid_after[:, 0])  # the pulse is not a vector: not turned


def test_shifting_carries_the_edge_value_on_instead_of_wrapping_round(monkeypatch) -> None:
    _only(monkeypatch, "SHIFT_STEPS")
    model = _model(["accel_x"])
    ramp = torch.arange(STEPS, dtype=torch.float32).expand(200, STEPS).clone()
    shifted = model._augment(ramp, torch.Generator().manual_seed(4))
    # Every row is still non-decreasing (a wrapped shift would put the end's high values at the start), within the range.
    assert bool((shifted[:, 1:] >= shifted[:, :-1]).all())
    assert float(shifted.min()) >= 0.0 and float(shifted.max()) <= STEPS - 1


def test_scaling_changes_the_swing_not_the_level(monkeypatch) -> None:
    _only(monkeypatch, "SCALE")
    model = _model()
    before = _windows()
    after = model._augment(before, torch.Generator().manual_seed(5))
    level_before = before.reshape(-1, len(NAMES), STEPS)[:, 0].mean(dim=1)
    level_after = after.reshape(-1, len(NAMES), STEPS)[:, 0].mean(dim=1)
    assert torch.allclose(level_before, level_after, rtol=1e-6)  # a 50,000 pulse level stays where it was
    swing = lambda t: t.reshape(-1, len(NAMES), STEPS)[:, 1].std(dim=1)  # noqa: E731
    assert not torch.allclose(swing(before), swing(after))
