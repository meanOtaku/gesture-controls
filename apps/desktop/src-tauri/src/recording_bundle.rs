//! Persistence boundary for the immutable recording-bundle contract from
//! `docs/decisions/2026-09-dataset-capture-recording-contract.md`.
//!
//! Each completed capture is written once as:
//! ```text
//! recording/<recording-id>/
//!   raw.csv           # immutable; never rewritten
//!   recording.json    # capture/session metadata
//!   annotations.json  # label intervals + curation state; may change later
//! ```
//! This module never touches the legacy single-label dataset CSV pipeline in
//! `model_lab.rs` (`import_model_dataset`/`DATASET_CSV_HEADER`), which stays the
//! compatibility path for existing exports and training. `import_recording_from_raw_csv`
//! additionally *accepts* a document in that legacy dataset-export shape as an input
//! format, converting it server-side into a canonical `raw.csv` (see
//! `convert_legacy_dataset_csv`); it never writes back to the legacy pipeline.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::model_lab::DATASET_CSV_HEADER;

pub(crate) const RECORDING_BUNDLES_DIR_NAME: &str = "recording";
const RAW_CSV_FILE_NAME: &str = "raw.csv";
const RECORDING_METADATA_FILE_NAME: &str = "recording.json";
const ANNOTATIONS_FILE_NAME: &str = "annotations.json";
/// Matches `model_lab::MAX_DATASET_CSV_BYTES`; kept as its own constant since
/// the two csv contracts (legacy fused dataset vs. new immutable raw capture)
/// are intentionally independent.
const MAX_RAW_CSV_BYTES: usize = 20 * 1024 * 1024;
/// Stable `RecordingSource.source_id` for every bundle created by
/// `import_recording_from_raw_csv`, so imported bundles are always
/// identifiable by source rather than by a browser-supplied label.
const IMPORTED_SOURCE_ID: &str = "timeline_capture_csv_import";

/// The exact `raw.csv` header written by `RAW_RECORDING_CSV_COLUMNS`
/// (`telemetryStore.ts`): `DATASET_CSV_COLUMNS` minus `label`.
const RAW_CSV_HEADER: [&str; 16] = [
    "timestamp_ns",
    "sequence",
    "ppg_green",
    "ppg_red",
    "ppg_ir",
    "accel_x",
    "accel_y",
    "accel_z",
    "gyro_x",
    "gyro_y",
    "gyro_z",
    "quat_w",
    "quat_x",
    "quat_y",
    "quat_z",
    "contact_quality",
];

/// The subset of `RAW_CSV_HEADER` inspectable as an image-viewer channel;
/// `timestamp_ns` and `sequence` are exposed separately in every window
/// response and are not themselves selectable channels.
const RAW_WINDOW_ALLOWED_COLUMNS: [&str; 14] = [
    "ppg_green",
    "ppg_red",
    "ppg_ir",
    "accel_x",
    "accel_y",
    "accel_z",
    "gyro_x",
    "gyro_y",
    "gyro_z",
    "quat_w",
    "quat_x",
    "quat_y",
    "quat_z",
    "contact_quality",
];

/// Allow-listed square grid sizes (GC-012). The hop equals the grid size
/// (one displayed row of raw rows), and the window is always `size * size`
/// values, so `RAW_WINDOW_MAX_VALUES` (the largest allowed size squared)
/// remains the absolute upper bound on any response.
const RAW_GRID_SIZES: [u32; 16] = [
    4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64,
];
const DEFAULT_RAW_GRID_SIZE: u32 = 64;
/// Absolute upper bound on values returned by any allow-listed grid size.
const RAW_WINDOW_MAX_VALUES: usize = 4_096;

