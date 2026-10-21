"""How a model behaves as a detector over whole recordings, not decision by decision.

`detect` is a copy of the runtime's `TemporalDetector` (crates/label-inference/src/detection.rs); the shared cases in
`tests/fixtures/detection_cases.json` keep the two equal. The trainer replays held-out recordings through it and matches the
detections with the gestures' starts (`label_train.replay`), then totals them with `summarise`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MS_TO_NS = 1_000_000


@dataclass(frozen=True)
class Policy:
    """The runtime's detection rule (`model_lab_core::Thresholds`)."""

    activation: float
    release: float
    debounce_ms: int = 0
    cooldown_ms: int = 0
    # "edge": rise when the score reaches the activation threshold (held for the debounce time). "peak": rise on the first
    # score that is lower than the one before it, while both are at or above the activation threshold, so a detection
    # comes at the top of the score's climb rather than on its way up (the debounce is not used).
    trigger: str = "edge"


def detect(times_ns: list[int] | np.ndarray, scores: list[float] | np.ndarray, policy: Policy) -> list[tuple[int, int | None]]:
    """The detections in a stream of scores, as (rising time, falling time or None if still on at the end).

    A detection rises when the score has stayed at or above the activation threshold for the debounce time (or, with the
    peak trigger, when it first falls back while still at or above it), and not within the cooldown after the last one
    fell; it falls when the score drops below the release threshold."""
    if policy.trigger not in ("edge", "peak"):
        raise ValueError(f"unknown trigger {policy.trigger!r}")
    detections: list[tuple[int, int | None]] = []
    active_since: int | None = None
    pending_since: int | None = None
    previous: float | None = None
    last_fall: int | None = None
    debounce_ns = policy.debounce_ms * MS_TO_NS
    cooldown_ns = policy.cooldown_ms * MS_TO_NS
    for at, score in zip((int(t) for t in times_ns), (float(s) for s in scores)):
        if active_since is not None:
            if score < policy.release:
                detections.append((active_since, at))
                active_since, last_fall = None, at
            continue
        if score < policy.activation:
            pending_since = previous = None
            continue
        if last_fall is not None and at - last_fall < cooldown_ns:
            pending_since = previous = None
            continue
        if policy.trigger == "peak":
            if previous is not None and score < previous:
                active_since, previous = at, None
            else:
                previous = score
            continue
        if pending_since is None:
            pending_since = at
        if at - pending_since >= debounce_ns:
            active_since, pending_since = at, None
    if active_since is not None:
        detections.append((active_since, None))
    return detections


def summarise(per_recording: list[dict]) -> dict:
    """The totals over every held-out recording."""
    gestures = sum(r["gestures"] for r in per_recording)
    caught = sum(r["caught"] for r in per_recording)
    false_activations = sum(r["falseActivations"] for r in per_recording)
    negative_seconds = sum(r["negativeNs"] for r in per_recording) / 1e9
    latencies = [latency for r in per_recording for latency in r["latenciesMs"]]
    return {
        "recordings": len(per_recording),
        "gestures": gestures,
        "caught": caught,
        "gestureRecall": caught / gestures if gestures else None,
        "repeats": sum(r["repeats"] for r in per_recording),
        "medianLatencyMs": float(np.median(latencies)) if latencies else None,
        "falseActivations": false_activations,
        "negativeSeconds": negative_seconds,
        "falseActivationsPerHour": false_activations / (negative_seconds / 3600.0) if negative_seconds > 0 else None,
    }
