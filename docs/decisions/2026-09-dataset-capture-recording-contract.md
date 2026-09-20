# ADR: Immutable recording bundles and interval annotations

**Status:** Accepted for the dataset-capture/curation migration.  
**Scope:** Collection and curation data only. This decision does not change sensor transport, graph buffering, model activation, or live gesture actions.

## Context

The legacy collector writes one fused CSV session with one label per row. That prevents a continuous recording from holding multiple labels, makes raw-data relabeling destructive, and leaves unclear whether graph history is included when a recording starts.

The new collector must support both a quick one-label recording and a longer, continuously annotated recording without altering raw sensor evidence.

## Decision

### 1. Recording bundle

Each completed recording is stored as an immutable bundle:

```text
recording/<recording-id>/
  raw.csv
  recording.json
  annotations.json
```

- `raw.csv` contains only samples accepted after the user presses Start. It is never rewritten for relabeling, curation, or training.
- `recording.json` describes the capture session and source configuration.
- `annotations.json` contains label intervals, revisions, and curation state. It may change without changing `raw.csv`.

A legacy single-label CSV remains readable through an adapter. It is represented to the new workflow as one recording with one full-span interval; no destructive conversion is required.

### 2. Capture state and timing

The state machine is:

```text
Idle → Arming → Recording → Stopped → Saved | Discarded
```

- **Start** enters `Arming`. Existing graph/ring-buffer samples are explicitly excluded.
- The first valid accepted sensor sample after Start creates the first raw row, establishes `actual_start`, starts the duration countdown, and transitions to `Recording`.
- The collector stores the original raw per-sample source timestamp. It also stores desktop monotonic and wall-clock audit times in session metadata; it never synthesizes source timestamps.
- A configured duration ends the session with `timer_elapsed`; a user stop uses `manual_stop`; a required source becoming unavailable uses `source_unavailable`.
- If no valid sample arrives while armed, the recording is discarded with `cancelled_before_first_sample`; no empty `raw.csv` is created.

### 3. Annotation model

A quick capture and a timeline capture use the same model:

- A **Quick Capture** creates one `quick_capture` interval spanning the accepted recording evidence.
- A **Timeline Capture** creates zero or more exclusive intervals. Gaps stay `unannotated`; they do not become a negative/background label implicitly.
- Intervals may not overlap by default. Starting a different live label closes the active one before the new interval begins.
- A label has an immutable stable ID and editable display name. New labels are collection-neutral; their training role is chosen later by a dataset recipe/snapshot.
- Historical labels are archived rather than deleted.

### 4. Interval-boundary resolution

Live annotation commands preserve both the requested recording-clock time and the resolved captured-sample boundary:

- **Start:** resolve to the first accepted sample at or after the requested time.
- **End:** resolve to the last accepted sample at or before the requested time.

The resolver records the rule version and selected raw-row/sample reference. This makes later window extraction reproducible without changing raw timestamps.

### 5. Curation and training

Curation is metadata over intervals, not a raw-file operation. An interval has one of `unreviewed`, `approved`, or `excluded` states.

A trainable dataset is an immutable snapshot that records:

- source recording IDs and annotation revisions;
- approved intervals and their resolved boundaries;
- explicit raw-label-to-training-target mapping;
- feature/window schema;
- split/grouping policy by recording ID; and
- content hashes.

The trainer must reject an incomplete label mapping and must not generate windows across annotation boundaries, unannotated gaps, or excluded intervals unless a recipe explicitly allows it.

## Version-1 metadata examples

These examples are design fixtures, not production files yet. The implementation must validate equivalent fixtures in TypeScript, Rust, and Python before treating the format as stable.

### `recording.json`

```json
{
  "format_version": 1,
  "recording_id": "rec_01J...",
  "requested_start_at": "2026-09-16T10:00:00Z",
  "actual_start": {
    "monotonic_ns": 42000000000,
    "wall_clock_at": "2026-09-16T10:00:01Z"
  },
  "actual_end": {
    "monotonic_ns": 52000000000,
    "wall_clock_at": "2026-09-16T10:00:11Z"
  },
  "requested_duration_ms": 10000,
  "actual_duration_ms": 10000,
  "stop_reason": "timer_elapsed",
  "sources": [{"source_id": "watch", "configuration": {"imu_rate_hz": 100}}],
  "raw_row_count": 1000,
  "raw_source_row_counts": {"watch": 1000}
}
```

