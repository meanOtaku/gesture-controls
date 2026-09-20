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

**Status: done** (M1–M4 complete; validation gates deferred/not cleared).

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
- [x] GC-009-M3: dedicated "Raw image viewer" tab inside `LiveTelemetry`
      (the existing saved-recording/telemetry host), added via
      `RawImageViewerPanel` and `RawImageCanvas` under
      `apps/desktop/src/features/telemetry/components/`. Recording/channel
      `Select`s, a recording-vs-frame-scale `RadioGroup`, and a 64-row-hop
      `Slider` drive `rawImageViewerStore`; the frame itself renders through
      one `<canvas>`/`ImageData` (never 4,096 DOM nodes) with distinct fills
      for real values (grayscale), missing raw fields (fuchsia), pixels
      beyond the recording's end (slate), and constant-valued channels/frames
      (neutral gray) plus a matching legend. Keyboard/hover pixel inspection
      reports raw row, timestamp, value, and null/beyond state. Covers the
      no-recording, empty-selection, loading, unavailable-channel,
      short-recording, and command-error states. No annotation-edit or
      training action is exposed.
- [x] GC-009-M4: documented the read-only raw-image-viewer contract (fixed
      4,096-value/64-row-hop frame, chronological row-major canvas order,
      null/missing vs. beyond-recording treatment, recording- vs. frame-scale
      normalization, and the explicit non-training/non-classifier boundary)
      in `docs/decisions/2026-09-dataset-capture-recording-contract.md`
      (new "Raw image viewer (read-only inspection)" section) and added a
      matching user-facing "Raw image viewer" subsection to
      `docs/using-the-application.md`. Performed an independent source/diff
      review of M1-M3 against their acceptance criteria (backend bounds/null
      handling, frontend hop-alignment/stale-response guards, UI states and
      tab wiring) with no discrepancies found. No application behavior was
      changed.
- [x] GC-009 is now **done**: M1-M4 are committed and pushed in order
      (`1cfc7a2`, `1b8d75a`, `2e9e45f`, and this M4 commit).
- [ ] Automated tests, builds, linting, formatting, screenshots, and runtime
      validation are **DEFERRED / NOT CLEARED** — not run for any of
      GC-009-M1 through M4.

See `.hermes/plans/2026-09-19-gc-009-raw-recording-image-viewer-milestones.md`
and `.hermes/queues/gc-009-raw-recording-image-viewer.json`.

## GC-010 — Registry-mutation helper refactor in `model_registry.rs`

- [x] Added one private helper, `with_registry_mutation`, that owns the
      `ModelRegistryRuntime` lock acquisition, `load_registry`, a fallible
      mutation closure over `RegistryIndex`, `write_registry_atomic`,
      `emit_registry`, and `RegistryView` conversion for every
      registry-mutating command.
- [x] Refactored `transition_model_state`, `update_model_thresholds`,
      `update_model_quality_gate`, `set_model_intent_bindings`,
      `activate_model`, `rollback_active_model`, and `set_inference_mode`
      through the helper. `get_model_registry` stays explicit (read-only,
      never mutates).
- [x] No change to any Tauri command interface, lifecycle rule, bundle
      validation, atomic-persistence mechanism, error text, or operation
      ordering. `activate_model`/`rollback_active_model` keep validation and
      `force_release_before_swap` inside their closures in the same order as
      before. `set_inference_mode` still applies gesture-policy mode after
      persistence.
- [ ] Automated tests, builds, lint, formatting, and installs are
      **DEFERRED / NOT CLEARED** — not run for this change; only the diff
      and `git diff --check` were inspected.

## GC-011 — Raw image viewer: import a Timeline Capture `raw.csv` as a new read-only recording

- [x] Added `RawImageViewerPanel` an "Import raw.csv" control (hidden native
      `<input type="file" accept=".csv">` plus the existing shadcn
      `Input`/`Button`, read via `File.text()`), visible even when no
      recordings exist yet. In-panel `role="alert"` error text and a
      `role="status"`/`aria-live="polite"` success message; no changes to
      `model_lab`, labels, training, capture, or CSV export UI.
