# pinch-classifier

Offline training package for the Milestone 10 pinch classifier. It retains the
scikit-learn `RandomForestClassifier` baseline and adds a neural three-class
(`negative`, `pinch_start`, `pinch_release`) path that exports a validated
TFLite/LiteRT deployment bundle from Milestone 9 CSV recordings.

## Setup

Requires Python >=3.11.

```bash
cd tools/pinch-classifier
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"              # baseline and tests
pip install -e ".[dev,tensorflow]"   # also train/export TFLite
```

## Performance notes

Dataset building is vectorized and benchmarked in
[`docs/performance.md`](../../docs/performance.md) (100,000 rows in about one second). The
vectorized loader, windowing, carry-forward and feature extraction are required to be
**bit-identical** to the original loops, which are kept as `tests/reference_impl.py`;
`tests/test_optimized_equivalence.py` enforces it. If you change feature extraction, update
the production code and the reference together, deliberately: a change to a feature value is a
change to every trained model.

## Running tests

```bash
uv run --with pytest pytest tests -q        # or `pytest` inside an activated venv
```

The TensorFlow conversion tests skip unless the `tensorflow` extra is installed. CI does
not run this suite yet, so run it before changing the bundle contract, the label
mapping, windowing or feature extraction.

## Baseline training (scikit-learn)

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

Run `pinch-classifier-train --help` for the full list. This existing path is
unchanged and continues to write `model.joblib` and `model_card.json`.

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
- Every row must carry a non-empty `label`. A label outside the recorder's legacy
  vocabulary (`idle`, `pinch_start`, `pinch_hold`, `pinch_release`, `walking`,
  `typing`, `using_mouse`, `touching_face`, `adjusting_headphones`,
  `picking_up_cup`, `scratching`, `normal_wrist_rotation`, `standing`, `sitting`) needs
  an explicit training role from `--label-mapping-file`; without one the run is
  rejected rather than treating the label as negative.
- Numeric sensor columns may be blank; blanks are carry-forward filled from
  the last known value in that column (leading blanks fall back to `0.0`).
- Each CSV file is treated as one recording session and its filename stem becomes
  the `session_id` (the unit the train/test split holds out). A file may carry one
  label throughout (Quick Capture) or several (Timeline Capture); windows never cross a
  label boundary. The desktop's Model Lab importer prepares a Timeline Capture export
  for this loader by dropping the unlabeled gap rows, so the loader itself still
  requires a label on every row.

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

## Neural TFLite/LiteRT training and export

Install the optional TensorFlow dependency and run:

```bash
pinch-classifier-train-tflite \
  --input session1.csv session2.csv recordings/ \
  --output-dir artifacts/pinch-tflite
```

The command uses the same CSV parser, 55-feature contract, windowing, and
session-grouped holdout as the baseline. `pinch_hold` windows are excluded so
the deployment output always has exactly these ordered output probabilities:

1. `negative`
2. `pinch_start`
3. `pinch_release`

The small Keras MLP embeds a `Normalization` layer fitted only on training
sessions, then converts it to float32 TFLite. Training requires that the
training side of the grouped split contain all three classes. If it does not,
add recording sessions or adjust `--random-seed`/`--test-size`; the command
fails rather than exporting an incomplete classifier.

Useful neural flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--epochs` | 30 | Neural training epochs |
| `--batch-size` | 32 | Training batch size |
| `--learning-rate` | 0.001 | Adam learning rate |
| `--parity-atol` | 0.00001 | Maximum allowed source/TFLite probability error |

The output directory is the deployment bundle:

- `model.tflite` — float32 TFLite flatbuffer with preprocessing embedded.
- `metadata.json` — validated inference contract containing ordered classes,
  ordered 55-feature names (or a canonical-order subset), tensor shapes/dtypes,
  `window_config` (window, stride, max gap, and a minimum of at least 2 samples per
  window), preprocessing policy, grouped split, metrics, TensorFlow/training details,
  conversion parity, and the lowercase SHA-256 digest of `model.tflite`.
- `label_mapping.json` — written by the desktop next to the bundle when it runs the
  trainer; the label-to-role mapping the run used. Replay reads it.

`bundle.validate_metadata` is the contract's writer-side check, and the desktop's
`load_and_verify_bundle` (`apps/desktop/src-tauri/src/model_registry.rs`) enforces the
same checks on activation, rollback and every runtime load, including for a bundle this
tool did not produce. `tests/fixtures/valid_bundle/` is a small shared fixture that
**both** this package's tests and the desktop's Rust tests validate, so the two
validators cannot drift apart silently; change the contract in both places and
regenerate that fixture with `bundle.build_metadata`.

Before metadata is accepted, the exporter loads the converted model with the
TFLite interpreter and runs every held-out feature row through both Keras and
TFLite. Export fails unless class argmax agrees for every row and maximum
absolute probability error is within `--parity-atol`. The metadata is then
written, loaded back, schema-validated, and checked against the model bytes'
SHA-256. Consumers should perform the same metadata and digest checks before
loading a deployed model.

## Offline replay

```bash
pinch-classifier-replay --bundle-dir artifacts/pinch-tflite --input session1.csv session2.csv
```

Replays recordings against a validated bundle without any desktop actions and prints
one bounded JSON report (per-window expected vs predicted, accuracy, predicted class
counts). Windows are built with the bundle's own `window_config`, and labels are
resolved through the bundle's `label_mapping.json`, the same mapping the model was
trained with, so a label trained as `pinch_start` is replayed as `pinch_start`. A bundle
with no mapping file (for example one imported from elsewhere) uses the legacy
fixed-vocabulary mapping and **rejects any label it does not cover** instead of scoring
it as negative. Replay requires TensorFlow.

TensorFlow is deliberately optional: baseline users do not install the large
runtime, and the ordinary test suite skips real conversion tests when the
`tensorflow` extra is absent.

## Baseline vs. derivative-feature experiment (research only)

```bash
pinch-classifier-experiment --input session1.csv session2.csv ... --output report.json
```

Offline-only comparison (M5) between the existing baseline feature set and a
candidate that adds per-channel accel/gyro/PPG first-derivative features
(`pinch_classifier.derivative_features`). It reuses the same CSV loader,
windowing, and grouped-session split as `pinch-classifier-train`, trains a
RandomForest on each feature set with the identical train/test split, and
never writes a model file, model card, or any deployment artifact — output is
one machine-readable `report.json` (dataset/session/window counts, split
method and parameters, both feature sets' metrics, and a `recommendation`
string).

Time-based derivatives require a reasonably regular sample cadence: any
window whose sample-interval deviation from its own median cadence exceeds
`--timestamp-tolerance` (default `0.5`, i.e. 50%) is excluded from *both*
feature sets for that comparison, and the rejection count/reasons are
reported explicitly rather than silently dropped. Accepts the same
`--hold-handling` / `--label-mapping-file` / `--window-ms` / `--stride-ms` /
`--max-gap-ms` / `--test-size` / `--random-seed` / `--n-estimators` flags as
`pinch-classifier-train`.
