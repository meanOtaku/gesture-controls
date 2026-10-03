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

### Off/Monitor/Live gating of the live inference path

The wiring that loads a verified active model into
`DesktopPinchRuntime<Box<dyn PinchModel>>` and feeds its transitions to
`GesturePolicyRuntime` already existed. This slice makes the Off/Monitor/Live
contract explicit, closes the one place `Monitor` could still reach the
desktop, and pins all three modes with tests.

- [x] `inference::mode_classifies` is now the single, named, unit-tested
      Off/Monitor/Live gate. `active_model_runtime_config` no longer folds
      `Off` into its `None` (it returns the mode in a new
      `ActiveModelRuntimeConfig`), so "`Off` never reaches a model" is stated
      in the live path itself rather than hidden in a registry lookup.
- [x] `inference::decision_actuates` is now the single predicate separating
      `Monitor` from `Live` on the desktop side; `apply_decision` branches on
      it. Every decision is still emitted on `GESTURE_POLICY_EVENT` first, so
      Monitor keeps full observability.
- [x] **Bug fixed:** `Monitor` could perform a real OS-level action. A release
      was unconditionally `live` ("releasing is always safe"), so a
      model-driven `Released` — or any forced release from a rejected/stale
      window — reached `OverlayRuntime::release`, which hides the overlay
      window and ends the wrist-rotation interaction. Since the Watch button
      grabs that same overlay directly (`WatchEvent::Button` in `lib.rs`,
      routing around the policy), monitoring could tear down a Watch-button
      grab it never started. `GesturePolicy` now records whether the grab in
      progress was actually executed (`PolicyState::Grabbed { executed }`) and
      a release is `live` only if the grab it ends was. A Live grab is still
      always releasable, so the fail-closed guarantee is unchanged.
- [x] `GesturePolicy::set_mode` now force-releases on *any* mode change while
      grabbed, not just a downgrade out of `Live`. Previously a grab recorded
      under Monitor survived an upgrade into Live and swallowed the user's
      first real pinch as `IgnoredAlreadyGrabbed`.
- [x] Fail-closed on an absent `litert` feature is unchanged and still correct:
      `load_model_backend` returns `UnavailablePinchModel`, whose every
      `predict` errors, so `DesktopPinchRuntime::submit` fails closed and the
      desktop behaves as `Off`. Default builds remain LiteRT-free.
- [x] Tests: 4 new/updated `interaction-engine` gesture-policy cases plus 6 new
      `pinch-inference` cases driving a stub model through a real
      `GesturePolicy` per mode, and 8 new `InferenceMode` gating cases
      colocated with `inference.rs`.
- [x] Ran locally: `cargo test -p pinch-inference -p interaction-engine`
      — 112 passed, 0 failed (pinch-inference lib 50; interaction-engine lib
      25 plus its 5 integration binaries 7/4/1/2/23) and
      `cargo clippy -p pinch-inference -p interaction-engine --all-targets
      -- -D warnings` clean (with `-A clippy::doc_lazy_continuation`, a
      pre-existing lint at `interaction-engine/src/lib.rs:562-566` that this
      slice does not touch). `rustfmt --check` clean on every file changed.
- [ ] **CI-verified only:** `cargo test -p spatial-gesture-desktop`,
      `cargo clippy --all-targets -- -D warnings`, and
      `cargo fmt --all -- --check`. This host has no Rust toolchain
      preinstalled (rustup was installed into the run), no `pkg-config`, no
      GTK/glib/webkit dev headers, and no passwordless root — the same
      recurring blocker as GC-002/GC-009/GC-018/GC-019/GC-024/GC-025/GC-037.
      Staging the 747-package dependency closure in user space was rejected as
      impractical. The `inference.rs`/`model_registry.rs` changes and the 8 new
      `InferenceMode` tests are therefore **unrun locally**;
      `.github/workflows/desktop-ci.yml` is the verification path.
      Note: `cargo fmt --all -- --check` also reports pre-existing drift in
      `recording_bundle.rs`, `training_label_mapping.rs`, and unrelated regions
      of `model_registry.rs` under rustfmt 1.9.0; those were already unformatted
      at `c12899f` and were deliberately left alone.
- [ ] **Still deferred / not cleared:** feature-enabled cross-platform
      packaging/build validation, and any real Galaxy Watch hardware
      Off/Monitor/Live walkthrough.

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
- [x] GC-015 follow-up: moved `SidebarTrigger` out of normal document flow
      (`absolute left-2 top-2 z-10`), so it no longer consumes the page's
      top space or displaces each view heading.
- [x] GC-015 follow-up 2: removed the overlaying page trigger entirely and
      used the generated `SidebarRail` inside the sidebar for collapse/expand,
      leaving the content inset free of navigation chrome.

## GC-016 — Watch discovery recognizes already-active Wi-Fi

- [x] Seed `DesktopDiscovery` from `ConnectivityManager.allNetworks` before
      waiting for future network callbacks, so discovery starts when the watch
      opens while Wi-Fi is already connected.