- [x] Added `recording_bundle::import_recording_from_raw_csv`, a new bounded
      Tauri command (registered in `lib.rs`) plus a typed
      `importRecordingFromRawCsv` wrapper in
      `shared/tauri/recordingBundle.ts`. It accepts only raw CSV text (no
      browser-supplied metadata), enforces the existing `MAX_RAW_CSV_BYTES`
      limit, and validates the **exact** 16-column `RAW_CSV_HEADER` plus
      every row's field count/numeric-or-blank contract via a new
      `validate_raw_csv_full` (reuses `parse_raw_csv_column`'s per-field
      rules, extended to every column, not just the requested one) —
      rejecting malformed, empty, oversized, or wrong-header input outright
      and preserving blank fields as-is (never coerced).
- [x] All recording metadata (`recording_id` via `Uuid::new_v4()`,
      `actual_start`/`actual_end` from the CSV's first/last `timestamp_ns`,
      `raw_row_count`, `actual_duration_ms`) is generated server-side from
      CSV facts; the source uses a stable identity constant,
      `IMPORTED_SOURCE_ID = "timeline_capture_csv_import"`. An empty
      `annotations.json` (`intervals: []`) is created. The bundle is written
      through the same atomic stage-in-`.tmp`-then-rename path as
      `save_recording_bundle`, reusing `write_bundle_files`/
      `summarize_bundle` unchanged.
- [x] On success the panel refreshes the recording list
      (`listVersion` bump), selects the imported recording via
      `rawImageViewerStore.setRecording`, and shows the success message. No
      train/annotate/raw-write action is exposed for imported (or any) raw
      image viewer recordings — this stays a read-only inspection surface.
- [x] Added unit tests for `validate_raw_csv_full` (valid CSV row
      count/timestamps, bad header, wrong field count, non-numeric field)
      and a stable-identity assertion for `IMPORTED_SOURCE_ID`, alongside
      the existing `recording_bundle.rs` test module.
- [x] `graphify update .` run after the source changes.
- [ ] Automated tests, builds, lint, formatting, installs, and runtime
      validation are **DEFERRED / NOT CLEARED** by explicit delivery
      instruction — only the diff and `git diff --check` were inspected.

### GC-011 follow-up — accept the legacy dataset CSV export as an import source

- [x] `import_recording_from_raw_csv` rejected the actual supported legacy
      export (optional `#` metadata comments, then the exact 17-column
      `DATASET_CSV_HEADER` from `model_lab.rs`, ending in `label`) because it
      only matched the 16-column `RAW_CSV_HEADER`. Root-caused instead of
      patched around: `model_lab::DATASET_CSV_HEADER` made `pub(crate)` and
      reused directly rather than duplicated.
- [x] Added `convert_legacy_dataset_csv` in `recording_bundle.rs`: detects
      the legacy shape by header match after skipping leading `#` lines,
      then converts it to a canonical `raw.csv` document by dropping the
      metadata lines and the trailing `label` field from each data row.
      Source row order and every retained field's original string are
      preserved unchanged (no reordering, no normalization/fabrication of
      timestamps or values). A non-legacy document (no header match) returns
      `None` and falls through to the existing plain `raw.csv` path
      unchanged; a malformed legacy document (wrong column count or an empty
      label) is a hard `Err`, never a silent skip.
- [x] The converted document is still run through the existing
      `validate_raw_csv_full` (full per-field raw validation, exact header,
      numeric-or-blank contract) before being written — no separate/weaker
      validation path for the legacy input.
- [x] Updated `RawImageViewerPanel`'s import help text to mention both
      accepted formats. Success handling (list refresh + auto-select the
      imported recording) was already in place from the original GC-011
      delivery; no change needed there.
- [x] Added `recording_bundle.rs` unit tests: legacy-to-canonical conversion
      preserves row order/values, rejects a missing label or wrong column
      count, and a non-legacy document is left alone (`None`).
- [x] `graphify update .` run after the source changes.
- [ ] Automated tests, builds, lint, formatting, and installs are
      **DEFERRED / NOT CLEARED** by explicit delivery instruction — only the
      diff and `git diff --check` were inspected.

