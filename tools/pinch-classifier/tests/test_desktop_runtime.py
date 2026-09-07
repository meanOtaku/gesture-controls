from __future__ import annotations

import json

import numpy as np
import pytest

tf = pytest.importorskip("tensorflow")

from pinch_classifier.desktop_runtime import DesktopPinchRuntime
from pinch_classifier.features import FEATURE_NAMES
from pinch_classifier.train_tflite import main as train_main

from .conftest import make_dataset_csv


@pytest.fixture(scope="module")
def bundle_dir(tmp_path_factory):
    """Trains one small real TFLite bundle and reuses it across this module's tests."""
    root = tmp_path_factory.mktemp("desktop_runtime_bundle")
    for index in range(4):
        make_dataset_csv(root, f"idle_{index}.csv", "idle", 80, start_ns=index * 10_000_000_000)
        make_dataset_csv(
            root, f"start_{index}.csv", "pinch_start", 80,
            start_ns=(index + 10) * 10_000_000_000, accel_bias=5.0,
        )
        make_dataset_csv(
            root, f"release_{index}.csv", "pinch_release", 80,
            start_ns=(index + 20) * 10_000_000_000, accel_bias=-5.0,
        )
    output = root / "bundle"
    assert train_main([
        "--input", str(root), "--output-dir", str(output),
        "--window-ms", "200", "--stride-ms", "100", "--test-size", "0.25",
        "--random-seed", "4", "--epochs", "2", "--batch-size", "16",
    ]) == 0
    return output


class _FakeInterpreter:
    """Replaces the real LiteRT interpreter so state-machine logic can be
    driven by exact, deterministic probability vectors rather than depending
    on a real model's (nondeterministic-ish) predictions."""

    def __init__(self) -> None:
        self.next_output: np.ndarray | None = None
        self.last_input: np.ndarray | None = None

    def set_tensor(self, _index: int, value: np.ndarray) -> None:
        self.last_input = value

    def invoke(self) -> None:
        pass

    def get_tensor(self, _index: int) -> np.ndarray:
        if self.next_output is None:
            raise RuntimeError("no fake output queued")
        return self.next_output.reshape(1, -1)


def _make_runtime(bundle_dir, **kwargs) -> tuple[DesktopPinchRuntime, list, _FakeInterpreter]:
    transitions: list = []
    runtime = DesktopPinchRuntime(bundle_dir, transitions.append, **kwargs)
    fake = _FakeInterpreter()
    runtime._interpreter = fake  # noqa: SLF001 - swap in a deterministic double for the state-machine tests
    return runtime, transitions, fake


def test_rejects_mismatched_feature_contract(bundle_dir, tmp_path):
    mismatched = tmp_path / "mismatched"
    mismatched.mkdir()
    metadata = json.loads((bundle_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata["feature_contract"]["ordered_names"] = list(FEATURE_NAMES[:-1]) + ["bogus_feature"]
    (mismatched / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (mismatched / "model.tflite").write_bytes((bundle_dir / "model.tflite").read_bytes())

    with pytest.raises(ValueError, match="feature_contract"):
        DesktopPinchRuntime(mismatched, lambda _t: None)


@pytest.mark.parametrize("start_threshold,release_threshold", [(0.0, 0.8), (0.8, 1.5), (-0.1, 0.8)])
def test_rejects_out_of_range_thresholds(bundle_dir, start_threshold, release_threshold):
    with pytest.raises(ValueError, match="thresholds must be in"):
        DesktopPinchRuntime(
            bundle_dir, lambda _t: None,
            start_threshold=start_threshold, release_threshold=release_threshold,
        )


def test_submit_fails_closed_on_invalid_feature_vector(bundle_dir):
    runtime, transitions, _fake = _make_runtime(bundle_dir)
    runtime.submit(np.zeros(len(FEATURE_NAMES) - 1, dtype=np.float32), timestamp_ns=1)
    assert transitions == []
    assert runtime._active is False  # noqa: SLF001


def test_submit_fails_closed_and_emits_release_when_active_on_bad_input(bundle_dir):
    runtime, transitions, fake = _make_runtime(bundle_dir)
    fake.next_output = np.array([0.0, 0.9, 0.1], dtype=np.float32)
    runtime.submit(np.zeros(len(FEATURE_NAMES), dtype=np.float32), timestamp_ns=1)
    assert runtime._active is True  # noqa: SLF001

    fake.next_output = None  # NaN input is rejected before reaching the interpreter => fail closed
    runtime.submit(np.full(len(FEATURE_NAMES), np.nan, dtype=np.float32), timestamp_ns=2)
    assert runtime._active is False  # noqa: SLF001
    assert transitions[-1].phase == "released"
    assert transitions[-1].confidence == 1.0


def test_full_start_hold_release_cycle(bundle_dir):
    runtime, transitions, fake = _make_runtime(
        bundle_dir, start_threshold=0.7, release_threshold=0.6,
    )
    zeros = np.zeros(len(FEATURE_NAMES), dtype=np.float32)

    fake.next_output = np.array([0.1, 0.8, 0.1], dtype=np.float32)
    runtime.submit(zeros, timestamp_ns=10)

    fake.next_output = np.array([0.2, 0.3, 0.5], dtype=np.float32)  # released < threshold, still active => held
    runtime.submit(zeros, timestamp_ns=20)

    fake.next_output = np.array([0.1, 0.1, 0.8], dtype=np.float32)
    runtime.submit(zeros, timestamp_ns=30)

    assert [t.phase for t in transitions] == ["started", "held", "released"]
    assert transitions[0].confidence == pytest.approx(0.8)
    assert transitions[0].timestamp_ns == 10
    assert transitions[2].confidence == pytest.approx(0.8)
    assert all(t.model_id == runtime._model_id for t in transitions)  # noqa: SLF001


def test_submit_ignores_sub_threshold_start(bundle_dir):
    runtime, transitions, fake = _make_runtime(bundle_dir, start_threshold=0.9)
    fake.next_output = np.array([0.2, 0.75, 0.05], dtype=np.float32)
    runtime.submit(np.zeros(len(FEATURE_NAMES), dtype=np.float32), timestamp_ns=1)
    assert transitions == []
    assert runtime._active is False  # noqa: SLF001


def test_reset_emits_release_only_when_active(bundle_dir):
    runtime, transitions, fake = _make_runtime(bundle_dir)
    runtime.reset(timestamp_ns=5)
    assert transitions == []

    fake.next_output = np.array([0.0, 0.9, 0.1], dtype=np.float32)
    runtime.submit(np.zeros(len(FEATURE_NAMES), dtype=np.float32), timestamp_ns=6)
    assert runtime._active is True  # noqa: SLF001

    runtime.reset(timestamp_ns=7)
    assert runtime._active is False  # noqa: SLF001
    assert transitions[-1].phase == "released"
    assert transitions[-1].timestamp_ns == 7
