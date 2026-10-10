# Label inference: bundles, shared pipeline and detections

**Status:** step 2 of the Model Lab refactor. Delivered as the crate `crates/label-inference` and a host in `apps/desktop/src-tauri/src/label_runtime.rs`. Models run **in-process** with `tract` (see [the decision record](../decisions/2026-10-model-runtime-and-format.md)); there is no Python at run time and no sidecar. The runtime stays **Off** until the per-label registry says otherwise, and the registry has no models in it yet, so nothing runs on an installed app today. Importing a model, the recipe connection and the UI come in later steps.

## The model bundle

A directory with two files: `manifest.json` and one ONNX model. Only ONNX is accepted (never pickle, joblib, torch or SavedModel, which can run code or depend on a framework version).

```json
{
  "schemaVersion": 1,
  "modelId": "...", "targetLabel": "swipe_left",
  "model": { "file": "model.onnx", "sha256": "...", "format": "onnx", "opset": 15 },
  "framework": { "name": "scikit-learn", "version": "1.x" },
  "input":  { "name": "X", "shape": [null, 4], "dtype": "float32", "features": ["accel_x_std", "..."] },
  "output": { "name": "probabilities", "shape": [null, 2], "dtype": "float32", "positiveIndex": 1 },
  "sources": ["watchAcceleration"],
  "window": { "durationMs": 1000, "strideMs": 200, "maxGapMs": 300, "minSamples": 5 },
  "quality": { "maxContactQuality": 0.0, "minSampleCount": 3 },
  "thresholds": { "activation": 0.8, "release": 0.5 },
  "preprocessing": { "kind": "none" },
  "provenance": { }
}
```

Validation refuses a bundle for any of: a missing, oversized (manifest over 256 KB, model over 16 MB) or malformed manifest; an unknown schema version or an unknown field; a model file name that is not a plain file name (no separators, `..`, hidden names); any format but ONNX; an opset outside 9 to 21; any preprocessing but `none`; non-float32 tensors; a feature that is not one of the 55 canonical features; a feature whose stream is not listed in `sources`; a head-pose source (no canonical head-pose features exist yet); an unsound window or thresholds; a model hash that differs from the manifest's; a wrong target label (when one is expected); an input or output name that is not in the model; a feature count that does not match the input shape; a positive index outside the output; a model the runtime cannot load (an unsupported operator is the usual cause); and a model that does not return finite probabilities in [0, 1] on three bounded test inputs. The hash is taken from the same bytes that are then loaded.

A model is loaded only for a registry version that is **Active** and deployable and whose model hash is the approved one.

## The shared pipeline

```
raw telemetry -> order/finite checks -> per-model gates -> window -> 55 canonical features
              -> the model's declared subset -> inference -> label score
              -> temporal policy -> detections
```

- Telemetry is validated and buffered **once** for all models. Each model has its own window and stride, evaluated on its own schedule against the shared buffers.
- Windows are cut on the desktop's receive clock, the only one the watch's streams share. Raw timestamps are never altered: they are checked for strict order and carried through, and a score is stamped with the raw timestamp of the newest sample of the model's first listed stream.
- A model reads only the streams it declares (watch orientation, acceleration, gyroscope, PPG). Nothing else is windowed for it.
- Per-model gates: a stream quiet for longer than `maxGapMs`, a gap longer than that inside the window, fewer than `minSamples`, too few PPG samples or degraded PPG contact quality all **reject the window**, and a rejection ends that label's detection.
- Out-of-order, repeated, malformed or non-finite samples are refused and not buffered, and end the detection of every model that reads that stream. A different watch's samples never mix into a window.
- Buffers are bounded by the longest window loaded.

Features reuse `pinch-inference`'s canonical extraction, so a model trained offline sees the same features live.

## Detections

A label's score becomes a detection: it **rises** when the score reaches the activation threshold (held for the debounce time, and not within the cooldown after the last one ended), stays **active** until the score falls **below the release threshold** (never above activation, which gives the hysteresis), then **falls**.

Labels that cannot both be true are declared as an exclusivity group, separately from any model. If two are detected together, **both are held off**, a conflict is reported once, and a label that had been detected is released. No label wins by being first or stronger.

