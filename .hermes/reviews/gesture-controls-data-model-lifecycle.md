# Gesture Controls Data & Model Lifecycle Review — Milestone 3

**Scope:** Milestone 3 of `.hermes/plans/2026-10-02_133139-gesture-controls-architecture-review.md`.
**Date:** 2026-10-02
**Baselines read first:** `.hermes/reviews/gesture-controls-architecture-baseline.md` (M1) and `.hermes/reviews/gesture-controls-sensor-timing.md` (M2, accepted). Their facts, identifiers (F-1…F-6, G-1, R-1…R-4, D-1…D-7, R-M2-1…R-M2-12, T-2/T-3/T-6, G-M2-1…G-M2-6) and carried conditions are honoured and referenced, never restated as new findings.
**Repository state:** branch `main`, local HEAD `6dd50df6c955f44454c66424596caa531aa5ea64`, `origin/main` `6dd50df6c955f44454c66424596caa531aa5ea64` (equal at the start of this milestone). The five pre-existing dirty paths (`package.json`, `package-lock.json`, `.hermes/`, `.presentation-build/`, `status-resp.json`) were left exactly as found; `git status --porcelain` was re-captured after every command and matched the opening capture.
**Nature:** Read-only tracing and verification. No product code, test, dependency, configuration, plan, generated artifact or existing document was modified. **No remediation is proposed or applied** — Milestone 6 owns ranking and fixes. Every scratch script and every artifact produced by this review was written under this job's own scratch directory, outside the repository, and nothing was added to the working tree except this report.

### Milestone 1 and 2 conditions carried forward

1. **`spatial-gesture-desktop` is still unverified by execution on this host**, and this milestone's subject matter lives almost entirely inside it. `cargo test -p spatial-gesture-desktop --no-run` exits `101` (`pkg-config` absent, so `glib-sys` cannot configure) — V-M3-1. Every Rust claim below is source-level, and the crate's own unit tests are cited as *present but unexecuted here* (G-M3-1). `apps/watch/` likewise remains unverified; it plays no part in this milestone's paths.
2. **R-M2-1 and T-3 are treated as open inputs**, not closed findings, exactly as M2 required. This milestone produces the trained bundle M2 lacked (G-M2-6) and uses it for the bundle-contract comparisons, but `litert` is still not compiled and no model was ever executed inside the desktop runtime, so R-M2-1's accuracy cost remains unquantified.
3. **Graphify:** the repository still has **no `.mcp.json`**, so the Graphify MCP server is unavailable; the `graphify query` CLI was used for orientation and that fallback is reported explicitly as required (V-M3-7). The graph is still stale (built at `e91f79d`, two milestones of commits behind HEAD), although the symbol locations it returned for this milestone's subjects happened to match HEAD exactly (`activate_model()` at `model_registry.rs:978`, `with_registry_mutation()` at `:750`, both re-confirmed by reading). **Every citation below was confirmed against primary source at `6dd50df`**; no claim rests on graph output.
4. F-1…F-6, G-1 and D-1…D-7 are untouched and still carried to Milestone 6. Two of M2's defects are squarely data-model findings and are cross-referenced rather than re-derived: **D-6** (`validate_raw_csv_full` never checks timestamp order while `csv_io.load_recording` rejects a decrease) and **D-5** (`MonotonicWallClock.monotonic_ns` carries two different clock domains depending on provenance).
5. R-1 (unignored presentation artifacts, non-product root dependencies) remains the repository owner's call.

---

## Executive findings

The system has a **well-built artifact-safety layer and a broken dataset-to-training seam.**

The model side is genuinely careful. A bundle's `model.tflite` digest is recomputed from the bytes on disk at activation, at rollback and at every runtime (re)load, never trusted from a prior validation (`model_registry.rs:478-547`, `:574-618`). Feature contracts are resolved by canonical index with reordering rejected (`:416-453`). Intent bindings are a closed, per-model, safety-checked mapping — `negative` can never bind to an actuating intent (`:310-356`). Activation requires `Approved` plus a full revalidation under the same lock, and forces any in-progress grab to release before the swap (`:978-1018`, `:659-670`). Single-active enforcement, `previous_active_model_id` and rollback all revalidate rather than trusting state (`:1025-1057`).

What is not built is the path from recorded evidence to a training input, and the comparison of a bundle's declared training settings against what the runtime actually does.

- **D-M3-1 — Timeline Capture labels can never reach training.** `annotations.json` is read by no training code at all. The only trainer input is the legacy dataset CSV, whose import requires a non-empty `# label:` comment and whose loader requires a non-empty label on *every* row (`csv_io.py:122-123`); a Timeline Capture export has an empty session label and blank label cells in every unannotated gap. Both gates reject it (reproduced, V-M3-6). The entire ADR §3–§5 annotation/curation model is collected and then unusable.
- **D-M3-2 — `save_recording_bundle` validates nothing it is handed.** No header check, no row-count cross-check, no interval-bounds check, no label check. `raw_row_count`, `actual_duration_ms`, `raw_source_row_counts` and every `resolved_*` row index are webview-supplied and persisted unverified into the file the module's own header calls immutable evidence. The *import* path, by contrast, generates all of that server-side and runs `validate_raw_csv_full`.
- **D-M3-3 — a corrupt `registry.json` silently erases the model registry.** `load_registry` is `serde_json::from_str(...).unwrap_or_default()` with no warning, unlike its two siblings; the next mutating command then persists that empty index, destroying lifecycle state, thresholds, intent bindings and approval history for every model while the bundle directories remain on disk.
- **D-M3-6 — the desktop validates only the shape fields of a bundle, not its inference-critical settings.** `window_config`, `conversion_parity` and `training` have no field in the desktop's `BundleMetadata` at all; `preprocessing`, `window_semantics` and `feature_contract.version` parse into `Option`s marked `#[allow(dead_code)]`. Two of those three fields are not even emitted by the writer. **Seven scenarios were reproduced in which the trainer's own validator rejects a bundle and the desktop's accepts it** (V-M3-4), including a bundle with no conversion-parity record, a bundle whose parity explicitly failed, a bundle with no training provenance at all, a bundle whose train/test split leaks a session, and a bundle declaring an unsupported normalization policy. The most pointed case is the desktop crate's *own* "valid bundle" test fixture: a four-key document that `bundle.validate_metadata` rejects outright.
- **D-M3-5 — offline replay re-roles labels.** `replay.py:31` builds its dataset with no label mapping, so every user-defined collection label falls through `resolve_target`'s final `return NEGATIVE_TARGET` (`labels.py:168`) to `negative`. Reproduced: 28 windows the training run mapped to `pinch_start` are scored as `negative` on replay of the same files.
- **R-M3-1 — window semantics differ between training, replay and live inference, and nothing compares them.** The bundle declares `window_ms`/`stride_ms`/`min_samples_per_window`; offline replay rebuilds a `WindowConfig` from exactly those declared values; the live desktop path has no window length at all (one `FusedWindow` per PPG batch, M2 C-3) and gates on a `min_sample_count` that is a Rust default constant, not the bundle's number. A bundle declaring `window_ms: 5000` is accepted by both validators and silently ignored live (reproduced, V-M3-4 case 3).

On reproducibility the news is better than expected and precisely bounded: **TFLite training is byte-identical across two runs with identical arguments on this host** (same `model.tflite` SHA-256, same loss to the last digit), and the grouped split is order-independent — but **reversing `--input` order with the same seed produces a different model and different metrics** (V-M3-3). Lineage records the seed, the ordered input paths, the group split, the TF version and the full metric set; it records **no content hash of any input, no recording id, no device identity, and no tool version other than TensorFlow's**.

Six confirmed defects, thirteen risks, six evidence gaps and three deliberate tradeoffs are recorded below.

---

## Recording lifecycle

### The write path, cited end to end

