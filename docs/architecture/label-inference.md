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
- Importing a bundle into the registry, training, and the Model Lab UI.