- [ ] Automated tests, builds, lint, formatting, installs, and runtime
      validation are **DEFERRED / NOT CLEARED**.

## GC-017 — Dataset CSV output folder and label cleanup

- [x] Dataset CSV export now requires a native selected folder in the desktop
      app and writes the existing generated filename directly there; browser
      preview retains its download fallback.
- [x] The recorder form consolidates label entry, previously-used labels, and
      export-folder selection. Labels can be removed unless an existing
      timeline interval still references one, protecting recorded intervals.
- [x] Added the native dialog open permission required for folder selection.
- [x] Targeted telemetry tests: **37 passed** (CSV export, telemetry export,
      store, and dataset recorder card).
- [ ] Production build is **NOT CLEARED**: the existing unrelated TypeScript
      failures in Model Lab and `RecordingTimelineEditor` remain; no runtime
      desktop verification was performed.

## GC-018 — Timeline Capture becomes a timed recorder; raw import accepts unlabeled legacy CSV

- [x] Timeline Capture is now a timed recorder, not a live-labeling/interval-
      review workflow: the user enters a duration in seconds and clicks Start;
      capture runs for that duration, then stops once and auto-exports the
      generated dataset CSV straight to the already-selected Export folder
      (no save dialog). Quick Capture's own start/stop/export behavior is
      unchanged.
- [x] Duration input (`DatasetCaptureCard.tsx`) is a native, required
      `<input type="number">` (`min`/`max`/`step`, disabled while recording),
      constrained to **1–3600 seconds (up to 1 hour)**. Range chosen against
      `telemetryStore.ts`'s existing capture ceiling: `MAX_CSV_ROWS = 200_000`
      at `DEFAULT_RECORDING_RATE_HZ = 30` gives a real buffer ceiling of
      ~6,666s, so 3600s stays comfortably inside it while still being a
      round, easy-to-reason-about "up to an hour" limit; 1s is the minimum
      duration that can produce a real recording. Start is disabled outside
      this range.
- [x] The timer starts only once the dataset session actually reaches
      `"recording"` (i.e., once the first sample lands), not during
      `"arming"`. It is owned by a `useEffect` in `LiveTelemetry.tsx` keyed on
      `[captureMode, datasetRecordingState]`; the effect's cleanup — which
      React runs on every dependency change as well as unmount — cancels any
      pending `setTimeout`, which is what satisfies cleanup on manual stop,
      mode switch, unmount, and completion with a single mechanism (no
      timer is ever armed twice or left running past its owning session).
      At timeout the session is stopped exactly once; if at least one row was
      captured the CSV is auto-exported through the existing
      `exportDatasetCsv` (native selected-folder write, no dialog, no new
      dependency, no new persisted config); if zero rows were captured, the
      existing `OperationFeedback.error` toast path is used instead (the same
      surfaced-error mechanism `useTelemetryExport` already uses for a
      missing export folder).
- [x] Simplified `DatasetCaptureCard.tsx` for Timeline Capture: removed the
      live-label hotkey controls, the custom-label input/"Apply label"/
      previously-used-labels list, the `RecordingTimelineEditor` (interval
      review/relabel/gap-fill), and the manual "Save recording bundle"
      action. Quick Capture's label controls and behavior are untouched.
      Per instruction, no core store or recording-bundle code was deleted:
      `telemetryStore.ts`'s timeline-interval methods
      (`setTimelineLabel`/`relabelInterval`/`setIntervalCurationStatus`/
      `moveIntervalBoundary`/`splitInterval`/`createInterval`/
      `deleteInterval`) and `buildRecordingBundlePayload` remain intact and
      unused-but-present; `RecordingTimelineEditor.tsx` itself is untouched
      and simply no longer rendered from Timeline Capture.