## Modes and safety

- **Off** does nothing. **Monitor** scores and reports but lets no *start* through. **Live** forwards detections from the loaded, validated, approved models.
- A **falling edge always gets through in every mode**: releasing is the safe direction.
- Changing the mode ends every detection. A remembered Live restarts as Monitor.
- Replacing, removing or rolling back a model releases its detection **before** the new model is used.
- A stale or bad stream, a failed window, a model error, the watch disconnecting or a malformed watch message clears the affected labels and reports a falling edge for each, so whatever depends on them lets go. After a loss the buffers are emptied, so nothing is scored from stale data.
- A model that cannot be loaded (altered or missing file, unsafe directory) is reported by name and that label has no model; it never falls back to another.
- The host fails closed: if the registry cannot be opened the runtime is Off and the status says why.

## The host

`label_runtime.rs` opens the per-label registry (migrating the old one once, see [the domain model](model-lab-domain.md)), loads the active models, feeds watch orientation and PPG events in, runs a 100 ms timer so a stream that stops is noticed, emits `label-detections` events (rising, active, falling, conflicts, rejections) and answers `get_label_runtime_status`. On every runtime update and every tick it hands the recipe engine the loaded labels, the detections cleared to act, the labels that just started and those cut short (see below). It **performs no action itself**; actions come only from recipes.

## Importing a bundle

`import_label_model(path)` takes a folder holding `manifest.json` and the one model file it names, and adds the model as a **Draft**. It never approves or activates anything.

1. **Stage.** Only those two files are copied, into a private `model-lab/staging/<unique>` folder; every other file in the folder is ignored. A link (symlink) as the folder or either file is refused, as is a model name with a path in it, a manifest over 256 KB or a model over 16 MB. The full bundle validation then runs **on the staged copy**, so what was checked is exactly what is stored. This happens without holding the registry, so detection is not stalled.
2. **Publish.** Refused if the same model bytes were already imported for that label. The staged folder is moved to `model-lab/label-models/<label>-<hash prefix>` with one rename, then the Draft is recorded; the label's project is created (trainer "external import") if it has none, and reused if it has. If the registry cannot be saved, the moved folder is removed again, so disk and registry agree.
3. **Startup** deletes anything left in staging. A published folder the registry does not know (a crash between the rename and the save) is never trusted or deleted: importing the same bytes again reports it and asks you to move it aside.

Later moves (Draft → Evaluated → Approved → Active) are explicit and go through the registry's own rules. **Activation first loads the model** (full validation and a hash check against the one recorded) and is refused if that fails; every registry change then reloads the runtime, which releases a replaced model's detection before using the new one. Commands: `set_label_model_state`, `activate_label_model`, `deactivate_label_model`, `rollback_label_model`, `set_label_runtime_mode`.

## Training

Training lives in two places with a clean line between them (`apps/desktop/src-tauri/src/label_training.rs`, `crates/label-inference/src/training.rs`, `tools/label-trainer/src/label_trainer/label_train.py`).

**The desktop decides and records; the trainer only trains.** Before anything runs, `begin_run` fixes and seals, in one saved registry change: the label's project (created if there is none), a **dataset snapshot** (the recordings by content hash, the label roles, the streams and window, and the train/evaluation split) and a started **run**. It refuses, recording nothing, if a label has no role, the target is not marked as the target, a recording is not what it was, or the data cannot be split fairly. The split is deterministic (ordered by the hash of the recording id), holds out about 30%, never shares a recording, and leaves both the target and "something else" on both sides.

The trainer gets a `spec.json` (target, negatives, excludes, recordings, train, evaluation, streams, window, method, seed) and runs `uv run --project tools/label-trainer --extra onnx [--extra torch] label-classifier-train`. It computes the same 55 canonical features the runtime computes, restricted to the streams the model may read; trains; scores the held-out recordings; exports ONNX; checks the file reproduces the trained model (within 1e-3) and uses only operators the runtime can run; and writes `bundle/` (manifest and model), `evaluation.json`, `parity.json` and `result.json`.

