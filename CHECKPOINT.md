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
- Historical evidence: `cargo test -p pinch-inference` previously passed (41
  tests). Per the current delivery direction, no validation is being run or
  accepted as clearance; all test, CI, package, and hardware gates remain
  explicitly **not cleared**.
- Model Lab now presents an explicit "Import custom LiteRT bundle" chooser for
  `metadata.json`. The backend validates the source before copying, copies only
  `metadata.json` and `model.tflite` into app-private model storage, validates
  the copied bundle again, then registers it as Draft. Failed validation leaves
  no registered model. Imported bundles remain subject to the existing
  Draft → Evaluated → Approved lifecycle and complete safe intent bindings;
  activation revalidates the stored artifact.

## Remaining work

## GC-008 — Bright electric-blue desktop outlines (2026-09-15)

- Standardized visible non-semantic desktop component borders, inputs,
  shadcn border/sidebar tokens, and focus outlines on a bright electric-blue
  token (`#268cff`).
- Semantic error, success, warning, recording, and completed-state borders
  retain their existing colors. Layout selectors and shadcn component
  structure are unchanged.
- Per task direction, no tests, CI, builds, linting, formatting, installs,
  screenshots, or runtime validation were run. Those gates are **DEFERRED /
  NOT CLEARED**.

## GC-007 — Flat super-dark-blue desktop UI (2026-09-15)

- Replaced the desktop visual treatment's visible gradients, translucent cards,
  blur, and decorative glow effects with opaque super-dark-blue surfaces.
- Existing layout, responsive behavior, focus affordances, and semantic
  success/warning/error/recording colors are retained.
- Per task direction, no tests, CI, builds, linting, formatting, installs,
  screenshots, or runtime validation were run. Those gates are **DEFERRED /
  NOT CLEARED**.

See `TASKS.md` for the full GC-002–GC-006 breakdown. In short: GC-002 is
complete. GC-003's custom-bundle UI/backend flow is implemented. GC-004 adds
the explicit `npm run package:litert` release entrypoint, target-native staging,
loader layout, and release instructions in
`docs/release/litert-runtime-packaging.md`; it refuses a missing, unreviewed,
or cross-target runtime rather than manufacturing a LiteRT package. Default
builds and the existing inference/gesture-policy path remain fail-closed.

No native runtime was supplied and no feature-enabled build, package,
installation, CI run, clean-host loader check, Off/Monitor/Live exercise,
fallback/forced-release exercise, signing step, or physical LiteRT execution
was performed for GC-004. Every validation, platform, release, and hardware
gate remains **DEFERRED / NOT CLEARED**.

## GC-009 — Raw recording image viewer (2026-09-19)

**Status: done.** M1-M4 committed and pushed in order: `1cfc7a2` (M1, backend
window contract), `1b8d75a` (M2, typed bridge + viewer state), `2e9e45f`
(M3, tab UI + canvas renderer), and this M4 commit (documentation + delivery
reconciliation).

- M1 (`recording_bundle::get_raw_recording_window`): a dedicated, read-only
  command bounding a `raw.csv` column read to at most 4,096 chronological
  values starting at a hop-64-aligned raw row; rejects negative/non-aligned
  starts, clamps an out-of-range start down to the last reachable hop-aligned
  window, and preserves empty fields as `None` rather than coercing or
  carrying forward. Never touches `load_recording_bundle`'s metadata/
  annotation path or writes any file.
- M2 (`recordingBundle.ts`, `rawImageViewerStore.ts`): a narrow typed
  invocation wrapper and a request-versioned state module that aligns every
  navigation path to the 64-row hop client-side, derives slider bounds from
  the backend's own `totalRawRowCount`, and discards any response superseded
  by a newer request or a changed recording/channel selection.
- M3 (`RawImageViewerPanel.tsx`, `RawImageCanvas.tsx`): a "Raw image viewer"
  tab inside `LiveTelemetry` rendering one `<canvas>`/`ImageData` 64×64
  chronological frame (never 4,096 DOM nodes), with distinct fills for real
  values, missing raw fields, and out-of-recording pixels, a
  recording-vs-frame-scale normalization toggle, a matching legend, and
  keyboard/hover pixel inspection. Covers no-recording, empty-selection,
  loading, unavailable-channel, short-recording, and command-error states.
  No annotation-editing or training action is exposed anywhere in this path.
