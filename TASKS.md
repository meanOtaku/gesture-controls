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
- [ ] Feature-enabled LiteRT build and real-device validation.

## GC-004 — (not yet scoped)

Not defined by this session. Likely candidate: cross-platform LiteRT native
library packaging/distribution for the `litert` Cargo feature (today gated
off by default and not exercised in default CI, per
`crates/pinch-inference/Cargo.toml`'s own comments).

## GC-005 — (not yet scoped)

Not defined by this session. Likely candidate: real-device model lifecycle
validation from `docs/release-readiness.md`'s "Model lifecycle, replay, and
inference diagnostics" checklist (import → train → approve → activate →
replay → rollback) on actual Galaxy Watch hardware, which that document
already flags as unexecuted on this host.

## GC-006 — (not yet scoped)

Not defined by this session. Likely candidate: packaging/signing the
`litert-inference` feature build across the release matrix
(`docs/release-readiness.md`'s LiteRT-candidate precondition row) once
GC-003–GC-005 land.

> GC-004–GC-006 titles above are placeholders inferred from open gaps in
> `docs/release-readiness.md` and existing code comments, not commitments —
> confirm scope before starting them.
