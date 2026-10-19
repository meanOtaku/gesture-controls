# label-trainer

Offline training of **one model for one label**: the PPG pinch-start model. The desktop app runs it when you train a model
in Model Lab, and imports the bundle it writes.

The model, chosen by the October 2026 PPG research
([`docs/research/artifacts/ppg-benchmark-2026-10/ppg-multiscale-zscore`](../../docs/research/artifacts/ppg-benchmark-2026-10/ppg-multiscale-zscore/report.md)):

```text
PPG (green, red, IR) -> causal z-score against the previous 1, 2 and 4 s -> causal cubic slope, curvature, jerk
-> 21 statistics over the last 8, 16 and 32 ticks (1,701 inputs) -> ExtraTrees (300 trees)
```

It reads only the pulse sensor and fires about 0.9 s after a gesture starts. Every label is trained this way; there are no
other methods.

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
   counting starts caught (680 to 1,280 ms after they began), delay, and false activations per hour.
6. Writes the trees as `model.trees` (`trees.py`: plain node arrays, read by `crates/label-inference/src/trees.rs`), and
   checks the file reproduces the trained model to 1e-6.
7. Writes `bundle/` (manifest and model), `evaluation.json`, `inspection.json` and `result.json`. A model that does not pass
   the checks for going live is still written, as **evaluation only**: the desktop keeps it as monitor-only, so it can be
   activated but only ever reports.

`tests/make_runtime_bundle.py` writes the bundle the runtime's tests load, with a pulse trace and the probability the
trainer gives each of its samples.

## Running it

The desktop starts it for you (`uv run --project tools/label-trainer label-classifier-train`). By hand:

```bash
cd tools/label-trainer
uv run label-classifier-train --spec spec.json --out run-dir
```

`--suggest-offset` instead tries a range of label offsets and says how well the recordings separate the gesture's starts
at each, judged on recordings left out.
