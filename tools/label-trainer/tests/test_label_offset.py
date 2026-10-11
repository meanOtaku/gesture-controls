"""Moving the labels in time: when the camera marks a pinch, the label can sit a fraction of a second away from the signal."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from label_trainer import label_train as lt
from label_trainer.csv_io import load_recording, shift_labels
from label_trainer.schema import HEADER_COLUMNS


def session(directory: Path, rid: str, *, seed: int, level: float, lag_s: float, seconds: float = 70.0) -> Path:
    """Pulse and motion rows at 50 Hz. A "pinch" label runs for about 1.5 s with about 1 s of rest between; the pulse level
    rises by 3000 only `lag_s` after the label begins and falls `lag_s` after it ends (the label leads the signal)."""
    rng = np.random.default_rng(seed)
    rows, intervals, t = int(seconds * 50), [], 0.5
    while t < seconds - 2:
        length = rng.uniform(1.2, 1.8)
        intervals.append((t, t + length))
        t += length + rng.uniform(0.8, 1.2)
    lines = ["# gesture-dataset-export: 1", "# label: pinch", ",".join(HEADER_COLUMNS)]
    for row in range(rows):
        now = row / 50
        label = "pinch" if any(a <= now < b for a, b in intervals) else "idle"
        signal = any(a + lag_s <= now < b + lag_s for a, b in intervals)
        if row % 3 == 0:
            value = level + (3000.0 if signal else 0.0) + rng.normal(0, 150.0)
            ppg = [f"{value:.1f}"] * 3
            lines.append(",".join([str(row * 20_000_000), str(row), *ppg, *([""] * 10), "0", label]))
        else:
            lines.append(",".join([str(row * 20_000_000), str(row), "", "", "", *[f"{v:.4f}" for v in rng.normal(0, 0.3, 10)], "", label]))
    path = directory / f"{rid}.csv"
    path.write_text("\n".join(lines) + "\n")
    return path


def spec(tmp_path: Path, lag_s: float = 0.5, **over) -> dict:
    levels = {"a": 90_000.0, "b": 20_000.0, "c": 150_000.0, "d": 60_000.0}
    recordings = {rid: str(session(tmp_path, rid, seed=i, level=level, lag_s=lag_s)) for i, (rid, level) in enumerate(levels.items())}
    return {
        "version": 1, "target": "pinch", "negatives": ["idle"], "excludes": [], "recordings": recordings,
        "train": ["a", "b"], "evaluation": ["c", "d"], "sources": ["watchPpg"], "baselineMs": 2000,
        "features": ["ppg_green_rel_low", "ppg_red_rel_low", "ppg_ir_rel_low"], "window": {"windowMs": 500, "strideMs": 150, "maxGapMs": 250, "minSamples": 3},
        "backend": "logreg", "seed": 7, **over,
    }


def test_the_label_a_row_has_is_the_one_the_recording_had_that_long_before(tmp_path: Path) -> None:
    recording = load_recording(session(tmp_path, "a", seed=1, level=1000.0, lag_s=0.0))
    labels = recording.raw_labels
    later = shift_labels(recording, 500)  # 25 rows at 50 Hz
    assert list(later.raw_labels[25:]) == list(labels[:-25])
    assert set(later.raw_labels[:25]) == {labels[0]}  # nothing before the start to take a label from
    earlier = shift_labels(recording, -500)
    assert list(earlier.raw_labels[:-25]) == list(labels[25:]) and set(earlier.raw_labels[-25:]) == {labels[-1]}
    assert shift_labels(recording, 0) is recording
    assert np.array_equal(later.timestamps_ns, recording.timestamps_ns) and np.array_equal(later.channels["ppg_green"], recording.channels["ppg_green"])


def test_an_offset_outside_the_limit_or_not_a_whole_number_is_refused(tmp_path: Path) -> None:
    for bad in (1501, -1501, 250.5, "250", True):
        with pytest.raises(lt.TrainingRefused, match="label offset"):
            lt.parse_spec(spec(tmp_path, labelOffsetMs=bad))
    assert lt.parse_spec(spec(tmp_path, labelOffsetMs=-1500)).label_offset_ms == -1500
    assert lt.parse_spec(spec(tmp_path)).label_offset_ms == 0


def test_training_with_the_offset_that_matches_the_lag_scores_better_on_recordings_it_never_saw(tmp_path: Path) -> None:
    pytest.importorskip("onnxruntime")
    aucs = {}
    for offset in (0, 500):
        out = tmp_path / f"run{offset}"
        result = lt.run(spec(tmp_path, labelOffsetMs=offset), out)
        assert result["outcome"] in ("deployable", "evaluationOnly"), result["message"]
        aucs[offset] = result["metrics"]["rocAuc"]
        if result["outcome"] == "deployable":  # only a model that is shipped has a manifest
            assert json.loads((out / "bundle" / "manifest.json").read_text())["provenance"]["labelOffsetMs"] == offset
    assert aucs[500] > aucs[0] + 0.03, aucs


def test_looking_for_the_best_timing_finds_the_lag_and_is_judged_on_recordings_left_out(tmp_path: Path, capsys) -> None:
    scores = lt.suggest_label_offset(spec(tmp_path, lag_s=0.5))
    best = max(scores, key=lambda s: s["auc"])
    assert best["offsetMs"] in (250, 500, 750), scores
    assert next(s for s in scores if s["offsetMs"] == 0)["auc"] < best["auc"] - 0.03
    assert [s["offsetMs"] for s in scores] == list(lt.OFFSET_CANDIDATES_MS)
    assert all(s["windows"] > 0 for s in scores)
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec(tmp_path, lag_s=0.5)))
    assert lt.main(["--spec", str(spec_path), "--suggest-offset"]) == 0
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert printed["outcome"] == "ok" and len(printed["scores"]) == len(lt.OFFSET_CANDIDATES_MS)
