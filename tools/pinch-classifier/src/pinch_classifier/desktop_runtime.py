"""Desktop-owned LiteRT pinch inference state machine.

Sensor devices send raw timestamped data; callers perform feature fusion using the
exported contract and submit its ordered 55-value feature vectors here.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .bundle import CLASS_NAMES, METADATA_FILENAME, MODEL_FILENAME, validate_metadata
from .features import FEATURE_NAMES


@dataclass(frozen=True)
class PinchTransition:
    phase: str  # started | held | released
    confidence: float
    timestamp_ns: int
    model_id: str


class DesktopPinchRuntime:
    """Fail-closed desktop state machine around a validated LiteRT bundle."""

    def __init__(self, bundle_dir: Path, on_transition: Callable[[PinchTransition], None],
                 start_threshold: float = 0.80, release_threshold: float = 0.80) -> None:
        metadata = json.loads((bundle_dir / METADATA_FILENAME).read_text(encoding="utf-8"))
        validate_metadata(metadata, bundle_dir)
        if metadata["feature_contract"]["ordered_names"] != list(FEATURE_NAMES):
            raise ValueError("model feature contract does not match desktop feature pipeline")
        if not (0.0 < start_threshold <= 1.0 and 0.0 < release_threshold <= 1.0):
            raise ValueError("thresholds must be in (0, 1]")
        try:
            import tensorflow as tf
        except ImportError as exc:
            raise RuntimeError("desktop inference requires pinch-classifier[tensorflow]") from exc
        self._interpreter = tf.lite.Interpreter(model_path=str(bundle_dir / MODEL_FILENAME))
        self._interpreter.allocate_tensors()
        self._input = self._interpreter.get_input_details()[0]
        self._output = self._interpreter.get_output_details()[0]
        self._on_transition = on_transition
        self._model_id = metadata["model"]["sha256"]
        self._start_threshold = start_threshold
        self._release_threshold = release_threshold
        self._active = False

    def reset(self, timestamp_ns: int) -> None:
        if self._active:
            self._emit("released", 1.0, timestamp_ns)
        self._active = False

    def submit(self, features: np.ndarray | list[float], timestamp_ns: int) -> None:
        """Infer one desktop-fused feature window; invalid input fails closed."""
        try:
            values = np.asarray(features, dtype=np.float32).reshape(1, -1)
            if values.shape != (1, len(FEATURE_NAMES)) or not np.isfinite(values).all():
                raise ValueError("invalid feature vector")
            self._interpreter.set_tensor(self._input["index"], values)
            self._interpreter.invoke()
            probabilities = self._interpreter.get_tensor(self._output["index"])[0]
            if probabilities.shape != (len(CLASS_NAMES),) or not np.isfinite(probabilities).all():
                raise ValueError("invalid model output")
            negative, started, released = (float(value) for value in probabilities)
            if not self._active and started >= self._start_threshold and started > max(negative, released):
                self._active = True
                self._emit("started", started, timestamp_ns)
            elif self._active and released >= self._release_threshold and released > max(negative, started):
                self._active = False
                self._emit("released", released, timestamp_ns)
            elif self._active:
                self._emit("held", max(0.0, 1.0 - released), timestamp_ns)
        except Exception:
            self.reset(timestamp_ns)

    def _emit(self, phase: str, confidence: float, timestamp_ns: int) -> None:
        self._on_transition(PinchTransition(phase, float(np.clip(confidence, 0.0, 1.0)), max(0, int(timestamp_ns)), self._model_id))
