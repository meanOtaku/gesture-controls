# Label inference: bundles, shared pipeline and detections

**Status (2026-10-21):** the crate `crates/label-inference` and its host `apps/desktop/src-tauri/src/label_runtime.rs` run per-label binary models **in-process**, with no Python at run time (see [the decision record](../decisions/2026-10-model-runtime-and-format.md)). The models are tree ensembles of two kinds:

- the **PPG + IMU pinch-start model**, which Model Lab trains;
- the earlier **PPG-only** one, which still runs.

The research behind them is in [IMU fusion, trigger rules and label shifts](../research/ppg-imu-fusion-and-triggers-2026-10.md) and the [PPG benchmark artifacts](../research/artifacts/ppg-benchmark-2026-10/README.md).

## The model bundle

A directory with `manifest.json` and one model file: `model.trees`, plain node arrays the runtime walks (`trees.rs`), or for the CNN `model.cnn`, JSON weights the runtime evaluates (`cnn.rs`: one to five networks of dilated 1-D convolutions with batch normalisation folded in, max and mean pooling and dense layers, their sigmoid outputs averaged). Either is data, never code.

```json
{
  "schemaVersion": 1,
  "modelId": "pinch-1a2b3c4d", "targetLabel": "pinch",
  "model": { "file": "model.trees", "sha256": "...", "format": "trees", "opset": 0 },
  "framework": { "name": "scikit-learn", "version": "1.x" },
  "input":  { "name": "X", "shape": [null, 2733], "dtype": "float32", "features": ["ppg_z1000ms_d1_green_n8_q10", "...", "imu_gyro_mag_spread_vs_3s_n1280ms"], "trainingRange": { "low": [], "high": [] } },
  "output": { "name": "probabilities", "shape": [null, 2], "dtype": "float32", "positiveIndex": 1 },
  "sources": ["watchPpg", "watchOrientation"],
  "window": { "durationMs": 5640, "strideMs": 40, "maxGapMs": 250, "minSamples": 100 },
  "quality": { "maxContactQuality": 0.0, "minSampleCount": 3 },
  "thresholds": { "activation": 0.85, "release": 0.7, "cooldownMs": 1500, "trigger": "peak" },
  "preprocessing": { "kind": "ppg_imu_onset" },
  "provenance": { }
}
```

**The preprocessing kind decides the model kind** (`inputs::ModelKind`):

| Kind | Sources | Inputs |
|---|---|---|
| `ppg_imu_onset` | `watchPpg`, `watchOrientation` | 2,733: the 1,701 pulse features, then the 1,032 motion features |
| `ppg_multiscale_onset` | `watchPpg` | 1,701 |
| `ppg_imu_cnn` | `watchPpg`, `watchOrientation` | 450: 9 channels x the last 50 ticks (`cnn_input`); format `cnn`, window 11,000 ms |

The bundle must declare exactly its kind's sources, features (names and order), input shape, window and file format (`trees`, or `cnn` for the CNN). `thresholds.trigger` is `"edge"` when absent, which is what bundles made before triggers say.

**Validation refuses:**

- a missing, oversized (manifest over 512 KB, model over 64 MB) or malformed manifest, an unknown schema version or field, or an unsafe model file name;
- any format but `trees` or `cnn`, a format that is not its kind's, or any other preprocessing;
- a contract that does not match its kind;
- a training range that is not a finite low-not-above-high per input;
- unsound thresholds or quality rules;
- a model whose hash differs from the manifest's;
- a tree or CNN file that reads a different number of features, or a CNN whose layers do not chain or whose weights are not finite;
- a model that does not answer a probability on four constant test inputs.

The hash is taken from the same bytes that are parsed. A model is loaded only for a registry version that is **Active** and may run (deployable, or Monitor-only) and whose hash is the approved one.

## The inputs

All are computed by `crates/pinch-inference` and, identically, by the trainer (`tools/label-trainer/src/label_trainer/ppg_onset.py`, `imu_onset.py`, `cnn_input.py`). Shared fixtures keep them equal (`ppg_onset_cases.json`, `imu_onset_cases.json`, `cnn_input_cases.json`).

- **Pulse** (`ppg_onset`). For a decision at a pulse sample:
  - a 25 Hz grid of 141 ticks (5.6 s) ends at it;
  - each channel is z-scored against the previous 1, 2 and 4 s;
  - each z-series gets slope, curvature and jerk from a least-squares cubic over the nine ticks before each tick;
  - 21 statistics summarise the last 8, 16 and 32 ticks: 1,701 features.
  - A gap over 250 ms in the span, or too little history, gives none.
