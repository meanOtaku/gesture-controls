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

/// A bounded, read-only window of one numeric `raw.csv` column's **observed**
/// (finite, present) samples only, ordered by source row/timestamp, for the
/// compact sample-order image viewer
/// (`.hermes/plans/2026-09-23-compact-sample-order-image-viewer.md`). Unlike
/// `RawRecordingWindow`, absent/non-finite fields are never represented as a
/// pixel at all — pixel `i` is compact sample `startSampleIndex + i`, not raw
/// row `startSampleIndex + i` — so every entry here carries its own source
/// `raw.csv` row and timestamp rather than assuming one contiguous run of
/// rows. This is a pure read derived fresh from `raw.csv` on every call; it
/// never writes any bundle file and never changes `get_raw_recording_window`'s
/// null-preserving raw-row semantics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactObservationWindow {
    pub recording_id: String,
    pub column: String,
    pub grid_size: u32,
    /// Count of this channel's own finite observed samples in the whole
    /// recording (never the raw row count, which may be far larger).
    pub total_observed_sample_count: usize,
    pub start_sample_index: usize,
    pub end_sample_index: usize,
    /// One entry per returned sample: the `raw.csv` row it was read from.
    /// Equal length to `timestamps_ns`/`values` and chronologically ordered.
    pub source_raw_row_indices: Vec<usize>,
    pub timestamps_ns: Vec<i64>,
    /// Always finite; a null/non-finite source field is filtered out upstream
    /// and never appears here as a fabricated or placeholder value.
    pub values: Vec<f64>,
    /// The timestamp of the observed sample immediately before
    /// `start_sample_index` in this channel's own sample sequence, or `None`
    /// when `start_sample_index` is 0 (the very first observed sample of the
    /// whole recording has no predecessor to gap against). Lets the frontend
    /// compute pixel 0's "elapsed since preceding observation" even though
    /// that predecessor sample itself lies outside this bounded window.
    pub preceding_timestamp_ns: Option<i64>,
    pub recording_min: Option<f64>,
    pub recording_max: Option<f64>,
    /// Maximum absolute finite difference between two consecutive observed
    /// samples (sample-order, never time-weighted) over the entire channel's
    /// observed sequence — computed before slicing to `start_sample_index`,
    /// so it stays fixed while paging through compact windows. `None` when
    /// there are fewer than two observed samples or no finite adjacent diff
    /// exists. This is the fixed scale the sample-order derivative preview
    /// uses in `"recording"` normalization mode.
    pub recording_max_abs_sample_order_derivative: Option<f64>,
}

/// Pure computation behind `get_compact_observation_window`, kept separate
/// from file IO so it is directly unit-testable against synthetic
/// `raw.csv` column data (same split as `compute_sg_derivative_window` above).
/// `grid_size_usize` must already be allow-list-validated by the caller.
fn compute_compact_observation_window(
    recording_id: String,
    column: String,
    grid_size: u32,
    grid_size_usize: usize,
    start_sample_index: i64,
    timestamps_ns: &[i64],
    all_values: &[Option<f64>],
) -> Result<CompactObservationWindow, String> {
    // This channel's own finite observed samples, in source row/timestamp
    // order — the same "present" extraction `compute_sg_derivative_window`
    // uses, kept independent here since this command never derives anything.
    let present: Vec<(usize, i64, f64)> = timestamps_ns
        .iter()
        .zip(all_values.iter())
        .enumerate()
        .filter_map(|(row, (&timestamp_ns, &value))| {
            value.filter(|v| v.is_finite()).map(|v| (row, timestamp_ns, v))
        })
        .collect();

    let total_observed_sample_count = present.len();
    let (resolved_start, resolved_end) =
        resolve_raw_window_bounds(total_observed_sample_count, start_sample_index, grid_size_usize)?;

    let window = &present[resolved_start..resolved_end];
    let source_raw_row_indices = window.iter().map(|(row, _, _)| *row).collect();
    let window_timestamps = window.iter().map(|(_, timestamp_ns, _)| *timestamp_ns).collect();
    let values = window.iter().map(|(_, _, value)| *value).collect();
    let preceding_timestamp_ns = if resolved_start == 0 {
        None
    } else {
        Some(present[resolved_start - 1].1)
    };

    let recording_min = present
        .iter()
        .map(|(_, _, value)| *value)
        .fold(None, |acc: Option<f64>, value| Some(acc.map_or(value, |current| current.min(value))));
    let recording_max = present
        .iter()
        .map(|(_, _, value)| *value)
        .fold(None, |acc: Option<f64>, value| Some(acc.map_or(value, |current| current.max(value))));

    let recording_max_abs_sample_order_derivative = present
        .windows(2)
        .map(|pair| pair[1].2 - pair[0].2)
        .filter(|diff| diff.is_finite())
        .map(f64::abs)
        .fold(None, |max, abs| Some(max.map_or(abs, |m: f64| m.max(abs))));

    Ok(CompactObservationWindow {
        recording_id,
        column,
        grid_size,
        total_observed_sample_count,
        start_sample_index: resolved_start,
        end_sample_index: resolved_end,
        source_raw_row_indices,
        timestamps_ns: window_timestamps,
        values,
        preceding_timestamp_ns,
        recording_min,
        recording_max,
        recording_max_abs_sample_order_derivative,
    })
}

/// Returns a bounded, chronological window of one numeric `raw.csv` column's
/// finite observed samples only (no nulls, no interpolation, no resampling)
/// for the compact sample-order image viewer. Navigation is in observed
/// sample-sequence positions, not raw rows: `start_sample_index` must be a
/// non-negative multiple of `grid_size`, exactly like
/// `get_raw_recording_window`'s `start_raw_row`, and is resolved/clamped by
/// the identical `resolve_raw_window_bounds` logic against this channel's own
/// observed sample count. This never writes any bundle file.
#[tauri::command]
pub fn get_compact_observation_window(
    recording_id: String,
    column: String,
    start_sample_index: i64,
    grid_size: u32,
    app: AppHandle,
) -> Result<CompactObservationWindow, String> {
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

    compute_compact_observation_window(
        recording_id,
        column,
        grid_size,
        grid_size_usize,
        start_sample_index,
        &timestamps_ns,
        &all_values,
    )
}