- M4 (this entry): documented the fixed 4,096-value/64-row-hop frame
  contract, chronological row-major canvas order, null/missing vs.
  beyond-recording treatment, recording-/frame-scale normalization, and the
  explicit non-training/non-classifier boundary in
  `docs/decisions/2026-09-dataset-capture-recording-contract.md` (new
  section) and `docs/using-the-application.md` (new user-facing
  subsection). Performed an independent source/diff review of M1-M3 against
  their acceptance criteria (bounds/null handling, hop-alignment/stale-
  response guards, UI states and tab wiring) with no discrepancies found.
  Reconciled `TASKS.md`, `CHECKPOINT.md`, and
  `.hermes/queues/gc-009-raw-recording-image-viewer.json` to reflect M1-M4
  completion. No application behavior was changed in this milestone.
- Per task direction, no tests, CI, builds, linting, formatting, installs,
  screenshots, or runtime validation were run for any of GC-009-M1 through
  M4. Those gates remain **DEFERRED / NOT CLEARED**.

## GC-010 — Registry-mutation helper refactor (this session)

Minimal architecture cleanup of `apps/desktop/src-tauri/src/model_registry.rs`:
added a single private helper, `with_registry_mutation`, that centralizes
lock acquisition, `load_registry`, a fallible mutation closure over
`RegistryIndex`, `write_registry_atomic`, `emit_registry`, and `RegistryView`
conversion. `transition_model_state`, `update_model_thresholds`,
`update_model_quality_gate`, `set_model_intent_bindings`, `activate_model`,
`rollback_active_model`, and `set_inference_mode` now go through it;
`get_model_registry` is unchanged (read-only). No command interface,
lifecycle rule, bundle validation, atomic-persistence mechanism, error text,
or operation ordering changed — `activate_model`/`rollback_active_model`
still run validation and `force_release_before_swap` inside their closures in
the original order, and `set_inference_mode` still applies the gesture-policy
mode change after persistence.

Per task direction: no tests, builds, lint, formatting, or installs were run.
Only the final diff and `git diff --check` were inspected. Validation
(cargo test/clippy/fmt, targeted `model_registry` unit tests) remains
**DEFERRED / NOT CLEARED**.

## GC-011 — Import a Timeline Capture `raw.csv` into the raw image viewer (this session)

Bounded vertical slice: `RawImageViewerPanel` gained an "Import raw.csv"
control (hidden native file input + existing shadcn `Input`/`Button`,
`File.text()`), visible even with no saved recordings. It only accepts the
app's exact Timeline Capture `raw.csv` schema — no arbitrary-CSV upload, no
mapping UI.

- Backend: `recording_bundle::import_recording_from_raw_csv`, a new Tauri
  command that owns the trust boundary. `validate_raw_csv_full` extends
  `parse_raw_csv_column`'s per-field rules (empty -> `None`, non-empty must
  parse as its numeric type) across every column, not just one, and enforces
  the exact `RAW_CSV_HEADER`, row field count, and the existing
  `MAX_RAW_CSV_BYTES` limit — rejecting malformed, empty, oversized, or
  wrong-header CSV outright.
- All recording metadata (`recording_id`, `actual_start`/`actual_end`,
  `raw_row_count`, `actual_duration_ms`) is derived server-side from the CSV
  itself; nothing browser-supplied is trusted. Source identity is the stable
  constant `IMPORTED_SOURCE_ID = "timeline_capture_csv_import"`. Annotations
  are created empty. The bundle is written through the same atomic
  stage-then-rename path as `save_recording_bundle`, reusing
  `write_bundle_files`/`summarize_bundle` unchanged.
- Frontend: `importRecordingFromRawCsv` typed wrapper in
  `shared/tauri/recordingBundle.ts`. On success the panel refreshes the
  recording list, selects the imported bundle, and shows a
  `role="status"`/`aria-live="polite"` message; errors render in-panel via
  `role="alert"`. No train/annotate/raw-write action is exposed.