fn validate_grid_size(grid_size: u32) -> Result<usize, String> {
    if !RAW_GRID_SIZES.contains(&grid_size) {
        return Err(format!(
            "unsupported grid size {grid_size}; must be one of {RAW_GRID_SIZES:?}"
        ));
    }
    Ok(grid_size as usize)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonotonicWallClock {
    pub monotonic_ns: i64,
    pub wall_clock_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    TimerElapsed,
    ManualStop,
    SourceUnavailable,
    CancelledBeforeFirstSample,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingSource {
    pub source_id: String,
    pub configuration: serde_json::Value,
}

/// Mirrors the ADR's `recording.json` fixture exactly (field-for-field, same
/// names) so this struct is both the wire contract from the webview and the
/// on-disk format, with no separate translation layer to drift.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingMetadata {
    pub format_version: u32,
    pub recording_id: String,
    pub requested_start_at: String,
    pub actual_start: MonotonicWallClock,
    pub actual_end: MonotonicWallClock,
    pub requested_duration_ms: Option<u64>,
    pub actual_duration_ms: u64,
    pub stop_reason: StopReason,
    pub sources: Vec<RecordingSource>,
    pub raw_row_count: usize,
    pub raw_source_row_counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedBoundary {
    pub raw_row: usize,
    pub source_timestamp_ns: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreationMechanism {
    QuickCapture,
    HotkeyHold,
    HotkeyToggle,
    TimelineEdit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CurationStatus {
    Unreviewed,
    Approved,
    Excluded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationInterval {
    pub interval_id: String,
    pub label_id: String,
    pub requested_start_monotonic_ns: i64,
    pub requested_end_monotonic_ns: i64,
    pub resolved_start: ResolvedBoundary,
    pub resolved_end: ResolvedBoundary,
    pub resolution_rule_version: u32,
    pub creation_mechanism: CreationMechanism,
    pub curation_status: CurationStatus,
    pub created_at: String,
    pub revision: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationsFile {
    pub format_version: u32,
    pub recording_id: String,
    pub intervals: Vec<AnnotationInterval>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingBundleSummary {
    pub recording_id: String,
    pub raw_row_count: usize,
    pub interval_count: usize,
    pub actual_duration_ms: u64,
    pub stop_reason: StopReason,
    pub label_ids: Vec<String>,
    pub unreviewed_count: usize,
    pub approved_count: usize,
    pub excluded_count: usize,
}

/// The read side of a saved bundle for curation review: full metadata plus
/// annotation intervals, deliberately excluding `raw.csv` since curation UI
/// only needs interval/label/curation-state data, not the raw samples.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingBundleDetail {
    pub recording: RecordingMetadata,
    pub annotations: AnnotationsFile,
}

fn summarize_bundle(recording: &RecordingMetadata, annotations: &AnnotationsFile) -> RecordingBundleSummary {
    let mut label_ids: Vec<String> = annotations
        .intervals
        .iter()
        .map(|interval| interval.label_id.clone())
        .collect();
    label_ids.sort();
    label_ids.dedup();
    let count_where = |status: CurationStatus| {
        annotations
            .intervals
            .iter()
            .filter(|interval| interval.curation_status == status)
            .count()
    };
    RecordingBundleSummary {
        recording_id: recording.recording_id.clone(),
        raw_row_count: recording.raw_row_count,
        interval_count: annotations.intervals.len(),
        actual_duration_ms: recording.actual_duration_ms,
        stop_reason: recording.stop_reason,
        label_ids,
        unreviewed_count: count_where(CurationStatus::Unreviewed),
        approved_count: count_where(CurationStatus::Approved),
        excluded_count: count_where(CurationStatus::Excluded),
    }
}

fn load_bundle_pair(dir: &std::path::Path) -> Result<(RecordingMetadata, AnnotationsFile), String> {
    let recording_json =
        fs::read_to_string(dir.join(RECORDING_METADATA_FILE_NAME)).map_err(|error| error.to_string())?;
    let recording: RecordingMetadata =
        serde_json::from_str(&recording_json).map_err(|error| error.to_string())?;
    let annotations_json =
        fs::read_to_string(dir.join(ANNOTATIONS_FILE_NAME)).map_err(|error| error.to_string())?;
    let annotations: AnnotationsFile =
        serde_json::from_str(&annotations_json).map_err(|error| error.to_string())?;
    Ok((recording, annotations))
}

/// Recording ids are always generated by the caller with `crypto.randomUUID()`
/// on the webview side, but this also gates untrusted input before it ever
/// reaches a `Path::join`, mirroring `model_lab::validate_dataset_id`.
fn validate_recording_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("invalid recording id".to_string())
    }
}

fn recording_bundles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    Ok(base.join(RECORDING_BUNDLES_DIR_NAME))
}

/// Writes the three-file bundle atomically: everything is staged in a sibling
/// `<id>.tmp` directory, then the whole directory is renamed into place in one
/// filesystem operation, so `raw.csv` never exists half-written and a
/// recording id is never observed to exist before it is complete.
#[tauri::command]
pub fn save_recording_bundle(
    raw_csv: String,
    recording: RecordingMetadata,
    annotations: AnnotationsFile,
    app: AppHandle,
) -> Result<RecordingBundleSummary, String> {
    validate_recording_id(&recording.recording_id)?;
    if recording.recording_id != annotations.recording_id {
        return Err("recording.recording_id and annotations.recording_id must match".to_string());
    }
    if raw_csv.trim().is_empty() {
        return Err("raw CSV must not be empty; an armed session with no accepted sample must be discarded, not saved".to_string());
    }
    if raw_csv.len() > MAX_RAW_CSV_BYTES {
        return Err(format!(
            "raw CSV exceeds the {MAX_RAW_CSV_BYTES}-byte limit (got {} bytes)",
            raw_csv.len()
        ));
    }

    let dir = recording_bundles_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let final_dir = dir.join(&recording.recording_id);
    if final_dir.exists() {
        return Err(format!(
            "recording bundle '{}' already exists; raw.csv is immutable and never overwritten",
            recording.recording_id
        ));
    }

    let tmp_dir = dir.join(format!("{}.tmp", recording.recording_id));
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).map_err(|error| error.to_string())?;
    }
    let write_result = write_bundle_files(&tmp_dir, &raw_csv, &recording, &annotations);
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(error);
    }
    if let Err(error) = fs::rename(&tmp_dir, &final_dir) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(error.to_string());
    }

    Ok(summarize_bundle(&recording, &annotations))
}