| Step | Owner | Citation |
| --- | --- | --- |
| Live sample accepted into the session buffer, inserted at its chronological position by `timestampNs` (not appended), with every timeline interval boundary at or after the insertion point shifted by one | webview store | `telemetryStore.ts:646-676` (`pushDatasetRowSorted`) |
| Genuine orientation rows leave PPG columns `null` rather than carrying forward, so each channel keeps its own cadence (GC-030) | webview store | `telemetryStore.ts:905-920` |
| Arming → Recording on the first accepted sample; `datasetRecordingStartedAtMs`, `datasetActualStartAtIso`, `datasetActualStartMonotonicMs` all stamped there | webview store | `telemetryStore.ts:1074-1081` |
| Stop closes any open interval at `performance.now()` and the current row count; state → `saved` | webview store | `telemetryStore.ts:678-687` |
| Bundle payload built: `raw.csv` text (16 columns, no label), `recording.json` fields, `annotations.json` intervals | webview store | `telemetryStore.ts:739-805` |
| Persisted immediately after Stop | export hook | `useTelemetryExport.ts:74-79` |
| `save_recording_bundle`: id validation, id/annotations-id agreement, non-empty CSV, 20 MiB cap, refuse an existing directory, stage into `<id>.tmp`, rename the whole directory into place | Tauri command | `recording_bundle.rs:295-340` |
| Three files written inside the staging directory | Tauri command | `recording_bundle.rs:2286-2303` |

`raw.csv` immutability is real in the strong sense: no command in the module ever opens it for writing after the rename. `set_interval_curation_status` touches only `annotations.json`, through its own sibling-tmp-plus-rename (`:2252-2284`). `delete_recording_bundle` is the only removal path and it loads the bundle first to confirm the id resolves to a well-formed bundle before removing anything (`:665-678`).

### D-M3-2 (confirmed) — the save path trusts the webview for everything the import path verifies

`save_recording_bundle` performs four checks (`:301-313`): id charset, `recording_id == annotations.recording_id`, non-empty CSV, size cap. It then writes. It never calls `validate_raw_csv_full` — the only call sites are the import path (`:533`) and tests (`:2789-2862`, `:2939`). Consequently, for a manually captured bundle:

- `raw.csv`'s header is never checked against `RAW_CSV_HEADER` (`:45-62`), and no field is checked for numeric parseability.
- `recording.raw_row_count` and `raw_source_row_counts` are never cross-checked against the CSV's actual row count, although `RecordingBundleSummary` publishes `raw_row_count` straight from metadata (`:245`) and `compute_quality_summary` derives its own count from the file (`:2094`) — so a disagreement between the two is silently possible and visible only by comparing two different reads.
- `actual_duration_ms` is the webview's `Date.now()` delta (`telemetryStore.ts:748`), unrelated to the CSV's own timestamp span.
- No interval is validated: `resolved_start.raw_row` / `resolved_end.raw_row` are never bounded against the row count, never required to be ordered, `label_id` is never checked against the label registry, and overlap is never rejected. Those invariants exist only in the webview (`timeline.ts:35-54`, `telemetryStore.ts:585`, `:631`).

The asymmetry is the finding, not the webview's current correctness: `import_recording_from_raw_csv` deliberately distrusts browser-supplied metadata and generates all of it server-side (`:504-515`, `:516-606`), and the module's own doc comment says so. The save path is the same trust boundary with none of the same checks.

### Crash and partial-write behaviour

| Scenario | Behaviour | Evidence |
| --- | --- | --- |
| Crash between staging and rename | `<id>.tmp` survives; `list_recording_bundles` skips any directory whose pair fails to parse rather than failing the listing | `recording_bundle.rs:608-640`; test `list_recording_bundles_skips_unparsable_tmp_directories` (`:2445`) |
| Re-save of the same recording id | Refused — "raw.csv is immutable and never overwritten" | `:318-324` |
| Stale `<id>.tmp` from a previous crash, same id retried | Removed and re-staged | `:326-329` |
| Any write failure during staging | Staging directory removed, error returned, nothing visible | `:330-337` |
| Rename failure | Staging directory removed | `:334-337` |
| Crash between `annotations.json.tmp` write and its rename | Orphan `annotations.json.tmp` beside an intact `annotations.json`; nothing cleans it up, nothing reads it | `:2280-2283` |
| Durability of either rename | **No `fsync` anywhere.** A repository-wide search for `fsync`/`sync_all` across `apps/desktop/src-tauri/src` and `crates` returns nothing — R-M3-4 | V-M3-8 |

**R-M3-4 (risk, medium).** All four atomic writers in the app — `write_bundle_files` + rename (`recording_bundle.rs:2286-2303`), `set_interval_curation_status` (`:2277-2283`), `write_registry_atomic` (`model_registry.rs:291-302`), `write_index_atomic` (`model_lab.rs:328-339`) and `settings::write_atomic` (`settings.rs:320-331`) — write then rename with no `fsync` of the file and no `fsync` of the containing directory. Rename gives all-or-nothing *visibility* to a later reader in a running system, which is what the comments claim; it does not give durability across power loss, where a renamed file can be observed as zero-length. **Unverified by experiment** — no power-loss or crash-injection test was run here, and none exists in the repository (G-M3-3).

**R-M3-8 (risk, low).** A cancelled or failed training run leaves `models/<model-id>/` on disk with its `label_mapping.json` and whatever the trainer had written. Nothing removes it (`model_lab.rs:566-645` registers only on `Completed` at `:638-641`; no cleanup path exists), and `read_trained_models` lists any directory holding a readable `metadata.json` or `model_card.json` (`:496-535`). So a directory can appear in the trained-models list with no registry record at all, in which case `activate_model` fails with "no registered model with id …" (`model_registry.rs:795-802`) — fail-closed, but the orphan is permanent.

---

## Label and interval semantics

### Ownership and authority

Labels are **user-owned stable slugs** in a persistent catalogue that archives rather than deletes, "so an imported historical recording remains interpretable" (`label_registry.rs:1-4`, 14 built-ins at `:16-46`). `LabelRole` on a catalogue entry is explicitly **presentation-only and never authoritative for training** (`:48-53`) — training roles are decided per run by an explicit versioned mapping (`training_label_mapping.rs:1-12`, `labels.py:1-22`). That separation is clean and is stated identically on both sides.

Within a recording, **the interval list is the authoritative annotation record** and the per-row `label` column is explicitly "a compatibility view only" (`telemetryStore.ts:1062-1072`).

### Interval semantics, with the boundary convention made explicit

| Property | Rule | Citation |
| --- | --- | --- |
| Live interval row range | `[startRawRow, endRawRow)` — **end exclusive** | `timeline.ts:9-13` |
| Persisted `resolved_end.raw_row` | `endRawRow - 1` — **end inclusive** | `timeline.ts:69-76` |
| Quality-summary row coverage | `end - start + 1` — consistent with the inclusive persisted form | `recording_bundle.rs:2156-2166` |
| Legacy-import intervals | one per maximal contiguous same-label run, inclusive `end_row` | `recording_bundle.rs:435-500`, `:563-583` |
| Zero-row interval | `isDegenerate`; discarded, never persisted | `timeline.ts:34-36`, `telemetryStore.ts:792` |
| Overlap | Rejected for every live and post-capture edit, open intervals included | `timeline.ts:38-54`, `telemetryStore.ts:585`, `:631` |
| Gaps | Stay unannotated; never implicitly negative | ADR `:51`, `telemetryStore.ts:1070` |
| Boundary resolution rule version | Fixed at `1`, persisted per interval | `telemetryStore.ts:95`, `recording_bundle.rs:175` |
| Revision | Bumped on relabel, curation change, boundary move, split | `telemetryStore.ts:552`, `:559`, `:588`, `timeline.ts:100-108`, `recording_bundle.rs:2271` |

The exclusive→inclusive conversion is correct today but is a **hand-maintained convention across the TS/Rust boundary with no shared fixture and no Rust-side assertion of it** — the same class of gap M1 recorded as C-1…C-5 and M2 resolved by mechanical diff. It is listed here as part of G-M3-6, not as a defect.

### D-M3-1 (confirmed, high) — the annotation model cannot reach training

