# label-trainer

[The pinch models](../../docs/architecture/pinch-models.md) explains the trees and the CNN side by side, and how to train on
another machine, including an older NVIDIA card. `python -m label_trainer.gpu_check` says what a machine will train on.

Offline training of **one model for one label**: the PPG pinch-start model. The desktop app runs it when you train a model
in Model Lab, and imports the bundle it writes.

The model, chosen by the October 2026 PPG research
([`docs/research/artifacts/ppg-benchmark-2026-10/ppg-multiscale-zscore`](../../docs/research/artifacts/ppg-benchmark-2026-10/ppg-multiscale-zscore/report.md)):

```text
PPG (green, red, IR) -> causal z-score against the previous 1, 2 and 4 s -> causal cubic slope, curvature, jerk
-> 21 statistics over the last 8, 16 and 32 ticks (1,701 inputs) -> ExtraTrees (300 trees)
```

It reads only the pulse sensor and fires about 0.9 s after a gesture starts.

A spec with `"backend": "ppg-imu-cnn"` trains the **CNN** instead (`cnn.py`, research
[`double-pinch-2026-10`](../../docs/research/artifacts/double-pinch-2026-10/README.md) step 12): the last second of
motion and pulse on a 50 Hz grid, each channel z-scored against its last 10 s and put through a sigmoid (`cnn_input.py`,
450 inputs, mirrored by `crates/pinch-inference/src/cnn_input.rs` and kept equal by `tests/fixtures/cnn_input_cases.json`),
into three small dilated CNNs whose votes are averaged. It fires about 0.5 s after a gesture starts and is written as
`model.cnn` (JSON weights, read by `crates/label-inference/src/cnn.rs`). It needs PyTorch: `uv run --extra cnn ...`.

A spec with `"backend": "ppg-imu-cnn-v2"` trains the **v2 CNN** (`cnn_v2.py`, research
[`pinch-cnn-v2-2026-11`](../../docs/research/artifacts/pinch-cnn-v2-2026-11/FINDINGS.md)), a model type of its own beside
the CNN: the CNN's nine channels plus the accelerometer's jerk envelope (`cnn_input.inputs(..., envelope=True)`, 10 x 100
inputs at 100 Hz, mirrored by `cnn_input.rs`'s `inputs_v2`), one small branch network per sensor joined partway and at the
end, three networks averaged, trained with time and magnitude warping and with noise-overlay copies of the gesture
recordings (motion from the training everyday-noise recordings added to their raw accelerometer and gyroscope). A peak
gate in the manifest (`preprocessing.gate`) lets a decision score only after an accelerometer jerk spike in the last
600 ms (`cnn_input.spike`, at the level 90% of the training pinch moments reach), and the cut-off is chosen out of fold on
the no-gesture training recordings (`v2_threshold`). Written as `model.cnn` in the `ppg-imu-cnn-branches` format, read by
`crates/label-inference/src/cnn_branches.rs`; `tests/make_runtime_bundle.py cnn-v2` writes its runtime fixture.

The desktop decides everything that must be recorded and cannot change afterwards: which recordings train and which
evaluate (never the same one) and what each label in the data means (the target, negatives, or left out). It hands them to
this trainer in a `spec.json`.

## What it does

1. Reads the recordings named in the spec (Model Lab datasets, CSV with a `label` column; an empty label is time between
   gestures).
2. Picks the moments to learn from in each recording (`ppg_onset.sample_decisions`, the rules the research's events
   follow): a positive about 880 ms after each start of the target label, and as negatives the same moment after every other
   label's start, points inside holds, and unlabelled time at least 1.5 s from any hold.
3. Computes the 1,701 inputs of each moment (`ppg_onset.features`). `crates/pinch-inference/src/ppg_onset.rs` computes the
   same live; `tests/fixtures/ppg_onset_cases.json` keeps the two equal (regenerate with
   `uv run python tests/make_ppg_onset_cases.py` after an intended change).
4. Trains ExtraTrees with the research's settings (300 trees, at least 3 samples a leaf, 70% of the inputs per split).
5. Fits the decision threshold on the training recordings (each scored by a model trained without it), then evaluates on
   the held-out recordings: per moment, and replayed as a detector over each whole recording, at every pulse sample, through
   the runtime's own detection rule (`events.py`, kept equal to the runtime by `tests/fixtures/detection_cases.json`),
   counting starts caught (680 to 1,280 ms after they began for the trees; 100 to 900 ms for a CNN, `Spec.match_window_ms`), delay, and false activations per hour.
6. Writes the trees as `model.trees` (`trees.py`: plain node arrays, read by `crates/label-inference/src/trees.rs`), and
   checks the file reproduces the trained model to 1e-6.
7. Writes `bundle/` (manifest and model), `evaluation.json`, `inspection.json` and `result.json`. A model that does not pass
   the checks for going live is still written, as **evaluation only**: the desktop keeps it as monitor-only, so it can be
   activated but only ever reports.

A v2 CNN spec may name a model to continue from (`startFrom`: its `model.cnn`, name, cut-off and gate). `cnn_v2.load`
turns the file back into networks (its batch normalisation, folded into the convolutions, is set to pass values through
and kept frozen), and they train on for `CONTINUE_EPOCHS` passes at `CONTINUE_LEARNING_RATE_SCALE` of the learning rate,
the cut-off folds included. The desktop keeps the recordings that model trained on out of the test, and the trainer
replays it, as it runs, on the same held-out recordings (`metrics.startedFrom`) for the side-by-side; the bundle's
provenance says what it continued from (`continuedFrom`).

A v2 CNN spec may name several `gestures` (the target first): `multi_gesture.run_multi` trains one network with an
output for nothing and each gesture (softmax; the file names them, `"outputs"`), chooses each gesture's cut-off on its
folds as `v2_threshold` does, and writes, for each, what a one-gesture run writes under `gestures/<label>/` (its
bundle's manifest reads its own output, `positiveIndex`), and in `result.json` the outcome of each and the confusion
matrices (`confusion`: `events`, played through as the runtime runs; `moments`, each held-out decision).

`tests/make_runtime_bundle.py` writes the bundle the runtime's tests load, with a pulse trace and the probability the
trainer gives each of its samples.

## Running it

The desktop starts it for you (`uv run --project tools/label-trainer label-classifier-train`, with `--extra cnn` for the
CNN). By hand:

```bash
cd tools/label-trainer
uv run label-classifier-train --spec spec.json --out run-dir
```

`--suggest-offset` instead tries a range of label offsets and says how well the recordings separate the gesture's starts
at each, judged on recordings left out.