/// Validates a complete `raw.csv` document against the exact `RAW_CSV_HEADER`
/// contract and existing per-field parsing rules (empty -> null, non-empty
/// must parse as its numeric type), and returns the data row count plus the
/// first/last `timestamp_ns` for metadata generation. This is stricter than
/// `parse_raw_csv_column` (which only validates the requested column) since
/// an import must reject a malformed file in any column, not just the one
/// currently being viewed.
fn validate_raw_csv_full(content: &str) -> Result<(usize, i64, i64), String> {
    let mut lines = content.lines();
    let header = lines.next().ok_or_else(|| "raw.csv is empty".to_string())?;
    let expected_header = RAW_CSV_HEADER.join(",");
    if header != expected_header {
        return Err(format!(
            "malformed raw.csv: expected header '{expected_header}', got '{header}'"
        ));
    }

    let mut row_count = 0usize;
    let mut first_timestamp_ns: Option<i64> = None;
    let mut last_timestamp_ns: Option<i64> = None;
    for (offset, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row_number = offset + 2; // 1-indexed, plus the header line
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != RAW_CSV_HEADER.len() {
            return Err(format!(
                "malformed raw.csv: row {row_number} has {} fields, expected {}",
                fields.len(),
                RAW_CSV_HEADER.len()
            ));
        }
        let timestamp_ns: i64 = fields[0]
            .trim()
            .parse()
            .map_err(|_| format!("malformed raw.csv: row {row_number} has a non-numeric timestamp_ns"))?;
        for (column_index, column_name) in RAW_CSV_HEADER.iter().enumerate().skip(1) {
            let raw_value = fields[column_index].trim();
            if !raw_value.is_empty() {
                raw_value.parse::<f64>().map_err(|_| {
                    format!("malformed raw.csv: row {row_number} column '{column_name}' is not numeric")
                })?;
            }
        }
        row_count += 1;
        first_timestamp_ns.get_or_insert(timestamp_ns);
        last_timestamp_ns = Some(timestamp_ns);
    }

    if row_count == 0 {
        return Err("raw CSV must contain at least one data row".to_string());
    }
    Ok((row_count, first_timestamp_ns.unwrap(), last_timestamp_ns.unwrap()))
}

/// If `content` is in the legacy dataset-export shape (optional leading `#`
/// metadata lines, then the exact `DATASET_CSV_HEADER` row), converts it into
/// a canonical `raw.csv` document by dropping the metadata lines and the
/// trailing `label` field from every data row. Row order and every retained
/// field's original string form are preserved unchanged; only the discarded
/// metadata/label content is removed. Returns `None` when `content` is not
/// headed by the legacy header at all (the caller then validates it as a
/// plain `raw.csv` document instead). A malformed legacy document (wrong
/// column count) is a hard `Err`, not a fall-through. The label field itself
/// is never validated here — raw inspection doesn't use labels, and
/// Timeline Capture's own export (`telemetryStore.ts::generateDatasetCsv`)
/// legitimately produces this exact legacy header with an empty label, e.g.
/// for unannotated rows; label presence/validity stays `model_lab.rs`'s
/// concern for the training-import path.
fn convert_legacy_dataset_csv(content: &str) -> Option<Result<String, String>> {
    let lines: Vec<&str> = content.lines().collect();
    let mut index = 0;
    while index < lines.len() && lines[index].trim_start().starts_with('#') {
        index += 1;
    }
    let header_line = lines.get(index)?;
    if *header_line != DATASET_CSV_HEADER.join(",") {
        return None;
    }

    let mut converted_lines = vec![RAW_CSV_HEADER.join(",")];
    for (offset, line) in lines[index + 1..].iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != DATASET_CSV_HEADER.len() {
            return Some(Err(format!(
                "malformed legacy dataset CSV: row {} has {} fields, expected {}",
                offset + 1,
                fields.len(),
                DATASET_CSV_HEADER.len()
            )));
        }
        converted_lines.push(fields[..RAW_CSV_HEADER.len()].join(","));
    }
    Some(Ok(converted_lines.join("\n")))
}

/// Imports a Timeline Capture `raw.csv` document (exact `RAW_CSV_HEADER`
/// contract), or the app's legacy dataset-export CSV (exact
/// `DATASET_CSV_HEADER` contract, converted via `convert_legacy_dataset_csv`)
/// — no arbitrary-CSV mapping — as a new, immutable, read-only recording
/// bundle. All metadata (`recording_id`, timestamps, row counts, source
/// identity) is generated server-side from the validated CSV content; no
/// browser-supplied recording metadata is trusted. The created bundle has no
/// annotations and is written through the same atomic stage-then-rename path
/// as `save_recording_bundle`.
#[tauri::command]
pub fn import_recording_from_raw_csv(csv_text: String, app: AppHandle) -> Result<RecordingBundleSummary, String> {
    if csv_text.trim().is_empty() {
        return Err("raw CSV must not be empty".to_string());
    }
    if csv_text.len() > MAX_RAW_CSV_BYTES {
        return Err(format!(
            "raw CSV exceeds the {MAX_RAW_CSV_BYTES}-byte limit (got {} bytes)",
            csv_text.len()
        ));
    }
    let csv_text = match convert_legacy_dataset_csv(&csv_text) {
        Some(result) => result?,
        None => csv_text,
    };
    let (row_count, first_timestamp_ns, last_timestamp_ns) = validate_raw_csv_full(&csv_text)?;

    let recording_id = Uuid::new_v4().to_string();
    let imported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let actual_duration_ms = last_timestamp_ns.saturating_sub(first_timestamp_ns).max(0) as u64 / 1_000_000;

    let recording = RecordingMetadata {
        format_version: 1,
        recording_id: recording_id.clone(),
        requested_start_at: imported_at.clone(),
        actual_start: MonotonicWallClock { monotonic_ns: first_timestamp_ns, wall_clock_at: imported_at.clone() },
        actual_end: MonotonicWallClock { monotonic_ns: last_timestamp_ns, wall_clock_at: imported_at },
        requested_duration_ms: None,
        actual_duration_ms,
        stop_reason: StopReason::ManualStop,
        sources: vec![RecordingSource {
            source_id: IMPORTED_SOURCE_ID.to_string(),
            configuration: serde_json::json!({}),
        }],
        raw_row_count: row_count,
        raw_source_row_counts: BTreeMap::from([(IMPORTED_SOURCE_ID.to_string(), row_count)]),
    };
    let annotations = AnnotationsFile {
        format_version: 1,
        recording_id: recording_id.clone(),
        intervals: Vec::new(),
    };

    let dir = recording_bundles_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let final_dir = dir.join(&recording_id);
    if final_dir.exists() {
        return Err(format!("recording bundle '{recording_id}' already exists"));
    }
    let tmp_dir = dir.join(format!("{recording_id}.tmp"));
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).map_err(|error| error.to_string())?;
    }
    if let Err(error) = write_bundle_files(&tmp_dir, &csv_text, &recording, &annotations) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(error);
    }
    if let Err(error) = fs::rename(&tmp_dir, &final_dir) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(error.to_string());
    }

    Ok(summarize_bundle(&recording, &annotations))
}

