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

## Consequences

- Collection supports both one-label and multi-label recordings without two incompatible storage formats.
- Raw samples, source timestamps, and capture provenance remain auditable.
- Model training becomes reproducible and can avoid leakage across windows from the same recording.
- The migration requires Rust, TypeScript, and Python readers/writers to share fixture tests before a production format change.
- The current fixed-label CSV pipeline remains a compatibility path until the snapshot adapter is implemented.

## Deferred verification

No runtime capture, test suite, build, lint, package, CI, or device validation has been run for this decision record. Those gates remain deferred until explicitly authorized.
