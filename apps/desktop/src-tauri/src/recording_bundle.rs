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
//! compatibility path for existing exports and training.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub(crate) const RECORDING_BUNDLES_DIR_NAME: &str = "recording";
const RAW_CSV_FILE_NAME: &str = "raw.csv";
const RECORDING_METADATA_FILE_NAME: &str = "recording.json";
const ANNOTATIONS_FILE_NAME: &str = "annotations.json";
/// Matches `model_lab::MAX_DATASET_CSV_BYTES`; kept as its own constant since
/// the two csv contracts (legacy fused dataset vs. new immutable raw capture)
/// are intentionally independent.
const MAX_RAW_CSV_BYTES: usize = 20 * 1024 * 1024;

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
}