/// Lists every saved bundle for curation review. A bundle directory that fails
/// to parse (e.g. a `.tmp` staging directory left behind by a crash between
/// `save_recording_bundle`'s write and rename) is skipped rather than failing
/// the whole listing, since curation review of the other bundles must not be
/// blocked by one partial write.
#[tauri::command]
pub fn list_recording_bundles(app: AppHandle) -> Result<Vec<RecordingBundleSummary>, String> {
    let dir = recording_bundles_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok((recording, annotations)) = load_bundle_pair(&path) {
            summaries.push(summarize_bundle(&recording, &annotations));
        }
    }
    summaries.sort_by(|a, b| a.recording_id.cmp(&b.recording_id));
    Ok(summaries)
}

/// Loads one bundle's metadata and annotations for curation review, without
/// its (potentially large) `raw.csv`.
#[tauri::command]
pub fn load_recording_bundle(
    recording_id: String,
    app: AppHandle,
) -> Result<RecordingBundleDetail, String> {
    validate_recording_id(&recording_id)?;
    let dir = recording_bundles_dir(&app)?.join(&recording_id);
    let (recording, annotations) = load_bundle_pair(&dir)?;
    Ok(RecordingBundleDetail { recording, annotations })
}

/// A bounded, read-only window into one numeric `raw.csv` column, resolved
/// to at most `RAW_WINDOW_MAX_VALUES` chronological rows starting at a
/// hop-aligned raw row. This is the only path that ever parses `raw.csv`'s
/// data rows; it never writes the file and never touches
/// `recording.json`/`annotations.json`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRecordingWindow {
    pub recording_id: String,
    pub column: String,
    pub grid_size: u32,
    pub total_raw_row_count: usize,
    pub start_raw_row: usize,
    pub end_raw_row: usize,
    pub row_indices: Vec<usize>,
    pub timestamps_ns: Vec<i64>,
    pub values: Vec<Option<f64>>,
    pub channel_available: bool,
    pub recording_min: Option<f64>,
    pub recording_max: Option<f64>,
}

fn raw_csv_path(dir: &std::path::Path) -> PathBuf {
    dir.join(RAW_CSV_FILE_NAME)
}

/// Parses `raw.csv`'s data rows for exactly one already-validated column,
/// returning that column's full per-row values alongside `timestamp_ns` for
/// every row. Empty fields become `None`, never a coerced/carried-forward
/// value; any non-empty field that fails to parse as a number, any row with
/// the wrong column count, or a header that does not match
/// `RAW_CSV_HEADER` is a malformed-CSV error.
fn parse_raw_csv_column(content: &str, column: &str) -> Result<(Vec<i64>, Vec<Option<f64>>), String> {
    let mut lines = content.lines();
    let header = lines.next().ok_or_else(|| "raw.csv is empty".to_string())?;
    let expected_header = RAW_CSV_HEADER.join(",");
    if header != expected_header {
        return Err(format!(
            "malformed raw.csv: expected header '{expected_header}', got '{header}'"
        ));
    }
    let column_index = RAW_CSV_HEADER
        .iter()
        .position(|candidate| *candidate == column)
        .ok_or_else(|| format!("unsupported raw column '{column}'"))?;

    let mut timestamps_ns = Vec::new();
    let mut values = Vec::new();
    for (offset, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row_number = offset + 2; // 1-indexed, plus the header line
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != RAW_CSV_HEADER.len() {
            return Err(format!(
                "malformed raw.csv: row {row_number} has {} fields, expected {}",
                fields.len(),
                RAW_CSV_HEADER.len()
            ));
        }
        let timestamp_ns: i64 = fields[0]
            .trim()
            .parse()
            .map_err(|_| format!("malformed raw.csv: row {row_number} has a non-numeric timestamp_ns"))?;
        let raw_value = fields[column_index].trim();
        let value = if raw_value.is_empty() {
            None
        } else {
            Some(raw_value.parse::<f64>().map_err(|_| {
                format!("malformed raw.csv: row {row_number} column '{column}' is not numeric")
            })?)
        };
        timestamps_ns.push(timestamp_ns);
        values.push(value);
    }
    Ok((timestamps_ns, values))
}