- **Motion** (`imu_onset`). For the same moment on the watch clock:
  - a 50 Hz grid of 214 ticks (4.26 s) ends at it;
  - the channels are the accelerometer and gyroscope axes and their magnitudes, raw and as tick-to-tick change;
  - over the last 16, 32 and 64 ticks (0.32, 0.64, 1.28 s), the same 21 statistics, plus each channel's spread against the 3 s before: 1,032 features.
  - A gap over 250 ms, or a tick before the first sample, gives none.
- **CNN** (`cnn_input`). For a decision at a pulse sample, on the watch clock (the pulse is placed on it by the pipeline's
  clock map, as the recordings have it):
  - a 50 Hz grid of 549 ticks (10.96 s) ends at it, each tick holding each stream's last sample;
  - the channels are the accelerometer and gyroscope axes and the pulse's green, red and infrared;
  - each of the last 50 ticks is z-scored against the 500 ticks ending at it (floors 0.02 m/s², 0.01 rad/s, and for the
    pulse 0.001 x (|mean| + 1)) and put through a sigmoid: 450 inputs, channel by channel.
  - A gap over 250 ms in either stream, or a tick before either's first sample, gives none.

## The shared pipeline

```
pulse batches  -> order/finite checks -> buffer (receive clock + watch clock)  \
motion samples -> order/finite checks -> buffer (watch clock)                    -> per-model gates
  -> each pending pulse sample, once its motion has arrived -> its kind's features -> trees -> score
  -> detector (trigger, hysteresis, cooldown, exclusivity) -> detections
```

**Buffering:**

- Telemetry is validated and buffered **once** for all models, bounded by the longest window loaded.
- Out-of-order, repeated, malformed or non-finite samples are refused, not buffered, and end the detection of every model that reads that stream.
- A different watch's samples never mix in.
- Motion samples are kept only when they carry both an accelerometer and a gyroscope reading.

**Three clocks** (`clock.rs`):

- Pulse samples are placed on the desktop's receive clock, through the smallest `received - taken` seen in the last 30 s. The window gates (staleness, gaps, sample counts, contact quality) use this clock.
- The pulse sensor stamps its samples with the Samsung SDK's clock. The motion samples use the watch's `elapsedRealtimeNanos`, a different clock.
- So each pulse sample is also placed on the watch clock, by the smallest offset between a batch's send time (on the watch clock) and its newest sample. This is exactly what the recorder does (`SourceClockMap`), so live inputs line up as the recordings do. The motion features of a decision end there.
- The pulse features are computed from the pulse samples' raw timestamps, as the trainer computes them. A score is stamped with its pulse sample's raw timestamp.

**Deciding:**

- A model decides on **every pulse sample**, in order, as the trainer replays a recording.
- The first time, it decides on the newest ready sample. After that, on each one after the last it decided on, at most 50 per round.
- A PPG + IMU model decides on a sample only when motion at or after its moment has arrived. The streams are sent separately, about every 100 ms each. Deciding earlier would hold stale motion over the missing samples.
- **Rejections:**
  - A stream silent for over 1 s is `SourceStale` (`WatchPpg` or `WatchOrientation`). A late batch is waited for, not refused: decisions are made at the samples' own times, and Bluetooth delivers the pulse's 10 Hz batches up to a few hundred ms apart.
  - A gap longer than `maxGapMs` between pulse samples in the window, fewer than `minSamples`, or degraded contact quality reject the window.
  - A rejection ends that label's detection.
- Until the buffer holds the window (5.6 s of pulse, plus motion), the model is quiet, not rejected.

`check_input` compares each decision's inputs with the training range and raises a warning when most decisions are unlike the training ones. It never changes a score.

## Detections

A label's scores become detections in `TemporalDetector`. The release threshold is never above activation, which gives the hysteresis.

**Rising:**

- **Edge trigger:** the score reaches the activation threshold and stays there for the debounce time.
- **Peak trigger:** the first score lower than the one before it once the score has reached the activation threshold, wherever that fall lands, that is, the top of the score's climb. The debounce is not used. A peak that only touches the threshold still fires.

In both cases a detection cannot rise within the cooldown after the last one fell.

**Active and falling:** a detection stays active until the score falls below the release threshold, then falls.

`TemporalDetector::observe` feeds it one score at a time outside the runtime: the desktop's replay (`labelling::replay`)
runs each model's recorded scores through it at thresholds from 0.30 to 0.95 (`ModelReplay::sweep`), for the Threshold and
Compare cards and the Labelling page's slider. It skips the runtime's clears on a rejected window, so it is close to a run at
that threshold rather than exact.