Nothing in `tools/pinch-classifier/` reads `annotations.json`, `recording.json`, or a recording bundle directory; the only loader is `csv_io.load_recording`, which consumes the 17-column legacy dataset CSV (`csv_io.py:53-137`). There is no Rust command that converts a bundle into a dataset CSV: the trainer's inputs are resolved exclusively from ids already present in the Model Lab dataset index (`model_lab.rs:454-477`), and the only way into that index is `import_model_dataset` from a user-picked file (`model_lab.rs:342-397`, `ModelLab.tsx:249`).

A Timeline Capture session's own export is rejected at both ends (V-M3-6):

```text
A1 desktop import_model_dataset: REJECT (missing '# label: <value>' metadata line)
A2 trainer load_recording:       REJECT missing 'label' value
```

- `generateDatasetCsv` writes `# label: ${session?.label ?? ""}` and a Timeline session's label is always `""` (`telemetryStore.ts:704`, `:490`). `extract_label` only returns a value for a non-empty one (`model_lab.rs:213-227`), so `parse_csv` fails with "missing `# label: <value>` metadata line required to import a dataset" (`:284-286`).
- Even past that gate, every unannotated gap row carries an empty label cell (`telemetryStore.ts:1070`), and `load_recording` raises `CsvFormatError` on the first one (`csv_io.py:122-123`).

Quick Capture works: its session label is stamped into the comment and `currentDatasetRowLabel()` returns that same label for every row (`telemetryStore.ts:1071`), so the file satisfies both gates. The consequence is precise: **multi-interval labelling, post-capture editing, boundary resolution and curation exist, are persisted, and feed nothing.** The ADR anticipated this ("the current fixed-label CSV pipeline remains a compatibility path until the snapshot adapter is implemented", ADR `:146`), which is why the *missing snapshot adapter* is recorded as G-M3-2 rather than as a defect; the defect is that the collected curation and interval data has no consumer at all today, including the `excluded` curation state the ADR requires the trainer to honour (ADR `:77`).

### D-M3-4 (confirmed, medium) — curation and post-capture editing are unreachable

- `set_interval_curation_status` (`recording_bundle.rs:2252-2284`) and its client wrapper `setIntervalCurationStatus` (`recordingBundle.ts:474`) have **no caller anywhere in `apps/desktop/src` outside the client module and tests** (V-M3-9).
- `RecordingTimelineEditor` — the component whose doc comment describes split/move/relabel/curate/delete/fill-gap — is **mounted nowhere**; the only occurrences of its name are its own definition and its test (V-M3-9).
- The store's post-capture editors (`relabelTimelineInterval`, `splitTimelineInterval`, `moveTimelineIntervalBoundary`, `createTimelineInterval`, `deleteTimelineInterval`, `setTimelineIntervalCurationStatus`, `telemetryStore.ts:545-650`) all require state `saved`, which is reached only *after* `saveDatasetRecording` has already written the bundle (`useTelemetryExport.ts:74-79`, whose own comment notes it runs "right after a manual Stop, so it never races later interval edits"). **There is no command that writes an edited interval set back to a saved bundle** — only curation status has one, and it is uncalled.

Net effect: a persisted `annotations.json` always carries `curation_status: "unreviewed"` and the interval set as it stood at Stop. Every post-capture edit is lost when the view unmounts.

### R-M3-7 / R-M3-9 / R-M3-10 (risks, low)

- **R-M3-7.** `labeled_row_count` sums per-interval row spans and then clamps with `.min(row_count)` (`recording_bundle.rs:2156-2171`). Overlapping intervals therefore inflate the sum and the clamp hides it: coverage reads as complete and `unlabeled_row_count` as zero. Overlap cannot arise through the webview today (above), but Rust accepts it (D-M3-2), so the one place that would surface it instead conceals it.
- **R-M3-9.** `toAnnotationInterval` falls back to `source_timestamp_ns: 0` when a row index is out of range (`timeline.ts:71`, `:75`) — a fabricated value in a provenance field rather than an error. Unreachable with correct bookkeeping; `pushDatasetRowSorted`'s boundary shifting (`telemetryStore.ts:666-674`) is what keeps it so.
- **R-M3-10.** `splitInterval` overwrites the *original* half's `created_at` with the split time (`timeline.ts:101`), losing the original annotation's creation timestamp. Audit-only impact, and moot while D-M3-4 stands.

---

## Dataset integrity and lineage

### What a training run actually persists

`metadata.json` top-level keys, read off a real bundle produced in this review (V-M3-3):

```text
['classes', 'conversion_parity', 'feature_contract', 'model', 'preprocessing', 'schema_version', 'training', 'window_config']
training keys: ['batch_size', 'epochs', 'final_training_loss', 'groups_test', 'groups_train',
                'input_files', 'learning_rate', 'metrics', 'model_type', 'n_windows_test',
                'n_windows_train', 'random_seed', 'tensorflow_version']
```

| Lineage element the criterion asks for | Persisted? | Evidence |
| --- | --- | --- |
| Recording IDs | **No.** Nothing in the chain carries a `recording_id`; the bundle pipeline and the training pipeline do not meet (D-M3-1) | `bundle.py:40-88`; `dataset.py:1-7` |
| Source / device identity | **No.** No source id, no watch identity. M2's D-3 already established `deviceId` is the compile-time constant `"galaxy-watch-4"`, so even the live path cannot distinguish devices | `bundle.py:76-88` |
| Feature contract | **Yes** — `count` + `ordered_names`, canonical order enforced on both sides | `bundle.py:68-71`, `features.py:51-79`, `model_registry.rs:416-453` |
| Split strategy | **Yes, as an outcome:** `groups_train`/`groups_test` (session ids) and window counts; the *policy* (`GroupShuffleSplit`, `test_size`) is **not** recorded — `test_size` appears in no metadata field | `train_tflite.py:233-243`; `train.py:93-101` |
| Random seed | **Yes** | `train_tflite.py:247`, `bundle.py:81-84` |
| Normalization | **Declared, and genuinely embedded in the model graph** — a `keras.layers.Normalization` adapted on the training split only, inside the exported graph, so it travels with `model.tflite` rather than being a runtime contract | `train_tflite.py:112-131`; `bundle.py:19-25` |
| Metrics | **Yes** — accuracy, macro F1, full classification report, confusion matrix, false-activation count/rate | `train_tflite.py:183-196`, `:241` |
| Tool / runtime versions | **Partly.** `tensorflow_version` only. No Python, numpy, sklearn, `pinch-classifier` package version, OS or git commit. The *sklearn* card records `package_version`, `sklearn_version`, `numpy_version` — the deployable backend records none of them | `train_tflite.py:246`; `train.py:193-196` |
| Artifacts | **Yes** — `model.tflite` + `metadata.json`, plus the run's `label_mapping.json` written by the desktop into the same output directory | `bundle.py:213-218`; `model_lab.rs:718-724` |
| Hashes | **Of the model only.** `model.sha256` is computed and verified. **No hash of any training input**, and no hash or reference to `label_mapping.json` | `bundle.py:32-37`, `:62`, `:205-211` |
| Provenance of inputs | **Paths only**, in order: `input_files: [str(path) …]`, i.e. absolute app-data paths of the dataset CSVs | `train_tflite.py:242` |

### R-M3-2 (risk, high) — lineage is path-based, not content-based

The group key is the CSV filename stem (`csv_io.py:131`, `dataset.py:1-7`), which under the app is the dataset's own UUID (`model_lab.rs:298-300`), so `groups_*` and `input_files` *do* attribute a model to specific managed datasets — a real and usable link to the dataset index (`model_lab.rs:64-72`). What is absent is any way to prove the bytes behind those paths are the bytes that trained the model: no input hash, and no immutability guarantee on the dataset CSV (`delete_model_dataset` removes the file and its index entry, `model_lab.rs:413-437`, leaving a model whose `input_files` point at nothing). Combined with the absent recording id, a model's dataset provenance is **attributable but not verifiable, and not traceable back to a recording or a device.**