/// Validates `start_raw_row` and resolves it to a hop-aligned, in-bounds
/// `[start, end)` window against `total_raw_row_count`. Negative or
/// non-hop-aligned starts are rejected outright; an aligned start beyond the
/// last reachable window is clamped deterministically down to the final
/// hop-aligned window so the end of a recording is always reachable.
fn resolve_raw_window_bounds(
    total_raw_row_count: usize,
    start_raw_row: i64,
    grid_size: usize,
) -> Result<(usize, usize), String> {
    if start_raw_row < 0 {
        return Err("start raw row must not be negative".to_string());
    }
    let row_hop = grid_size;
    let max_values = grid_size * grid_size;
    if start_raw_row as u64 % row_hop as u64 != 0 {
        return Err(format!(
            "start raw row {start_raw_row} must be a multiple of {row_hop}"
        ));
    }

    let last_valid_start = if total_raw_row_count <= max_values {
        0
    } else {
        let max_start = total_raw_row_count - max_values;
        (max_start / row_hop) * row_hop
    };
    let requested_start = start_raw_row as usize;
    let resolved_start = requested_start.min(last_valid_start);
    let resolved_end = (resolved_start + max_values).min(total_raw_row_count);
    Ok((resolved_start, resolved_end))
}

/// Returns a bounded, chronological window of one numeric `raw.csv` column
/// for image-viewer inspection. This never writes any bundle file and never
/// changes `load_recording_bundle`'s metadata/annotation behavior.
#[tauri::command]
pub fn get_raw_recording_window(
    recording_id: String,
    column: String,
    start_raw_row: i64,
    grid_size: u32,
    app: AppHandle,
) -> Result<RawRecordingWindow, String> {
    validate_recording_id(&recording_id)?;
    if !RAW_WINDOW_ALLOWED_COLUMNS.contains(&column.as_str()) {
        return Err(format!("unsupported raw column '{column}'"));
    }
    let grid_size_usize = validate_grid_size(grid_size)?;

    let dir = recording_bundles_dir(&app)?.join(&recording_id);
    let csv_path = raw_csv_path(&dir);
    let content = fs::read_to_string(&csv_path)
        .map_err(|error| format!("failed to read raw.csv for recording '{recording_id}': {error}"))?;
    if content.len() > MAX_RAW_CSV_BYTES {
        return Err(format!(
            "raw.csv exceeds the {MAX_RAW_CSV_BYTES}-byte limit (got {} bytes)",
            content.len()
        ));
    }
    let (timestamps_ns, all_values) = parse_raw_csv_column(&content, &column)?;

    let total_raw_row_count = all_values.len();
    let (resolved_start, resolved_end) =
        resolve_raw_window_bounds(total_raw_row_count, start_raw_row, grid_size_usize)?;

    let window_values = all_values[resolved_start..resolved_end].to_vec();
    let window_timestamps = timestamps_ns[resolved_start..resolved_end].to_vec();
    let row_indices: Vec<usize> = (resolved_start..resolved_end).collect();

    let channel_available = all_values.iter().any(Option::is_some);
    let recording_min = all_values
        .iter()
        .filter_map(|value| *value)
        .fold(None, |acc: Option<f64>, value| {
            Some(acc.map_or(value, |current| current.min(value)))
        });
    let recording_max = all_values
        .iter()
        .filter_map(|value| *value)
        .fold(None, |acc: Option<f64>, value| {
            Some(acc.map_or(value, |current| current.max(value)))
        });

    Ok(RawRecordingWindow {
        recording_id,
        column,
        grid_size,
        total_raw_row_count,
        start_raw_row: resolved_start,
        end_raw_row: resolved_end,
        row_indices,
        timestamps_ns: window_timestamps,
        values: window_values,
        channel_available,
        recording_min,
        recording_max,
    })
}

/// Sets one interval's curation status after a bundle has been saved,
/// bumping its revision. `raw.csv` is never touched; only `annotations.json`
/// is rewritten, atomically via a sibling tmp file plus rename.
#[tauri::command]
pub fn set_interval_curation_status(
    recording_id: String,
    interval_id: String,
    curation_status: CurationStatus,
    app: AppHandle,
) -> Result<AnnotationInterval, String> {
    validate_recording_id(&recording_id)?;
    let dir = recording_bundles_dir(&app)?.join(&recording_id);
    let annotations_path = dir.join(ANNOTATIONS_FILE_NAME);
    let annotations_json =
        fs::read_to_string(&annotations_path).map_err(|error| error.to_string())?;
    let mut annotations: AnnotationsFile =
        serde_json::from_str(&annotations_json).map_err(|error| error.to_string())?;

    let interval = annotations
        .intervals
        .iter_mut()
        .find(|interval| interval.interval_id == interval_id)
        .ok_or_else(|| format!("interval '{interval_id}' not found in recording '{recording_id}'"))?;
    interval.curation_status = curation_status;
    interval.revision += 1;
    let updated = interval.clone();

    let updated_json =
        serde_json::to_string_pretty(&annotations).map_err(|error| error.to_string())?;
    let tmp_path = dir.join(format!("{ANNOTATIONS_FILE_NAME}.tmp"));
    fs::write(&tmp_path, updated_json).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &annotations_path).map_err(|error| error.to_string())?;

    Ok(updated)
}