## GC-012 — Raw image viewer: dynamic, allow-listed grid size

- [x] Replaced the fixed 64×64/4,096-value/64-row-hop backend contract with a
      typed, allow-listed grid-size request. `get_raw_recording_window` now
      takes `grid_size: u32`, validated by `validate_grid_size` against
      `RAW_GRID_SIZES = [8, 16, 32, 64]` (default 64); any other value is
      rejected outright. `resolve_raw_window_bounds` derives hop (`= N`) and
      max values (`= N * N`) from the validated size; `RAW_WINDOW_MAX_VALUES =
      4096` (64×64) remains the absolute upper bound on any response.
      `RawRecordingWindow` gained a `grid_size` field so every response
      echoes the size actually served, preserving deterministic terminal
      clamping against the selected window length.
- [x] Column allow-listing, record-id validation, null preservation
      (never coerced/replaced), and recording-wide min/max normalization are
      unchanged; no raw-data mutation.
- [x] Mirrored grid size through the shared Tauri types:
      `shared/tauri/recordingBundle.ts` gained `RAW_GRID_SIZES`,
      `RawGridSize`, `DEFAULT_RAW_GRID_SIZE`, and `rawWindowMaxValues`/
      `rawWindowRowHop` helpers; `RawRecordingWindowRequest` and
      `RawRecordingWindow` both carry `gridSize`.
- [x] `rawImageViewerStore.ts`: added a `gridSize` field (default 64) and
      `setGridSize`, which realigns the current start to the new hop and
      reloads rather than always resetting to 0. `alignToRowHop`/
      `lastValidStart` take hop/max-values explicitly; the stale-response
      guard now also discards a response if the grid size has since changed,
      alongside the existing recording/channel guard. Navigation bounds
      derive from the loaded window's own `gridSize`.
- [x] `RawImageViewerPanel.tsx`: added the existing shadcn `Select` for grid
      size next to the recording/channel selects (default 64×64), labeled
      with the selected size and its row hop; prev/next labels, the slider
      step, and the short-recording hint derive from the selected grid size.
- [x] `RawImageCanvas.tsx` is genuinely dynamic: removed the fixed
      `GRID_SIZE`/`PIXEL_COUNT` constants — canvas dimensions, `ImageData`
      allocation, pixel-index mapping, pointer/keyboard inspection, the
      aria-label, and the legend/description text all derive from the loaded
      response's own `gridSize`. Still renders through one
      `<canvas>`/`ImageData` only, never N² DOM nodes.
- [x] Updated `docs/decisions/2026-09-dataset-capture-recording-contract.md`'s
      Raw image viewer section and `docs/using-the-application.md`'s Raw
      image viewer subsection to describe the bounded dynamic grid-size
      contract in place of the fixed 64×64 invariant. Read-only/non-training
      boundary language unchanged.
- [x] No arbitrary custom width/height, no separate hop control, no training
      integration, and no new dependency.
- [x] Added Rust unit tests: `resolve_raw_window_bounds_scales_hop_and_window_with_grid_size`
      and `validate_grid_size_allows_only_the_listed_sizes`, plus updated the
      existing `resolve_raw_window_bounds_*` tests for the new `grid_size`
      argument.
- [x] `graphify update .` run after the source changes.
- [ ] Automated tests, builds, lint, formatting, installs, and runtime
      validation are **DEFERRED / NOT CLEARED** by explicit delivery
      instruction — only the diff and `git diff --check` were inspected.

## GC-013 — Raw image viewer: second rainbow false-colour canvas

- [x] `RawImageCanvas.tsx` gained a local `RawImageColorMode` prop
      (`"grayscale" | "rainbow"`, default `"grayscale"`) and a required
      `title` prop (visible heading, also the aria-label prefix). Grayscale
      behavior is byte-for-byte unchanged when the prop is omitted/default.
      Rainbow maps a normalized fraction through HSV (hue 0°→270°, S=V=1) so
      low = red through the spectrum to high = violet, never wrapping back
      toward red. `MISSING_COLOR`, `BEYOND_COLOR`, and `CONSTANT_COLOR` are
      unchanged and shared by both palettes — same missing/beyond/constant
      treatment in both images, only the value gradient differs.
