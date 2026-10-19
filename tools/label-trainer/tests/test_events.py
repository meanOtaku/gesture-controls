"""The detection rule a model's scores go through, the same in the trainer's replay and in the runtime.

`fixtures/detection_cases.json` holds score sequences with the detections `events.detect` finds in them; the runtime's
`TemporalDetector` (crates/label-inference) reads the same file and must find the same ones. Regenerate it after an intended
change with `DETECTION_FIXTURE_REGENERATE=1 uv run pytest tests/test_events.py`.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path


from label_trainer.events import Policy, detect

FIXTURE = Path(__file__).parent / "fixtures" / "detection_cases.json"
MS = 1_000_000


def test_a_detection_rises_at_the_activation_threshold_and_falls_below_the_release_one() -> None:
    times = [i * 100 * MS for i in range(8)]
    scores = [0.1, 0.85, 0.7, 0.65, 0.5, 0.9, 0.95, 0.9]
    assert detect(times, scores, Policy(0.8, 0.6)) == [(100 * MS, 400 * MS), (500 * MS, None)]


def test_debounce_and_cooldown_hold_back_a_rise() -> None:
    times = [i * 100 * MS for i in range(11)]
    scores = [0.9, 0.1, 0.9, 0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9]
    # A lone high score is not enough; one held for 200 ms is (rises at 400). After it falls at 500, high scores in the
    # 300 ms cooldown do not count, so the next run starts at 800 and rises 200 ms later.
    assert detect(times, scores, Policy(0.8, 0.6, debounce_ms=200, cooldown_ms=300)) == [(400 * MS, 500 * MS), (1_000 * MS, None)]


def _detection_cases() -> list[dict]:
    rng = random.Random(20261011)
    cases = []
    for index in range(16):
        policy = Policy(
            activation=rng.choice([0.5, 0.7, 0.8, 0.9]),
            release=0.0,
            debounce_ms=rng.choice([0, 0, 150, 400]),
            cooldown_ms=rng.choice([0, 0, 300, 1000]),
        )
        policy = Policy(policy.activation, round(policy.activation - rng.choice([0.0, 0.1, 0.3]), 2), policy.debounce_ms, policy.cooldown_ms)
        times, scores, at, level = [], [], 1_000 * MS, rng.random()
        for _ in range(rng.choice([20, 60, 120])):
            at += rng.choice([100, 150, 200]) * MS
            level = min(1.0, max(0.0, level + rng.gauss(0, 0.25)))
            times.append(at)
            scores.append(round(level, 4))
        found = detect(times, scores, policy)
        cases.append({
            "name": f"random_{index}",
            "policy": {"activation": policy.activation, "release": policy.release, "debounceMs": policy.debounce_ms, "cooldownMs": policy.cooldown_ms},
            "timesNs": times,
            "scores": scores,
            "detections": [[rise, fall] for rise, fall in found],
        })
    return cases


def test_the_shared_detection_cases_still_hold() -> None:
    cases = _detection_cases()
    if os.environ.get("DETECTION_FIXTURE_REGENERATE"):
        FIXTURE.write_text(json.dumps({"cases": cases}, indent=1) + "\n")
    stored = json.loads(FIXTURE.read_text())["cases"]
    assert stored == json.loads(json.dumps(cases))
    assert sum(len(case["detections"]) for case in stored) > 20, "the cases exercise many rises and falls"