/// Half-width of the fixed Savitzky–Golay first-derivative window (M2): the
/// window itself is `2 * SG_HALF_WIDTH + 1` = 11 samples, centered on the row
/// being derived.
const SG_HALF_WIDTH: usize = 5;
/// Fixed, documented M2 filter window: polynomial order 2, 11 samples
/// (~220 ms at the ~50 Hz target rate). Not user-configurable in this slice.
pub const SG_WINDOW_SIZE: usize = 2 * SG_HALF_WIDTH + 1;
pub const SG_POLYNOMIAL_ORDER: u32 = 2;
/// Bumped whenever the filter math, window, order, or regularity tolerance
/// changes, so a cached/compared derivative can never silently mix versions.
pub const SG_FILTER_VERSION: &str = "savitzky_golay_order2_window11_v1";
/// A full SG window is the minimum basis for even attempting a cadence claim.
const MIN_ROWS_FOR_DERIVATIVE: usize = SG_WINDOW_SIZE;
/// Documented tolerance band around the robust (median) sample cadence: any
/// timestamp delta more than this fraction away from the median marks the
/// stream irregular for M2's purposes. Widening this (or adding resampling)
/// is a separate, reviewed decision per the milestone plan's "Irregular data
/// policy" — not something this slice tunes per recording.
const CADENCE_TOLERANCE_FRACTION: f64 = 0.25;

/// Least-squares first-derivative coefficients for a symmetric,
/// evenly-spaced Savitzky–Golay window of polynomial order >= 2: by symmetry
/// the quadratic (even-power) term is orthogonal to the linear (odd-power)
/// term at symmetric sample offsets, so the order-2 and order-1 first
/// derivative filters coincide — `c_i = i / sum(j^2 for j in -m..=m)`. The
/// result is in "value units per sample"; dividing by the cadence (seconds
/// per sample) converts it to "value units per second".
fn sg_first_derivative_coefficients(half_width: usize) -> Vec<f64> {
    let sum_of_squares: f64 = (1..=half_width).map(|i| (i * i) as f64).sum::<f64>() * 2.0;
    (0..=(2 * half_width))
        .map(|index| {
            let offset = index as f64 - half_width as f64;
            offset / sum_of_squares
        })
        .collect()
}

/// Pure, dependency-free symmetric Savitzky–Golay convolution: shared by both
/// `compute_sg_derivative_window` (time mode) and
/// `compute_sample_order_derivative_window` (GC-032 sample-order fallback),
/// which differ only in whether the result is divided by an elapsed time
/// afterward. `present` is `(original_row_index, value)` for a column's own
/// genuine finite samples, in the order they occur (by timestamp for time
/// mode, by row for sample-order mode); the caller decides that ordering.
/// Returns the raw "value units per sample" convolution, keyed by original
/// row index, for every position with a full symmetric window of
/// `half_width` genuine neighbors on each side within `present` itself.
fn convolve_symmetric_sg(
    present: &[(usize, f64)],
    coefficients: &[f64],
    half_width: usize,
) -> std::collections::HashMap<usize, f64> {
    let mut result = std::collections::HashMap::new();
    for present_index in half_width..present.len().saturating_sub(half_width) {
        let window_start = present_index - half_width;
        let mut accumulator = 0.0;
        for (offset, coefficient) in coefficients.iter().enumerate() {
            accumulator += coefficient * present[window_start + offset].1;
        }
        let (row, _) = present[present_index];
        result.insert(row, accumulator);
    }
    result
}

/// Outcome of assessing whether a full timestamp series is regular enough to
/// support a Savitzky–Golay time-derivative claim at all. `median_dt_ns` is
/// the robust per-sample cadence used to convert the per-sample SG
/// coefficient sum into a per-second derivative.
enum CadenceRegularity {
    Regular { median_dt_ns: f64 },
    Irregular(String),
}

/// Robust-median-cadence check over an entire recording's timestamps: fails
/// closed (never guesses a working cadence) on too few rows, any
/// non-strictly-increasing delta, or any delta outside
/// `CADENCE_TOLERANCE_FRACTION` of the median. See `CADENCE_TOLERANCE_FRACTION`
/// for why this rejects rather than resamples.
fn assess_cadence_regularity(timestamps_ns: &[i64]) -> CadenceRegularity {
    if timestamps_ns.len() < MIN_ROWS_FOR_DERIVATIVE {
        return CadenceRegularity::Irregular(format!(
            "fewer than {MIN_ROWS_FOR_DERIVATIVE} rows; a {SG_WINDOW_SIZE}-sample Savitzky–Golay window needs at least that many rows of context"
        ));
    }
    let deltas: Vec<i64> = timestamps_ns
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .collect();
    if deltas.iter().any(|&delta| delta <= 0) {
        return CadenceRegularity::Irregular(
            "timestamps are not strictly increasing; a time-based derivative requires strictly increasing timestamps".to_string(),
        );
    }

    let mut sorted_deltas = deltas.clone();
    sorted_deltas.sort_unstable();
    let mid = sorted_deltas.len() / 2;
    let median_dt_ns = if sorted_deltas.len() % 2 == 0 {
        (sorted_deltas[mid - 1] + sorted_deltas[mid]) as f64 / 2.0
    } else {
        sorted_deltas[mid] as f64
    };

    let lower_bound = median_dt_ns * (1.0 - CADENCE_TOLERANCE_FRACTION);
    let upper_bound = median_dt_ns * (1.0 + CADENCE_TOLERANCE_FRACTION);
    if deltas
        .iter()
        .any(|&delta| (delta as f64) < lower_bound || (delta as f64) > upper_bound)
    {
        return CadenceRegularity::Irregular(format!(
            "timestamp spacing deviates by more than {:.0}% from the median cadence; the stream is too irregular for a fixed-window time derivative",
            CADENCE_TOLERANCE_FRACTION * 100.0
        ));
    }

    CadenceRegularity::Regular { median_dt_ns }
}

/// True when a `compute_sg_derivative_window` unavailable `reason` is a pure
/// timestamp/cadence problem (non-monotonic or out-of-tolerance spacing)
/// rather than the recording simply not having enough rows to fill a full SG
/// window. Only the former is something the "preview by sample order"
/// fallback (GC-032) can ever route around — a too-short recording is short
/// in sample order too, so the fallback would fail identically there and
/// must not be offered for it.
fn is_cadence_only_unavailable_reason(reason: &str) -> bool {
    !reason.starts_with("fewer than")
}