The ADR specifies exactly the missing piece — a trainable dataset snapshot recording "source recording IDs and annotation revisions; approved intervals and their resolved boundaries; explicit raw-label-to-training-target mapping; feature/window schema; split/grouping policy by recording ID; and content hashes" (ADR `:68-75`) — and states it is not yet built (ADR `:146`). Recorded as **G-M3-2**, an unimplemented decision, not a contradiction.

### R-M3-12 (risk, medium) — the pre-flight label check validates the wrong label set

`start_training_job` collects the **dataset-level** labels (one per imported CSV, from its `# label:` comment) and checks the effective mapping covers those (`model_lab.rs:685-701`, `training_label_mapping.rs:6-8`). The trainer resolves the **per-row** labels and rejects the run if any lacks a mapping entry (`dataset.py:52-66`). Nothing checks that the comment label and the row labels agree — `parse_csv` validates only column counts in data rows (`model_lab.rs:272-281`), and the registry check applies to the comment label alone (`:356-360`). A file whose comment says one label and whose rows say another therefore passes the desktop's pre-flight and either fails deep inside the trainer subprocess (surfacing as a trainer exit message) or, if the row label happens to be in the legacy vocabulary, trains silently under the legacy mapping's `negative` role.

### Carried from M2 (restated as data-model relevance, not re-derived)

**D-6** is the integrity hole on the ingest side: the desktop accepts and persists a `raw.csv` whose timestamps decrease, while `csv_io.load_recording` rejects the first decrease as a hard error (`recording_bundle.rs:350-402` vs `csv_io.py:101-106`). **D-5** means `actual_start.monotonic_ns` is the WebView clock for a captured bundle and the watch's own clock for an imported one, with no field distinguishing them.

---

## Training reproducibility

Executed on this host against a real TensorFlow 2.21.0 install in `tools/pinch-classifier/.venv` (V-M3-3). Twelve synthetic sessions (4 × `idle`, 4 × `pinch_start`, 4 × `pinch_release`), `--window-ms 200 --stride-ms 100 --test-size 0.25 --random-seed 4 --epochs 2 --batch-size 16`, run three times: **A** and **B** with identical arguments, **C** with the same files in reversed `--input` order.

```text
A sha256: da82960263732b0daa054f39b5c83345172399041ef9d2639ec389e4fe131c41
B sha256 (identical args):          da8296…31c41   A==B bytes: True
C sha256 (reversed --input order):  f99abb…4f82b   A==C bytes: False
A: loss=1.2713932991027832 acc=0.7142857142857143 groups_test=['idle_3','release_0','release_2'] n_train=126 n_test=42
B: loss=1.2713932991027832 acc=0.7142857142857143 groups_test=['idle_3','release_0','release_2'] n_train=126 n_test=42
C: loss=1.2835583686828613 acc=0.6666666666666666 groups_test=['idle_3','release_0','release_2'] n_train=126 n_test=42
A==B metrics: True   A==C metrics: False   A==C groups_test: True
```

| Reproducibility axis | Verdict | Mechanism |
| --- | --- | --- |
| Same arguments, same host | **Bit-identical model and identical metrics** | `tf.keras.utils.set_random_seed(random_seed)` plus best-effort `enable_op_determinism()` before the model is built (`train_tflite.py:112-118`) |
| Split determinism | **Deterministic and input-order-independent** — `groups_test` identical in all three runs | `GroupShuffleSplit(n_splits=1, test_size, random_state=seed)` over `np.unique(groups)` (sorted) (`train.py:93-101`) |
| Grouped leakage | **Structurally prevented and asserted in metadata validation** — a run whose `groups_train ∩ groups_test` is non-empty fails `validate_metadata` | `bundle.py:196-197`; `dataset.py:1-7` |
| Window/feature determinism | **Deterministic** — segmentation, striding and feature extraction are pure over the parsed arrays | `windowing.py:72-104`, `features.py:103-158` |
| Preprocessing determinism | **Deterministic and travels with the artifact** — normalization adapted on `x_train` only, embedded in the graph | `train_tflite.py:120-131` |
| **Input ordering** | **Not reproducible.** Same files, same seed, reversed order → different weights and different metrics | Row order of the feature matrix follows `--input` order (`dataset.py:67-88`); `model.fit(..., shuffle=True)` (`train_tflite.py:215-222`) then composes different batches |
| Environment dependence | **Unbounded.** `enable_op_determinism()` failures are swallowed (`train_tflite.py:115-118`); only `tensorflow_version` is recorded, so cross-host or cross-version reproduction is not assessable from the artifact | `train_tflite.py:113-118`, `:246` |
| Repository test coverage | **The deployable backend has no determinism test.** `test_train_cli_is_deterministic` covers the *sklearn* baseline and compares accuracy, confusion matrix and `groups_test` — not model bytes | `tests/test_train.py:57-77`; `tests/test_train_tflite.py` has no equivalent |

**R-M3-3 (risk, medium).** Order sensitivity is recoverable in principle — `training.input_files` preserves the order used — but only as long as those paths still hold the same bytes, which nothing records (R-M3-2). The honest statement is: *a run is reproducible on this host from its own metadata plus unchanged input files; it is not reproducible from the metadata alone, and cross-environment reproducibility is untested and unrecorded.*

---

## Model bundle compatibility

### What each side validates

`load_and_verify_bundle` (`model_registry.rs:478-547`) is the single choke point for activation, rollback, runtime (re)load, custom import and replay resolution. It checks: `schema_version == 1`; `classes` exactly `["negative","pinch_start","pinch_release"]` in index order; `feature_contract.count == len(ordered_names)`; every name known, unique, and in canonical `FEATURE_NAMES` order (`:416-453`); `model.file == "model.tflite"`; `model.format == "TFLite"`; `input_shape == [1, declared_feature_count]`; `output_shape == [1, CLASS_COUNT]`; `model.sha256` well-formed; and the digest **recomputed from the bytes on disk** (`:456-466`, `:534-546`).

What it does not look at: `window_config`, `conversion_parity` and `training` have **no field in `BundleMetadata` at all** (`:388-403`); `preprocessing` and `window_semantics` are `Option<serde_json::Value>` with `#[allow(dead_code)]` and the comment "Accepted for forward-compatible parsing of the bundle schema but not yet read by any validation" (`:395-402`); `feature_contract.version` is the same (`:379-387`). `input_dtype`/`output_dtype` are not modelled either.

Two of those three forward-compatible fields **do not exist in any bundle this system produces** (V-M3-3): `window_semantics` is absent — the writer emits `window_config` (`bundle.py:72-79`) — and `feature_contract.version` is never written (`bundle.py:68-71`). So the M1-located gap is wider than M1 could state: those `Option`s are structurally always `None`.

### Reproduced divergences (V-M3-4)

The desktop crate cannot be built on this host (G-M3-1), so its checks were **re-expressed step for step in Python from `model_registry.rs:478-547`** — the same technique M2 used for Kotlin framing in C-2 — and each candidate document was run through both that re-expression and the trainer's real `bundle.validate_metadata`.

| # | Bundle | Desktop (re-expressed) | Trainer `validate_metadata` |
| --- | --- | --- | --- |
| 1 | real bundle from `pinch-classifier-train-tflite` | ACCEPT | ACCEPT |
| 2 | **the desktop crate's own `write_valid_bundle` fixture** (`model_registry.rs:1291-1320`: 4 keys, no `preprocessing`/`window_config`/`conversion_parity`/`training`) | ACCEPT | **REJECT** — "preprocessing does not match the supported deployment policy" |
| 3 | real bundle, `window_config.window_ms` 200 → 5000 | ACCEPT | ACCEPT *(neither side compares it to the runtime — see R-M3-1)* |
| 4 | real bundle, `window_config.min_samples_per_window` 3 → 99 | ACCEPT | ACCEPT *(same)* |
| 5 | real bundle, `preprocessing.normalization` → "none; raw feature values fed directly" | ACCEPT | **REJECT** — preprocessing policy mismatch |
| 6 | real bundle, `conversion_parity` removed | ACCEPT | **REJECT** — "must record a passed source-vs-TFLite check" |
| 7 | real bundle, `conversion_parity.passed` → `false` | ACCEPT | **REJECT** — same |
| 8 | real bundle, `training` block removed (no seed, no groups, no input files) | ACCEPT | **REJECT** — required training fields |
| 9 | real bundle, `groups_test` set to a training session (split leak) | ACCEPT | **REJECT** — "training group split leaks a session between train and test" |
| 10 | real bundle, `model.sha256` → 64 zeros | **REJECT** — digest mismatch | REJECT when the bundle directory is supplied (`bundle.py:205-211`), which `write_and_validate_metadata` always does (V-M3-5) |