The trainer's replay uses a copy of this rule (`events.detect`). `tests/fixtures/detection_cases.json`, edge and peak cases, keeps the two equal.

**Exclusivity:**

- Several scores of one label in a round go through its detector in time order.
- Scores of the same moment go through together, so labels declared exclusive are judged on the same moment.
- If two exclusive labels are detected together, **both are held off**, a conflict is reported once, and a label that had been detected is released. No label wins by being first or stronger.

## Modes and safety

- **Off** does nothing. **Monitor** scores and reports but lets no *start* through. **Live** forwards detections from the loaded, validated, approved models.
- A **falling edge always gets through in every mode**: releasing is the safe direction.
- Changing the mode ends every detection. A remembered Live restarts as Monitor.
- Replacing, removing or rolling back a model releases its detection **before** the new model is used.
- A stale or bad stream, a failed window, a model error, the watch disconnecting or a malformed watch message clears the affected labels and reports a falling edge for each, so whatever depends on them lets go. After a loss the buffers are emptied, so nothing is scored from stale data.
- **A start can be made to need a still hand** (`steadiness.rs`). With the gate on (the host follows the
  `steadyStartsOnly` setting, off by default, for the active models and the one being compared), a rising edge is let
  through only if the watch's motion was still from 1.5 to 0.5 s before the gesture's estimated start: the decision (on
  the watch's clock, `LabelScore::watch_ns`) less the model's decision delay (`thresholds.decisionDelayMs` in its
  manifest; 880 ms, the trainer's positive moment, for a bundle that does not say). Still is acceleration spread at most
  0.4 m/s², gyroscope RMS at most 0.5 rad/s, tilt change at most 10°; and from 0.25 s before the estimated start to
  0.4 s after it (or the decision) the watch's orientation may turn at most 30° from where it was
  (`Steadiness::turned_during`; with too little motion to judge, that part is left to the window before). Otherwise it is withheld: never announced or
  actionable, the detector cleared so the next start is judged afresh, and a `Rejection::HandNotStill` reported. Too few
  motion samples, or no decision time on the watch's clock, is not still (it fails closed). Held detections and releases
  are never touched by it.
- **A start always needs a jolt** (`Steadiness::jolt_near`), whatever the gate: some sample's linear acceleration, less
  the mean of the samples within 150 ms of it, must reach 0.04 m/s² from 0.25 s before the estimated start to 0.6 s after
  it (or the decision, if sooner). Otherwise the start is withheld as above with a `Rejection::NoMovement`. It catches
  models firing on sensor noise or a resting arm; with too little motion to judge it lets the start through. It is
  checked before the still-hand gate.
- **Off the wrist nothing is scored** (`LabelRuntime::set_worn`, from the watch's `watch.wear_state`): every detection is
  released with a falling edge and ticks score nothing until the watch says it is worn again. Losing the watch forgets
  the state, since a watch that comes back reports it again.
- A model that cannot be loaded (altered or missing file, unsafe directory) is reported by name and that label has no model; it never falls back to another.
- The host fails closed: if the registry cannot be opened the runtime is Off and the status says why.

## The host

`label_runtime.rs` opens the per-label registry (migrating the old one once, see [the domain model](model-lab-domain.md)), loads the active models, feeds watch orientation and PPG events in, runs a 100 ms timer so a stream that stops is noticed, emits `label-detections` events (rising, active, falling, conflicts, rejections) and answers `get_label_runtime_status`. It emits `hand-steadiness` when the hand goes from still to moving or back (`HandSteadinessView`, from the last second of motion) and answers `get_hand_steadiness`, for the Activity card's badge. On every runtime update and every tick it hands the recipe engine the loaded labels, the detections cleared to act, the labels that just started and those cut short (see below). It **performs no action itself**; actions come only from recipes.

## The miss recorder

`apps/desktop/src-tauri/src/miss_recorder.rs` keeps the last 45 s of the watch's motion and pulse in memory, with every
score, detection, rejection, conflict, recipe change, head location, button press and link change of those seconds. Nothing
is written until a miss is marked: the sidebar's **It didn't fire** and **It fired by itself** buttons (`mark_miss`), or
Ctrl+Alt+M from any app (Control-Option-M on a Mac).

A marked miss becomes an ordinary recording in Datasets, in the group **Misses**, with no labels: `ppg.csv` and `imu.csv`
as the Recorder writes them (the pulse placed on the watch's clock the same way), so it can be labelled and trained on.
`live_log.json` is kept in its folder: the runtime's mode, each active model's thresholds, the entries (each with
`msBeforeMark`), and a summary per label (highest score and when, detections, those acted on, rejections by kind) and per
stream (gaps over 250 ms). The summary's sentences are shown when the miss is saved. It is 45 s, not 30, because the CNN
scores nothing in its first 11 s, so a replay covers about the last half minute.

## Importing a bundle

`import_label_model(path)` takes a folder holding `manifest.json` and the one model file it names, and adds the model as a **Draft**. It never approves or activates anything.

1. **Stage.** Only those two files are copied, into a private `model-lab/staging/<unique>` folder; every other file in the folder is ignored. A link (symlink) as the folder or either file is refused, as is a model name with a path in it, a manifest over 512 KB or a model over 64 MB. The full bundle validation then runs **on the staged copy**, so what was checked is exactly what is stored. This happens without holding the registry, so detection is not stalled.
2. **Publish.** Refused if the same model bytes were already imported for that label. The staged folder is moved to `model-lab/label-models/<label>-<hash prefix>` with one rename, then the Draft is recorded; the label's project is created (trainer "external import") if it has none, and reused if it has. If the registry cannot be saved, the moved folder is removed again, so disk and registry agree.
3. **Startup** deletes anything left in staging. A published folder the registry does not know (a crash between the rename and the save) is never trusted or deleted: importing the same bytes again reports it and asks you to move it aside.

Later moves (Draft → Evaluated → Approved → Active) are explicit and go through the registry's own rules. **Activation first loads the model** (full validation and a hash check against the one recorded) and is refused if that fails; every registry change then reloads the runtime, which releases a replaced model's detection before using the new one. Commands: `set_label_model_state`, `activate_label_model`, `deactivate_label_model`, `rollback_label_model`, `set_label_runtime_mode`.

## Training

The desktop decides and records; the trainer only trains (`apps/desktop/src-tauri/src/label_training.rs`, `crates/label-inference/src/training.rs`, `tools/label-trainer/src/label_trainer/label_train.py`).

**The desktop.** Before anything runs, `begin_run` seals, in one saved registry change:

- the label's project;
- a dataset snapshot: recordings by content hash, label roles, and the model's contract (`pinch_start_contract`, or
  `cnn_contract` when the request's `method` is `ppg-imu-cnn`);
- a deterministic train/evaluation split by recording, holding out about 30% and leaving both the target and something else on both sides;
- a started run.

**The trainer** gets a `spec.json` and runs `uv run --project tools/label-trainer label-classifier-train` (with
`--extra cnn` for the CNN, which installs PyTorch). The trees:

- **Samples.** In each recording it takes:
  - a positive 880 ms after each start of the target;
  - as negatives, the same moment after other labels' starts;
  - points inside holds and quiet time, at least 1.5 s from any hold edge;
  - for the PPG + IMU model, moments 0, 200 and 400 ms after each start of the target, so it does not fire before the moment.
- **Model.** It computes their inputs and fits ExtraTrees: 300 trees, minimum leaf 3, 70% of features per split.
- **Cut-off.** For a PPG + IMU model:
  - the training recordings are split into up to five folds, each scored by a model trained without it;
  - each left-out recording is **replayed as the runtime would run it**: every pulse sample, the peak trigger;
  - the cut-off taken is the one of 0.30–0.95 that catches the most starts with at most 30 false activations per hour
    with no gesture under way (`FALSE_ACTIVATIONS_BUDGET_PER_HOUR`); none within it: the most starts caught less false
    activations, never simply the highest. It is the same budget the release check holds the held-out replay to.
  - A PPG-only spec keeps Youden's J on the left-out moments and the edge trigger.
- **Testing.** It replays the held-out recordings the same way, counted as
  [the evaluation standard](../research/gesture-detector-evaluation-metrics.md) counts them:
  - a detection 680–1,280 ms after a start catches it;
  - another detection while that gesture is under way (its start, through the parts of it that follow, such as
    `pinch_hold` and `pinch_out`, to the end of its catch window) is a **repeat** if the gesture was caught, **late** if it
    was not;
  - any other detection is a **false activation**, per hour of time with no gesture under way.
- **Label timing.** The spec's `labelTiming` says which recordings the camera timed and which were estimated from motion
  (from `DatasetSummary::labels_from`). When both kinds are there and the camera-timed ones hold at least 20 gestures and a
  minute without one, the cut-off and the verdict use the camera-timed ones (`cohort`); the totals of each kind are kept in
  `byLabelTiming`.
- **Still hand.** With the `steadyStartsOnly` setting on, the desktop's spec asks for `steadyStarts`: every decision
  whose gesture was not preceded by still motion (`steadiness.py`, the same test as the runtime's gate, with the trainer's
  880 ms decision delay) is left out of training and testing, and the replays count only the detections the gate would
  let start. `evaluation.json` records `steadyStarts`, and the manifest's thresholds carry `decisionDelayMs`.
- **Bundle.** It writes the bundle and checks the tree file reproduces the trained model (within 1e-6).
- **The CNN** (`backend: ppg-imu-cnn`, `cnn.py`) differs only where it must: every pulse sample is a decision, those
  400-600 ms after a start of the target are positives and those with no start from 200 ms before to 1.2 s after are
  negatives (the rest left out); three networks are trained from different seeds (12 epochs, up to 40,000 negatives) and
  averaged; the cut-off may also be 0.96-0.99, as its scores crowd towards 1; it decides 500 ms after a start, so the
  replay's catch window, the still-hand test and `decisionDelayMs` use 500 ms; and the exported file must reproduce the
  networks within 1e-4.
- **Left out.** A stretch marked on the Labelling page with the label `left_out` (`dataset_files::LEFT_OUT_LABEL`) is
  always given the Exclude role, whatever the request says, so no decision touching it is trained on; it needs no catalogue
  entry. The final test, the mistakes list and the threshold sweep do not count a detection judging a moment inside one
  (`sealed_test::outside_left_out`).
- **Refusals.** A sealed recording (kept for the final test, `sealed_test.rs`) or two recordings with the same rows
  (`dataset_files::rows_sha`) are refused before anything runs.
- **Gates.** A model that misses a go-live gate is still written, as Monitor-only:
  - AUC and balanced accuracy at least 0.7, and the cross-check AUC at least 0.7;
  - at most 10% of other moments flagged;
  - at least 60 s without the gesture in the held-out recordings;
  - at most 30 false activations an hour;
  - at least half the gestures caught.
- **Files.** It also writes `evaluation.json` (with `crossCheckEvents`, the replay the cut-off was chosen on), `parity.json`, `inspection.json` (the inputs the trees lean on, every held-out moment's score, and with `research` the learning curve and leave-one-recording-out) and `result.json`.

**Finishing is one saved change too.** The bundle is staged and validated like an import, its contract must be the one planned, and `complete_run` records the run and the model as a Draft together, or neither. Nothing is approved or activated by training.

**Startup clean-up.** Models and runs of any other kind (the earlier ONNX models) are removed from the store on startup. The pinch-start trees and the CNN, and their runs, are kept.

## Recipes use detections

A recipe step `{ "kind": "model", "label": "snap_fingers", "hold": "held" | "oneShot" }` reads the runtime:

- **held** counts while the label stays detected and cleared to act (Live only), like a pinch. It can keep a dial turning, and when the detection falls the dial lets go.
- **oneShot** counts for 0.6 s after the label first rises, like a shake, so it can be chained with a head location. Button actions only; the recipe validator refuses it for a dial. A fault, a model change or a rejected window cancels a pending one-shot, and when a rise and a cancel arrive together the cancel wins.
- Resource conflicts work as before: two enabled recipes on the same action are both paused, whatever labels they use. Labels declared mutually exclusive are already both held off inside the runtime.
- A recipe naming a label that is not loaded cannot start; the Recipes tab shows "Waiting for model" once the runtime has said what it loaded. Nothing is reported before that, and the label name is validated as a slug either way, so a recipe can be written ahead of the model.

## Tests

- `crates/label-inference`: 88 tests (one ignored, run by hand).
- `crates/pinch-inference`: 6 tests, against the trainer's shared cases.
- `tools/label-trainer`: 51 tests.

Among them:

- Bundles the trainer made, of each kind, are validated and scored by the live pipeline exactly as the trainer scored them (`tests/fixtures/ppg_onset_bundle`, `ppg_imu_onset_bundle`; regenerate with `tools/label-trainer/tests/make_runtime_bundle.py`).
- The motion model is fed with motion arriving 60 ms behind the pulse and a pulse clock 7 s behind the watch's.
- It detects the synthetic trace's pinch and not its fists.
- **On real recordings:** `a_real_bundle_scores_a_real_recording_as_the_trainer_did` (ignored; set `PPG_E2E_BUNDLE` and `PPG_E2E_TRACE`) was run on a model trained from the real recordings and two held-out 10-17 recordings. It scored about 1,365 decisions each, with a largest difference of 6e-17.

**Not yet checked:**

- the motion model on a real watch's live streams;
- Windows and Linux builds;
- any recording with the IMU above 50 Hz.
