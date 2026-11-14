# Pinch-start CNN v2: phase 1 (offline experiments)

A new variant of the pinch-start model, developed here without touching Model Lab or the active model
(`pinch_in-ae0a22bf`). Phase 1 tests ideas offline on one fixed benchmark. Phase 2 will port the winner as a new model
type in Model Lab, beside the current CNN. Background: [`../../live-misses-2026-11.md`](../../live-misses-2026-11.md).

## The benchmark (`bench.py`)

One split by session, so that no test pinch, and no window overlapping one, is ever trained on. The test recordings are
unseen by `ae0a22bf` too, so it is a fair reference.

| Set | Recordings | Measures |
|---|---|---|
| Train | `ae0a22bf`'s 20 training recordings; 13 Nov live session 2 (08:12); 14 Nov noise 09:58 (20 min) | |
| Test: live | 13 Nov live session 1 (07:29 and 07:30 windows), 20 pinches | real-use pinches, the hard case |
| Test: moving | the five 9 Nov sessions, 102 pinches | pinches with the arm moving |
| Test: resting | `ae0a22bf`'s 3 held-out pinch recordings, 57 pinches | the easy case |
| Test: everyday | 14 Nov noise 10:29 (27 min) and 4 Nov everyday (10 min) | false activations per hour |
| Test: still | 2 still and 2 supported recordings (15 min) | false activations at rest |
| Left out | live windows overlapping a test window; the 4 Nov `new/` session (automatic labels only) | |

Scoring is the trainer's own: its CNN training moments (`label_train.cnn_examples`), its detection rule and its event
accounting (`label_train.detections`: a start is caught by an event 300–900 ms after it). Each model's headline threshold
is chosen **without the test set**: four models trained out of fold on the training recordings score them, and the
trainer's budget rule (`label_train.budget_threshold`) picks the cut-off. Every result also lists a full sweep.

Inputs are cached in `~/Library/Caches/gesture-controls-pinch-bench` (set `BENCH_CACHE` to move it). Results go to
`results/<name>.md` and `.json`.

## Running

```bash
# references: a trained bundle, with the trainer it was trained with
TRAINER_SRC=<trainer src> tools/label-trainer/.venv/bin/python docs/research/artifacts/pinch-cnn-v2-2026-11/ref_bundle.py <bundle> <name>
# MiniRocket (aeon needs Python <= 3.13)
uv run --isolated --no-project --python 3.13 --with aeon --with torch --with scikit-learn \
    python docs/research/artifacts/pinch-cnn-v2-2026-11/exp_minirocket.py 4000 100
```

`ae0a22bf` needs the trainer at `c924661` (`git archive c924661 tools/label-trainer/src | tar -x -C <dir>`).

## Plan (fastest first)

1. MiniRocket on the current inputs (minutes, no GPU).
2. The current CNN with new inputs: jerk and jerk envelope, orientation-independent channels, smoothing before 100 Hz.
3. Augmentation: time and magnitude warping, small rotations, recorded everyday wrist motion overlaid on pinches.
4. Per-sensor branches (accelerometer, gyroscope, pulse), joined partway and at the end.
5. InceptionTime.
6. Ensembles of the best (50 + 100 Hz, seeds); peak gating in front of the winner.

## Results

What the experiments show: [`FINDINGS.md`](FINDINGS.md). All tables: [`RESULTS.md`](RESULTS.md) (regenerate with `tools/label-trainer/.venv/bin/python summarize.py`; it needs numpy).
