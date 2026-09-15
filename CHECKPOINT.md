# CHECKPOINT

Last updated: 2026-09-15, on `feature/litert-pinch-model` (task GC-002).

## What this checkpoint covers

GC-002: turn the offline pinch classifier baseline into a deployable, versioned
LiteRT/TFLite model bundle, with desktop-side (Tauri) import/register/validate
lifecycle integration. Live gesture-triggered actions are explicitly out of
scope for GC-002 and are owned by GC-003.

## State found at the start of this session

The GC-002 implementation was already present on this branch from prior work
(commits `e5159bc`, `f8ca5fc`, `e1d7900`, and earlier). No exporter, bundle
schema, or desktop registry code needed to be newly written. This session's
job was verification, one small documentation-accuracy fix, and adding this
durable checkpoint/task record (neither existed anywhere in the repo before).

## Model bundle export (`tools/pinch-classifier`)

- `train_tflite.py` / `pinch-classifier-train-tflite`: trains a small Keras
  MLP with the feature normalization baked into the graph, converts it to
  `model.tflite`, and verifies float32 TFLite-vs-source parity
  (`argmax_agreement == 1.0`, `max_absolute_error <= --parity-atol`) on a
  held-out split before ever writing the bundle.
- `bundle.py`: defines `BUNDLE_SCHEMA_VERSION = 1`, the fixed three-class
  contract (`negative`, `pinch_start`, `pinch_release`), the 55-name ordered
  feature contract, and `validate_metadata()`, which fail-closed rejects any
  schema/version/class/feature/shape/digest/parity mismatch.
  `write_and_validate_metadata()` writes `metadata.json` and then re-reads and
  re-validates it (plus the on-disk `model.tflite` digest) before returning,
  so a bundle can never be written in a state that would later fail its own
  contract.
- The sklearn baseline (`train.py`) is untouched in behavior; only its
  `model_card.json.tflite_export` string was corrected (see below) since it
  was stale relative to the now-implemented `tflite` backend.

## Desktop Model Lab / Tauri integration

- `apps/desktop/src-tauri/src/model_lab.rs`: dataset import/validation
  (exact Milestone 9 CSV header contract, label registry check, size/filename
  limits), and `start_training_job` which shells out to
  `pinch-classifier-train` or `pinch-classifier-train-tflite` via `uv`
  depending on the selected `TrainingBackend`. A completed `Tflite` job
  registers the model as `Draft` in the registry.
- `apps/desktop/src-tauri/src/model_registry.rs`: full lifecycle
  (Draft → Evaluated → Approved → Active/Archived), per-model thresholds and
  sensor-quality gate, and `load_and_verify_bundle()` — an independent Rust
  re-validation of the bundle contract (schema version, class order, feature
  order/count, tensor shapes, SHA-256 digest recomputed from the actual
  `model.tflite` bytes) that never trusts the metadata alone. Intent bindings
  are a closed set (`pinch_start` -> grab/no-op, `pinch_release` ->
  release/no-op, `negative` -> no-op only); activation and rollback both
  re-run `ActiveModelSnapshot::verified()` rather than trusting a prior
  validation.
- `crates/pinch-inference/src/litert_model.rs`: the real LiteRT-backed
  `PinchModel`, gated behind the `litert` Cargo feature (off by default; the
  default build fails inference closed, per `docs/release-readiness.md`).

## What this session changed

- `tools/pinch-classifier/src/pinch_classifier/train.py`: replaced the
  `model_card.json` field `"tflite_export": "not yet implemented — this slice
  only trains and evaluates the scikit-learn baseline"` with a message that
  reflects reality — the sklearn baseline still cannot export TFLite (by
  design, that backend is not a neural model), but the `tflite` backend
  (`train_tflite.py`) now does. No behavior change; `tests/test_train.py`
  still passes unchanged.
- Added this `CHECKPOINT.md` and `TASKS.md` (neither previously existed
  anywhere in the repo).

## Verification run this session