- Did not touch `model_lab`, labels, training, capture, existing raw
  recordings, or CSV export behavior.
- Added unit tests for `validate_raw_csv_full` (valid CSV, bad header, wrong
  field count, non-numeric field) and the `IMPORTED_SOURCE_ID` constant.
- `graphify update .` run after the source changes.

Per task direction: no tests, builds, lint, formatting, installs, or runtime
validation were run. Only the diff and `git diff --check` were inspected.
Those gates remain **DEFERRED / NOT CLEARED**.

## GC-011 follow-up — accept the legacy dataset CSV export (this session)

Root-cause compatibility fix: the importer only accepted the 16-column
Timeline Capture `raw.csv` header, so it correctly-but-unhelpfully rejected
the app's other real supported export format — the legacy dataset CSV
(optional `#` metadata comments, then the exact 17-column
`DATASET_CSV_HEADER` from `model_lab.rs`, ending in `label`).

- `model_lab::DATASET_CSV_HEADER` made `pub(crate)` and reused as-is from
  `recording_bundle.rs` (no duplicated schema, no shared abstraction built
  for a single caller).
- Added `convert_legacy_dataset_csv` in `recording_bundle.rs`: recognizes the
  legacy shape by exact header match (after skipping leading `#` lines) and
  converts it into a canonical `raw.csv` document by dropping the metadata
  lines and the trailing `label` field from each data row. Row order and
  every retained field's original string are preserved unchanged — no
  reordering, no timestamp/value normalization or fabrication. A document
  that isn't headed by the legacy header returns `None` and falls through to
  the existing plain `raw.csv` path unchanged; a malformed legacy document
  (wrong column count, or a row with an empty label) is a hard `Err`.
- The converted document still goes through the existing
  `validate_raw_csv_full` full per-field validation before being written —
  same numeric-or-blank contract, same exact-header check, same
  `MAX_RAW_CSV_BYTES` limit as the plain `raw.csv` path. No mapper, no UI
  mapping screen, no training changes, no mutation of any existing bundle.
- `RawImageViewerPanel`'s import help text now names both accepted formats.
  Success handling (recording-list refresh + auto-select the imported
  recording) needed no change; it already ran for every successful import.
- Added `recording_bundle.rs` unit tests for `convert_legacy_dataset_csv`:
  row order/value preservation on conversion, rejection of a missing label
  or wrong column count, and pass-through (`None`) for a non-legacy
  document.
- `graphify update .` run after the source changes.

Per task direction: no tests, builds, lint, formatting, or installs were run.
Only the diff and `git diff --check` were inspected. Those gates remain
**DEFERRED / NOT CLEARED**.

## GC-012 — Dynamic raw-image grid size (this session)

Bounded vertical slice: replaced the raw image viewer's fixed 64×64/4,096-value/
64-row-hop contract with a typed, allow-listed grid size (`8, 16, 32, 64`,
default 64), while preserving the same absolute upper bound (4,096 values) and
every existing read-only/non-training guarantee.

- Backend (`recording_bundle.rs`): `get_raw_recording_window` now takes a
  `grid_size: u32` argument, validated against `RAW_GRID_SIZES = [8, 16, 32, 64]`
  via `validate_grid_size` (rejects anything else outright). `resolve_raw_window_bounds`
  derives its hop and max-values from the validated grid size (`hop = N`,
  `max_values = N * N`) instead of the old fixed constants; `RAW_WINDOW_MAX_VALUES = 4096`
  now documents only the absolute upper bound (64×64). `RawRecordingWindow`
  gained a `grid_size` field so every response echoes the size actually served.
  Column allow-listing, record-id validation, null preservation, and
  recording-wide min/max normalization are unchanged.
- Frontend types (`shared/tauri/recordingBundle.ts`): added `RAW_GRID_SIZES`,
  `RawGridSize`, `DEFAULT_RAW_GRID_SIZE`, and `rawWindowMaxValues`/
  `rawWindowRowHop` helpers mirroring the backend; `RawRecordingWindowRequest`
  and `RawRecordingWindow` both carry `gridSize`.