**D-M3-6 (confirmed, high).** Seven documents (2, 5, 6, 7, 8, 9 and the pair 3/4 as the silently-ignored case) establish that the desktop's activation gate is strictly weaker than the trainer's own writer-side validation on every axis except the model digest. For an app-trained bundle this is mostly harmless, because `write_and_validate_metadata` refuses to write a bundle that fails the strict contract (`bundle.py:213-218`) — but `import_custom_tflite_bundle` (`model_registry.rs:831-889`) is an explicit path for a bundle this system did not produce, validated **only** by `load_and_verify_bundle`, before and after the copy. A third-party or hand-edited bundle with no conversion-parity evidence, no training provenance, a leaked split, and an unsupported preprocessing policy is accepted, registered as `Draft`, and — once approved and bound — activatable.

Case 10 is **not** a divergence: it is listed because an earlier call shape (`validate_metadata` without `bundle_dir`) makes it look like one. Verified both ways (V-M3-5): with the directory supplied, the trainer rejects a digest mismatch exactly as the desktop does.

### R-M3-1 (risk, high) — inference-critical window settings are never compared with the runtime

| Setting | Training value (declared in the bundle) | Offline replay | Live desktop runtime |
| --- | --- | --- | --- |
| Window length | `window_config.window_ms` (default 500.0, `windowing.py:24`) | **Honoured** — `WindowConfig` is rebuilt from the bundle's declared values (`replay.py:28-30`) | **No window length exists.** One `FusedWindow` per PPG batch (M2 C-3, `features.rs:73-95`, `fusion.rs:95-137`) |
| Stride | `stride_ms` (default 150.0, `windowing.py:25`) | Honoured | No concept of stride |
| Max gap | `max_gap_ms` (default 250.0, `windowing.py:26`) | Honoured | Replaced by `ORIENTATION_STALENESS_TIMEOUT_NS = 500 ms` and the staleness watchdog (M2) |
| Minimum samples | `min_samples_per_window` (default 3, `windowing.py:27`) | Honoured | `QualityGateConfig::min_sample_count`, a **Rust default of 3** whose comment claims it "Matches windowing.py's DEFAULT_MIN_SAMPLES_PER_WINDOW" (`model_registry.rs:113-120`) but which is read from the registry record, never from the bundle (`:693-706`) |
| Boundary policy | `"windows never cross recording, label, or max_gap_ms boundaries"` (`bundle.py:78`) | Structurally honoured | Not applicable |

So the same bundle is evaluated under its declared window semantics offline and under batch-shaped semantics live, and a bundle whose declared settings differ from both defaults activates without a word (cases 3 and 4). This is the concrete form of M2's carried question. Note also that `validate_metadata` accepts `min_samples_per_window == 1` (`bundle.py:132-134`) while `WindowConfig.__post_init__` requires ≥ 2 (`windowing.py:44-45`), so a hand-edited bundle declaring 1 is activatable on the desktop and makes `replay.py` raise — a small, loud, bounded inconsistency.

### R-M3-5 / R-M3-6 (risks)

- **R-M3-5 (medium).** The loaded backend is rebuilt — and the bundle therefore re-digested — only when `needs_reload` is true, and that compares `model_id` and `thresholds` alone (`inference.rs:487-492`). A `model.tflite` replaced on disk while the same model stays active with unchanged thresholds is not re-validated until the next swap, so the digest guarantee covers *load time*, not *continuous* agreement with disk. Fail-safe in the sense that the bytes already loaded are the bytes that were verified; the gap is attestation, not execution of unverified bytes.
- **R-M3-6 (medium, unverified).** Nothing on the Rust side inspects the interpreter's own input signature. `LiteRtPinchModel::load` compiles the file (`litert_model.rs:33-42`) and `predict` builds an input tensor of `[1, features.len()]` from the *metadata-declared* feature count (`:47-52`). A bundle whose `metadata.json` declares 55 features while `model.tflite` accepts 10 passes `load_and_verify_bundle` — the digest matches its own file — and fails at LiteRT run time, which `submit` converts into a forced release (M2 C-4 root cause, `model.rs:35-59`, `runtime.rs:64-68`). Fail-closed by design; **unverified here**, since `litert` is not compiled (G-M3-5). The trainer does check the interpreter contract, but only at conversion time (`train_tflite.py:150-154`).

### T-M3-1…T-M3-3 (tradeoffs, not defects)