### `annotations.json`

```json
{
  "format_version": 1,
  "recording_id": "rec_01J...",
  "intervals": [{
    "interval_id": "ann_01J...",
    "label_id": "pinch-start",
    "requested_start_monotonic_ns": 42000000000,
    "requested_end_monotonic_ns": 52000000000,
    "resolved_start": {"raw_row": 0, "source_timestamp_ns": 7000000000},
    "resolved_end": {"raw_row": 999, "source_timestamp_ns": 17000000000},
    "resolution_rule_version": 1,
    "creation_mechanism": "quick_capture",
    "curation_status": "unreviewed",
    "created_at": "2026-09-16T10:00:11Z",
    "revision": 1
  }]
}
```

### 6. Raw image viewer (read-only inspection)

The desktop "Raw image viewer" tab (`get_raw_recording_window`, `apps/desktop/src-tauri/src/recording_bundle.rs`) gives a human a bounded visual read of `raw.csv` for one allow-listed numeric column. It is the only additional reader of `raw.csv` beyond bundle load, and it changes nothing about this ADR's write path:

- **Grid size is allow-listed and bounded, hop derives from it (GC-012):** the request carries a `grid_size`, which must be one of `RAW_GRID_SIZES = [8, 16, 32, 64]` (default 64) — any other value is rejected outright. For grid size N, a window is at most `N * N` raw rows (reshaped client-side into an N×N image) and navigation moves in `N`-row hops; every accepted `start_raw_row` must be a multiple of N. `RAW_WINDOW_MAX_VALUES = 4096` (64×64) remains the absolute upper bound across every allowed size. A start beyond the last reachable window is clamped down to the final hop-aligned window rather than rejected, so the end of a recording is always reachable. The resolved `grid_size` is echoed back on every response so the frontend renders exactly what was served, never a stale or requested-but-unconfirmed size.
- **Canvas order is chronological and row-major:** pixel `i` in the rendered frame maps to raw row `startRawRow + i` in the same order the rows appear in `raw.csv`, laid out left-to-right then top-to-bottom (`column = i % N`, `row = floor(i / N)`, for the response's own `N`). No reordering, resampling, or windowing beyond the plain slice.
- **Nulls are preserved, never replaced:** an empty `raw.csv` field for the selected column stays `None`/null through the backend response and renders with an explicit missing-value fill distinct from both real data and from "beyond the end of the recording" (a pixel position past `total_raw_row_count`, which is a different fact from a present-but-empty field). Neither case is coerced to zero or carried forward from a neighboring row.
- **Normalization is a rendering choice, not a data transform:** the response carries the recording-wide `(min, max)` extent for the selected column; the viewer defaults to recording-scale normalization and offers an explicitly labeled per-frame-scale alternative. A constant-valued channel/frame renders at a fixed neutral gray instead of dividing by a zero range. Switching modes re-renders the already-loaded window and never issues a new backend request.
- **A second false-colour rendering of the same window is a client-only palette choice (GC-013):** alongside the existing grayscale image, the panel renders a rainbow false-colour image (low value → red, high value → violet) of the identical bounded window — same recording, channel, grid size, navigation position, and normalization mode; no additional backend read. Color mode only changes how an already-normalized fraction is mapped to a pixel color client-side; it is not a channel mapping and does not composite multiple sensors into one RGB image. The missing-value, beyond-recording, and constant-value fills are unchanged between the two images.
- **Explicit non-training, non-classifier boundary:** this path is visual inspection only. Its request/response types, Tauri command, and frontend state module are isolated from Model Lab, dataset export, annotation editing, and inference — none of the values, images, or normalization extents produced here are, or are intended to become, a model input, training representation, or classifier feature. Extending this into a training data source is a separate product decision, not an implicit consequence of this contract.

## Consequences

- Collection supports both one-label and multi-label recordings without two incompatible storage formats.
- Raw samples, source timestamps, and capture provenance remain auditable.
- Model training becomes reproducible and can avoid leakage across windows from the same recording.
- The migration requires Rust, TypeScript, and Python readers/writers to share fixture tests before a production format change.
- The current fixed-label CSV pipeline remains a compatibility path until the snapshot adapter is implemented.

## Deferred verification

No runtime capture, test suite, build, lint, package, CI, or device validation has been run for this decision record. Those gates remain deferred until explicitly authorized.