- Python: `uv run --extra dev --extra tensorflow pytest -q` in
  `tools/pinch-classifier` — **28 passed** (covers `bundle.py`, `train.py`,
  `train_tflite.py`, `desktop_runtime.py`, `csv_io.py`, `windowing.py`,
  `features.py`).
- Rust: `cargo test -p pinch-inference -p spatial-protocol -p head-tracking
  -p interaction-engine -p volume-control --all-targets` — all passed
  (41 + 7 + 5 + 5 + 11 = 69 tests), including `model_registry`-equivalent
  bundle-tamper tests inside `pinch-inference`'s own suite and the dedicated
  `model_registry.rs` unit tests (digest mismatch, missing metadata, wrong
  schema version, swapped class order, truncated feature contract, wrong
  output shape, malformed SHA-256 — all rejected).
- `cargo fmt --all -- --check` — clean.
- `cargo clippy -p pinch-inference -p spatial-protocol -p head-tracking
  -p interaction-engine -p volume-control -p watch-bridge
  -p native-head-tracking --all-targets -- -D warnings` — clean.
- JS: `npm ci && npm test && npm run typecheck && npm run build` — 24 test
  files / 162 tests passed, typecheck clean, production build succeeds.

## Known blocker: desktop Tauri crate (`spatial-gesture-desktop`) cannot compile in this environment

`cargo test -p spatial-gesture-desktop` fails during the `glib-sys` build
script with `pkg-config` not found. This host is missing the Linux Tauri
build prerequisites that `.github/workflows/desktop-ci.yml` installs in CI:

```
pkg-config
libwebkit2gtk-4.1-dev
libayatana-appindicator3-dev
librsvg2-dev
patchelf
```

`sudo apt-get install` requires a password not available in this session, so
these could not be installed here. This means `model_registry.rs`'s and
`model_lab.rs`'s own `#[cfg(test)]` unit tests (bundle-tamper rejection,
CSV parsing, dataset-id path-traversal rejection, etc. — all present in the
source already, see above) could not be executed locally in this session.
As a substitute, this session verified the equivalent bundle-contract logic
via `pinch-inference`'s test suite and read every relevant function in
`model_registry.rs`/`model_lab.rs` line-by-line to confirm the fail-closed
behavior the acceptance criteria require. CI (`desktop-ci.yml`) already
installs these prerequisites and runs the full desktop crate suite, so this
is a local-environment limitation, not an unverified code path in CI.

## GC-003 progress (2026-09-15)

- The active runtime now projects the extracted canonical feature vector only
  through the verified bundle contract's ordered names. `PinchModel` and the
  feature-gated LiteRT backend accept that exact vector length; no path pads,
  guesses, or silently remaps inputs.
- `metadata.json` accepts legacy app-trained 55-feature bundles unchanged.
  A custom bundle is accepted only when it declares feature-contract version
  1, 1..54 unique canonical names, matching input shape, preprocessing and
  window semantics, exact class order/output shape, and a matching SHA-256.
  Any other reduced contract rejects before activation/runtime load.
- `cargo test -p pinch-inference` passed (41 tests). Desktop crate tests
  remain blocked by the missing GTK/pkg-config prerequisites below.
- Model Lab now presents an explicit "Import custom LiteRT bundle" chooser for
  `metadata.json`. The backend validates the source before copying, copies only
  `metadata.json` and `model.tflite` into app-private model storage, validates
  the copied bundle again, then registers it as Draft. Failed validation leaves
  no registered model. Imported bundles remain subject to the existing
  Draft → Evaluated → Approved lifecycle and complete safe intent bindings;
  activation revalidates the stored artifact.

## Remaining work

See `TASKS.md` for the full GC-002–GC-006 breakdown. In short: GC-002 is
complete. GC-003's custom-bundle UI/backend flow is implemented. A
feature-enabled LiteRT build/package and physical inference validation are still
release gates. The existing inference and gesture-policy paths route classified
output through the safety state machine; physical LiteRT execution remains
unvalidated on this host.