**A model is only kept if it works on recordings it never saw.** The trainer reports the ROC AUC and fits the activation threshold (release is 0.15 below it) on the held-out recordings, because scores shift between sessions and a fixed 0.8 can sit above every score of a model that ranks perfectly; the numbers at that threshold are therefore a little optimistic, `evaluation.json` and the manifest's provenance say so, and the default threshold's numbers are reported too. If AUC is under 0.7 or F1 under 0.5 the outcome is `evaluationOnly`: no bundle, the run is finished as EvaluationOnly with the reason, and nothing is registered. A first real run (two pinch recordings, acceleration and gyroscope) produced AUC 0.05, a model that had memorised the training session's posture; with the pulse sensor the same recordings gave AUC 0.99. `movementOnly` (spread and change, not absolute levels) is the defence against posture memorisation; the desktop and the trainer share the rule and are tested against the same list.

**Finishing is one saved change too.** The bundle is staged and fully validated like an import, and its features must be exactly those planned. `complete_run` then marks the run finished (with the hashes of its artifacts) and records the model as a Draft whose origin is that run, together or not at all. `fail_run` records why a run produced nothing. A finished run is immutable. Nothing is approved or activated by training.

**What the runtime can run constrains the exporters.** tract has no scikit-learn `Scaler` or `LinearClassifier`, and could not load the `TreeEnsembleClassifier` that scikit-learn's converter writes. So logistic regression and the scikit-learn MLP are written as plain ONNX by hand (`MatMul`, `Add`, `Relu`, `Sigmoid`, `Sub`, `Concat`), with the feature scaling folded into the first layer so the manifest's preprocessing is always "none"; the PyTorch network bakes its normalisation in and exports with the legacy exporter. Tree models are not offered. Real bundles from all three methods are checked into `crates/label-inference/tests/fixtures/trained_*_bundle` (regenerate with `tools/model-bundle-fixture/make_trained_fixtures.py`) and a Rust test validates and scores them against the trainer's own predictions. Writing that test found two real incompatibilities, both fixed.

Known limits: training windows are cut from a recording's own sample timestamps, while the runtime cuts windows on the desktop's receive clock, so a model can behave differently live than on its held-out recordings (this is true of the older pinch path too); the runtime's PPG and orientation fusion is shared with it, not re-derived. Nothing here has been run against recordings from a real watch, so the scores are only as meaningful as your recordings.

## Recipes use detections

A recipe step `{ "kind": "model", "label": "snap_fingers", "hold": "held" | "oneShot" }` reads the runtime:

- **held** counts while the label stays detected and cleared to act (Live only), like a pinch. It can keep a dial turning, and when the detection falls the dial lets go.
- **oneShot** counts for 0.6 s after the label first rises, like a shake, so it can be chained with a head location. Button actions only; the recipe validator refuses it for a dial. A fault, a model change or a rejected window cancels a pending one-shot, and when a rise and a cancel arrive together the cancel wins.
- Resource conflicts work as before: two enabled recipes on the same action are both paused, whatever labels they use. Labels declared mutually exclusive are already both held off inside the runtime.
- A recipe naming a label that is not loaded cannot start; the Recipes tab shows "Waiting for model" once the runtime has said what it loaded. Nothing is reported before that, and the label name is validated as a slug either way, so a recipe can be written ahead of the model.

## Tests, and what has not been checked

`crates/label-inference` has 43 tests, including a real scikit-learn model exported with `skl2onnx` (`tools/model-bundle-fixture/make_fixture.py` regenerates it) that is validated, matches scikit-learn's output, and runs the whole way from a registry through the pipeline to a rising edge in Live mode.

Not yet done or checked:

- Windows and Linux builds of the crate (see the decision record's correction).
- Any model from Keras or PyTorch exporters; any model trained on real recordings; behaviour on a real watch's streams.
- Head-pose input, standardisation preprocessing, and quantised variants.
- Training on real watch recordings (only synthetic data has been run). Import, review, approval, activation, rollback and the Off/Monitor/Live switch are in the Model Lab's **Label models** card.
- Importing on a real machine with a bundle from a real exporter other than the scikit-learn fixture.