- **T-M3-1.** Subset feature bundles are a deliberate Rust-only capability (M2's T-3). `validate_feature_subset` rejects reordering precisely because live inference selects by canonical index (`model_registry.rs:405-415`, `features.rs:284-286`).
- **T-M3-2.** `model_is_activatable` checks only file presence, justified in its own comment by the fact that `metadata.json` "is only ever written by `write_and_validate_metadata`" (`model_registry.rs:769-775`). That justification is sound for app-trained bundles and false for imported ones — but the full revalidation runs immediately after it in `activate_model` (`:1002-1006`), so the weaker check is a better error message, not a weaker gate.
- **T-M3-3.** The offline replay path is deliberately stricter than activation: it runs the trainer's full `validate_metadata` with the bundle directory (`replay.py:26-27`) and refuses a non-approved model (`model_registry.rs:718-731`).

---

## Activation and rollback

### The state machine

Legal transitions are a closed, unit-asserted table (`model_registry.rs:50-67`): `Draft→Evaluated`, `Evaluated→Approved`, `Evaluated→Archived`, `Approved→Archived`, `Approved→Evaluated`, `Archived→Draft`. Everything else is refused (`legal_transition_allows_draft_evaluated_approved_and_denies_skips`, `:1152`; `legal_transition_allows_archive_and_restore`, `:1162`).

| Guarantee | Mechanism | Citation | Proof status |
| --- | --- | --- | --- |
| Approval required before activation | `state != Approved` → error | `:983-990` | Source only (G-M3-1) |
| Full revalidation at activation under the same lock as the state check | `model_is_activatable` then `ActiveModelSnapshot::verified` | `:995-1006`, `:574-618` | Source; `load_and_verify_bundle` has 14 unit tests (`:1372-1560`), **unexecuted here** |
| Complete, safe intent bindings required | `validate_intent_bindings` inside `verified` | `:329-356`, `:580` | 6 unit tests (`:1241-1279`), unexecuted here |
| Bindings immutable once Approved/Active | explicit state check | `:957-967` | Source only |
| Single active model | `activate_model` demotes the outgoing model to `Approved` and sets `active_model_id` in one mutation | `:1008-1017` | Source only |
| No grab survives a model swap | `force_release_before_swap` resets the backend and forces a policy release before the swap, in both activation and rollback | `:659-670`, `:1007`, `:1040` | Source; the policy side is covered by `inference.rs` tests (`:818-858`), unexecuted here |
| The active model cannot be transitioned out from under itself | `transition_model_state` refuses the active id | `:905-909` | Source only |
| Rollback revalidates the restored model rather than trusting its earlier approval | `verified` before the swap | `:1034-1038` | Source only |
| Rollback is reversible | `previous_active_model_id` is set to the outgoing model | `:1053-1054` | Source only |
| Every registry mutation is serialized and atomically persisted, then emitted | `with_registry_mutation` (lock → load → mutate → atomic write → emit) | `:735-770` | Source only (G-M3-4) |
| Fresh install never actuates | `InferenceMode::Off` is `#[default]`, and the Off/Monitor/Live gate is a single choke point in the live path | `:232-240`; `inference.rs:217-225` | `inference.rs` tests `off_is_the_registrys_default…` (`:785`), `only_monitor_and_live_ever_reach_the_model` (`:778`) — unexecuted here |

### D-M3-3 (confirmed, high) — a corrupt registry is silently erased, not refused

```rust
fn load_registry(app: &AppHandle) -> RegistryIndex {
    …
    serde_json::from_str(&contents).unwrap_or_default()      // model_registry.rs:287
}
```

A truncated, partially written or hand-corrupted `registry.json` therefore yields an empty registry — **with no warning log at all**, in contrast to both siblings, which log before falling back (`model_lab.rs:317-321`, `settings.rs:344-356`). The next mutating command (any threshold edit, any binding change, `set_inference_mode`) runs `with_registry_mutation`, which loads that empty index, applies its change, and persists it (`:750-770`, `:291-302`). The result:

- every `ModelRecord` is gone: lifecycle state, `created_at`, the full `history` transition log, per-model thresholds, per-model quality gate, and the `intent_bindings` that are the system's actuation-safety contract;
- `active_model_id` becomes `None`, so `active_model_runtime_config` returns `None` and inference stops (`:693-706`) — **fail-closed in the safety direction**, which is why the user may notice nothing but a dead feature;
- the bundle directories survive, so `read_trained_models` still lists every model (`model_lab.rs:496-535`) and the loss is recoverable only by re-approving and re-binding from scratch, with the approval history permanently gone.

Reproducing the write-back requires a running Tauri app (G-M3-1); the read-side behaviour is a two-line source fact, and **no test covers either** — `registry_index_round_trips_through_json` (`:1196`) covers only the happy path.

### R-M3-11 (risk, low) — a mode change can be persisted without being applied

`set_inference_mode` persists the new mode and emits the registry event first, then calls `gesture_policy.set_mode(mode)?` (`:1060-1072`). If `set_mode` fails — it returns `Result` and propagates a poisoned-lock error (`inference.rs:601-607`) — the command returns an error while disk and the frontend already say the mode changed, and the policy did not switch. The dangerous direction (disk says `Live`, policy still `Off`) under-actuates rather than over-actuating, because `PolicyMode::Live` is what gates initiation (M1, `gesture_policy.rs:12-18`).

### Unproven by any test on this host

Activation, rollback, archive, mode change, interrupted registry writes, concurrent commands and recovery are **all `AppHandle`-dependent and have no unit test at all** — the module's 41 `#[test]` functions cover pure helpers (`legal_transition`, `validate_intent_bindings`, `evaluate_quality_gate`, `validate_feature_subset`, `load_and_verify_bundle` against on-disk fixtures) and stop at the command boundary. Combined with G-M3-1 this means **every row of the table above is source-evidence only**, and the activation guarantees are listed as blocking gaps rather than proven properties (G-M3-1, G-M3-3, G-M3-4).

One structural observation, offered as a fact rather than a finding: with exactly one model in the registry and that model `Active`, there is no reachable transition to `Archived` — `transition_model_state` refuses the active model (`:905-909`), `rollback_active_model` requires a previous active model (`:1030-1032`), and no deactivate command exists. The model can only be displaced by activating another.

---

## Corruption and data-loss paths

Every path below is classified by evidence strength. "Source" means read from primary source at `6dd50df`; "reproduced" means a command in *Acceptance evidence* demonstrates it; "unverified" means the mechanism is cited but its effect was not observed here.

| Path | Outcome | Classification | Evidence |
| --- | --- | --- | --- |
| Corrupt/truncated `registry.json` | Silent full registry reset, then overwritten on the next mutation. Permanent loss of lifecycle state, thresholds, bindings, history | **Defect D-M3-3** | Source `model_registry.rs:280-288`, `:291-302`, `:750-770`; write-back unverified (G-M3-1) |
| Corrupt `recording.json`/`annotations.json` in one bundle | That bundle is skipped in listings; others unaffected; nothing is rewritten | Safe by design | Source `:259-273`, `:618-640`; test `:2445` (unexecuted here) |
| Crash between bundle staging and rename | Orphan `<id>.tmp`; no partially visible bundle; id reusable | Safe by design | Source `:326-337` |
| Crash between `annotations.json.tmp` and rename | Orphan tmp file; `annotations.json` intact | Safe, leaks a file | Source `:2280-2283` |
| Power loss after any rename | Possible zero-length file; no `fsync` barrier anywhere | **Risk R-M3-4**, unverified | Source (V-M3-8) |
| `raw.csv` replaced or corrupted after save | Not detected. No bundle-level digest exists; `raw_row_count` in metadata is never re-checked against the file | **Risk R-M3-13**, source | `:295-340`, `:2086-2094` |
| `model.tflite` replaced after approval | Detected at the next `verified()` — activation, rollback or backend reload — and rejected | Safe by design | Source `:534-546`; test `load_and_verify_bundle_rejects_a_model_file_that_no_longer_matches_the_recorded_digest` (`:1381`), unexecuted here |
| `model.tflite` replaced while the model stays active with unchanged thresholds | Not re-digested until the next reload | **Risk R-M3-5**, source | `inference.rs:487-492` |
| `metadata.json` hand-edited to drop parity/training/preprocessing | Accepted by the desktop; rejected by the trainer | **Defect D-M3-6**, reproduced | V-M3-4 cases 2, 5–9 |
| `metadata.json` declaring a feature count the `.tflite` does not implement | LiteRT error at predict → `InvalidOutput`/`Backend` → forced release | **Risk R-M3-6**, unverified (no litert build) | `litert_model.rs:47-52`, `model.rs:35-59`, `runtime.rs:64-68` |
| Partial/corrupt custom bundle at import | Rejected before copy and again after copy; destination removed on failure | Safe by design | Source `:841-877` |
| Stale `previous_active_model_id` whose bundle was removed externally | Rollback fails closed with a validation error | Safe by design | Source `:1034-1038` |
| Stale model directory from a cancelled/failed run | Listed as a trained model with no registry record; activation refuses it | **Risk R-M3-8**, source | `model_lab.rs:496-535`, `model_registry.rs:795-802` |
| Unordered `raw.csv` persisted by the desktop | Trainer refuses the file; `duration_ms` meaningless | **M2 D-6**, carried | `:350-402` vs `csv_io.py:101-106` |
| Dataset CSV deleted after training | Model's `input_files` dangle; no hash to detect substitution | **Risk R-M3-2**, source | `model_lab.rs:413-437` |
| Post-capture interval edits | Lost on unmount; no persistence command | **Defect D-M3-4**, reproduced (no caller) | V-M3-9 |
| Label mapping drift between a training run and a replay | 28/28 target windows silently re-roled to `negative` | **Defect D-M3-5**, reproduced | V-M3-6 part B |
| `delete_recording_bundle` | Irreversible by design, documented as such; id validated, bundle loaded first | Intended | Source `:655-678` |

**D-M3-5 (confirmed, medium), reproduced:**

```text
B1 training targets (explicit mapping, as start_training_job always supplies):
   {'negative': 28, 'pinch_release': 28, 'pinch_start': 28}
B2 replay targets (replay.py:31, no label mapping):
   {'negative': 56, 'pinch_release': 28}
B3 fist_clench windows trained as pinch_start but replayed as negative: 28
```

`start_training_job` always writes and passes a `label_mapping.json` (`model_lab.rs:726-732`), so training always resolves labels through an explicit mapping. `replay.py:31` calls `build_dataset(list(inputs), config, "negative")` with `label_mapping=None`, so resolution falls to `resolve_target`, whose final line returns `NEGATIVE_TARGET` for **any** unrecognised label (`labels.py:168`). Every user-defined collection label the run trained as a target is therefore scored as `negative` on replay, and `pinch_hold` additionally changes role between the two (`"exclude"` at training, `"negative"` at replay). The replay report's accuracy and confusion matrix are consequently not comparable with the bundle's own recorded metrics, and the bundle records no reference to the mapping that produced them.

### Evidence gaps

Each item is something this milestone could not establish. None is guessed at, and none is converted into a pass.

- **G-M3-1 — the entire lifecycle's Rust half has no execution evidence on this host.** `recording_bundle.rs` (3 920 lines, 76 `#[test]`s), `model_registry.rs` (1 558 lines, 41 `#[test]`s), `model_lab.rs` and `inference.rs` all live in `spatial-gesture-desktop`, which exits `101` at `cargo test --no-run` for want of `pkg-config`/glib (V-M3-1). Every Rust statement in this report is source-level, and every Rust test cited is labelled *present but unexecuted here*. **Resolution:** install the Linux Tauri prerequisites, or read the CI run for `6dd50df`.
- **G-M3-2 — the ADR's trainable dataset snapshot is not implemented.** Recording ids, annotation revisions, approved-interval boundaries, the explicit label mapping, the feature/window schema, split/grouping by recording id, and content hashes (ADR `:68-75`) exist in no artifact. The ADR records this itself (`:147`), so it is an unbuilt decision, not a contradiction — but it is the direct cause of D-M3-1 and R-M3-2. **Resolution:** a product decision, not a review finding.
- **G-M3-3 — no crash-recovery or durability test exists.** `list_recording_bundles_skips_unparsable_tmp_directories` (`recording_bundle.rs:2445`) is the only crash-adjacent test in the tree. Nothing exercises an interrupted `save_recording_bundle`, an interrupted `annotations.json.tmp` rename, a truncated `registry.json`, or a power-loss window (R-M3-4). **Resolution:** crash-injection against a built desktop binary.
- **G-M3-4 — no concurrency test for registry or model-lab commands.** `ModelRegistryRuntime`'s mutex and `with_registry_mutation`'s lock→load→mutate→persist→emit ordering (`model_registry.rs:735-770`) are source-visible only; no test issues two commands concurrently, and `register_trained_model` silently returns if the lock cannot be taken (`:809-811`). **Resolution:** same as G-M3-1 plus a command-level harness.
- **G-M3-5 — no model was executed by the desktop runtime.** `litert` is still off by default in both `crates/pinch-inference/Cargo.toml` and `apps/desktop/src-tauri/Cargo.toml`, so `load_model_backend` returns `UnavailablePinchModel` and every window fails closed (`inference.rs:379-387`). This milestone produced a real `model.tflite` and exercised it through the Python interpreter only. Carries M1 unknown 3 and half of M2's G-M2-6. **Resolution:** a `litert`-enabled build on a host that can compile the desktop crate.
- **G-M3-6 — no cross-language fixture for the bundle or annotation contracts.** The desktop crate's `write_valid_bundle` (`model_registry.rs:1291-1320`) is a four-key document the trainer rejects (V-M3-4 case 2); the exclusive→inclusive interval-boundary convention is asserted on neither side; `bundle.py` and `model_registry.rs` share no fixture, and the ADR itself names shared fixture tests as a precondition for a format change (`:145`). **Resolution:** one shared fixture set, which is a Milestone 6 proposal, not this milestone's.

---

## Acceptance evidence

### Checks executed

All commands were run from the repository root (or the stated subdirectory) at `6dd50df`, with the pre-existing dirty state untouched. Scratch scripts and all generated bundles live in this job's scratch directory (`$CLAUDE_JOB_DIR/tmp/m3`), outside the repository; nothing was written into the working tree except this report.

| id | Command | Exit | Outcome |
| --- | --- | --- | --- |
| V-M3-1 | `cargo test -p spatial-gesture-desktop --no-run` | **101** | **Blocked, not a failure.** `pkg-config` absent → `glib-sys` cannot configure. The crate holding `recording_bundle.rs`, `model_registry.rs`, `model_lab.rs` and `inference.rs` cannot be compiled or tested on this host. Carries M1 unknown 1. |
| V-M3-2 | `.venv/bin/python -m pytest -q` in `tools/pinch-classifier` | 0 | **57 passed**, 46 warnings, 17.04 s. Includes `test_bundle.py` (10 bundle-contract tests), `test_train_tflite.py` (4, TensorFlow present), `test_csv_io.py` (7), `test_windowing.py` (3), `test_train.py` (3, incl. the sklearn determinism test). |
| V-M3-3 | `.venv/bin/python <scratch>/repro.py` — three real TFLite training runs | 0 | A/B byte-identical (`da8296…31c41`), identical loss and metrics; C (reversed `--input`) differs in bytes and metrics with an identical group split. Confirmed `window_semantics` and `feature_contract.version` are absent from a real bundle. |
| V-M3-4 | `.venv/bin/python <scratch>/contract.py` — 10 bundle documents through the trainer's `validate_metadata` and a line-cited re-expression of `load_and_verify_bundle` | 0 | **7 divergences** where the desktop accepts and the trainer rejects (cases 2, 5, 6, 7, 8, 9) plus the silently-ignored window cases 3 and 4. Case 1 agrees; case 10 is an artifact of the call shape, resolved by V-M3-5. |
| V-M3-5 | `.venv/bin/python -` — `validate_metadata` on a digest-mismatched bundle, with and without `bundle_dir` | 0 | With the directory supplied: REJECT (digest mismatch). Without: ACCEPT. Case 10 is therefore **not** a divergence; both sides reject a tampered model file. |
| V-M3-6 | `.venv/bin/python <scratch>/labels_check.py` | 0 | A1/A2: a Timeline Capture export is rejected by the desktop import gate *and* by the trainer's loader. B1/B2/B3: 28 windows trained as `pinch_start` are replayed as `negative`. |
| V-M3-7 | `graphify query "recording bundle persistence model registry activation"` | 0 | 247 nodes, truncated to 55 at the default budget. Used for orientation only. **MCP fallback reported:** no `.mcp.json` exists, so the CLI was used; the graph is stale (`e91f79d`) and every citation here was re-confirmed against source. |
| V-M3-8 | `grep -rn 'fsync\|sync_all' --include=*.rs apps/desktop/src-tauri/src crates` | 1 | **No matches.** No durability barrier anywhere in the Rust tree. |
| V-M3-9 | Caller search for all seven recording-bundle client functions across `apps/desktop/src`, excluding the client module and tests | 0 | `setIntervalCurationStatus`: **no callers**. `RecordingTimelineEditor`: **mounted nowhere**. The other six are used from `RawImageViewerPanel.tsx` / `useTelemetryExport.ts`. |
| V-M3-10 | `git status --porcelain` before and after every command above | 0 | Byte-identical to the opening capture at every checkpoint; the five pre-existing dirty paths unchanged. |

**Not attempted, with reasons:** a `litert`-enabled build (pulls a prebuilt native library at build time; also blocked by V-M3-1), any activation/rollback/mode-change execution (requires a running Tauri app), any crash- or power-loss injection (would require writing into the app data directory and killing a process that cannot be built here), any hardware capture (no watch, no headset — carries M1 unknown 4).

### Milestone 3 acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| A cited end-to-end trace from live samples through persistence, labels, quality metadata, export/import, training input, model bundle, registry, activation and inference | **met, with the break named** | *Recording lifecycle* (write path table), *Label and interval semantics*, *Dataset integrity and lineage*, *Model bundle compatibility*, *Activation and rollback*. The trace is complete and it is **discontinuous**: `annotations.json` reaches no training input (D-M3-1, reproduced V-M3-6), and the only continuous route is Quick Capture → dataset CSV → manual re-import → trainer → bundle → registry → activation → `select_features` → `submit`. |
| Label ownership, interval boundaries, overlap, source metadata, timestamp fidelity, schema versions, atomic writes, crash recovery, immutable raw data — with tests or gaps | **met** | *Label and interval semantics* (ownership, exclusive→inclusive convention, overlap, revisions); *Recording lifecycle* (atomicity table, crash rows, immutability); gaps at G-M3-3, G-M3-6; defects D-M3-2, D-M3-4; risks R-M3-4, R-M3-7, R-M3-9, R-M3-10; M2 D-5/D-6 carried. |
| Dataset-to-model lineage: recording ids, source/device identity, feature contract, split strategy, seeds, normalization, metrics, tool/runtime versions, artifacts, hashes, provenance **actually persisted** | **met** | *Dataset integrity and lineage* — a per-element table read off a real bundle, each row marked persisted / partly / absent with a citation. Absent: recording ids, device identity, input hashes, split policy, every tool version but TensorFlow's. |
| Training reproducibility tested or honestly bounded | **met** | *Training reproducibility* — three real runs; bit-identical for identical args, order-sensitive, environment dependence explicitly unbounded, and the absence of a determinism test for the deployable backend recorded. |
| Model bundle validation: hash binding, schema compatibility, feature names/order/count, preprocessing, window semantics, thresholds, intent bindings, corrupt/partial files, stale references, unsupported backends | **met** | *Model bundle compatibility* — what each side checks, a 10-row reproduced divergence table, R-M3-1's three-way window-semantics comparison, R-M3-5, R-M3-6; thresholds and bindings in *Activation and rollback*. |
| Approval, single-active enforcement, activation, rollback, archive, mode changes, interrupted writes, concurrent commands, failure recovery proven by cited tests **or listed as blocking gaps** | **met, as gaps** | *Activation and rollback* — each guarantee cited to source with its proof status; all command-level behaviour is **listed as a blocking gap** (G-M3-1, G-M3-3, G-M3-4) rather than asserted, since the crate cannot be built here and has no command-level test. |
| Inference-critical training settings compared mechanically with runtime expectations; any silently accepted mismatch reproduced and classified | **met** | V-M3-4 (10 documents, 7 divergences, cases 3/4 the silently accepted window mismatch) and R-M3-1's training/replay/live table. |
| Every data-loss, corruption, incompatible-model and stale-binding path has source evidence, a reproducible scenario, or an explicit unverified label | **met** | *Corruption and data-loss paths* — 18 rows, each labelled source / reproduced / unverified. |
| Only the review report committed; pre-existing dirty work and product code untouched | **met** | V-M3-10; `git diff --check` clean; one path staged. |

### Self-review performed before delivery

- No raw prompts, reasoning traces, credentials, secrets or unbounded logs appear here. `status-resp.json`'s internal identifiers are not touched or described. The synthetic data used in every check is generated by the repository's own test fixture formulas — no sensor capture and no user data was read.
- Every line citation was read from the primary worktree at `6dd50df`, never from the `.claude/worktrees/` copies (M1 R-2).
- The Rust-side bundle validator was **re-expressed, not executed**, and is labelled as such everywhere it is used; the re-expression carries the line ranges it was derived from so it can be audited against source. No desktop-crate behaviour is reported as executed.
- V-M3-4 case 10 initially read as an eighth divergence; it was re-checked (V-M3-5), found to be an artifact of calling `validate_metadata` without a bundle directory, and is reported as not a divergence.
- Counts are reported as observed: 57 Python tests passed here, where M1 recorded 61 under `uv run` — this review states only what it ran, through the project venv, and does not reconcile the two.
- Milestone 4–6 material met along the way (module depth in `recording_bundle.rs`'s 3 920 lines, the dead `RecordingTimelineEditor`, the missing snapshot adapter's product shape) is recorded as a cited fact or gap with an explicit deferral, not as analysis or a recommendation.
- Every artifact this review generated — three TFLite bundles, synthetic CSVs, four scratch scripts — was written to this job's scratch directory outside the repository and nothing was copied in; `git status --porcelain` is byte-identical to the opening capture apart from this report.

---

## Milestone verdict

**Milestone 3 is complete.** The lifecycle is traced from an accepted live sample through the immutable bundle, the annotation model, derived quality metadata, the legacy export/import path, the trainer, the deployment bundle, the registry, activation and the live `select_features`/`submit` call, with citations at every hop. Ten checks were executed and their exit codes recorded; one is honestly reported as blocked rather than converted into a pass.

**Datasets and models are, today: not reproducible from their own metadata alone; attributable only to dataset files, never to a recording or a device; corruption-resistant where a digest exists and silently fragile where one does not; and not safe to activate from an untrusted source.**

- *Reproducible* — bit-identical for identical arguments on one host, and the grouped split is order-independent, which is better than expected. Bounded by input ordering, by the absence of input content hashes, and by an unrecorded environment.
- *Attributable* — `groups_*` and `input_files` tie a model to specific managed dataset UUIDs, and `model.sha256` ties `metadata.json` to its model bytes. Nothing ties either to a recording id, a watch, or the label mapping that produced its targets.
- *Corruption-resistant* — the model artifact is well protected: recomputed digest at activation, rollback and reload, with import validated before and after copy. `raw.csv` has no digest at all, and `registry.json` has the opposite of protection: a parse failure silently erases the registry and the next command persists the erasure (D-M3-3).
- *Safe to activate* — for an app-trained bundle, yes, because the writer refuses to emit a non-conforming one. For an imported bundle, no: seven reproduced scenarios pass the desktop's gate that the project's own validator rejects, including a bundle with no conversion-parity evidence, no training provenance, a leaked train/test split, and an unsupported preprocessing policy (D-M3-6).

**The single highest-impact structural finding is D-M3-1.** The ADR's annotation model — multi-interval labelling, boundary resolution with rule versions, revisions, curation states — is fully implemented on the capture side, persisted immutably, and consumed by nothing. Training reads only the legacy one-label-per-session CSV, and a Timeline Capture export is rejected by both the desktop's import gate and the trainer's loader. With D-M3-4 (curation and post-capture editing unreachable from any UI) this means the newer, better data model is currently write-only, and the pipeline that actually produces models is the compatibility path the ADR intended to replace.

**The weakest *safety* finding is D-M3-6 together with R-M3-1.** The desktop's activation gate validates shape and bytes but not meaning: it never compares a bundle's declared window semantics, preprocessing policy, conversion parity or training provenance against anything. Offline replay honours the declared window config; the live runtime has no window length at all. A bundle can therefore be trained on 500 ms windows, replayed on 500 ms windows, and served one PPG batch at a time, with no component in the system positioned to notice.

**Nothing found here blocks Milestone 4.** The quality-metadata surface M4 will reason about (`compute_quality_summary` and its fourteen derived fields, `recording_bundle.rs:2064-2227`), the dead/unwired UI surface (`RecordingTimelineEditor`, the uncalled curation command), and the module-size signal (`recording_bundle.rs` at 3 920 lines carrying persistence, image windowing, six spike-extraction methods, Savitzky–Golay derivatives and quality summaries in one module) are all located and cited above.

**Conditions carried into Milestone 4:**

1. **Treat every activation, rollback, archive, mode-change and concurrency guarantee as unproven**, not as holding. They are source-evidenced only: `spatial-gesture-desktop` does not build here (V-M3-1) and has **no command-level test** even where it does build. Resolving this needs the Linux Tauri prerequisites or the CI run for `6dd50df`.
2. **Do not treat R-M2-1 as quantified.** This milestone produced the trained bundle M2 lacked, which closes half of G-M2-6, but no model was ever executed inside the desktop runtime — `litert` remains uncompiled — so the accuracy cost of the 13 structurally-zero features is still unmeasured.
3. **Carry the window-semantics comparison (R-M3-1) forward as an open question about the live window definition**, not as a bundle-metadata bug. Deciding what the desktop's window *is* precedes deciding what a bundle should be allowed to declare about it.
4. Carry D-M3-1…D-M3-6, R-M3-1…R-M3-13 and T-M3-1…T-M3-3 into the Milestone 6 finding set for ranking, alongside M1's F-1…F-6/G-1 and M2's D-1…D-7/R-M2-1…R-M2-12. This milestone proposes no fixes.
5. Leave the five pre-existing dirty paths untouched; R-1 remains the repository owner's call.