/// Pure, dependency-free Savitzky–Golay first-derivative computation over one
/// full source column, sliced afterward to `[start, end)` — the same bounded
/// response shape `get_raw_recording_window` uses. Reads the *entire* source
/// series (never just the requested window) so rows near the edges of the
/// requested window still get real leading/trailing context instead of a
/// fabricated boundary value. Returns `(derivative_values, available,
/// unavailable_reason, effective_sample_rate_hz)`.
///
/// `raw.csv` is a fused, multi-channel-per-row schema (GC-030): a row belongs
/// to whichever channel's sample triggered it, and every *other* channel is
/// `None` on that row rather than carried forward. Availability and cadence
/// are therefore assessed only over *this column's own* present rows — its
/// own finite samples on its own time series — never the full fused-row
/// timeline, which would mix this channel's cadence with unrelated channels'
/// arrival timing. Rows where the column is absent simply stay `None`,
/// independent of whether the channel's own cadence is regular.
/// Maximum absolute finite value across every recording-wide computed
/// derivative (not just the sliced display window) — the fixed scale
/// `"recording"`-mode normalization needs so a given magnitude keeps the same
/// color while scrolling. `None` when no derivative could be computed anywhere.
fn max_abs_finite(derivative_by_row: &std::collections::HashMap<usize, f64>) -> Option<f64> {
    derivative_by_row
        .values()
        .copied()
        .filter(|value| value.is_finite())
        .map(f64::abs)
        .fold(None, |max, abs| Some(max.map_or(abs, |m: f64| m.max(abs))))
}

fn compute_sg_derivative_window(
    timestamps_ns: &[i64],
    values: &[Option<f64>],
    start: usize,
    end: usize,
) -> (Vec<Option<f64>>, bool, Option<String>, Option<f64>, Option<f64>) {
    debug_assert_eq!(timestamps_ns.len(), values.len());
    let row_count = values.len();

    // The channel's own genuine samples: (original row index, timestamp,
    // value) for every row where this column is actually present.
    let present: Vec<(usize, i64, f64)> = timestamps_ns
        .iter()
        .zip(values.iter())
        .enumerate()
        .filter_map(|(row, (&timestamp_ns, &value))| {
            value.filter(|v| v.is_finite()).map(|v| (row, timestamp_ns, v))
        })
        .collect();
    let present_timestamps_ns: Vec<i64> = present.iter().map(|(_, ts, _)| *ts).collect();

    let placeholder_len = end.saturating_sub(start).min(row_count.saturating_sub(start));
    let (median_dt_ns, effective_sample_rate_hz) = match assess_cadence_regularity(&present_timestamps_ns) {
        CadenceRegularity::Irregular(reason) => {
            return (vec![None; placeholder_len], false, Some(reason), None, None);
        }
        CadenceRegularity::Regular { median_dt_ns } => {
            (median_dt_ns, Some(1_000_000_000.0 / median_dt_ns))
        }
    };
    let dt_seconds = median_dt_ns / 1_000_000_000.0;
    let coefficients = sg_first_derivative_coefficients(SG_HALF_WIDTH);

    // Derivative at each *present-sequence* position, mapped back to the
    // original row it came from; a full symmetric SG window needs
    // SG_HALF_WIDTH genuine neighbors on each side within this channel's own
    // present-sample sequence, not within the raw row index space.
    let present_values: Vec<(usize, f64)> = present.iter().map(|&(row, _, value)| (row, value)).collect();
    let derivative_by_row = convolve_symmetric_sg(&present_values, &coefficients, SG_HALF_WIDTH);
    let derivative_by_row: std::collections::HashMap<usize, f64> = derivative_by_row
        .into_iter()
        .map(|(row, raw)| (row, raw / dt_seconds))
        .collect();
    let recording_max_abs_derivative = max_abs_finite(&derivative_by_row);

    let derivative_values = (start..end).map(|row| derivative_by_row.get(&row).copied()).collect();
    (derivative_values, true, None, effective_sample_rate_hz, recording_max_abs_derivative)
}

/// GC-032 legacy fallback: the same Savitzky–Golay first-difference filter as
/// `compute_sg_derivative_window`, but run over this column's present finite
/// values in raw row/sample order instead of by timestamp — no cadence
/// regularity check, and no division by an elapsed time, so the result is in
/// "value units per sample", never "per second". This is an explicit,
/// opt-in *visual preview* for recordings whose saved timestamps are too
/// irregular for the time-based derivative; it does not and cannot make the
/// recording timing-valid, and must never be offered to model training,
/// export, or inference. Returns `(derivative_values, available,
/// unavailable_reason)`.
fn compute_sample_order_derivative_window(
    values: &[Option<f64>],
    start: usize,
    end: usize,
) -> (Vec<Option<f64>>, bool, Option<String>, Option<f64>) {
    let row_count = values.len();
    let present: Vec<(usize, f64)> = values
        .iter()
        .enumerate()
        .filter_map(|(row, &value)| value.filter(|v| v.is_finite()).map(|v| (row, v)))
        .collect();

    let placeholder_len = end.saturating_sub(start).min(row_count.saturating_sub(start));
    if present.len() < MIN_ROWS_FOR_DERIVATIVE {
        return (
            vec![None; placeholder_len],
            false,
            Some(format!(
                "fewer than {MIN_ROWS_FOR_DERIVATIVE} finite samples in this channel; a {SG_WINDOW_SIZE}-sample Savitzky–Golay window needs at least that many rows of context even in sample order"
            )),
            None,
        );
    }

    let coefficients = sg_first_derivative_coefficients(SG_HALF_WIDTH);
    // No `dt_seconds` division here (contrast `compute_sg_derivative_window`):
    // the coefficients already yield "value units per sample", which is
    // exactly this fallback's unit.
    let derivative_by_row = convolve_symmetric_sg(&present, &coefficients, SG_HALF_WIDTH);
    let recording_max_abs_derivative = max_abs_finite(&derivative_by_row);

    let derivative_values = (start..end).map(|row| derivative_by_row.get(&row).copied()).collect();
    (derivative_values, true, None, recording_max_abs_derivative)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivativeFilterConfig {
    pub method: String,
    pub polynomial_order: u32,
    pub window_size: usize,
    pub version: String,
}

fn sg_filter_config() -> DerivativeFilterConfig {
    DerivativeFilterConfig {
        method: "savitzky_golay".to_string(),
        polynomial_order: SG_POLYNOMIAL_ORDER,
        window_size: SG_WINDOW_SIZE,
        version: SG_FILTER_VERSION.to_string(),
    }
}

/// A bounded, read-only, **offline-derived** window of one numeric raw.csv
/// column's Savitzky–Golay first time-derivative, aligned row-for-row and
/// timestamp-for-timestamp with `RawRecordingWindow` for the same request.
/// This is calculated fresh from the immutable `raw.csv` on every call; it is
/// never persisted, never written back into any bundle file, and is not a
/// live/Watch/inference signal — see the module-level docs and the M2
/// section of `.hermes/plans/2026-09-22_072210-data-collection-derivative-viewer-milestones.md`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRecordingDerivativeWindow {
    pub recording_id: String,
    pub column: String,
    pub grid_size: u32,
    pub total_raw_row_count: usize,
    pub start_raw_row: usize,
    pub end_raw_row: usize,
    pub row_indices: Vec<usize>,
    pub timestamps_ns: Vec<i64>,
    /// One entry per `row_indices` entry: `None` where no derivative could be
    /// computed for that specific row (window-edge, missing/nonfinite value
    /// in its local window), regardless of the recording-wide `available` flag.
    pub derivative_values: Vec<Option<f64>>,
    /// False when the *entire recording's* timestamp cadence failed the
    /// regularity check; when false every `derivative_values` entry is `None`
    /// and `unavailable_reason` explains why.
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub effective_sample_rate_hz: Option<f64>,
    pub filter_config: DerivativeFilterConfig,
    /// `"time"` (default) or `"sample_order"` (GC-032 legacy preview fallback
    /// — see `preview_by_sample_order` on `get_raw_recording_derivative_window`).
    pub mode: String,
    /// `"per_second"` in `"time"` mode, `"per_sample"` in `"sample_order"`
    /// mode. The frontend must render this alongside every value; the two
    /// are not comparable or interchangeable.
    pub units: String,
    /// Only meaningful in `"time"` mode: true when `available` is false
    /// *solely* because of a timestamp/cadence irregularity (not because the
    /// recording has too few rows) — i.e. exactly the case the
    /// `preview_by_sample_order` fallback exists for. Always false in
    /// `"sample_order"` mode.
    pub unavailable_is_cadence_issue: bool,
    /// Maximum absolute finite derivative value over the *entire* selected
    /// recording/channel (not just this sliced display window) — the fixed,
    /// zero-centred scale `"recording"`-mode normalization uses so a given
    /// magnitude keeps the same color while scrolling. `None` when
    /// unavailable or no derivative could be computed anywhere.
    pub recording_max_abs_derivative: Option<f64>,
}

