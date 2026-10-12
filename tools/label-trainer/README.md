# label-trainer

Offline training of **one model for one label**. The desktop app runs it when you train a model in Model Lab, and imports the
ONNX bundle it writes. The folder keeps its original name; it no longer contains any three-class pinch tooling.

The desktop decides everything that must be recorded and cannot change afterwards: which recordings train and which
evaluate (never the same one), what each label in the data means (the target is positive, everything else is negative or left
out), the streams the model may read, and the window. It hands them to this trainer in a `spec.json`.

## What it does

1. Reads the recordings named in the spec (Model Lab datasets, CSV with a `label` column).
2. Builds windows (sliding across label changes, each labelled by how much of it the gesture covers) and the canonical features (55 statistics and 10 motion dynamics; 24 pulse-sensor spike features when a `spikeMethod` is set, one of `features.SPIKE_METHODS`; 12 level-against-the-past features when a `baselineMs` is), limited to the streams the model is allowed to read. The spike features are defined in `features.spike_features` and mirrored in `crates/pinch-inference`; `tests/fixtures/spike_cases.json` keeps the two equal (regenerate with `SPIKE_FIXTURE_REGENERATE=1 uv run pytest tests/test_spike_features.py` after an intended change).
3. Trains logistic regression, a small multilayer perceptron, a PyTorch network, or (`cnn1d`) a small 1D convolutional network over the window's grid of channels x steps (`grid.py`, parity-checked against the runtime by `tests/fixtures/grid_cases.json`; regenerate with `GRID_FIXTURE_REGENERATE=1 uv run pytest tests/test_grid.py`).
4. Fits the decision threshold on the training recordings (each scored by a model trained without it), then evaluates on
   the held-out recordings: per window, and replayed as a detector over each whole recording through the runtime's own
   detection rule (`events.py`), counting gestures caught, delay, and false activations per hour.
5. Exports ONNX built from plain dense layers, and checks the ONNX file reproduces the trained model to 1e-3.
6. Writes `bundle/` (manifest and model), `evaluation.json` and `result.json`. A model whose scores are not good enough is
   written as **evaluation only**: it can be reviewed but never activated.

## Running it

The desktop starts it for you (`uv run --project tools/label-trainer --extra onnx label-classifier-train`, plus
`--extra torch` for the PyTorch backend). By hand:

```bash
cd tools/label-trainer
uv run --extra onnx label-classifier-train --spec spec.json --out run-dir
```

## Comparing methods

```bash
uv run --extra onnx --extra torch label-classifier-train --compare --spec spec.json --out compare-dir
```

Trains every method (logistic regression, boosted trees, both neural networks, the convolutional network) on the spec's
recordings, split and settings, each with its own default inputs, and prints the numbers that matter side by side: AUC on
the test recordings, the cross-check AUC (how well the training recordings agree with each other), balanced accuracy,
false-alarm rate, Brier score, gestures caught and false activations per hour. Each run is kept in `compare-dir/<method>`
and the table in `compare-dir/compare.json`.

## Starting from a pre-trained motion encoder

A convolutional model can start its convolution layers from an encoder pre-trained on many people instead of from
nothing, then learn its head (and, unless frozen, adjust the layers) on your recordings. The encoder is trained on
[MicroDPad](https://huggingface.co/datasets/eth-siplab/microdpad) (65 people, 11 wrist micro-gestures and "nothing"),
read into the same grid of the six motion channels, in the watch's units, with the same augmentation; half its sessions
are smoothed the way watch builds before October 2026 smoothed motion.

```bash
uv run --extra onnx --extra torch --extra pretrain label-classifier-train \
    --pretrain-microdpad ../../data/external/microdpad --out ../../data/external/microdpad/encoders/motion-encoder.pt
```

Then add `"pretrained": "<that file>"` (and `"pretrainedFreeze": true` to keep its layers as they are) to a `cnn1d` spec
that reads acceleration and gyroscope only, with the encoder's window and steps (1000 ms, 32). Such a model always centres
each window on its own mean, as the encoder did.

**Licence.** MicroDPad is CC BY-NC-ND 4.0: non-commercial use, no derivatives distributed. Weights trained on it may count
as a derivative, so the encoder stays in `data/external` (git ignores it) and must not be committed, shared or shipped
with the app; a model fine-tuned from it is for use on this computer.

## Layout

| Module | Purpose |
|---|---|
| `label_train.py` | The trainer and its command line |
| `csv_io.py`, `schema.py` | Reading a recording's CSV and its exact column contract |
| `windowing.py`, `features.py` | Windows and the canonical features (the desktop computes the same ones while running) |
| `dataset.py`, `labels.py` | Turning recordings and a label mapping into training data |
| `pretrain.py` | Pre-training a motion encoder on MicroDPad (`--pretrain-microdpad`) |
| `compare.py` | Every method on the same recordings and split, side by side (`--compare`) |
| `events.py` | Replaying held-out recordings through the runtime's detection rule (`tests/fixtures/detection_cases.json` keeps it equal to `TemporalDetector`) |

The feature definitions are mirrored in `crates/pinch-inference` and `crates/label-inference`; the tests on each side keep
the two in step.

## Tests

```bash
uv run --extra dev --extra onnx pytest -q          # add --extra torch to include the PyTorch backend test
```
