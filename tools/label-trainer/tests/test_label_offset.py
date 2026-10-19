"""Moving the labels in time: when the camera marks a pinch, the label can sit a fraction of a second away from the signal."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from label_trainer import label_train as lt
from label_trainer.csv_io import load_recording, shift_labels

from .pulse_data import spec_for, write_pulse_recording


def test_the_label_a_row_has_is_the_one_the_recording_had_that_long_before(tmp_path: Path) -> None:
    recording = load_recording(write_pulse_recording(tmp_path, "a", seed=1, seconds=12.0))
    moved = shift_labels(recording, 400)
    first = int(np.flatnonzero(recording.raw_labels == "pinch")[0])
    later = int(np.flatnonzero(moved.raw_labels == "pinch")[0])
    assert recording.timestamps_ns[later] - recording.timestamps_ns[first] == pytest.approx(400e6, abs=45e6)


def test_an_offset_outside_the_limit_or_not_a_whole_number_is_refused(tmp_path: Path) -> None:
    spec = spec_for(tmp_path, train=1, evaluation=1, seconds=12.0)
    for offset in (1600, -1600, 0.5, True):
        with pytest.raises(lt.TrainingRefused, match="label offset"):
            lt.parse_spec({**spec, "labelOffsetMs": offset})


def test_looking_for_the_best_timing_finds_the_lag_and_is_judged_on_recordings_left_out(tmp_path: Path, capsys) -> None:
    # The labels are 500 ms late: moving them 500 ms earlier puts the starts where the signal changes.
    spec = spec_for(tmp_path, train=3, evaluation=1, lag_ms=500, seconds=40.0, step=150.0)
    scores = lt.suggest_label_offset(spec, candidates=(-500, 0, 500))
    best = max(scores, key=lambda s: s["auc"] or 0)
    assert best["offsetMs"] == -500 and best["auc"] > next(s["auc"] for s in scores if s["offsetMs"] == 0)
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(spec))
    lt.OFFSET_CANDIDATES_MS, saved = (0,), lt.OFFSET_CANDIDATES_MS
    try:
        assert lt.main(["--spec", str(path), "--suggest-offset"]) == 0
    finally:
        lt.OFFSET_CANDIDATES_MS = saved
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert printed["outcome"] == "ok" and printed["scores"]