fn write_bundle_files(
    tmp_dir: &std::path::Path,
    raw_csv: &str,
    recording: &RecordingMetadata,
    annotations: &AnnotationsFile,
) -> Result<(), String> {
    fs::create_dir_all(tmp_dir).map_err(|error| error.to_string())?;
    fs::write(tmp_dir.join(RAW_CSV_FILE_NAME), raw_csv).map_err(|error| error.to_string())?;
    let recording_json =
        serde_json::to_string_pretty(recording).map_err(|error| error.to_string())?;
    fs::write(tmp_dir.join(RECORDING_METADATA_FILE_NAME), recording_json)
        .map_err(|error| error.to_string())?;
    let annotations_json =
        serde_json::to_string_pretty(annotations).map_err(|error| error.to_string())?;
    fs::write(tmp_dir.join(ANNOTATIONS_FILE_NAME), annotations_json)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn sample_metadata(id: &str) -> RecordingMetadata {
        RecordingMetadata {
            format_version: 1,
            recording_id: id.to_string(),
            requested_start_at: "2026-09-16T10:00:00Z".to_string(),
            actual_start: MonotonicWallClock {
                monotonic_ns: 42_000_000_000,
                wall_clock_at: "2026-09-16T10:00:01Z".to_string(),
            },
            actual_end: MonotonicWallClock {
                monotonic_ns: 52_000_000_000,
                wall_clock_at: "2026-09-16T10:00:11Z".to_string(),
            },
            requested_duration_ms: None,
            actual_duration_ms: 10_000,
            stop_reason: StopReason::ManualStop,
            sources: vec![RecordingSource {
                source_id: "watch".to_string(),
                configuration: serde_json::json!({ "imu_rate_hz": 100 }),
            }],
            raw_row_count: 2,
            raw_source_row_counts: BTreeMap::from([("watch".to_string(), 2)]),
        }
    }

    fn sample_annotations(id: &str) -> AnnotationsFile {
        AnnotationsFile {
            format_version: 1,
            recording_id: id.to_string(),
            intervals: vec![AnnotationInterval {
                interval_id: Uuid::new_v4().to_string(),
                label_id: "pinch_start".to_string(),
                requested_start_monotonic_ns: 42_000_000_000,
                requested_end_monotonic_ns: 52_000_000_000,
                resolved_start: ResolvedBoundary {
                    raw_row: 0,
                    source_timestamp_ns: 7_000_000_000,
                },
                resolved_end: ResolvedBoundary {
                    raw_row: 1,
                    source_timestamp_ns: 17_000_000_000,
                },
                resolution_rule_version: 1,
                creation_mechanism: CreationMechanism::QuickCapture,
                curation_status: CurationStatus::Unreviewed,
                created_at: "2026-09-16T10:00:11Z".to_string(),
                revision: 1,
            }],
        }
    }

    #[test]
    fn validate_recording_id_rejects_path_traversal() {
        assert!(validate_recording_id("../../etc/passwd").is_err());
        assert!(validate_recording_id("../secret").is_err());
        assert!(validate_recording_id("/etc/passwd").is_err());
        assert!(validate_recording_id("a/b").is_err());
        assert!(validate_recording_id("").is_err());
        assert!(validate_recording_id(&Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn write_bundle_files_creates_all_three_files() {
        let id = Uuid::new_v4().to_string();
        let tmp_dir = std::env::temp_dir().join(format!("recording-bundle-test-{id}"));
        write_bundle_files(&tmp_dir, "timestamp_ns\n1\n", &sample_metadata(&id), &sample_annotations(&id))
            .expect("writing a fresh bundle must succeed");
        assert!(tmp_dir.join(RAW_CSV_FILE_NAME).exists());
        assert!(tmp_dir.join(RECORDING_METADATA_FILE_NAME).exists());
        assert!(tmp_dir.join(ANNOTATIONS_FILE_NAME).exists());
        let recording_json = fs::read_to_string(tmp_dir.join(RECORDING_METADATA_FILE_NAME)).unwrap();
        let parsed: RecordingMetadata = serde_json::from_str(&recording_json).unwrap();
        assert_eq!(parsed.recording_id, id);
        assert_eq!(parsed.stop_reason, StopReason::ManualStop);
        fs::remove_dir_all(&tmp_dir).ok();
    }

    #[test]
    fn recording_bundles_dir_name_matches_adr() {
        assert_eq!(RECORDING_BUNDLES_DIR_NAME, "recording");
    }

    #[test]
    fn summarize_bundle_counts_labels_and_curation_statuses() {
        let id = Uuid::new_v4().to_string();
        let mut annotations = sample_annotations(&id);
        annotations.intervals.push(AnnotationInterval {
            interval_id: Uuid::new_v4().to_string(),
            label_id: "idle".to_string(),
            requested_start_monotonic_ns: 0,
            requested_end_monotonic_ns: 1,
            resolved_start: ResolvedBoundary { raw_row: 0, source_timestamp_ns: 0 },
            resolved_end: ResolvedBoundary { raw_row: 0, source_timestamp_ns: 0 },
            resolution_rule_version: 1,
            creation_mechanism: CreationMechanism::TimelineEdit,
            curation_status: CurationStatus::Excluded,
            created_at: "2026-09-16T10:00:11Z".to_string(),
            revision: 1,
        });
        let summary = summarize_bundle(&sample_metadata(&id), &annotations);
        assert_eq!(summary.interval_count, 2);
        assert_eq!(summary.label_ids, vec!["idle".to_string(), "pinch_start".to_string()]);
        assert_eq!(summary.unreviewed_count, 1);
        assert_eq!(summary.excluded_count, 1);
        assert_eq!(summary.approved_count, 0);
    }

    fn write_temp_bundle(id: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("recording-bundle-curation-test-{id}"));
        write_bundle_files(&dir, "timestamp_ns\n1\n", &sample_metadata(id), &sample_annotations(id))
            .expect("writing a fresh bundle must succeed");
        dir
    }

    #[test]
    fn list_recording_bundles_skips_unparsable_tmp_directories() {
        let id = Uuid::new_v4().to_string();
        let dir = write_temp_bundle(&id);
        let tmp_dir = dir.parent().unwrap().join(format!("{id}.tmp"));
        fs::create_dir_all(&tmp_dir).unwrap();

        let (recording, annotations) = load_bundle_pair(&dir).expect("bundle must parse");
        assert_eq!(recording.recording_id, id);
        assert_eq!(annotations.intervals.len(), 1);
        assert!(load_bundle_pair(&tmp_dir).is_err());

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&tmp_dir).ok();
    }

    #[test]
    fn interval_curation_update_bumps_revision_and_persists() {
        let id = Uuid::new_v4().to_string();
        let dir = write_temp_bundle(&id);
        let annotations_path = dir.join(ANNOTATIONS_FILE_NAME);

        let mut annotations: AnnotationsFile =
            serde_json::from_str(&fs::read_to_string(&annotations_path).unwrap()).unwrap();
        let interval_id = annotations.intervals[0].interval_id.clone();
        let interval = annotations.intervals.iter_mut().find(|i| i.interval_id == interval_id).unwrap();
        interval.curation_status = CurationStatus::Approved;
        interval.revision += 1;
        let expected_revision = interval.revision;
        fs::write(&annotations_path, serde_json::to_string_pretty(&annotations).unwrap()).unwrap();

        let reloaded: AnnotationsFile =
            serde_json::from_str(&fs::read_to_string(&annotations_path).unwrap()).unwrap();
        let reloaded_interval = reloaded.intervals.iter().find(|i| i.interval_id == interval_id).unwrap();
        assert_eq!(reloaded_interval.curation_status, CurationStatus::Approved);
        assert_eq!(reloaded_interval.revision, expected_revision);

        fs::remove_dir_all(&dir).ok();
    }

    fn raw_csv_with_rows(rows: &[(i64, &str)]) -> String {
        let mut lines = vec![RAW_CSV_HEADER.join(",")];
        for (timestamp_ns, ppg_green) in rows {
            let mut fields = vec![timestamp_ns.to_string(), "0".to_string(), ppg_green.to_string()];
            fields.extend(std::iter::repeat("".to_string()).take(RAW_CSV_HEADER.len() - fields.len()));
            lines.push(fields.join(","));
        }
        lines.join("\n")
    }

    #[test]
    fn parse_raw_csv_column_preserves_nulls_and_rejects_bad_header() {
        let csv = raw_csv_with_rows(&[(1, "1.5"), (2, ""), (3, "3.5")]);
        let (timestamps, values) = parse_raw_csv_column(&csv, "ppg_green").expect("valid csv must parse");
        assert_eq!(timestamps, vec![1, 2, 3]);
        assert_eq!(values, vec![Some(1.5), None, Some(3.5)]);

        assert!(parse_raw_csv_column("not,a,header", "ppg_green").is_err());
        assert!(parse_raw_csv_column(&csv, "sequence").is_err());
    }

    #[test]
    fn parse_raw_csv_column_rejects_malformed_rows() {
        let header = RAW_CSV_HEADER.join(",");
        let short_row = format!("{header}\n1,0,1.5");
        assert!(parse_raw_csv_column(&short_row, "ppg_green").is_err());

        let mut fields = vec!["1".to_string(), "0".to_string(), "not_a_number".to_string()];
        fields.extend(std::iter::repeat("".to_string()).take(RAW_CSV_HEADER.len() - fields.len()));
        let non_numeric_value = format!("{header}\n{}", fields.join(","));
        assert!(parse_raw_csv_column(&non_numeric_value, "ppg_green").is_err());
    }

    #[test]
    fn resolve_raw_window_bounds_rejects_negative_and_unaligned_starts() {
        assert!(resolve_raw_window_bounds(10_000, -1, 64).is_err());
        assert!(resolve_raw_window_bounds(10_000, 1, 64).is_err());
        assert!(resolve_raw_window_bounds(10_000, 63, 64).is_err());
        assert!(resolve_raw_window_bounds(10_000, 64, 64).is_ok());
    }

    #[test]
    fn resolve_raw_window_bounds_clamps_deterministically_to_final_window() {
        // 10_000 rows: last full-window start is the largest multiple of 64
        // such that start + 4096 <= 10_000, i.e. floor(5904 / 64) * 64 = 5888.
        let (start, end) = resolve_raw_window_bounds(10_000, 5888, 64).unwrap();
        assert_eq!((start, end), (5888, 9984));

        // Requesting far past the end clamps to that same final window.
        let (start, end) = resolve_raw_window_bounds(10_000, 1_000_000, 64).unwrap();
        assert_eq!((start, end), (5888, 9984));

        // Re-requesting the already-clamped final start is idempotent.
        let (start, end) = resolve_raw_window_bounds(10_000, start as i64, 64).unwrap();
        assert_eq!((start, end), (5888, 9984));
    }

    #[test]
    fn resolve_raw_window_bounds_handles_short_recordings() {
        assert_eq!(resolve_raw_window_bounds(0, 0, 64).unwrap(), (0, 0));
        assert_eq!(resolve_raw_window_bounds(100, 0, 64).unwrap(), (0, 100));
        // Any aligned start beyond a short recording clamps back to 0.
        assert_eq!(resolve_raw_window_bounds(100, 64, 64).unwrap(), (0, 100));
    }

    #[test]
    fn resolve_raw_window_bounds_scales_hop_and_window_with_grid_size() {
        // 8x8: hop 8, max 64 values.
        assert!(resolve_raw_window_bounds(1_000, 4, 8).is_err());
        let (start, end) = resolve_raw_window_bounds(1_000, 936, 8).unwrap();
        assert_eq!((start, end), (936, 1_000));

        // 16x16: hop 16, max 256 values.
        let (start, end) = resolve_raw_window_bounds(1_000, 1_000_000, 16).unwrap();
        assert_eq!(end - start, 256);
        assert_eq!(start % 16, 0);
    }

    #[test]
    fn validate_grid_size_allows_only_the_listed_sizes() {
        for size in RAW_GRID_SIZES {
            assert!(validate_grid_size(size).is_ok());
        }
        assert!(validate_grid_size(2).is_err());
        assert!(validate_grid_size(6).is_err());
        assert!(validate_grid_size(50).is_err());
        assert!(validate_grid_size(128).is_err());
        assert!(RAW_GRID_SIZES.contains(&DEFAULT_RAW_GRID_SIZE));
        let max_grid_size = RAW_GRID_SIZES.iter().max().copied().unwrap();
        assert_eq!((max_grid_size * max_grid_size) as usize, RAW_WINDOW_MAX_VALUES);
    }

    #[test]
    fn validate_raw_csv_full_accepts_valid_csv_and_reports_row_count_and_timestamps() {
        let csv = raw_csv_with_rows(&[(10, "1.5"), (20, ""), (30, "3.5")]);
        let (row_count, first, last) = validate_raw_csv_full(&csv).expect("valid csv must parse");
        assert_eq!((row_count, first, last), (3, 10, 30));
    }

    #[test]
    fn validate_raw_csv_full_rejects_bad_header_wrong_field_count_and_non_numeric_fields() {
        assert!(validate_raw_csv_full("not,a,header").is_err());
        assert!(validate_raw_csv_full(&RAW_CSV_HEADER.join(",")).is_err()); // header only, no rows

        let header = RAW_CSV_HEADER.join(",");
        let short_row = format!("{header}\n1,0,1.5");
        assert!(validate_raw_csv_full(&short_row).is_err());

        let mut fields = vec!["1".to_string(), "not_a_number".to_string()];
        fields.extend(std::iter::repeat("".to_string()).take(RAW_CSV_HEADER.len() - fields.len()));
        let non_numeric = format!("{header}\n{}", fields.join(","));
        assert!(validate_raw_csv_full(&non_numeric).is_err());
    }

    fn legacy_row(timestamp_ns: i64, ppg_green: &str, label: &str) -> String {
        let mut fields = vec![timestamp_ns.to_string(), "0".to_string(), ppg_green.to_string()];
        fields.extend(std::iter::repeat("".to_string()).take(DATASET_CSV_HEADER.len() - 1 - fields.len()));
        fields.push(label.to_string());
        fields.join(",")
    }

    #[test]
    fn convert_legacy_dataset_csv_strips_metadata_and_label_preserving_row_order() {
        let legacy = format!(
            "# gesture-dataset-export\n# label: pinch\n{}\n{}\n{}\n",
            DATASET_CSV_HEADER.join(","),
            legacy_row(1, "1.5", "pinch"),
            legacy_row(2, "", "idle"),
        );
        let converted = convert_legacy_dataset_csv(&legacy)
            .expect("legacy header must be recognized")
            .expect("well-formed legacy csv must convert");
        let (_, values) = parse_raw_csv_column(&converted, "ppg_green").expect("converted csv must be valid raw.csv");
        assert_eq!(values, vec![Some(1.5), None]);
        assert_eq!(converted.lines().count(), 3);
    }

    #[test]
    fn convert_legacy_dataset_csv_accepts_empty_label_but_rejects_wrong_column_count() {
        let header = DATASET_CSV_HEADER.join(",");
        // Exactly the shape Timeline Capture's own export produces for unlabeled rows
        // (`telemetryStore.ts::generateDatasetCsv`): raw inspection never uses labels.
        let empty_label = format!("{header}\n{}\n", legacy_row(1, "1.5", ""));
        let converted = convert_legacy_dataset_csv(&empty_label)
            .expect("legacy header must be recognized")
            .expect("an empty per-row label must not be rejected");
        assert!(validate_raw_csv_full(&converted).is_ok());

        let wrong_columns = format!("{header}\n1,0,1.5\n");
        assert!(convert_legacy_dataset_csv(&wrong_columns).unwrap().is_err());
    }

    #[test]
    fn convert_legacy_dataset_csv_ignores_non_legacy_documents() {
        assert!(convert_legacy_dataset_csv(&RAW_CSV_HEADER.join(",")).is_none());
        assert!(convert_legacy_dataset_csv("not,a,header").is_none());
    }

    #[test]
    fn import_recording_from_raw_csv_uses_stable_source_identity() {
        assert_eq!(IMPORTED_SOURCE_ID, "timeline_capture_csv_import");
    }

    #[test]
    fn get_raw_recording_window_allow_list_matches_header_minus_metadata_columns() {
        for column in RAW_WINDOW_ALLOWED_COLUMNS {
            assert!(RAW_CSV_HEADER.contains(&column));
        }
        assert!(!RAW_WINDOW_ALLOWED_COLUMNS.contains(&"timestamp_ns"));
        assert!(!RAW_WINDOW_ALLOWED_COLUMNS.contains(&"sequence"));
    }
}
