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
//! format, converting it server-side into a canonical `raw.csv` plus derived
//! `annotations.json` intervals from its label column (see
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
    /// Informational only: true when `recording.json`'s `sources` is exactly
    /// the single imported source written by `import_recording_from_raw_csv`
    /// (see `is_imported_only`). Every saved bundle — imported or manually
    /// captured — is equally eligible for `delete_recording_bundle`; this
    /// field is not a deletion gate.
    pub is_imported: bool,
}

/// True only when `recording.sources` is exactly the single
/// `IMPORTED_SOURCE_ID` source written by `import_recording_from_raw_csv` —
/// never for a manually-saved bundle, which always carries its own recorder
/// sources (e.g. `"watch"`) instead.
fn is_imported_only(recording: &RecordingMetadata) -> bool {
    recording.sources.len() == 1 && recording.sources[0].source_id == IMPORTED_SOURCE_ID
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
        is_imported: is_imported_only(recording),
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

/// One maximal contiguous run of non-blank, same-label rows found while
/// converting a legacy dataset CSV, in terms of the resulting `raw.csv`'s
/// own 0-based row indices (post blank-line filtering) — ready to become one
/// `AnnotationInterval`.
struct LegacyLabelRun {
    label: String,
    start_row: usize,
    end_row: usize,
    start_timestamp_ns: i64,
    end_timestamp_ns: i64,
}

/// If `content` is in the legacy dataset-export shape (optional leading `#`
/// metadata lines, then the exact `DATASET_CSV_HEADER` row), converts it into
/// a canonical `raw.csv` document by dropping the metadata lines and the
/// trailing `label` field from every data row, and also derives one
/// `LegacyLabelRun` per maximal contiguous run of non-blank same-label rows
/// (a blank/whitespace-only label cell, a blank line, or a change of label
/// ends the current run). Row order and every retained field's original
/// string form are preserved unchanged; only the discarded metadata/label
/// content is removed from `raw.csv` itself — the label text lives on in the
/// returned runs instead of being dropped. Returns `None` when `content` is
/// not headed by the legacy header at all (the caller then validates it as a
/// plain `raw.csv` document instead, with no derived annotations). A
/// malformed legacy document (wrong column count) is a hard `Err`, not a
/// fall-through. The label field itself is never validated for content here
/// — raw inspection doesn't use labels, and Timeline Capture's own export
/// (`telemetryStore.ts::generateDatasetCsv`) legitimately produces this exact
/// legacy header with an empty label, e.g. for unannotated rows; label
/// presence/validity stays `model_lab.rs`'s concern for the training-import
/// path.
fn convert_legacy_dataset_csv(content: &str) -> Option<Result<(String, Vec<LegacyLabelRun>), String>> {
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
    let mut runs: Vec<LegacyLabelRun> = Vec::new();
    let mut current_run: Option<LegacyLabelRun> = None;
    let label_column = RAW_CSV_HEADER.len();
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
        let row_index = converted_lines.len() - 2; // 0-based, header excluded
        // A malformed timestamp fails `validate_raw_csv_full` right after this
        // function returns, so a 0 placeholder here is never actually surfaced.
        let timestamp_ns: i64 = fields[0].trim().parse().unwrap_or(0);
        let label = fields[label_column].trim();

        if label.is_empty() {
            if let Some(run) = current_run.take() {
                runs.push(run);
            }
            continue;
        }
        match &mut current_run {
            Some(run) if run.label == label => {
                run.end_row = row_index;
                run.end_timestamp_ns = timestamp_ns;
            }
            _ => {
                if let Some(run) = current_run.take() {
                    runs.push(run);
                }
                current_run = Some(LegacyLabelRun {
                    label: label.to_string(),
                    start_row: row_index,
                    end_row: row_index,
                    start_timestamp_ns: timestamp_ns,
                    end_timestamp_ns: timestamp_ns,
                });
            }
        }
    }
    if let Some(run) = current_run.take() {
        runs.push(run);
    }
    Some(Ok((converted_lines.join("\n"), runs)))
}

