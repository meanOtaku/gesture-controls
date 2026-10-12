"""How a model behaves as a detector over whole recordings, not window by window.

Window scores say little about use: what matters is whether each gesture is caught, how soon, and how often the model fires
when there is no gesture. So the held-out recordings are replayed as the desktop would see them live: windows slide across
the whole recording, label changes and all (`continuous_windows`), each is scored, and the scores go through the runtime's
own detection rule (`detect`, a copy of `TemporalDetector` in `crates/label-inference/src/detection.rs`; the shared cases in
`tests/fixtures/detection_cases.json` keep the two equal). The detections are then matched with the gestures in the labels
(`match_events`).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .windowing import MS_TO_NS, continuous_windows, labelled_spans  # noqa: F401 - re-exported for the trainer

# The runtime's release threshold sits this far under the activation threshold (see `write_bundle`).
RELEASE_GAP = 0.15
MIN_RELEASE = 0.05


@dataclass(frozen=True)
class Policy:
    """The runtime's detection rule (`model_lab_core::Thresholds`)."""

    activation: float
    release: float
    debounce_ms: int = 0
    cooldown_ms: int = 0

    @staticmethod
    def for_threshold(activation: float) -> "Policy":
        """What a trained model's manifest gives the runtime: no debounce or cooldown, release a little under activation."""
        return Policy(activation=activation, release=round(max(MIN_RELEASE, activation - RELEASE_GAP), 2))


def detect(times_ns: list[int] | np.ndarray, scores: list[float] | np.ndarray, policy: Policy) -> list[tuple[int, int | None]]:
    """The detections in a stream of scores, as (rising time, falling time or None if still on at the end).

    A detection rises when the score has stayed at or above the activation threshold for the debounce time, and not within
    the cooldown after the last one fell; it falls when the score drops below the release threshold."""
    detections: list[tuple[int, int | None]] = []
    active_since: int | None = None
    pending_since: int | None = None
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
            pending_since = None
            continue
        if last_fall is not None and at - last_fall < cooldown_ns:
            pending_since = None
            continue
        if pending_since is None:
            pending_since = at
        if at - pending_since >= debounce_ns:
            active_since, pending_since = at, None
    if active_since is not None:
        detections.append((active_since, None))
    return detections


def _covered_ns(spans: list[tuple[int, int]], low: int, high: int) -> int:
    """How much of [low, high] the union of `spans` covers."""
    total, reach = 0, low
    for start, end in sorted(spans):
        start, end = max(start, reach), min(end, high)
        if end > start:
            total += end - start
            reach = end
    return total


def match_events(
    detections: list[tuple[int, int | None]],
    gestures: list[tuple[int, int]],
    ignored: list[tuple[int, int]],
    observed: list[tuple[int, int]],
    window_ms: float,
) -> dict:
    """Matches detections with the gestures in the labels.

    A gesture is caught by the first detection that rises from its start until one window after its end (a window that
    ends that late still holds part of it). Another detection in that span is a repeat. A detection that rises anywhere
    else is a false activation, unless it is within an ignored (excluded) label's span, which counts neither way. The time
    in which a false activation could happen is the observed time (where windows were scored) outside both."""
    tail_ns = int(round(window_ms * MS_TO_NS))
    gesture_spans = [(start, end + tail_ns) for start, end in gestures]
    ignored_spans = [(start, end + tail_ns) for start, end in ignored]
    caught: dict[int, int] = {}
    repeats = 0
    false_activations = 0
    for rise, _ in detections:
        inside = [i for i, (start, end) in enumerate(gesture_spans) if start <= rise <= end]
        if inside:
            if inside[0] in caught:
                repeats += 1
            else:
                caught[inside[0]] = rise
            continue
        if any(start <= rise <= end for start, end in ignored_spans):
            continue
        false_activations += 1
    observed_ns = sum(end - start for start, end in observed)
    busy_ns = sum(_covered_ns(gesture_spans + ignored_spans, start, end) for start, end in observed)
    latencies = [(caught[i] - gestures[i][0]) / MS_TO_NS for i in sorted(caught)]
    return {
        "gestures": len(gestures),
        "caught": len(caught),
        "repeats": repeats,
        "falseActivations": false_activations,
        "latenciesMs": latencies,
        "negativeNs": max(observed_ns - busy_ns, 0),
    }


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
