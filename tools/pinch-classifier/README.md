# pinch-classifier

Offline training package for the `pinch_start` / `pinch_release` gesture
classifier (Milestone 10, slice 1). This slice trains and evaluates a
scikit-learn `RandomForestClassifier` baseline from CSV exports produced by
the Milestone 9 desktop dataset recorder. **It does not export TFLite or
LiteRT models** — see [TFLite/LiteRT export](#tflitelitert-export) below.

## Setup

Requires Python >=3.11.

```bash
cd tools/pinch-classifier
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Running tests

```bash
pytest
```

## Training

```bash
pinch-classifier-train --input session1.csv session2.csv ... --output-dir artifacts/
```

`--input` accepts individual CSV files, directories (all `*.csv` inside are
used), or a mix of both. Useful flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--window-ms` | 500 | Window duration in milliseconds |
| `--stride-ms` | 150 | Window stride in milliseconds (overlap = window-ms - stride-ms) |
| `--max-gap-ms` | 250 | Max gap between samples before a session is split into segments |
| `--min-samples-per-window` | 3 | Minimum raw rows required to keep a window |
| `--hold-handling` | `exclude` | How to treat `pinch_hold` rows: `exclude`, `negative`, or `class` (see below) |
| `--test-size` | 0.25 | Fraction of sessions (groups) held out for evaluation |
| `--random-seed` | 42 | Random seed for the split and the classifier |
| `--n-estimators` | 200 | Number of trees in the RandomForest |

Run `pinch-classifier-train --help` for the full list.

## CSV contract

Input files must match the Milestone 9 dataset-recorder export contract
exactly, mirrored in `src/pinch_classifier/schema.py` (source of truth:
`apps/desktop/src/features/telemetry/store/telemetryStore.ts`,
`DATASET_CSV_COLUMNS` / `GESTURE_DATASET_LABELS` / `generateDatasetCsv`):

- Optional leading comment lines starting with `#` (metadata), then one
  header line, then data rows.
- Header must equal, in order:
  `timestamp_ns,sequence,ppg_green,ppg_red,ppg_ir,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,quat_w,quat_x,quat_y,quat_z,contact_quality,label`
- `timestamp_ns` must be non-decreasing row-to-row (recording order).
- `label` must be one of the recorder's known labels (`idle`, `pinch_start`,
  `pinch_hold`, `pinch_release`, `walking`, `typing`, `using_mouse`,
  `touching_face`, `adjusting_headphones`, `picking_up_cup`, `scratching`,
  `normal_wrist_rotation`, `standing`, `sitting`).
- Numeric sensor columns may be blank; blanks are carry-forward filled from
  the last known value in that column (leading blanks fall back to `0.0`).
- Each CSV file is treated as one recording session, labeled uniformly for
  the whole file, and its filename stem becomes the `session_id`.

A file that doesn't match this contract fails to load with a `CsvFormatError`
instead of silently producing bad training data.

## Grouping rule

Evaluation is a **grouped holdout by CSV file (session)**: `GroupShuffleSplit`
splits on `session_id`, so every window from a given file lands entirely in
train or entirely in test — never both. This means reported metrics reflect
generalization to an unseen *recording*, not just an unseen window sampled
from a recording the model already trained on. Training requires at least 2
distinct sessions; with only one, `--test-size` has nothing to hold out and
the CLI exits with an error.

`--hold-handling` controls what happens to `pinch_hold` rows before the
split:

- `exclude` (default): dropped entirely, not trained on, not evaluated.
- `negative`: folded into the negative class (a held pinch must not look
  like a false activation of start/release).
- `class`: trained and evaluated as its own explicit class.

## Artifacts

Each run writes two files to `--output-dir`:

- `model.joblib` — the fitted `RandomForestClassifier`, loadable with
  `joblib.load`.
- `model_card.json` — run metadata: package/sklearn/numpy versions, the
  window config, `hold_handling`, the ordered `feature_names` contract,
  input files, session split (`groups_train` / `groups_test`), and the full
  `metrics` block (see below).

## False-activation metrics

Because false positives on `pinch_start`/`pinch_release` (or `pinch_hold`
under `--hold-handling class`) matter more here than raw accuracy, the model
card's `metrics` includes, alongside `accuracy`, `macro_f1`,
`classification_report`, and `confusion_matrix`:

- `false_activation_count` — number of *negative* (non-pinch) test windows
  the model predicted as a positive/activation class.
- `false_activation_total_negative_windows` — total negative windows in the
  test set (the denominator).
- `false_activation_rate` — `false_activation_count / false_activation_total_negative_windows`,
  or `null` if the test set contained no negative windows.

## TFLite/LiteRT export

This slice trains and evaluates the scikit-learn baseline only. It does
**not** convert or export a TFLite/LiteRT model — `model_card.json`'s
`tflite_export` field says so explicitly (`"not yet implemented — this
slice only trains and evaluates the scikit-learn baseline"`). On-device
conversion is a later milestone step, out of scope here.