/// Returns the offline Savitzky–Golay first-derivative window matching
/// `get_raw_recording_window`'s exact row/timestamp alignment and bounded
/// N×N response shape for the same recording, channel, grid size, and start
/// row. Never writes any bundle file; `raw.csv` is read fresh and untouched.
/// This is a saved-data analysis view, not a live signal and not a training
/// transformation — see `RawRecordingDerivativeWindow`'s docs.
///
/// `preview_by_sample_order` (GC-032, default `false`/omitted): an explicit,
/// caller-opted-in request for the legacy visual-preview fallback — the same
/// filter run in raw row/sample order instead of by timestamp, with no
/// cadence check and "per sample" (not "per second") units. It never
/// activates on its own; the frontend must only offer it once the
/// time-based derivative has already come back with
/// `unavailable_is_cadence_issue: true`. It is not offered to, and must
/// never be wired into, model training, export, or inference.
#[tauri::command]
pub fn get_raw_recording_derivative_window(
    recording_id: String,
    column: String,
    start_raw_row: i64,
    grid_size: u32,
    app: AppHandle,
    preview_by_sample_order: Option<bool>,
) -> Result<RawRecordingDerivativeWindow, String> {
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

    let window_timestamps = timestamps_ns[resolved_start..resolved_end].to_vec();
    let row_indices: Vec<usize> = (resolved_start..resolved_end).collect();

    let (
        derivative_values,
        available,
        unavailable_reason,
        effective_sample_rate_hz,
        mode,
        units,
        unavailable_is_cadence_issue,
        recording_max_abs_derivative,
    ) = if preview_by_sample_order.unwrap_or(false) {
        let (derivative_values, available, unavailable_reason, recording_max_abs_derivative) =
            compute_sample_order_derivative_window(&all_values, resolved_start, resolved_end);
        (
            derivative_values,
            available,
            unavailable_reason,
            None,
            "sample_order",
            "per_sample",
            false,
            recording_max_abs_derivative,
        )
    } else {
        let (derivative_values, available, unavailable_reason, effective_sample_rate_hz, recording_max_abs_derivative) =
            compute_sg_derivative_window(&timestamps_ns, &all_values, resolved_start, resolved_end);
        let unavailable_is_cadence_issue = !available
            && unavailable_reason
                .as_deref()
                .is_some_and(is_cadence_only_unavailable_reason);
        (
            derivative_values,
            available,
            unavailable_reason,
            effective_sample_rate_hz,
            "time",
            "per_second",
            unavailable_is_cadence_issue,
            recording_max_abs_derivative,
        )
    };

    Ok(RawRecordingDerivativeWindow {
        recording_id,
        column,
        grid_size,
        total_raw_row_count,
        start_raw_row: resolved_start,
        end_raw_row: resolved_end,
        row_indices,
        timestamps_ns: window_timestamps,
        derivative_values,
        available,
        unavailable_reason,
        effective_sample_rate_hz,
        filter_config: sg_filter_config(),
        mode: mode.to_string(),
        units: units.to_string(),
        unavailable_is_cadence_issue,
        recording_max_abs_derivative,
    })
}