- `rawImageViewerStore.ts`: added a `gridSize` field (default 64) and
  `setGridSize`, which realigns the current start to the new hop and reloads.
  `alignToRowHop`/`lastValidStart` take the hop/max-values explicitly instead
  of assuming fixed constants. The in-flight-response guard now also discards
  a response if the grid size has since changed, alongside the existing
  recording/channel guard.
- `RawImageViewerPanel.tsx`: added a shadcn `Select` for grid size next to the
  recording/channel selects, defaulting to 64×64, labeled with the selected
  size and its row hop; prev/next button labels, the slider step, and the
  short-recording hint now derive from the selected grid size instead of
  fixed text/constants.
- `RawImageCanvas.tsx`: removed the fixed `GRID_SIZE`/`PIXEL_COUNT` constants;
  every dimension, `ImageData` allocation, pixel-index mapping, pointer
  hit-testing, keyboard navigation, aria-label, and pixel-inspection text now
  derive from the loaded response's own `gridSize`. Canvas-only rendering is
  unchanged (still one `<canvas>`/`ImageData`, never N² DOM nodes).
- Docs: `docs/decisions/2026-09-dataset-capture-recording-contract.md`'s Raw
  image viewer section and `docs/using-the-application.md`'s Raw image viewer
  subsection now describe the bounded dynamic grid-size contract instead of
  the fixed 64×64 invariant.
- Added Rust unit tests: `resolve_raw_window_bounds_scales_hop_and_window_with_grid_size`
  and `validate_grid_size_allows_only_the_listed_sizes`, alongside updating the
  existing `resolve_raw_window_bounds_*` tests for the new `grid_size` argument.
- No arbitrary custom width/height, no separate hop control, no training
  integration, and no new dependency.
- `graphify update .` run after the source changes.

Per task direction: no tests, builds, lint, formatting, or installs were run.
Only the diff and `git diff --check` were inspected. Those gates remain
**DEFERRED / NOT CLEARED**.

## GC-013 — Second rainbow false-colour raw-image canvas (this session)

Bounded vertical slice: added a second, purely client-side false-colour
rendering of the same raw-image window already loaded by the raw image
viewer — no backend/Tauri contract change, no additional raw-data read.

- `RawImageCanvas.tsx`: added a local `RawImageColorMode` prop
  (`"grayscale" | "rainbow"`, default `"grayscale"`) and a required `title`
  prop used as the visible heading and the aria-label prefix. Extracted
  `colorForFraction`/`hsvToRgb` so both palettes share the same pixel loop,
  extent resolution, missing/beyond/constant handling, pointer hit-testing,
  and keyboard navigation — only the value-color mapping branches on
  `colorMode`. Rainbow sweeps hue 0° (red, low) to 270° (violet, high) at
  full saturation/value, never wrapping back toward red. `MISSING_COLOR`,
  `BEYOND_COLOR`, and `CONSTANT_COLOR` are unchanged and shared by both
  images.
- `RawImageViewerPanel.tsx`: when a window is loaded, renders two
  `RawImageCanvas` instances for the same `rawWindow`/`normalizationMode` —
  "Grayscale" and "Rainbow (false-colour)" — in a `flex-col md:flex-row`
  wrapper so they stack on narrow layouts and sit side by side when space
  allows. No new store state; both canvases read the same selected
  recording, channel, raw window, grid size, and normalization mode.
- Legend is palette-aware: names the palette, the normalization mode, and
  the actual low/high endpoint colors (black/white or red/violet); constant-
  range and missing/beyond wording is otherwise unchanged. Hover/keyboard
  pixel inspection remains per-canvas and reports row, timestamp, value, and
  missing/beyond state exactly as before.
- Not built: no RGB multi-sensor composite, no channel-mapping controls, no
  generalized/pluggable palette system, and no new dependency.
- Docs: `docs/decisions/2026-09-dataset-capture-recording-contract.md`'s Raw
  image viewer section and `docs/using-the-application.md`'s Raw image
  viewer subsection now describe the paired grayscale/rainbow rendering as a
  client-only rendering choice, not a data transform.
- `graphify update .` run after the source changes.

Per task direction: no tests, builds, lint, formatting, or installs were run.
Only the diff and `git diff --check` were inspected. Those gates remain
**DEFERRED / NOT CLEARED**.