- [x] Fixed the raw image viewer import failure: a CSV exported from Timeline
      Capture has the legacy 17-column `DATASET_CSV_HEADER` but an empty
      per-row label (raw inspection never uses labels — confirmed by tracing
      `telemetryStore.ts::generateDatasetCsv`, which writes `""` for
      Timeline Capture's rows). `recording_bundle.rs::convert_legacy_dataset_csv`
      no longer rejects an empty trailing label; it converts the row as-is
      once the column count matches, still rejecting any wrong column count.
      No arbitrary CSV mapping was introduced — the header must still match
      `DATASET_CSV_HEADER` exactly. The training/model-lab legacy importer
      (`model_lab.rs::parse_csv`) is untouched and keeps its own, independent
      label validation (`extract_label` on the `# label: <value>` metadata
      comment line, not the per-row field), so this fix does not weaken
      training-data label enforcement.
- [x] Added tests: a `DatasetCaptureCard.test.tsx` case that the duration
      input enforces the 1–3600 range and calls `onStart` with the chosen
      value; a new isolated `LiveTelemetry.timelineCapture.test.tsx` (4
      cases) covering that the timer does not start while merely arming,
      that it stops once and auto-exports exactly once after the duration
      elapses (and never re-fires), and that manual stop/discard before the
      timeout both prevent any auto-export; and a Rust unit test
      (`convert_legacy_dataset_csv_accepts_empty_label_but_rejects_wrong_column_count`)
      asserting the exact unlabeled shape Timeline Capture's own export
      produces is accepted while a wrong column count is still rejected.
- [x] Targeted frontend tests: **`DatasetCaptureCard.test.tsx`
      (10 passed)** + **`LiveTelemetry.timelineCapture.test.tsx` (4 passed)**
      + full `src/features/telemetry` suite **(50 passed, 1 pre-existing
      failure)** — the failing case
      (`LiveTelemetry.test.tsx` › "reports a failed dataset export via toast
      and re-enables the control") is unrelated and pre-existing: its own
      `vi.mock` of `shared/tauri/exportCsv` only stubs `exportCsv`, not the
      `exportCsvToFolder` the real code calls; confirmed identical on `main`
      via `git stash` before any of this task's edits.
      `npx tsc -b --pretty false`: same 5 pre-existing unrelated errors as on
      `main` (`RecordingTimelineEditor.tsx` x2, `IntentBindingEditor.test.tsx`,
      `LabelMappingEditor.tsx`, `ModelLifecycleControls.test.tsx`), none in
      any file touched by this task.
- [ ] Rust build/tests are **NOT CLEARED**: `cargo test`/`cargo check` on
      `spatial-gesture-desktop` fail on this host before reaching any test —
      `gobject-sys`'s build script requires `pkg-config`, which is not
      installed here. This is the same pre-existing host blocker already
      documented under GC-002. The `recording_bundle.rs` diff was instead
      reviewed by eye for correctness (minimal, syntactic `git diff`
      inspection) since it could not be compiled or run locally.
- [x] `git diff --check` clean (no whitespace errors).

## GC-019 — Reduce telemetry top whitespace, add 4×4 raw-image grid, sidebar brand mark

- [x] Reduced `.telemetry-shell`'s `padding-top` from `56px` to `36px`
      (`styles.css`), matching the base `.shell` rule it was previously
      adding 20px on top of. `.telemetry-shell` is used only by
      `LiveTelemetry.tsx` (confirmed via grep), so no other page's spacing
      changed; `.model-lab-shell` and the base `.shell` rule are untouched.
- [x] Added a 4×4 raw-image square-grid option, keeping 8/16/32/64 and the
      64 default unchanged, hop still equal to the selected side length:
      - `recording_bundle.rs`: `RAW_GRID_SIZES` is now `[4, 8, 16, 32, 64]`
        (`[u32; 5]`); `DEFAULT_RAW_GRID_SIZE`/`RAW_WINDOW_MAX_VALUES`/
        `validate_grid_size` needed no other change (4×4 = 16 values, well
        under the existing 4,096 cap from 64×64).
      - `recordingBundle.ts`'s `RAW_GRID_SIZES` (the typed frontend mirror)
        updated to match; `RawImageViewerPanel.tsx`'s grid `<Select>` is
        already driven entirely off `RAW_GRID_SIZES`, so no UI change was
        needed there beyond its doc-comment sizes list.
      - Updated the existing Rust unit test
        `validate_grid_size_allows_only_the_listed_sizes`, which previously
        asserted `validate_grid_size(4).is_err()` — that's now the new
        valid value, so the invalid-size probe was changed to `2`.
- [x] Sidebar brand mark: `AppNav.tsx`'s `SidebarHeader` now renders a
      `lucide-react` `Hand` icon plus a "Spatial Gesture" label, wrapped in
      a `div` with `aria-label="Spatial Gesture"` for a stable accessible
      name in both states. The label `<span>` is hidden via the existing
      `group-data-[collapsible=icon]:hidden` shadcn pattern on collapse, so
      only the icon remains visually; both the icon and the now-redundant
      visible label are `aria-hidden` so screen readers get exactly one
      "Spatial Gesture" announcement regardless of collapse state. No new
      dependency or logo asset — `lucide-react` was already a dependency
      and `Hand` is bundled in it. Sidebar itself is untouched: still the
      generated `Sidebar`/`SidebarContent`/`SidebarMenu*`/`SidebarRail`
      from GC-015, `SidebarRail` remains the sole collapse control, and
      `activeTab`/`onSelect` nav wiring is unchanged.
- [x] Verification run this session:
      - `git diff --check`: clean.
      - `npm run typecheck` (desktop workspace): same 5 pre-existing
        unrelated errors as on `main` before this task's edits (confirmed
        via `git stash`/`git stash pop`) — `RecordingTimelineEditor.tsx` x2,
        `IntentBindingEditor.test.tsx`, `LabelMappingEditor.tsx`,
        `ModelLifecycleControls.test.tsx`; none in any file this task
        touched.
      - `npx vitest run src/app/App.test.tsx`: **18 passed** — covers
        `AppNav`/`Sidebar` rendering and tab-switch behavior, confirming
        nav is unaffected by the brand-mark change.
      - `npx vitest run src/features/telemetry/components/LiveTelemetry.test.tsx`:
        **3 passed, 1 pre-existing failure**, identical on `main` via
        `git stash`/`git stash pop` (same unrelated CSV-export-toast mock
        gap noted under GC-018) — unaffected by the `.telemetry-shell`
        padding change.
- [ ] Rust build/tests are **NOT CLEARED**: `cargo test --lib
      recording_bundle` fails on this host before reaching any test —
      `gobject-sys`'s build script requires `pkg-config`, which is not
      installed here. Same pre-existing host blocker documented under
      GC-002/GC-018. The `recording_bundle.rs` diff (array literal + one
      test assertion) was reviewed by eye instead.
- [ ] No manual/runtime desktop verification (app not launched) — deferred
      per this task's smallest-relevant-check scope.

## GC-024 — M1: recording/collection quality summary (data-collection & derivative-viewer milestone plan)

Implements only **M1** of `.hermes/plans/2026-09-22_072210-data-collection-derivative-viewer-milestones.md`
(timestamp/label auditability); M2–M5 (offline Savitzky–Golay derivative
contract, third Derivative image-viewer canvas, review/export gate, and
training-preparation comparison) are not started and remain the next slices
in that plan's documented M1→M5 delivery sequence.

- [x] `recording_bundle.rs`: new derived-only `get_recording_quality_summary`
      Tauri command (`RecordingQualitySummary`, `compute_quality_summary`):
      row count, timestamp monotonicity/effective sample rate
      (`TimestampStatus::Ok/Warning/InsufficientData`), per-channel missing
      value counts, fully-missing-channel list, label coverage
      (labeled/unlabeled row counts), and short-label-interval flagging
      (< 150 ms — the fixed 500 ms model-window rationale from the plan).
      Reads `raw.csv`/`annotations.json` fresh on every call; writes
      neither. Registered in `lib.rs`'s `generate_handler!`.
- [x] `telemetryStore.ts`: a non-finite source timestamp is now rejected at
      the shared `ingestTimestampedBatch` choke point (covers PPG/heart
      rate/temperature/EDA) and in `ingestWatchOrientation`, instead of
      being accepted or silently fixed — only that one sample is skipped,
      every other sample in the batch still ingests normally.
- [x] `recordingBundle.ts`: `RecordingQualitySummary`/`TimestampStatus`
      types plus `getRecordingQualitySummary()` bridge function mirroring
      the Rust command field-for-field.
- [x] `computeLiveQualitySummary.ts`: client-side equivalent of the backend
      computation over the in-memory Timeline Capture session
      (`DatasetRow[]`/`LiveInterval[]`), so quality is visible **before** a
      bundle is ever saved, not only after.
- [x] `RecordingQualitySummaryCard.tsx`: one shared, read-only summary
      display used by both surfaces below.
- [x] Wired into the saved-recording detail path
      (`RawImageViewerPanel.tsx`, request-version-guarded like the
      existing label-range load) and the pre-save Timeline recorder
      (`RecordingTimelineEditor.tsx`).
- [x] `DatasetCaptureCard.tsx`: marker tooltip now recommends a 300–500 ms
      minimum hold duration tied to the current 500 ms model window.
- [x] Legacy imports/existing raw rows are untouched — the summary is
      purely derived/read-only; nothing here rewrites `raw.csv` or
      `annotations.json` for any recording, new or imported.
- [x] Tests: 5 new Rust unit tests on `compute_quality_summary` (uniform
      50 Hz → `Ok` + correct rate; non-monotonic → `Warning`, rate
      withheld; <2 rows → `InsufficientData`; fully-missing channel
      detection; short-label flagging + labeled/unlabeled row coverage). 6
      new Vitest unit tests on `computeLiveQualitySummary` mirroring the
      same cases plus an open-interval-ignored case. 2 new
      `RawImageViewerPanel` tests (renders the loaded summary; surfaces a
      backend timing warning). All 80 tests across
      `src/features/telemetry/**` pass.
- [ ] **Not cleared / host-blocked:** `cargo test`/`cargo fmt`/`cargo
      clippy` on `spatial-gesture-desktop` cannot run on this host — same
      pre-existing `gobject-sys`/`pkg-config` blocker as GC-002/GC-009/
      GC-018/GC-019 (`pkg-config` not installed). `cargo fmt -p
      spatial-gesture-desktop -- --check` (pure syntax/formatting, no
      linking) was run instead and confirms the new code parses; the 5 new
      Rust tests were reviewed by eye and mirror the already-passing
      Vitest equivalents line-for-line.
- [ ] `npm run typecheck` still reports the same 5 pre-existing errors
      already documented under GC-019 (`IntentBindingEditor.test.tsx`,
      `LabelMappingEditor.tsx`, `ModelLifecycleControls.test.tsx`,
      `RecordingTimelineEditor.tsx` x2) — none introduced by this task; a
      direct `tsc --noEmit -p tsconfig.json` on the touched files reports
      zero errors.
- [ ] No manual/runtime desktop capture or raw-image-viewer walkthrough was
      performed (app not launched on this host).

## GC-025 — M2: offline Savitzky–Golay first-derivative contract (data-collection & derivative-viewer milestone plan)

Implements only **M2** of `.hermes/plans/2026-09-22_072210-data-collection-derivative-viewer-milestones.md`
(offline SG derivative backend contract), following accepted M1 (GC-024).
M3 (third viewer canvas), M4 (review/export gate), and M5 (training
comparison) are not started.

- [x] `recording_bundle.rs`: new `get_raw_recording_derivative_window` Tauri
      command, aligned row/timestamp-for-row/timestamp with
      `get_raw_recording_window` for the same recording/channel/grid
      size/start row. Reads and derives from the *entire* source column
      (never just the requested window) so edge rows of a requested
      sub-window still get real leading/trailing context, then slices to the
      same bounded N×N response shape. `raw.csv`/bundle files are read-only;
      nothing is written.
- [x] `compute_sg_derivative_window`: pure, dependency-free Savitzky–Golay
      order-2, window-11 first derivative with respect to time (not
      row-to-row differencing). Uses the closed-form least-squares
      coefficient `c_i = i / sum(j^2)` (valid for order ≥ 2 by symmetry,
      documented in code), divided by the robust median per-sample cadence
      to convert "per sample" to "per second". A missing/nonfinite value
      anywhere in a row's local 11-sample window withholds only that row's
      derivative (`None`), never interpolated or fabricated; the two rows at
      either true boundary of the source series always withhold a value
      deterministically (no extrapolation).
- [x] `assess_cadence_regularity`: whole-recording gate, fails closed
      (`available: false` + a specific `unavailableReason`) on fewer than 11
      rows, any non-strictly-increasing timestamp delta, or any delta
      outside a documented ±25% band around the robust median cadence — no
      resampling, matching the plan's "Irregular data policy". Accepts an
      ordinary uniform ~50 Hz stream.
- [x] `DerivativeFilterConfig`/`SG_FILTER_VERSION` ("savitzky_golay_order2_window11_v1")
      travel on every response so a cached/compared derivative can never
      silently mix filter versions.
- [x] `recordingBundle.ts`: matching `RawRecordingDerivativeWindow`/
      `DerivativeFilterConfig` types and `getRawRecordingDerivativeWindow()`
      bridge function, field-for-field with the Rust response, with
      precise "offline, saved-data, not live, not training" doc comments.
      No `rawImageViewerStore.ts` change: nothing consumes this bridge call
      yet (M3 owns rendering the third canvas and wiring request-version
      race safety into the store for it), so adding unused store state now
      would be dead code ahead of its only caller.
- [x] Tests: 10 new Rust unit tests on `compute_sg_derivative_window`/
      `sg_first_derivative_coefficients`/`assess_cadence_regularity` —
      coefficient symmetry, constant signal (zero derivative), linear
      signal (exact known slope, row-aligned, and matching when requesting
      a sub-window), a missing-value gap (withholds only the rows whose
      window touches it), a NaN value (treated as missing), too-short input,
      non-monotonic timestamps, irregular/mixed cadence, an ordinary uniform
      50 Hz stream, boundary rows getting real context from *outside* a
      requested sub-window (vs. the true recording boundary), and
      deterministic repeat-call output.
- [ ] **Not cleared / host-blocked:** `cargo test -p spatial-gesture-desktop`
      cannot run on this host — same pre-existing `glib-sys`/`pkg-config`
      blocker as GC-002/GC-009/GC-018/GC-019/GC-024 (`pkg-config` not
      installed; confirmed again this session). `cargo fmt -p
      spatial-gesture-desktop -- --check` (pure syntax/formatting, no
      linking) was run instead and confirms the new code parses; the diff
      introduces zero new formatting violations beyond the file's
      pre-existing (already-unformatted) baseline. The 10 new tests were
      reviewed by eye; the SG coefficient/regularity math was independently
      hand-verified (S2 for m=5 is 110; linear-signal slope recovery is
      exact for a quadratic-order SG filter on an exactly linear signal).
- [x] `npx tsc --noEmit -p tsconfig.json`: zero errors. `npx vitest run
      src/features/telemetry`: **80 passed** (unchanged from GC-024 — no
      new frontend test needed since `getRawRecordingDerivativeWindow` is
      an untested-by-precedent thin `invoke` wrapper, same as the existing
      `getRawRecordingWindow`/`getRecordingQualitySummary`). `git diff
      --check`: clean. `graphify update .`: ran successfully.
- [ ] No manual/runtime desktop walkthrough (app not launched on this host,
      and there is no UI surface yet — M3 adds the viewer panel).

## GC-026 — M3: third derivative image viewer canvas (data-collection & derivative-viewer milestone plan)

Implements only **M3** of `.hermes/plans/2026-09-22_072210-data-collection-derivative-viewer-milestones.md`
(third synchronized Raw image viewer canvas for the M2 offline derivative),
following accepted M2 (GC-025). M4 (review/export gate) and M5 (training
comparison) are not started. Frontend-only slice: M2's Rust backend contract
(`get_raw_recording_derivative_window`) is reused unchanged; no Rust files
were touched.

- [x] `rawImageViewerStore.ts`: `reload()` now also fetches
      `getRawRecordingDerivativeWindow` with the identical
      recording/channel/grid-size/start-row as the existing raw-window
      fetch, guarded by the same shared `isStale()` check (request version
      plus current recording/channel/grid-size). The two fetches resolve
      independently — a slow, failed, or "unavailable" derivative never
      blocks or replaces the raw Grayscale/Rainbow canvases, and vice
      versa. New `getDerivativeStatus()`/`getDerivativeErrorMessage()`/
      `getDerivativeWindow()` getters mirror the existing raw-window ones.
- [x] `RawImageCanvas.tsx`: added a `"diverging"` `colorMode` — a
      zero-centred, frame-scale-only palette (blue = decreasing, white ≈ no
      change, red = increasing) driven by a new `derivativeWindow` prop,
      reusing the same component (not a new/duplicate canvas) for all three
      views. `buildDivergingImageData` computes the frame's max-absolute
      extent and shares the existing `MISSING_COLOR`/`BEYOND_COLOR`
      "not data" fills with the raw canvases. Pixel inspection
      (`describeDerivativePixel`) reports raw row, timestamp, the original
      raw value, the derivative value with its per-second unit, and the
      filter configuration (method/order/window/version) — missing rows
      (series edge or a nearby missing/nonfinite source value) are called
      out explicitly rather than silently rendered as zero. The legend
      states the palette convention and the signed ±scale in text, so
      positive/negative is never a hidden-color convention. Added an
      optional `titleHelp` slot for a heading-adjacent `HelpTooltip`.
- [x] `RawImageViewerPanel.tsx`: renders the third "Derivative
      (Savitzky–Golay)" canvas alongside Grayscale/Rainbow, sharing the same
      recording/channel/grid-size/frame/normalization selection and the same
      `RawImageLabelRangeRail` label overlay so the same saved interval is
      visible over raw and derived values. Explicit states: loading
      (skeleton), fetch error, not-yet-loaded, and whole-recording
      "unavailable" (M2's cadence-regularity gate) rendered as a clear
      message with the backend's reason instead of a blank/misleading
      canvas — never conflated with a per-row missing value. A `HelpTooltip`
      on the canvas heading states this is an offline, saved-data view, not
      a live signal, not used for training/inference, and never written
      back into the recording; the existing Grayscale/Rainbow raw views,
      live telemetry, and Watch behavior are explicitly called out as
      unchanged.
- [x] Tests: 3 new `RawImageCanvas.test.tsx` cases (available-pixel
      description merges raw value + derivative + filter config; a
      missing-derivative row keeps its raw value and states unavailability
      distinctly; the diverging legend shows the signed ±scale and palette
      convention). 2 new `RawImageViewerPanel.test.tsx` cases (derivative
      canvas renders row-aligned with the raw canvas once available;
      whole-recording "unavailable" shows the reason and never renders a
      derivative canvas, while the raw canvases are unaffected). Updated 4
      pre-existing `RawImageViewerPanel.test.tsx` label-range assertions
      from `getByRole`/`queryByRole` to `getAllByRole`/`queryAllByRole`,
      since the label-range overlay is now intentionally shown on both the
      Grayscale and Derivative canvases (M3's own acceptance criterion),
      not because prior behavior was wrong. All 85 tests across
      `src/features/telemetry/**` pass.
- [x] `npx tsc --noEmit -p tsconfig.json`: zero errors (no pre-existing
      errors remained to compare against this session). `git diff --check`:
      clean. `graphify update .`: ran successfully.
- [ ] No manual/runtime desktop walkthrough (app not launched on this host).

## GC-027 — M4: collection review/export gate (data-collection & derivative-viewer milestone plan)

Implements only **M4** of `.hermes/plans/2026-09-22_072210-data-collection-derivative-viewer-milestones.md`
(pre-export data-quality review gate), following accepted M1–M3
(GC-024/GC-025/GC-026). M5 (training comparison) is not started.
Frontend-only slice: reuses M1's `computeLiveQualitySummary` and
`RecordingQualitySummaryCard` unchanged; no Rust files were touched, and no
new timestamp/label-quality rule was added or duplicated.

- [x] `DatasetCaptureCard.tsx`: **Export Dataset CSV** now opens a review
      gate (`AlertDialog`) immediately before export whenever the buffered
      Timeline Capture session has rows (`datasetRows`/`timelineIntervals`
      props, both optional and empty by default). The gate runs the same
      `computeLiveQualitySummary` M1 uses and renders it through the shared
      `RecordingQualitySummaryCard`. A session with no warnings shows a
      plain "Export" action; a session with warnings requires an explicit
      "Export anyway" click. "Cancel" closes the dialog via the existing
      `AlertDialogCancel` primitive and calls nothing — no buffered row,
      interval, or session state is touched. A session with no buffered
      rows (nothing to summarize) calls the export callback directly, with
      no dialog — identical to the prior unconditional-export behavior. A
      thrown/failed summary computation is caught and shown as a bounded,
      non-blocking explanation with a plain "Export" action instead of an
      error loop or a blocked export. Copy explicitly says "data-quality
      review, not model validation" and never claims a recording is
      "training-ready."
- [x] `LiveTelemetry.tsx`: passes `telemetryStore.getDatasetRows()` /
      `getTimelineIntervals()` into `DatasetCaptureCard` so the gate reviews
      the same in-memory session `RecordingTimelineEditor` already
      summarizes; the actual CSV export callback (`exportDatasetCsv`) is
      unchanged.
- [x] `docs/using-the-application.md`: added "Recording quality summary",
      "Export review gate", and a compact numbered "Pinch collection
      protocol" (settle, rest, hold marker for ≥300–500 ms, repeat, capture
      multiple sessions, check quality/labels before export) to the existing
      "Labeled dataset recorder" section — no new document, no accuracy
      claims beyond what M1/M4 actually compute.
- [x] Tests: 5 new `DatasetCaptureCard.test.tsx` cases (no buffered
      summary exports directly with no dialog; clean data shows the gate
      with no warnings and exports on "Export"; warning data requires
      "Export anyway" and surfaces the M1 warning text via `role="alert"`;
      "Cancel" closes the dialog, calls neither export nor discard, and
      leaves buffered data untouched; a thrown quality-summary computation
      shows the bounded explanation and still allows "Export"). Updated 1
      pre-existing `LiveTelemetry.test.tsx` case to click through the new
      "Export anyway" step (one buffered row now trips M1's
      `insufficient_data` warning, which is the intended new gate behavior,
      not a regression). All 90 tests across `src/features/telemetry/**`
      pass (up from 85 in GC-026).
- [x] `npx tsc --noEmit -p tsconfig.json`: zero errors. `git diff --check`:
      clean. `graphify update .`: ran successfully.
- [ ] No manual/runtime desktop walkthrough (app not launched on this host).
- [ ] Rust backend untouched by this slice, so the pre-existing
      `pkg-config`/GTK build blocker (GC-002/GC-009/GC-018/GC-019/GC-024/
      GC-025) was not re-checked here; nothing in this change depends on it.

## GC-037 — Selectable Bluetooth LE Watch transport

- [x] `apps/watch/.../data/connection/WatchTransportLink.kt`: new
      `WatchTransportKind` (persisted, Bluetooth-default) and the single
      transport seam both Watch transports implement.
- [x] `apps/watch/.../data/connection/BleFraming.kt`: MTU-aware
      fragmentation/reassembly, byte-compatible with the desktop.
- [x] `apps/watch/.../data/connection/BleGattTransport.kt`: GATT server +
      advertising, encrypted characteristic permissions, explicit per-desktop
      trust gate, bounded outbound queue drained on `onNotificationSent`.
- [x] `apps/watch/.../data/connection/WebSocketTransport.kt`: the existing
      Wi-Fi socket lifecycle extracted behind the same seam, unchanged.
- [x] `apps/watch/.../data/connection/WatchLinkManager.kt`: now transport-
      agnostic; every `send*`, the heartbeat and both flush timers are shared.
- [x] `apps/watch/.../data/preferences/ConnectionPrefs.kt`: persists the
      transport choice and the trusted desktop address.
- [x] `apps/watch/.../app/MainActivity.kt`, layout, strings, manifest:
      transport radio selector, trust/forget button, `AWAITING_TRUST` state,
      BLE runtime permissions, and per-mode start/stop of the other transport.
- [x] `crates/watch-bridge/src/ble.rs`: btleplug central — scan filtered on the
      service UUID, connect, discover, subscribe, framed notify/write, typed
      actionable errors, `BleStatus` for the UI.
- [x] `crates/watch-bridge/src/lib.rs`: `WatchLinkTransport` seam,
      `run_connection` made generic over it, BLE session with cooperative
      cancellation, `WatchTransport` enum, rebindable Wi-Fi listener.
- [x] Desktop `settings.rs`/`watch.rs`/`lib.rs`: persisted `watchTransport`
      (default Bluetooth), `apply_watch_transport` starting one and stopping
      the other, and `get_watch_transport_status`/`set_watch_transport`/
      `rescan_watch_ble` commands.
- [x] `WatchTransportSection.tsx`: transport selector, BLE state, rescan;
      existing Wi-Fi controls untouched.
- [x] `docs/protocols/watch-ble-transport.md`: UUIDs, framing, backpressure,
      trust model and its limitations, platform support, hardware checklist.
- [x] Tests: 8 Rust BLE framing cases, 3 Rust settings transport-default/
      migration cases, 2 Wear OS test classes (framing + preference default),
      6 frontend transport-section cases.
- [ ] `cargo check -p spatial-gesture-desktop`: still blocked by the
      pre-existing host `pkg-config`/GTK dependency gap, so the desktop
      `settings.rs` tests were not run here.
- [x] Wear OS: installed a user-local Android SDK/JDK, fixed the first real
      compile failure by qualifying `AdvertiseCallback` constants, and ran
      `./gradlew --no-daemon test assembleDebug` successfully (40 tasks).
- [ ] Hardware validation on a real Galaxy Watch + BLE desktop still required.

## GC-038 — Engineering-review remediation and documentation refresh

Addresses the findings of the four engineering reviews in `.hermes/reviews/`
(architecture baseline, sensor timing, data/model lifecycle, gesture-to-action
safety). The per-finding status, with commits, is the canonical record:
[`docs/review-remediation.md`](docs/review-remediation.md). Summary:

**Actuation safety (M4)**

- [x] D-M4-1/2/7: wrist volume writes throttled to 1 per 100 ms; the
      "was this grab executed" bookkeeping and intent remap run under one policy
      lock; the first orientation sample after a grab is velocity-checked.
- [x] D-M4-3/4/5/6: overlay state lock no longer held across native volume calls
      (writes order on their own lock); `show_overlay` requires the backend's
      top-right target; `report_pinch_transition` removed; duplicate transition
      timestamps rejected.
- [x] R-M4-1/2/3/4/6/7: closed-channel loop ends; failed haptic keeps its slot;
      overlay grabs have an owner; teardown bounded at 10 s; mode applied before
      it is persisted, and a persisted `Live` is capped to `Monitor` at startup;
      event name declared once with a drift test.
- [ ] D-M4-7 remainder: the wrist reference pose has no freshness bound.

**Sensor timing (M2)**

- [x] D-1: `max_volume_points_per_second` is a real slew limit; the dead
      smoothing control was removed (old `settings.json` still loads).
- [x] D-2: PPG watermark cleared on disconnect.
- [x] D-3: BLE device id derived from the discovered peripheral and stamped by the
      desktop; Wi-Fi id is a unique persisted per-install value.
- [x] D-4: the watch verifies the orientation sensor clock and rebases it onto
      `elapsedRealtimeNanos` if it differs.
- [~] R-M2-1: live orientation statistics now run over the samples that arrived in
      the window (trainer-verified arithmetic); window membership still
      approximates the offline row model.
- [ ] D-5, D-6, D-7 and the remaining R-M2 risks are open.

**Data and model lifecycle (M3)**

- [x] D-M3-2/3/5/6, R-M3-11/12: save requests validated against their `raw.csv`;
      a corrupt registry is an error, never an empty index; replay uses the
      training label mapping; the desktop holds every bundle to the trainer's
      contract (shared cross-language fixture); label pre-flight uses row labels.
- [~] D-M3-1: a Timeline Capture CSV export now imports and trains; curation
      status and interval boundaries from `annotations.json` still reach nothing.
- [~] R-M3-1: each live PPG window's duration is checked against the bundle's
      `window_ms` (Live refused on mismatch, Monitor allowed) and
      `min_samples_per_window` is enforced; there is no sliding window live.
- [ ] D-M3-4 (curation/editing unreachable), R-M3-2 (input hashes) and the other
      R-M3 risks are open.

**Documentation**

- [x] New: `docs/architecture/components-and-deployment.md`,
      `docs/architecture/safety-and-fail-closed-behavior.md`,
      `docs/review-remediation.md`.
- [x] Updated: `README.md` (default Bluetooth transport, full crate list, test
      commands), `docs/README.md` (complete index), the user guide, running the
      project, the BLE and WebSocket protocol docs, the Wi-Fi-vs-BLE decision (marked
      superseded), the release-readiness checklist, both app `ARCHITECTURE.md`
      files, the watch README, the trainer README, and a status note on the project
      brief. Closes the documentation items F-3 to F-6 of the architecture review.

**Verification and gaps**

- [x] `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
      `cargo test --workspace` (excluding the environment-sensitive
      `native-head-tracking` `ffi_macos` smoke test), `npm test`, `npm run typecheck`,
      the trainer's `pytest`, and the watch's `testDebugUnitTest` passed.
- [ ] The trainer's and the watch's test suites are not run by CI (review G-1).
- [ ] **No physical hardware validation.** Every "fixed" item above is covered by
      automated tests only; the rows marked *(remediation)* in
      `docs/release-readiness.md` are the real-device confirmations still required.

