# label-trainer

Offline training of **one model for one label**. The desktop app runs it when you train a model in Model Lab, and imports the
ONNX bundle it writes. The folder keeps its original name; it no longer contains any three-class pinch tooling.

The desktop decides everything that must be recorded and cannot change afterwards: which recordings train and which
evaluate (never the same one), what each label in the data means (the target is positive, everything else is negative or left
out), the streams the model may read, and the window. It hands them to this trainer in a `spec.json`.

## What it does

1. Reads the recordings named in the spec (Model Lab datasets, CSV with a `label` column).
2. Builds windows and the 55 canonical features, limited to the streams the model is allowed to read.
3. Trains logistic regression, a small multilayer perceptron, or a PyTorch network.
4. Evaluates on the held-out recordings and fits the decision threshold there (the evaluation says so).
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

## Layout

| Module | Purpose |
|---|---|
| `label_train.py` | The trainer and its command line |
| `csv_io.py`, `schema.py` | Reading a recording's CSV and its exact column contract |
| `windowing.py`, `features.py` | Windows and the canonical features (the desktop computes the same ones while running) |
| `dataset.py`, `labels.py` | Turning recordings and a label mapping into training data |

The feature definitions are mirrored in `crates/pinch-inference` and `crates/label-inference`; the tests on each side keep
the two in step.

## Tests

```bash
uv run --extra dev --extra onnx pytest -q          # add --extra torch to include the PyTorch backend test
```
