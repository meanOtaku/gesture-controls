# TASKS

Tracks the bounded GC-00x implementation slices for the LiteRT pinch-model
work on `feature/litert-pinch-model`. See `CHECKPOINT.md` for the detailed
state/verification behind the current slice.

## GC-002 — Deployable LiteRT/TFLite pinch-model lifecycle (this slice)

**Status: done**, verified this session (no Live user actions — that is
GC-003's scope, and nothing in this slice performs one).

- [x] Reproducible model-bundle export (`train_tflite.py`): trains, converts
      to `model.tflite`, verifies TFLite-vs-source parity before writing.
- [x] Versioned metadata/schema/feature contract (`bundle.py`,
      `BUNDLE_SCHEMA_VERSION = 1`), with `validate_metadata()` covering
      schema version, fixed 3-class order, 55-feature ordered contract,
      tensor shapes, and a SHA-256 digest tied to the actual model bytes.
- [x] Desktop Model Lab import/register/validate: dataset import + label
      check (`model_lab.rs`), `tflite`-backend training job registers a
      Draft model, and `model_registry.rs::load_and_verify_bundle` fully
      revalidates (never trusts stored metadata alone) at activation and
      rollback.
- [x] Fail-closed on malformed/unknown-schema/feature-mismatch/missing/
      tampered bundles — confirmed via `model_registry.rs` unit tests
      (digest mismatch, missing metadata, wrong schema version, swapped
      class order, truncated feature contract, wrong output shape,
      malformed SHA-256) and `bundle.py`'s own round-trip validation.
- [x] sklearn baseline behavior preserved; only its stale
      `tflite_export: "not yet implemented"` model-card string was
      corrected to describe the real `tflite` backend instead.
- [x] No weakening of the Watch-button fallback and no automatic Live
      action — `set_inference_mode`/`activate_model` never call into
      `ingest_ppg_window`'s live path, which itself performs no
      classification yet (see GC-003).
- [x] Targeted tests run: Python (28), Rust (69 across
      `pinch-inference`/`spatial-protocol`/`head-tracking`/
      `interaction-engine`/`volume-control`), `cargo fmt`/`clippy` clean,
      JS (162 tests across 24 files), typecheck, and production build.
- [ ] `spatial-gesture-desktop` (the Tauri crate holding
      `model_registry.rs`/`model_lab.rs`'s own `#[cfg(test)]` unit tests)
      could not be compiled/tested locally — **host-blocked**, see
      "Known blocker" in `CHECKPOINT.md`. CI already covers this crate.

## GC-003 — Enable validated LiteRT inference (in progress)

Enable the already-present live desktop inference/policy pipeline to execute
a verified LiteRT model safely and make its runtime availability explicit:

- Load the active model (`model_registry::active_model_file_path` /
  `ActiveModelSnapshot::verified`) into the existing
  `crates/pinch-inference::LiteRtPinchModel`, keyed off `InferenceMode`.
  `Monitor` must classify and log without acting; `Off` must never classify.
- Enable and package the `litert` Cargo feature for supported targets, while
  retaining the current fail-closed behavior when that feature/runtime is
  absent or model loading/inference fails.
- Use the existing `GesturePolicyRuntime`/`interaction_engine` state machine
  for classified output; do not add a bypass around its gating or Watch-button
  fallback behavior.
- Re-verify the release-readiness checklist's "Model lifecycle, replay, and
  inference diagnostics" and "Interaction safety and failure handling"
  sections end-to-end on real hardware once this is wired.

Progress in this commit:

- [x] Variable-size model seam and strict ordered canonical-feature projection.
- [x] Reduced (1..54) contracts require version `1`, preprocessing, window
      semantics, exact tensor shape, class order, and SHA-256; legacy exact
      55-feature bundles and sklearn baseline behavior remain unchanged.
- [x] Explicit desktop custom-bundle import/register UI: choose `metadata.json`,
      validate source, copy only bundle artifacts into private storage,
      revalidate, register Draft, then require normal lifecycle approval and
      safe intent bindings before activation.
- [ ] **Deferred / not cleared:** feature-enabled LiteRT build, package, and
      real-device validation. Do not run validation until explicitly requested.

## GC-004 — LiteRT desktop runtime packaging

Package the optional `litert-inference` desktop backend deliberately, without
claiming that a host cache, cross-target binary, or absent native library is a
redistributable runtime:

- [x] `npm run package:litert` is the sole feature-package entrypoint. It
      requires an explicit supported target triple, reviewed native runtime
      directory, and reviewed native-runtime NOTICE; it rejects missing or
      cross-target inputs before a package is created.
- [x] The package command stages only supplied `libLiteRt*` files and a runtime
      inventory, sets `LITERT_LIB_DIR` plus `LITERT_NO_DOWNLOAD=1`, selects
      `litert-inference`, and removes staging on success or failure.
- [x] Tauri overlays and desktop linker configuration handle macOS Apple
      Silicon, Windows x64, Linux x64, and Linux ARM64 according to the
      selected binding's declared native targets. macOS/Linux use resource
      loader paths; Windows places runtime DLLs beside the executable.
- [x] Default builds remain LiteRT-free and fail closed. Off/Monitor/Live,
      policy gates, forced-release behavior, and the Watch-button fallback
      remain unchanged.
- [x] Release procedure and the expected native-runtime artifact layout are
      documented in `docs/release/litert-runtime-packaging.md`.
- [ ] **Deferred / NOT CLEARED:** source/license/hash review for every runtime,
      feature-enabled builds, all platform packages, native-loader checks,
      clean-host installation, signing/notarization, CI, real LiteRT execution,
      Off/Monitor/Live verification, fallback/forced-release verification, and
      physical hardware validation. Do not treat this source/configuration work
      as package or runtime availability evidence.

## GC-005 — (not yet scoped)

**Deferred / not cleared.** Likely candidate: real-device model lifecycle
validation from `docs/release-readiness.md`'s "Model lifecycle, replay, and
inference diagnostics" checklist (import → train → approve → activate →
replay → rollback) on actual Galaxy Watch hardware, which that document
already flags as unexecuted on this host.

## GC-006 — (not yet scoped)

**Deferred / not cleared.** Likely candidate: packaging/signing the
`litert-inference` feature build across the release matrix
(`docs/release-readiness.md`'s LiteRT-candidate precondition row) once
GC-003–GC-005 land.

## GC-007 — Flat super-dark-blue desktop UI

**Status: implemented; validation intentionally deferred.**

- [x] Replaced the desktop's visible gradient, blur, translucent-surface, and
      decorative glow treatment with opaque super-dark-blue surfaces.
- [x] Preserved the existing layout selectors, responsive rules, focus states,
      and semantic success/warning/error/recording states.
- [ ] No tests, CI, builds, linting, formatting, screenshots, or runtime
      validation were run, by explicit delivery instruction.

> GC-004–GC-006 titles above are placeholders inferred from open gaps in
> `docs/release-readiness.md` and existing code comments, not commitments —
> confirm scope before starting them.

## GC-008 — Bright electric-blue desktop outlines

**Status: implemented; validation intentionally deferred.**

- [x] Applied one bright electric-blue border and focus-outline token to visible
      non-semantic desktop components and shadcn border/input/sidebar tokens.
- [x] Kept error, success, warning, recording, and completed-state borders
      semantic, without changing component layouts or shadcn structure.
- [ ] No tests, CI, builds, linting, formatting, installs, screenshots, or
      runtime validation were run, by explicit delivery instruction.

## GC-009 — Raw recording image viewer

**Status: M1–M2 done; M3–M4 not started.**

- [x] GC-009-M1: bounded, read-only `raw.csv` window contract (4,096 values;
      allow-listed numeric channel; preserved nulls). Added
      `recording_bundle::get_raw_recording_window`, registered in `lib.rs`;
      `load_recording_bundle` and the write path are unchanged.
- [x] GC-009-M2: typed Tauri bridge and race-safe viewer state with 64-row
      frame navigation. Added `getRawRecordingWindow` plus the
      `RawRecordingWindow`/channel-allow-list types to
      `shared/tauri/recordingBundle.ts`, and a new
      `features/telemetry/store/rawImageViewerStore.ts` state module
      (recording/channel/normalization-mode selection, request-version +
      selection guard against stale responses, and hop-aligned navigation
      bounds derived from the last loaded window). No UI panel yet.
- [ ] GC-009-M3: dedicated inspection tab with a chronological 64 × 64 canvas
      renderer, explicit missing values, and recording-scale normalization.
- [ ] GC-009-M4: boundary documentation, final acceptance review, and delivery
      state reconciliation.
- [ ] Automated tests, builds, linting, formatting, screenshots, and runtime
      validation are **DEFERRED / NOT CLEARED** until explicitly requested.

See `.hermes/plans/2026-09-19-gc-009-raw-recording-image-viewer-milestones.md`
and `.hermes/queues/gc-009-raw-recording-image-viewer.json`.