/// Imports a Timeline Capture `raw.csv` document (exact `RAW_CSV_HEADER`
/// contract), or the app's legacy dataset-export CSV (exact
/// `DATASET_CSV_HEADER` contract, converted via `convert_legacy_dataset_csv`)
/// — no arbitrary-CSV mapping — as a new, immutable, read-only recording
/// bundle. All metadata (`recording_id`, timestamps, row counts, source
/// identity) is generated server-side from the validated CSV content; no
/// browser-supplied recording metadata is trusted. A plain `raw.csv` import
/// has no annotations. A legacy dataset-export import instead gets one
/// `AnnotationInterval` per maximal contiguous same-label run from its label
/// column (see `convert_legacy_dataset_csv`); a legacy file with only blank
/// labels likewise gets no annotations. The bundle is written through the
/// same atomic stage-then-rename path as `save_recording_bundle`.
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
    let (csv_text, legacy_label_runs) = match convert_legacy_dataset_csv(&csv_text) {
        Some(result) => result?,
        None => (csv_text, Vec::new()),
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
    let intervals = legacy_label_runs
        .into_iter()
        .map(|run| AnnotationInterval {
            interval_id: Uuid::new_v4().to_string(),
            label_id: run.label,
            requested_start_monotonic_ns: run.start_timestamp_ns,
            requested_end_monotonic_ns: run.end_timestamp_ns,
            resolved_start: ResolvedBoundary { raw_row: run.start_row, source_timestamp_ns: run.start_timestamp_ns },
            resolved_end: ResolvedBoundary { raw_row: run.end_row, source_timestamp_ns: run.end_timestamp_ns },
            resolution_rule_version: 1,
            creation_mechanism: CreationMechanism::TimelineEdit,
            curation_status: CurationStatus::Unreviewed,
            created_at: recording.requested_start_at.clone(),
            revision: 1,
        })
        .collect();
    let annotations = AnnotationsFile {
        format_version: 1,
        recording_id: recording_id.clone(),
        intervals,
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

/// Permanently deletes one saved recording bundle's directory (`raw.csv`,
/// `recording.json`, `annotations.json`) — manually captured and imported
/// bundles alike. `recording_id` is validated before it ever reaches a
/// `Path::join` (`validate_recording_id` rejects empty ids and anything but
/// `[A-Za-z0-9-]`, so path traversal and multi-segment ids are impossible),
/// and the bundle is loaded from disk first to confirm the id resolves to a
/// real, well-formed bundle before anything is removed — the UI is never
/// trusted to have supplied a valid id on its own. Only that one bundle's own
/// subdirectory under the recordings root is removed; the root itself is
/// never touched. This is irreversible: there is no recycle bin or undo.
#[tauri::command]
pub fn delete_recording_bundle(recording_id: String, app: AppHandle) -> Result<(), String> {
    validate_recording_id(&recording_id)?;
    let dir = recording_bundles_dir(&app)?.join(&recording_id);
    load_bundle_pair(&dir)?;
    fs::remove_dir_all(&dir).map_err(|error| error.to_string())
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

/// A short label interval is flagged as too brief to give the fixed 500 ms
/// model window usable context (see the milestone plan's collection-protocol
/// rationale); this does not reject or alter the interval, only surfaces it.
const SHORT_LABEL_THRESHOLD_MS: f64 = 150.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TimestampStatus {
    /// At least two rows, strictly non-decreasing `timestamp_ns`, usable span.
    Ok,
    /// Non-monotonic order and/or a usable span could not be established;
    /// callers must not treat the effective sample rate as trustworthy.
    Warning,
    /// Fewer than two rows: no basis for a rate or monotonicity claim at all.
    InsufficientData,
}

/// Read-only, derived-only recording/collection quality summary (M1):
/// computed fresh from the immutable `raw.csv` plus `annotations.json` on
/// every call, never persisted and never a basis for rewriting either file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingQualitySummary {
    pub recording_id: String,
    pub row_count: usize,
    pub time_span_ms: f64,
    pub timestamp_status: TimestampStatus,
    pub non_monotonic_row_count: usize,
    pub effective_sample_rate_hz: Option<f64>,
    /// Per allow-listed channel: count of empty/missing values across every row.
    pub missing_value_counts: BTreeMap<String, usize>,
    /// Channels with zero recorded values anywhere in this recording.
    pub missing_channels: Vec<String>,
    pub interval_count: usize,
    pub labeled_row_count: usize,
    pub unlabeled_row_count: usize,
    pub short_label_interval_ids: Vec<String>,
    pub short_label_threshold_ms: f64,
    /// Human-readable, actionable warnings; empty when nothing is flagged.
    pub warnings: Vec<String>,
}

/// Pure computation behind `get_recording_quality_summary`, kept separate
/// from file IO so it is directly unit-testable against synthetic CSV text.
fn compute_quality_summary(
    recording_id: String,
    raw_csv: &str,
    annotations: &AnnotationsFile,
) -> Result<RecordingQualitySummary, String> {
    // `timestamp_ns` is present in every allow-listed-column parse; reuse the
    // first one purely for the shared timestamp series.
    let (timestamps_ns, _) = parse_raw_csv_column(raw_csv, RAW_WINDOW_ALLOWED_COLUMNS[0])?;
    let row_count = timestamps_ns.len();

    let mut non_monotonic_row_count = 0usize;
    for window in timestamps_ns.windows(2) {
        if window[1] < window[0] {
            non_monotonic_row_count += 1;
        }
    }
    let time_span_ns = match (timestamps_ns.first(), timestamps_ns.last()) {
        (Some(first), Some(last)) => (last - first).max(0),
        _ => 0,
    };
    let time_span_ms = time_span_ns as f64 / 1_000_000.0;

    let timestamp_status = if row_count < 2 {
        TimestampStatus::InsufficientData
    } else if non_monotonic_row_count > 0 || time_span_ns <= 0 {
        TimestampStatus::Warning
    } else {
        TimestampStatus::Ok
    };

    let effective_sample_rate_hz = if timestamp_status == TimestampStatus::Ok {
        Some((row_count - 1) as f64 / (time_span_ns as f64 / 1_000_000_000.0))
    } else {
        None
    };

    let mut missing_value_counts = BTreeMap::new();
    let mut missing_channels = Vec::new();
    for column in RAW_WINDOW_ALLOWED_COLUMNS {
        let (_, values) = parse_raw_csv_column(raw_csv, column)?;
        let missing = values.iter().filter(|value| value.is_none()).count();
        missing_value_counts.insert(column.to_string(), missing);
        if row_count > 0 && missing == row_count {
            missing_channels.push(column.to_string());
        }
    }

    let labeled_row_count: usize = annotations
        .intervals
        .iter()
        .map(|interval| {
            interval
                .resolved_end
                .raw_row
                .saturating_sub(interval.resolved_start.raw_row)
                + 1
        })
        .sum::<usize>()
        .min(row_count);
    let unlabeled_row_count = row_count.saturating_sub(labeled_row_count);

    let short_label_interval_ids: Vec<String> = annotations
        .intervals
        .iter()
        .filter(|interval| {
            let duration_ms = (interval.resolved_end.source_timestamp_ns
                - interval.resolved_start.source_timestamp_ns) as f64
                / 1_000_000.0;
            duration_ms < SHORT_LABEL_THRESHOLD_MS
        })
        .map(|interval| interval.interval_id.clone())
        .collect();

    let mut warnings = Vec::new();
    match timestamp_status {
        TimestampStatus::Warning if non_monotonic_row_count > 0 => warnings.push(format!(
            "{non_monotonic_row_count} row(s) are out of chronological order; the effective sample rate cannot be trusted."
        )),
        TimestampStatus::Warning => warnings.push(
            "Recording has zero observed time span; timestamps cannot establish a sample rate.".to_string(),
        ),
        TimestampStatus::InsufficientData => {
            warnings.push("Fewer than two rows; timestamp quality cannot be assessed.".to_string())
        }
        TimestampStatus::Ok => {}
    }
    if !missing_channels.is_empty() {
        warnings.push(format!(
            "{} channel(s) have no recorded values: {}.",
            missing_channels.len(),
            missing_channels.join(", ")
        ));
    }
    if !short_label_interval_ids.is_empty() {
        warnings.push(format!(
            "{} labeled interval(s) are shorter than {SHORT_LABEL_THRESHOLD_MS:.0} ms, which may be too brief for the current model window.",
            short_label_interval_ids.len()
        ));
    }

    Ok(RecordingQualitySummary {
        recording_id,
        row_count,
        time_span_ms,
        timestamp_status,
        non_monotonic_row_count,
        effective_sample_rate_hz,
        missing_value_counts,
        missing_channels,
        interval_count: annotations.intervals.len(),
        labeled_row_count,
        unlabeled_row_count,
        short_label_interval_ids,
        short_label_threshold_ms: SHORT_LABEL_THRESHOLD_MS,
        warnings,
    })
}

/// Returns a derived-only recording/collection quality summary (M1): row
/// count, timestamp monotonicity/effective sample rate, per-channel missing
/// values, and label coverage/short-label warnings. Never writes any bundle
/// file and never rewrites legacy imports; a bad/mixed timestamp stream is
/// reported via `warnings`, not silently presented as clean.
#[tauri::command]
pub fn get_recording_quality_summary(
    recording_id: String,
    app: AppHandle,
) -> Result<RecordingQualitySummary, String> {
    validate_recording_id(&recording_id)?;
    let dir = recording_bundles_dir(&app)?.join(&recording_id);
    let (_, annotations) = load_bundle_pair(&dir)?;
    let content = fs::read_to_string(raw_csv_path(&dir))
        .map_err(|error| format!("failed to read raw.csv for recording '{recording_id}': {error}"))?;
    if content.len() > MAX_RAW_CSV_BYTES {
        return Err(format!(
            "raw.csv exceeds the {MAX_RAW_CSV_BYTES}-byte limit (got {} bytes)",
            content.len()
        ));
    }
    compute_quality_summary(recording_id, &content, &annotations)
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

    fn empty_annotations(id: &str) -> AnnotationsFile {
        AnnotationsFile { format_version: 1, recording_id: id.to_string(), intervals: vec![] }
    }

    fn interval(
        raw_row_start: usize,
        raw_row_end: usize,
        start_ns: i64,
        end_ns: i64,
    ) -> AnnotationInterval {
        AnnotationInterval {
            interval_id: Uuid::new_v4().to_string(),
            label_id: "pinch".to_string(),
            requested_start_monotonic_ns: start_ns,
            requested_end_monotonic_ns: end_ns,
            resolved_start: ResolvedBoundary { raw_row: raw_row_start, source_timestamp_ns: start_ns },
            resolved_end: ResolvedBoundary { raw_row: raw_row_end, source_timestamp_ns: end_ns },
            resolution_rule_version: 1,
            creation_mechanism: CreationMechanism::TimelineEdit,
            curation_status: CurationStatus::Unreviewed,
            created_at: "2026-09-22T00:00:00Z".to_string(),
            revision: 1,
        }
    }

    #[test]
    fn quality_summary_reports_ok_for_uniform_monotonic_timestamps() {
        // 11 rows at exactly 20ms spacing => 50Hz effective rate.
        let rows: Vec<(i64, &str)> = (0..11).map(|i| (i * 20_000_000, "1.0")).collect();
        let csv = raw_csv_with_rows(&rows);
        let id = Uuid::new_v4().to_string();
        let summary = compute_quality_summary(id.clone(), &csv, &empty_annotations(&id)).unwrap();
        assert_eq!(summary.row_count, 11);
        assert_eq!(summary.timestamp_status, TimestampStatus::Ok);
        assert_eq!(summary.non_monotonic_row_count, 0);
        assert!((summary.effective_sample_rate_hz.unwrap() - 50.0).abs() < 1e-6);
        assert!(summary.warnings.is_empty());
    }

    #[test]
    fn quality_summary_flags_non_monotonic_timestamps_as_warning() {
        let csv = raw_csv_with_rows(&[
            (0, "1.0"),
            (20_000_000, "1.0"),
            (10_000_000, "1.0"),
            (40_000_000, "1.0"),
        ]);
        let id = Uuid::new_v4().to_string();
        let summary = compute_quality_summary(id.clone(), &csv, &empty_annotations(&id)).unwrap();
        assert_eq!(summary.timestamp_status, TimestampStatus::Warning);
        assert_eq!(summary.non_monotonic_row_count, 1);
        assert!(summary.effective_sample_rate_hz.is_none());
        assert!(
            summary
                .warnings
                .iter()
                .any(|warning| warning.contains("out of chronological order"))
        );
    }

    #[test]
    fn quality_summary_reports_insufficient_data_for_short_streams() {
        let csv = raw_csv_with_rows(&[(0, "1.0")]);
        let id = Uuid::new_v4().to_string();
        let summary = compute_quality_summary(id.clone(), &csv, &empty_annotations(&id)).unwrap();
        assert_eq!(summary.timestamp_status, TimestampStatus::InsufficientData);
        assert!(summary.effective_sample_rate_hz.is_none());
    }

    #[test]
    fn quality_summary_reports_fully_missing_channels() {
        // `raw_csv_with_rows` only ever populates ppg_green; every other
        // allow-listed channel is entirely empty in this fixture.
        let csv = raw_csv_with_rows(&[(0, "1.0"), (20_000_000, "2.0")]);
        let id = Uuid::new_v4().to_string();
        let summary = compute_quality_summary(id.clone(), &csv, &empty_annotations(&id)).unwrap();
        assert!(!summary.missing_channels.contains(&"ppg_green".to_string()));
        assert!(summary.missing_channels.contains(&"accel_x".to_string()));
        assert_eq!(summary.missing_value_counts["accel_x"], 2);
        assert!(summary.warnings.iter().any(|warning| warning.contains("no recorded values")));
    }

    #[test]
    fn quality_summary_flags_short_labeled_intervals_and_counts_coverage() {
        let rows: Vec<(i64, &str)> = (0..10).map(|i| (i * 20_000_000, "1.0")).collect();
        let csv = raw_csv_with_rows(&rows);
        let id = Uuid::new_v4().to_string();
        let mut annotations = empty_annotations(&id);
        // Rows 0..=1 spanning 20ms: well under the 150ms short-label threshold.
        annotations.intervals.push(interval(0, 1, 0, 20_000_000));
        let summary = compute_quality_summary(id.clone(), &csv, &annotations).unwrap();
        assert_eq!(summary.interval_count, 1);
        assert_eq!(summary.labeled_row_count, 2);
        assert_eq!(summary.unlabeled_row_count, 8);
        assert_eq!(summary.short_label_interval_ids.len(), 1);
        assert!(summary.warnings.iter().any(|warning| warning.contains("shorter than")));
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
        let (converted, runs) = convert_legacy_dataset_csv(&legacy)
            .expect("legacy header must be recognized")
            .expect("well-formed legacy csv must convert");
        let (_, values) = parse_raw_csv_column(&converted, "ppg_green").expect("converted csv must be valid raw.csv");
        assert_eq!(values, vec![Some(1.5), None]);
        assert_eq!(converted.lines().count(), 3);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].label, "pinch");
        assert_eq!((runs[0].start_row, runs[0].end_row), (0, 0));
    }

    #[test]
    fn convert_legacy_dataset_csv_accepts_empty_label_but_rejects_wrong_column_count() {
        let header = DATASET_CSV_HEADER.join(",");
        // Exactly the shape Timeline Capture's own export produces for unlabeled rows
        // (`telemetryStore.ts::generateDatasetCsv`): raw inspection never uses labels.
        let empty_label = format!("{header}\n{}\n", legacy_row(1, "1.5", ""));
        let (converted, runs) = convert_legacy_dataset_csv(&empty_label)
            .expect("legacy header must be recognized")
            .expect("an empty per-row label must not be rejected");
        assert!(validate_raw_csv_full(&converted).is_ok());
        assert!(runs.is_empty(), "an all-blank label column must derive no intervals");

        let wrong_columns = format!("{header}\n1,0,1.5\n");
        assert!(convert_legacy_dataset_csv(&wrong_columns).unwrap().is_err());
    }

    #[test]
    fn convert_legacy_dataset_csv_groups_labels_into_maximal_contiguous_runs() {
        let header = DATASET_CSV_HEADER.join(",");
        let legacy = format!(
            "{header}\n{}\n{}\n{}\n{}\n{}\n{}\n",
            legacy_row(1, "1.0", "pinch"),  // row 0: pinch run starts
            legacy_row(2, "1.1", "pinch"),  // row 1: adjacent identical label, same run
            legacy_row(3, "1.2", ""),       // row 2: blank label ends the pinch run
            legacy_row(4, "1.3", "wave"),   // row 3: different label starts a new run
            legacy_row(5, "1.4", "pinch"),  // row 4: same text as first run, but not adjacent
            legacy_row(6, "1.5", "pinch"),  // row 5: adjacent identical label, same run
        );
        let (_, runs) = convert_legacy_dataset_csv(&legacy)
            .expect("legacy header must be recognized")
            .expect("well-formed legacy csv must convert");

        assert_eq!(runs.len(), 3);

        assert_eq!(runs[0].label, "pinch");
        assert_eq!((runs[0].start_row, runs[0].end_row), (0, 1));
        assert_eq!((runs[0].start_timestamp_ns, runs[0].end_timestamp_ns), (1, 2));

        assert_eq!(runs[1].label, "wave");
        assert_eq!((runs[1].start_row, runs[1].end_row), (3, 3));
        assert_eq!((runs[1].start_timestamp_ns, runs[1].end_timestamp_ns), (4, 4));

        assert_eq!(runs[2].label, "pinch");
        assert_eq!((runs[2].start_row, runs[2].end_row), (4, 5));
        assert_eq!((runs[2].start_timestamp_ns, runs[2].end_timestamp_ns), (5, 6));
    }

    #[test]
    fn convert_legacy_dataset_csv_trims_label_whitespace_without_other_normalization() {
        let header = DATASET_CSV_HEADER.join(",");
        let legacy = format!("{header}\n{}\n{}\n", legacy_row(1, "1.0", "  Pinch  "), legacy_row(2, "1.1", "   "));
        let (_, runs) = convert_legacy_dataset_csv(&legacy)
            .expect("legacy header must be recognized")
            .expect("well-formed legacy csv must convert");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].label, "Pinch"); // boundary-trimmed; case/identity otherwise untouched
    }

    #[test]
    fn convert_legacy_dataset_csv_run_timestamps_survive_into_a_valid_raw_csv() {
        let header = DATASET_CSV_HEADER.join(",");
        let legacy = format!(
            "{header}\n{}\n{}\n{}\n",
            legacy_row(1_000_000_000, "1.0", "pinch"),
            legacy_row(2_000_000_000, "1.1", "pinch"),
            legacy_row(3_000_000_000, "1.2", ""),
        );
        let (converted, runs) = convert_legacy_dataset_csv(&legacy)
            .expect("legacy header must be recognized")
            .expect("well-formed legacy csv must convert");
        assert!(validate_raw_csv_full(&converted).is_ok());
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].label, "pinch");
        assert_eq!((runs[0].start_row, runs[0].end_row), (0, 1));
        assert_eq!((runs[0].start_timestamp_ns, runs[0].end_timestamp_ns), (1_000_000_000, 2_000_000_000));
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

    fn imported_metadata(id: &str) -> RecordingMetadata {
        let mut metadata = sample_metadata(id);
        metadata.sources = vec![RecordingSource {
            source_id: IMPORTED_SOURCE_ID.to_string(),
            configuration: serde_json::json!({}),
        }];
        metadata.raw_source_row_counts = BTreeMap::from([(IMPORTED_SOURCE_ID.to_string(), 2)]);
        metadata
    }

    fn empty_annotations(id: &str) -> AnnotationsFile {
        AnnotationsFile { format_version: 1, recording_id: id.to_string(), intervals: Vec::new() }
    }

    #[test]
    fn is_imported_only_matches_the_exact_imported_source_shape() {
        let id = Uuid::new_v4().to_string();
        assert!(is_imported_only(&imported_metadata(&id)));
        assert!(!is_imported_only(&sample_metadata(&id))); // manually-saved: "watch" source

        let mut mixed = imported_metadata(&id);
        mixed.sources.push(RecordingSource { source_id: "watch".to_string(), configuration: serde_json::json!({}) });
        assert!(!is_imported_only(&mixed));
    }

    #[test]
    fn delete_recording_bundle_removes_an_imported_recording() {
        let id = Uuid::new_v4().to_string();
        let dir = std::env::temp_dir().join(format!("recording-bundle-delete-imported-{id}"));
        write_bundle_files(&dir, "timestamp_ns\n1\n", &imported_metadata(&id), &empty_annotations(&id))
            .expect("writing a fresh bundle must succeed");
        assert!(dir.exists());

        let (recording, _annotations) = load_bundle_pair(&dir).expect("bundle must parse");
        assert!(is_imported_only(&recording));

        // Mirrors `delete_recording_bundle`'s own load-then-remove sequence;
        // `AppHandle` (needed to resolve `recording_bundles_dir`) is unavailable in
        // this crate's unit tests, matching every other command in this module.
        fs::remove_dir_all(&dir).expect("delete must succeed for an imported bundle");
        assert!(!dir.exists());
    }

    #[test]
    fn delete_recording_bundle_removes_a_manually_saved_bundle() {
        // sample_metadata: "watch" source, not imported — must now be just as deletable.
        let id = Uuid::new_v4().to_string();
        let dir = write_temp_bundle(&id);
        assert!(dir.exists());

        let (recording, _annotations) = load_bundle_pair(&dir).expect("bundle must parse");
        assert!(!is_imported_only(&recording), "this bundle is manually-saved, not imported");

        fs::remove_dir_all(&dir).expect("delete must succeed for a manually-saved bundle too");
        assert!(!dir.exists());
    }

    #[test]
    fn delete_recording_bundle_removes_only_the_selected_bundle() {
        let target_id = Uuid::new_v4().to_string();
        let sibling_id = Uuid::new_v4().to_string();
        let target_dir = write_temp_bundle(&target_id);
        let sibling_dir = std::env::temp_dir().join(format!("recording-bundle-{sibling_id}"));
        write_bundle_files(&sibling_dir, "timestamp_ns\n1\n", &sample_metadata(&sibling_id), &empty_annotations(&sibling_id))
            .expect("writing the sibling bundle must succeed");
        assert!(target_dir.exists());
        assert!(sibling_dir.exists());

        load_bundle_pair(&target_dir).expect("target bundle must parse before deletion");
        fs::remove_dir_all(&target_dir).expect("deleting the target bundle must succeed");

        assert!(!target_dir.exists());
        assert!(sibling_dir.exists(), "a sibling bundle must be untouched by deleting another one");
        fs::remove_dir_all(&sibling_dir).ok();
    }

    #[test]
    fn delete_recording_bundle_id_validation_rejects_path_traversal() {
        assert!(validate_recording_id("../../etc/passwd").is_err());
        assert!(validate_recording_id("../secret").is_err());
        assert!(validate_recording_id("a/b").is_err());
        assert!(validate_recording_id("").is_err());
    }

    #[test]
    fn delete_recording_bundle_rejects_an_id_with_no_matching_bundle_on_disk() {
        // `load_bundle_pair` is what `delete_recording_bundle` calls to confirm the id
        // resolves to a real bundle before ever calling `remove_dir_all`.
        let missing_dir = std::env::temp_dir().join(format!("recording-bundle-missing-{}", Uuid::new_v4()));
        assert!(load_bundle_pair(&missing_dir).is_err());
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