/// A gap this many times the recording's own median row-to-row timestamp
/// delta marks the overall recording timing unusable for `RecordingQualitySummary`
/// purposes (see `compute_quality_summary`'s `has_dominant_outlier_gap`) —
/// deliberately far looser than the derivative's `CADENCE_TOLERANCE_FRACTION`,
/// since this only catches a gross, single dominant-gap timing break, not
/// ordinary multi-sensor cadence variation.
const MAX_TIMESTAMP_GAP_MEDIAN_MULTIPLE: f64 = 50.0;

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

    // A pathologically large gap relative to the recording's own typical
    // (median) row-to-row spacing — e.g. two channels whose timestamps were
    // fused from incomparable clock domains — can still be strictly
    // monotonic with a positive span, yet make the effective sample rate
    // meaningless (GC-030: 4,499 rows / 517,508s / "0.0 Hz effective",
    // reported as "Timing OK"). Flag that case explicitly instead of
    // presenting a misleadingly tiny effective rate as trustworthy.
    let has_dominant_outlier_gap = row_count >= 3 && {
        let mut deltas: Vec<i64> = timestamps_ns.windows(2).map(|pair| pair[1] - pair[0]).collect();
        deltas.sort_unstable();
        let mid = deltas.len() / 2;
        let median_delta_ns = if deltas.len() % 2 == 0 {
            (deltas[mid - 1] + deltas[mid]) as f64 / 2.0
        } else {
            deltas[mid] as f64
        };
        let max_delta_ns = *deltas.last().unwrap_or(&0) as f64;
        median_delta_ns > 0.0 && max_delta_ns > median_delta_ns * MAX_TIMESTAMP_GAP_MEDIAN_MULTIPLE
    };

    let timestamp_status = if row_count < 2 {
        TimestampStatus::InsufficientData
    } else if non_monotonic_row_count > 0 || time_span_ns <= 0 || has_dominant_outlier_gap {
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
        TimestampStatus::Warning if has_dominant_outlier_gap => warnings.push(
            "Timestamps contain a gap far larger than the recording's typical row spacing; the effective sample rate cannot be trusted.".to_string(),
        ),
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

    /// GC-030 repro: a mixed/incomparable-clock-domain bug (fixed upstream in
    /// the desktop ingest layer) could still produce a strictly monotonic,
    /// positive-span raw.csv dominated by one huge outlier gap — e.g. 11 rows
    /// at a normal ~20ms cadence, then one absurd jump. That must never
    /// present as "Timing OK" with a misleadingly tiny effective rate.
    #[test]
    fn quality_summary_flags_a_dominant_outlier_gap_as_warning_even_when_monotonic() {
        let mut rows: Vec<(i64, &str)> = (0..11).map(|i| (i * 20_000_000, "1.0")).collect();
        rows.push((517_508_300_000_000, "1.0")); // ~517,508s later: the GC-030 symptom
        let csv = raw_csv_with_rows(&rows);
        let id = Uuid::new_v4().to_string();
        let summary = compute_quality_summary(id.clone(), &csv, &empty_annotations(&id)).unwrap();

        assert_eq!(summary.non_monotonic_row_count, 0, "rows are still strictly increasing");
        assert_eq!(summary.timestamp_status, TimestampStatus::Warning);
        assert!(summary.effective_sample_rate_hz.is_none(), "a misleading near-zero rate must not be reported");
        assert!(summary.warnings.iter().any(|warning| warning.contains("typical row spacing")));
    }

    /// Old bundles saved before GC-030 densely populate every column on every
    /// row (carry-forward). The new per-channel-present derivative/cadence
    /// logic must produce the exact same result for that shape as before —
    /// legacy bundles are never rewritten and their analysis must not regress.
    #[test]
    fn legacy_densely_populated_bundle_derivative_is_unaffected_by_the_per_channel_fix() {
        let timestamps_ns = uniform_timestamps(21, 20_000_000);
        let values: Vec<Option<f64>> = (0..21).map(|i| Some(i as f64 * 0.5)).collect(); // every row populated
        let (derivative, available, reason, rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 21);
        assert!(available, "reason: {reason:?}");
        assert!((rate.unwrap() - 50.0).abs() < 1e-6);
        for row in SG_HALF_WIDTH..(21 - SG_HALF_WIDTH) {
            assert!((derivative[row].unwrap() - 25.0).abs() < 1e-9); // d/dt(0.5*i) at 50Hz = 0.5*50
        }
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

    // --- M1 (compact sample-order viewer): compute_compact_observation_window ---

    fn compact_window(
        timestamps_ns: &[i64],
        values: &[Option<f64>],
        start_sample_index: i64,
        grid_size: usize,
    ) -> Result<CompactObservationWindow, String> {
        compute_compact_observation_window(
            "rec-a".to_string(),
            "ppg_green".to_string(),
            grid_size as u32,
            grid_size,
            start_sample_index,
            timestamps_ns,
            values,
        )
    }

    #[test]
    fn compact_window_returns_only_finite_values_consecutively_with_source_provenance() {
        // Interleaved sparse field: only raw rows 3 and 10 carry a value.
        let mut timestamps_ns = vec![0i64; 11];
        let mut values = vec![None; 11];
        for (row, timestamp_ns) in timestamps_ns.iter_mut().enumerate() {
            *timestamp_ns = row as i64 * 1_000_000;
        }
        values[3] = Some(1.5);
        values[10] = Some(9.5);

        let window = compact_window(&timestamps_ns, &values, 0, 4).expect("valid window");
        assert_eq!(window.total_observed_sample_count, 2);
        assert_eq!(window.source_raw_row_indices, vec![3, 10]);
        assert_eq!(window.timestamps_ns, vec![3_000_000, 10_000_000]);
        assert_eq!(window.values, vec![1.5, 9.5]);
        assert!(window.values.iter().all(|value| value.is_finite()));
        assert_eq!(window.preceding_timestamp_ns, None);
        assert_eq!(window.recording_min, Some(1.5));
        assert_eq!(window.recording_max, Some(9.5));
    }

    #[test]
    fn compact_window_all_null_channel_is_empty_not_an_error() {
        let timestamps_ns = vec![0, 1_000_000, 2_000_000];
        let values = vec![None, None, None];
        let window = compact_window(&timestamps_ns, &values, 0, 4).expect("empty channel is not an error");
        assert_eq!(window.total_observed_sample_count, 0);
        assert!(window.values.is_empty());
        assert!(window.source_raw_row_indices.is_empty());
        assert_eq!(window.recording_min, None);
        assert_eq!(window.recording_max, None);
    }

    #[test]
    fn compact_window_short_recording_returns_fewer_than_a_full_frame() {
        let timestamps_ns = vec![0, 1_000_000];
        let values = vec![Some(1.0), Some(2.0)];
        let window = compact_window(&timestamps_ns, &values, 0, 4).expect("valid window");
        assert_eq!(window.total_observed_sample_count, 2);
        assert_eq!(window.values.len(), 2);
        assert_eq!(window.end_sample_index, 2);
    }

    #[test]
    fn compact_window_constant_values_report_equal_min_and_max() {
        let timestamps_ns = vec![0, 1_000_000, 2_000_000];
        let values = vec![Some(4.0), Some(4.0), Some(4.0)];
        let window = compact_window(&timestamps_ns, &values, 0, 4).expect("valid window");
        assert_eq!(window.recording_min, Some(4.0));
        assert_eq!(window.recording_max, Some(4.0));
    }

    #[test]
    fn compact_window_rejects_unaligned_or_negative_start() {
        let timestamps_ns = vec![0; 20];
        let values: Vec<Option<f64>> = (0..20).map(|i| Some(i as f64)).collect();
        assert!(compact_window(&timestamps_ns, &values, -1, 4).is_err());
        assert!(compact_window(&timestamps_ns, &values, 1, 4).is_err());
    }

    #[test]
    fn compact_window_clamps_oversized_start_to_final_reachable_frame() {
        let timestamps_ns: Vec<i64> = (0..20).map(|i| i * 1_000_000).collect();
        let values: Vec<Option<f64>> = (0..20).map(|i| Some(i as f64)).collect();
        // 20 observed samples, grid_size 4 -> max_values 16; last valid start is 4.
        let window = compact_window(&timestamps_ns, &values, 1_000, 4).expect("oversized start is clamped, not rejected");
        assert_eq!(window.start_sample_index, 4);
        assert_eq!(window.end_sample_index, 20);
    }

    #[test]
    fn compact_window_second_frame_reports_preceding_timestamp_for_gap_calculation() {
        // 20 observed samples, grid_size 4 (max_values 16) -> a real second
        // frame exists at start 4, distinct from the single-frame case above.
        let timestamps_ns: Vec<i64> = (0..20).map(|i| i * 1_000_000).collect();
        let values: Vec<Option<f64>> = (0..20).map(|i| Some(i as f64)).collect();
        let window = compact_window(&timestamps_ns, &values, 4, 4).expect("valid second frame");
        assert_eq!(window.start_sample_index, 4);
        assert_eq!(window.preceding_timestamp_ns, Some(3_000_000));
    }

    #[test]
    fn compact_window_never_fabricates_a_value_for_a_malformed_or_absent_source_field() {
        // The observed-values slice never contains a null: every entry
        // returned traces back to a genuinely present, finite source field.
        let timestamps_ns = vec![0, 1_000_000, 2_000_000, 3_000_000];
        let values = vec![Some(1.0), None, Some(f64::NAN), Some(2.0)];
        let window = compact_window(&timestamps_ns, &values, 0, 4).expect("valid window");
        assert_eq!(window.source_raw_row_indices, vec![0, 3]);
        assert_eq!(window.values, vec![1.0, 2.0]);
    }

    #[test]
    fn compact_window_recording_max_abs_sample_order_derivative_is_stable_across_frames() {
        // Observed sample sequence: 1, 5, 2, 20 -> adjacent diffs |4|, |3|, |18| -> max 18.
        let timestamps_ns: Vec<i64> = (0..4).map(|i| i * 1_000_000).collect();
        let values = vec![Some(1.0), Some(5.0), Some(2.0), Some(20.0)];
        let first_frame = compact_window(&timestamps_ns, &values, 0, 2).expect("valid first frame");
        let second_frame = compact_window(&timestamps_ns, &values, 2, 2).expect("valid second frame");
        assert_eq!(first_frame.recording_max_abs_sample_order_derivative, Some(18.0));
        assert_eq!(
            first_frame.recording_max_abs_sample_order_derivative,
            second_frame.recording_max_abs_sample_order_derivative,
        );
    }

    #[test]
    fn compact_window_recording_max_abs_sample_order_derivative_none_for_zero_or_one_sample() {
        let empty = compact_window(&[], &[], 0, 4).expect("empty channel is not an error");
        assert_eq!(empty.recording_max_abs_sample_order_derivative, None);

        let single = compact_window(&[0], &[Some(1.0)], 0, 4).expect("single-sample channel is not an error");
        assert_eq!(single.recording_max_abs_sample_order_derivative, None);
    }

    #[test]
    fn compact_window_recording_max_abs_sample_order_derivative_ignores_non_finite_diffs() {
        // f64::MAX - (-f64::MAX) overflows to +inf, which must not become "the" scale.
        let timestamps_ns = vec![0, 1_000_000, 2_000_000];
        let values = vec![Some(-f64::MAX), Some(f64::MAX), Some(f64::MAX - 1.0)];
        let window = compact_window(&timestamps_ns, &values, 0, 4).expect("valid window");
        assert_eq!(window.recording_max_abs_sample_order_derivative, Some(1.0));
    }

    // --- M2: Savitzky–Golay derivative helper ---

    fn uniform_timestamps(row_count: usize, dt_ns: i64) -> Vec<i64> {
        (0..row_count as i64).map(|i| i * dt_ns).collect()
    }

    #[test]
    fn sg_coefficients_are_antisymmetric_and_sum_to_zero() {
        let coefficients = sg_first_derivative_coefficients(SG_HALF_WIDTH);
        assert_eq!(coefficients.len(), SG_WINDOW_SIZE);
        assert!((coefficients.iter().sum::<f64>()).abs() < 1e-12);
        for offset in 0..=SG_HALF_WIDTH {
            assert!(
                (coefficients[SG_HALF_WIDTH + offset] + coefficients[SG_HALF_WIDTH - offset]).abs()
                    < 1e-12
            );
        }
        // c_i = i / sum(j^2), sum(j^2) for j in -5..=5 (excluding 0) = 110.
        assert!((coefficients[SG_HALF_WIDTH + 1] - (1.0 / 110.0)).abs() < 1e-12);
    }

    /// GC-036: `convolve_symmetric_sg` is the pure convolution extracted out
    /// of both `compute_sg_derivative_window` (time mode) and
    /// `compute_sample_order_derivative_window` (sample-order fallback) so
    /// the two no longer duplicate the same windowed-accumulation loop. This
    /// pins its output against the known linear-signal closed form directly
    /// (slope * dt_seconds per sample, `dt_seconds = 1` here), independent of
    /// either caller, and checks the exact edge rows a `SG_HALF_WIDTH = 5`
    /// window can and cannot cover — the same behavior the pre-extraction
    /// inlined loops produced.
    #[test]
    fn convolve_symmetric_sg_matches_known_linear_slope_and_respects_window_edges() {
        let present: Vec<(usize, f64)> = (0..16).map(|row| (row, 2.0 * row as f64 + 7.0)).collect();
        let coefficients = sg_first_derivative_coefficients(SG_HALF_WIDTH);
        let result = convolve_symmetric_sg(&present, &coefficients, SG_HALF_WIDTH);

        // Only rows with a full SG_HALF_WIDTH of genuine neighbors on both
        // sides (here, 5..=10 out of 16 present samples) get a value.
        assert_eq!(result.len(), present.len() - 2 * SG_HALF_WIDTH);
        for row in SG_HALF_WIDTH..(present.len() - SG_HALF_WIDTH) {
            assert!(
                (result[&row] - 2.0).abs() < 1e-9,
                "row {row}: expected slope 2.0, got {:?}",
                result.get(&row)
            );
        }
        for row in [0usize, 1, 2, 3, 4, 11, 12, 13, 14, 15] {
            assert!(!result.contains_key(&row), "row {row} should have no full window");
        }
    }

    #[test]
    fn constant_signal_has_zero_derivative_everywhere_available() {
        let timestamps_ns = uniform_timestamps(20, 20_000_000); // 50Hz
        let values: Vec<Option<f64>> = vec![Some(3.0); 20];
        let (derivative, available, reason, rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 20);
        assert!(available);
        assert!(reason.is_none());
        assert!((rate.unwrap() - 50.0).abs() < 1e-6);
        for (row, value) in derivative.iter().enumerate() {
            if (SG_HALF_WIDTH..20 - SG_HALF_WIDTH).contains(&row) {
                assert!(
                    (value.unwrap()).abs() < 1e-9,
                    "row {row} expected ~0, got {value:?}"
                );
            } else {
                assert!(
                    value.is_none(),
                    "boundary row {row} must have no derivative"
                );
            }
        }
    }

    #[test]
    fn linear_signal_derivative_matches_known_slope_and_aligns_by_row() {
        // y = 2.0 * t_seconds, uniform 50Hz (dt = 20ms) => dy/dt = 2.0 everywhere interior.
        let dt_ns = 20_000_000i64;
        let timestamps_ns = uniform_timestamps(21, dt_ns);
        let values: Vec<Option<f64>> = timestamps_ns
            .iter()
            .map(|&t| Some(2.0 * (t as f64 / 1_000_000_000.0)))
            .collect();
        let (derivative, available, _reason, _rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 21);
        assert!(available);
        for row in SG_HALF_WIDTH..(21 - SG_HALF_WIDTH) {
            let value = derivative[row].expect("interior row must have a derivative");
            assert!(
                (value - 2.0).abs() < 1e-9,
                "row {row}: expected slope 2.0, got {value}"
            );
        }
        // Requesting a sub-window [8,13) still aligns 1:1 with rows 8..13 of the full series.
        let (sub_derivative, _, _, _, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 8, 13);
        assert_eq!(sub_derivative.len(), 5);
        for value in &sub_derivative {
            assert!((value.unwrap() - 2.0).abs() < 1e-9);
        }
    }

    /// GC-030: `raw.csv` is a fused, multi-channel-per-row schema — a row
    /// where this column is `None` belongs to a *different* channel's
    /// trigger, never a carried-forward value. That row must never affect
    /// this channel's own cadence or derivative, no matter how the other
    /// channel's rows are timed, and it must itself always have no
    /// derivative.
    #[test]
    fn other_channel_rows_never_affect_this_channels_cadence_or_derivative() {
        // Even rows: this channel's own genuine samples on a uniform 50Hz
        // grid. Odd rows: a different channel's rows, `None` for this
        // column, each with an arbitrary offset timestamp of its own.
        let mut timestamps_ns = Vec::new();
        let mut values = Vec::new();
        for i in 0..21i64 {
            timestamps_ns.push(i * 20_000_000);
            values.push(Some(i as f64));
            timestamps_ns.push(i * 20_000_000 + 7_000_000);
            values.push(None);
        }
        let row_count = timestamps_ns.len();

        let (derivative, available, reason, rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, row_count);
        assert!(available, "reason: {reason:?}");
        assert!((rate.unwrap() - 50.0).abs() < 1e-6);

        for (row, value) in values.iter().enumerate() {
            if value.is_none() {
                assert!(derivative[row].is_none(), "other-channel row {row} must have no derivative");
            }
        }
        // Interior rows of this channel's own present-sample sequence still
        // get a real derivative, purely from this channel's own neighbors.
        for i in SG_HALF_WIDTH..(21 - SG_HALF_WIDTH) {
            let row = 2 * i;
            assert!(derivative[row].is_some(), "row {row} should have a derivative");
        }
    }

    #[test]
    fn nonfinite_value_is_excluded_from_cadence_like_an_absent_row() {
        // 21 genuine, uniformly-spaced own-channel samples, plus one extra
        // row (another channel's) whose value for this column is NaN rather
        // than a clean empty field — it must be excluded exactly like an
        // absent row, never propagated as a real sample or allowed to break
        // this channel's own regular cadence.
        let mut timestamps_ns = uniform_timestamps(21, 20_000_000);
        let mut values: Vec<Option<f64>> = (0..21).map(|i| Some(i as f64)).collect();
        timestamps_ns.insert(1, 10_000_000);
        values.insert(1, Some(f64::NAN));
        let row_count = timestamps_ns.len();

        let (derivative, available, reason, rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, row_count);
        assert!(available, "reason: {reason:?}");
        assert!((rate.unwrap() - 50.0).abs() < 1e-6);
        assert!(derivative[1].is_none(), "nonfinite row must have no derivative");
    }

    #[test]
    fn short_input_is_unavailable_with_reason() {
        let timestamps_ns = uniform_timestamps(5, 20_000_000); // fewer than SG_WINDOW_SIZE
        let values: Vec<Option<f64>> = vec![Some(1.0); 5];
        let (derivative, available, reason, rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 5);
        assert!(!available);
        assert!(derivative.iter().all(Option::is_none));
        assert!(rate.is_none());
        assert!(reason.unwrap().contains("fewer than"));
    }

    #[test]
    fn non_monotonic_timestamps_are_unavailable() {
        let mut timestamps_ns = uniform_timestamps(15, 20_000_000);
        timestamps_ns[7] = timestamps_ns[6]; // duplicate/non-increasing
        let values: Vec<Option<f64>> = vec![Some(1.0); 15];
        let (derivative, available, reason, _rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 15);
        assert!(!available);
        assert!(derivative.iter().all(Option::is_none));
        assert!(reason.unwrap().contains("strictly increasing"));
    }

    #[test]
    fn irregular_mixed_cadence_is_unavailable() {
        // Mostly 20ms deltas but one wildly different delta far outside tolerance.
        let mut timestamps_ns = uniform_timestamps(15, 20_000_000);
        for t in timestamps_ns.iter_mut().skip(8) {
            *t += 500_000_000; // a huge jump partway through
        }
        let values: Vec<Option<f64>> = vec![Some(1.0); 15];
        let (derivative, available, reason, _rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 15);
        assert!(!available);
        assert!(derivative.iter().all(Option::is_none));
        assert!(reason.unwrap().contains("irregular"));
    }

    #[test]
    fn ordinary_uniform_50hz_stream_is_accepted() {
        let timestamps_ns = uniform_timestamps(50, 20_000_000);
        let values: Vec<Option<f64>> = (0..50).map(|i| Some(i as f64 * 0.1)).collect();
        let (_derivative, available, reason, rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 50);
        assert!(available);
        assert!(reason.is_none());
        assert!((rate.unwrap() - 50.0).abs() < 1e-6);
    }

    #[test]
    fn recording_bounds_edge_rows_get_context_from_outside_the_requested_subwindow() {
        // 30-row recording; request the trailing sub-window [20,30). Row 20 is
        // not a boundary of the *recording* (rows 15..25 all exist), so it must
        // still get a real derivative even though it's the first row requested.
        let timestamps_ns = uniform_timestamps(30, 20_000_000);
        let values: Vec<Option<f64>> = timestamps_ns
            .iter()
            .map(|&t| Some(3.0 * (t as f64 / 1_000_000_000.0)))
            .collect();
        let (derivative, available, _reason, _rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 20, 30);
        assert!(available);
        assert_eq!(derivative.len(), 10);
        // row 20 (index 0 of this sub-slice) has full context from rows 15..25.
        assert!((derivative[0].unwrap() - 3.0).abs() < 1e-9);
        // row 29 (index 9, the last row of the whole recording) is a true boundary.
        assert!(derivative[9].is_none());
    }

    #[test]
    fn deterministic_repeat_calls_produce_identical_output() {
        let timestamps_ns = uniform_timestamps(25, 20_000_000);
        let values: Vec<Option<f64>> = (0..25).map(|i| Some((i as f64).sin())).collect();
        let first = compute_sg_derivative_window(&timestamps_ns, &values, 0, 25);
        let second = compute_sg_derivative_window(&timestamps_ns, &values, 0, 25);
        assert_eq!(first.0, second.0);
        assert_eq!(first.1, second.1);
        assert_eq!(first.3, second.3);
    }

    // --- GC-032: "preview by sample order" legacy fallback ---

    #[test]
    fn is_cadence_only_unavailable_reason_distinguishes_row_count_from_timing() {
        assert!(!is_cadence_only_unavailable_reason(
            "fewer than 11 rows; a 11-sample Savitzky–Golay window needs at least that many rows of context"
        ));
        assert!(is_cadence_only_unavailable_reason(
            "timestamps are not strictly increasing; a time-based derivative requires strictly increasing timestamps"
        ));
        assert!(is_cadence_only_unavailable_reason(
            "timestamp spacing deviates by more than 25% from the median cadence; the stream is too irregular for a fixed-window time derivative"
        ));
    }

    #[test]
    fn sample_order_derivative_matches_time_derivative_units_scaled_by_dt_for_uniform_cadence() {
        // Uniform 50Hz, slope 2.0/s => per-sample slope is 2.0 * 0.02s = 0.04/sample.
        let dt_ns = 20_000_000i64;
        let timestamps_ns = uniform_timestamps(21, dt_ns);
        let values: Vec<Option<f64>> = timestamps_ns
            .iter()
            .map(|&t| Some(2.0 * (t as f64 / 1_000_000_000.0)))
            .collect();
        let (sample_order, available, reason, _) =
            compute_sample_order_derivative_window(&values, 0, 21);
        assert!(available, "reason: {reason:?}");
        for row in SG_HALF_WIDTH..(21 - SG_HALF_WIDTH) {
            let value = sample_order[row].expect("interior row must have a derivative");
            assert!((value - 0.04).abs() < 1e-9, "row {row}: expected 0.04/sample, got {value}");
        }
    }

    #[test]
    fn sample_order_derivative_ignores_wildly_irregular_timestamps() {
        // Same irregular timestamps that make the time-based derivative
        // unavailable; the sample-order fallback ignores timestamps entirely
        // and still produces a result purely from row order.
        let mut timestamps_ns = uniform_timestamps(15, 20_000_000);
        for t in timestamps_ns.iter_mut().skip(8) {
            *t += 500_000_000;
        }
        let values: Vec<Option<f64>> = (0..15).map(|i| Some(i as f64)).collect();

        let (_time_derivative, time_available, time_reason, _rate, _) =
            compute_sg_derivative_window(&timestamps_ns, &values, 0, 15);
        assert!(!time_available);
        assert!(is_cadence_only_unavailable_reason(&time_reason.unwrap()));

        let (sample_order, available, reason, _) =
            compute_sample_order_derivative_window(&values, 0, 15);
        assert!(available, "reason: {reason:?}");
        for row in SG_HALF_WIDTH..(15 - SG_HALF_WIDTH) {
            assert!(
                (sample_order[row].unwrap() - 1.0).abs() < 1e-9,
                "row {row}: unit-slope-per-sample expected, got {:?}",
                sample_order[row]
            );
        }
    }

    #[test]
    fn sample_order_derivative_skips_gaps_and_nonfinite_values_like_time_mode() {
        let mut values: Vec<Option<f64>> = (0..21).map(|i| Some(i as f64)).collect();
        values[10] = None; // a gap (another channel's row)
        values.insert(1, Some(f64::NAN)); // an explicit non-finite reading
        let row_count = values.len();

        let (derivative, available, reason, _) =
            compute_sample_order_derivative_window(&values, 0, row_count);
        assert!(available, "reason: {reason:?}");
        assert!(derivative[10].is_none(), "gap row must have no derivative");
        assert!(derivative[1].is_none(), "nonfinite row must have no derivative");
    }

    #[test]
    fn sample_order_derivative_too_few_finite_samples_is_unavailable_with_reason() {
        let values: Vec<Option<f64>> = vec![Some(1.0); 5]; // fewer than SG_WINDOW_SIZE
        let (derivative, available, reason, _) = compute_sample_order_derivative_window(&values, 0, 5);
        assert!(!available);
        assert!(derivative.iter().all(Option::is_none));
        let reason = reason.unwrap();
        assert!(reason.contains("fewer than"));
        assert!(!is_cadence_only_unavailable_reason(&reason));
    }

    #[test]
    fn get_raw_recording_derivative_window_request_validation_is_shared_across_modes() {
        // The `preview_by_sample_order` opt-in must not bypass the existing
        // recording-id/column/grid-size request validation that runs before
        // either derivative path is ever reached.
        assert!(validate_recording_id("../escape").is_err());
        assert!(!RAW_WINDOW_ALLOWED_COLUMNS.contains(&"timestamp_ns"));
        assert!(validate_grid_size(0).is_err());
    }
}