- [x] `RawImageViewerPanel.tsx`: when a window is loaded, renders two
      `RawImageCanvas` instances side by side (`flex-col md:flex-row`, so
      they stack on narrow layouts and sit side-by-side when space allows)
      for the same `rawWindow`/`normalizationMode` — no new state, no
      additional backend read, same N×N grid and navigation controls shared
      by both.
- [x] Legend text is palette-aware: states the palette name, the
      normalization mode, and the actual low/high endpoint colors
      (black/white or red/violet) instead of assuming grayscale.
      Hover/keyboard pixel inspection is per-canvas and unchanged in
      behavior (row, timestamp, value, missing/beyond state).
- [x] No backend/Tauri contract change, no extra raw-data read, no RGB
      multi-sensor composite, no channel-mapping controls, no generalized
      palette system, and no new dependency.
- [x] Updated `docs/decisions/2026-09-dataset-capture-recording-contract.md`'s
      Raw image viewer section and `docs/using-the-application.md`'s Raw
      image viewer subsection to describe the paired grayscale/rainbow
      rendering as a client-only, non-data-transform choice.
- [x] `graphify update .` run after the source changes.
- [ ] Automated tests, builds, lint, formatting, installs, and runtime
      validation are **DEFERRED / NOT CLEARED** by explicit delivery
      instruction — only the diff and `git diff --check` were inspected.

## GC-014 — Raw image viewer: paired image cards in a responsive grid

- [x] `RawImageViewerPanel.tsx`: the two `RawImageCanvas` instances
      (Grayscale, Rainbow false-colour) are now each wrapped in their own
      shadcn `Card`, laid out as siblings in an explicit
      `grid grid-cols-1 lg:grid-cols-2` — one column on narrow screens,
      side-by-side at desktop widths. Each card contains only that image's
      title, canvas, hover/keyboard inspector text, and legend (all already
      rendered by `RawImageCanvas`); the shared recording/channel/grid/
      normalization selectors and frame navigation stay outside both cards.
- [x] No changes to `RawImageCanvas.tsx`, data normalization, the
      inspection contract, or backend reads; no new dependency — reused the
      existing `Card`/`CardContent` components already imported in this file.
- [x] `graphify update .` run after the source change.
- [ ] Automated tests, builds, lint, formatting, installs, and runtime
      validation are **DEFERRED / NOT CLEARED** by explicit delivery
      instruction — only the diff and `git diff --check` were inspected.

## GC-015 — Replace top AppNav with the official shadcn Sidebar

- [x] Installed the official `sidebar` component via `npx shadcn@latest add
      sidebar` from `apps/desktop` (also generated `sheet.tsx`,
      `use-mobile.ts`, and refreshed `separator.tsx`/`tooltip.tsx` with
      trivial `"use client"` directive changes from the registry).
- [x] `AppNav.tsx` now renders the generated `Sidebar`/`SidebarHeader`/
      `SidebarContent`/`SidebarGroup`/`SidebarMenu`/`SidebarMenuButton`
      directly (no bespoke wrapper), with the same six routes, the same
      `activeTab`/`onSelect` contract, and a lucide icon per tab.
- [x] `App.tsx` wraps the shell in `SidebarProvider`, renders `AppNav`
      alongside a `SidebarInset` holding a `SidebarTrigger` and the existing
      `Suspense`-lazy tab bodies — active-tab state, lazy page rendering,
      overlay window behavior, and all action logic are unchanged.
- [x] Removed the obsolete `.app-tabs` layout/CSS rules (including its
      responsive override and its entry in the shared border-color
      selector list); left all unrelated CSS untouched.
- [x] `graphify update .` run after the source changes.
- [ ] Automated tests, builds, lint, formatting, installs (beyond the
      requested `shadcn add`), and runtime validation are **DEFERRED / NOT
      CLEARED** by explicit delivery instruction — only the diff and
      `git diff --check` were inspected.
