use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tracing::warn;
use uuid::Uuid;

use crate::dataset_files::{self, GapReport, Meta, Pair};

const DATASETS_DIR_NAME: &str = "datasets";
pub(crate) const MODEL_LAB_DIR_NAME: &str = "model-lab";
const INDEX_FILE_NAME: &str = "index.json";
const MAX_DATASET_CSV_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILENAME_LEN: usize = 255;
const METADATA_COMMENT_PREFIX: char = '#';

/// The single-file dataset's columns before manual labels existed (what the Recorder's older exports and the Recordings
/// tab's bundles use). Still imported; stored with `manual_label` added. See [`DATASET_CSV_HEADER_V2`].
pub(crate) const DATASET_CSV_HEADER: [&str; 17] = [
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
    "label",
];

/// Exact column order of the single-file dataset the Recorder and the Labelling page write: [`DATASET_CSV_HEADER`] and then
/// `manual_label`. Mirrors `DATASET_CSV_COLUMNS` in telemetryStore.ts and `HEADER_COLUMNS` in
/// tools/label-trainer/src/label_trainer/schema.py. A dataset headed by neither is rejected on import.
pub(crate) const DATASET_CSV_HEADER_V2: [&str; 18] = [
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
    "label",
    dataset_files::MANUAL_LABEL_COLUMN,
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSummary {
    pub id: String,
    pub original_filename: String,
    pub imported_at: String,
    /// Display text: the single label of a legacy one-label session, or the
    /// labels of a multi-label (Timeline Capture) export joined by ", ".
    /// Use [`DatasetSummary::effective_labels`] for anything functional.
    pub label: String,
    /// Every distinct label present on the dataset's rows, sorted. Absent in
    /// an index written before multi-label datasets existed, in which case
    /// the dataset is the single `label`.
    #[serde(default)]
    pub labels: Vec<String>,
    pub row_count: usize,
    /// Where this recording came in the order they were imported: 1 for the first, with no gaps (see
    /// [`number_unnumbered`]); worked out when the index is read.
    #[serde(default)]
    pub sequence: u32,
    /// Stored as a folder of two dense files (`ppg.csv` and `imu.csv`) rather than one file with blank cells.
    #[serde(default)]
    pub two_files: bool,
    /// How dense each stream is: where it went quiet and for how long. Absent for a recording made before this was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gaps: Option<GapReport>,
    /// The saved Recorder recording this was made from, when it was added straight from one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_recording_id: Option<String>,
    /// The recording this one is a new version of, when it was saved from the Labelling page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derived_from: Option<String>,
    /// How the session was recorded: the Recorder's session details (`dataset_files::CONTEXT_PREFIX`).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub context: std::collections::BTreeMap<String, String>,
    /// Kept for the final test (`sealed_test.rs`): never trained on, nor used to choose anything.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sealed: bool,
    /// What the recording holds (`dataset_files::rows_sha`: its rows, whatever its `#` lines): two recordings with the same one
    /// hold the same data. Worked out when it is added, or the first time it is listed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_sha: Option<String>,
    /// What to know about its data before training on it (worked out like `content_sha`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<dataset_files::Quality>,
    /// Whether its labels were checked on the Labelling page; None while nobody has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<DatasetReview>,
    /// The group it is listed under in Model Lab (for example "old"); None for one in no group. Only for finding it again: a
    /// group changes nothing about training or testing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// The name you gave it, shown wherever it is listed or chosen; None shows when it was recorded and what it holds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The saved session made for an imported recording, so the Recordings tab can show it. Kept apart from
    /// `source_recording_id`, which says where the session's camera data and recording time are: this one has neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_session_id: Option<String>,
    /// How its labels were made: "camera" (where the camera saw the fingers meet and part), "motion" (estimated from the
    /// watch's motion, with no camera), "recorder" (while recording, by a button, key or cue) or "mixed". Kept when an
    /// import says so; otherwise worked out from its Recorder recording each time the list is read (see [`describe`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels_from: Option<String>,
    /// Whether the camera's hand landmarks are kept for it (with its Recorder recording, or in its own folder). Worked out
    /// each time the list is read; never stored.
    #[serde(
        default,
        skip_deserializing,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub camera: bool,
    /// When the session was recorded (UTC, RFC 3339), from its Recorder recording. Worked out like `camera`.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<String>,
}

/// Where a recording's labels stand after a look on the Labelling page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetReview {
    /// "reviewed" or "needs_work".
    pub status: String,
    /// What still needs doing, for "needs_work".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    pub at: String,
}

impl DatasetSummary {
    /// The labels this dataset trains on: what registry and training-role
    /// coverage checks must be applied to.
    pub fn effective_labels(&self) -> Vec<String> {
        if !self.labels.is_empty() {
            self.labels.clone()
        } else if self.label.is_empty() {
            Vec::new() // no labels yet: it is waiting on the Labelling page
        } else {
            vec![self.label.clone()]
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatasetIndex {
    pub(crate) datasets: Vec<DatasetSummary>,
    /// The sequence number the next import gets. Absent in an older index.
    #[serde(default)]
    pub(crate) next_sequence: u32,
}

/// Numbers the recordings 1, 2, 3 … in the order they are stored, which is the order they were imported, so the numbers
/// always run without a gap: deleting one moves the ones after it up.
fn number_unnumbered(index: &mut DatasetIndex) {
    for (position, dataset) in index.datasets.iter_mut().enumerate() {
        dataset.sequence = position as u32 + 1;
    }
    index.next_sequence = index.datasets.len() as u32 + 1;
}

/// Serializes writes to the on-disk dataset index/files so two concurrent
/// import/delete invocations from the UI never race each other.
#[derive(Default)]
pub struct ModelLabRuntime {
    pub(crate) lock: Mutex<()>,
}

fn validate_filename(filename: &str) -> Result<(), String> {
    if filename.trim().is_empty() {
        return Err("filename must not be empty".to_string());
    }
    if filename.chars().count() > MAX_FILENAME_LEN {
        return Err(format!(
            "filename must be at most {MAX_FILENAME_LEN} characters"
        ));
    }
    if filename.chars().any(|c| c.is_control()) {
        return Err("filename must not contain control characters".to_string());
    }
    if filename.contains('/') || filename.contains('\\') {
        return Err("filename must not contain path separators".to_string());
    }
    Ok(())
}

/// Dataset ids are always our own `Uuid::new_v4()` output, but this also
/// gates the `delete_model_dataset` argument, which comes straight from the
/// webview. Restricting it to `[a-zA-Z0-9-]` rules out path traversal
/// (`../`, absolute paths, etc.) before it ever reaches a `Path::join`.
fn validate_dataset_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("invalid dataset id".to_string())
    }
}

fn extract_label(comment_lines: &[&str]) -> Option<String> {
    for line in comment_lines {
        let trimmed = line
            .trim_start()
            .trim_start_matches(METADATA_COMMENT_PREFIX)
            .trim_start();
        if let Some(rest) = trimmed.strip_prefix("label:") {
            let value = rest.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// A validated dataset CSV, ready to store.
#[derive(Debug, PartialEq)]
struct ParsedDataset {
    /// Distinct labels present on the stored rows, sorted. Row labels are
    /// authoritative: they are what the trainer resolves.
    labels: Vec<String>,
    row_count: usize,
    /// The CSV to persist: `content` unchanged.
    csv: String,
}

/// Validates a dataset CSV against the Milestone 9 export contract: optional
/// leading `#` metadata lines, then the exact header row (with or without
/// `manual_label`), then data rows with the right column count, each carrying
/// its own `label`. A row trains on its manual label where it has one
/// (`dataset_files::effective_label`).
///
/// Two shapes are accepted:
/// - A single-label session (Quick Capture): `# label: <value>` is present, so
///   every row must carry exactly that label.
/// - A multi-label session (Timeline Capture), whose `# label:` line is empty
///   because its labels live on the rows: rows with no label are the time
///   between intervals and are kept (with no label), and the labelled rows'
///   labels are what the dataset is attributed to. Rows are never relabeled;
///   at least one labeled row is required.
fn parse_csv(content: &str) -> Result<ParsedDataset, String> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.iter().all(|line| line.trim().is_empty()) {
        return Err("dataset CSV is empty".to_string());
    }

    let mut index = 0;
    let mut comment_lines: Vec<&str> = Vec::new();
    while index < lines.len()
        && lines[index]
            .trim_start()
            .starts_with(METADATA_COMMENT_PREFIX)
    {
        comment_lines.push(lines[index]);
        index += 1;
    }

    let Some(header_line) = lines.get(index) else {
        return Err(format!(
            "no header found after {} leading metadata line(s)",
            comment_lines.len()
        ));
    };

    let expected_header = DATASET_CSV_HEADER_V2.join(",");
    let columns = if *header_line == expected_header {
        DATASET_CSV_HEADER_V2.len()
    } else if *header_line == DATASET_CSV_HEADER.join(",") {
        DATASET_CSV_HEADER.len()
    } else {
        return Err(format!(
            "header does not match the Milestone 9 dataset export contract\n  expected: {expected_header}\n  actual:   {header_line}"
        ));
    };

    let data_lines: Vec<&str> = lines[index + 1..]
        .iter()
        .copied()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if data_lines.is_empty() {
        return Err("header present but no data rows".to_string());
    }

    let mut row_labels: Vec<&str> = Vec::with_capacity(data_lines.len());
    let mut trains_on: Vec<&str> = Vec::with_capacity(data_lines.len());
    for (offset, line) in data_lines.iter().enumerate() {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != columns {
            return Err(format!(
                "row {}: expected {columns} columns, got {}",
                offset + 1,
                fields.len()
            ));
        }
        let label = fields[DATASET_CSV_HEADER.len() - 1].trim();
        row_labels.push(label);
        trains_on.push(dataset_files::effective_label(
            label,
            fields.get(DATASET_CSV_HEADER.len()).copied().unwrap_or(""),
        ));
    }

    let comment_label = extract_label(&comment_lines);
    if let Some(comment_label) = &comment_label {
        if let Some(offset) = row_labels.iter().position(|label| label.is_empty()) {
            return Err(format!(
                "row {}: no label, but the file declares a single '# label: {comment_label}' session",
                offset + 1
            ));
        }
        if let Some((offset, found)) = row_labels
            .iter()
            .enumerate()
            .find(|(_, label)| **label != comment_label.as_str())
        {
            return Err(format!(
                "row {}: labeled '{found}', but the file declares '# label: {comment_label}'",
                offset + 1
            ));
        }
    }

    // Rows with no label are the time between gestures. They are kept: the pulse model compares each moment with the
    // seconds before it, so the recording must stay continuous.
    let labels: Vec<String> = trains_on
        .iter()
        .filter(|label| !label.is_empty())
        .map(|label| label.to_string())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    // A recording with no labels yet is welcome: it joins Datasets to be labelled on the Labelling page.
    Ok(ParsedDataset {
        labels,
        row_count: data_lines.len(),
        csv: content.to_string(),
    })
}

pub(crate) fn datasets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    Ok(base.join(MODEL_LAB_DIR_NAME).join(DATASETS_DIR_NAME))
}

/// Where a dataset's data is: its folder of two files if it has one, otherwise the single file older recordings are in.
/// This is the path the trainer is given and that `dataset_sha` reads.
pub(crate) fn dataset_csv_path(dir: &std::path::Path, id: &str) -> PathBuf {
    let folder = dir.join(id);
    if folder.join(dataset_files::META_FILE).is_file() {
        folder
    } else {
        dir.join(format!("{id}.csv"))
    }
}

/// Whether a dataset's data is on disk, in either form.
pub(crate) fn dataset_exists(dir: &std::path::Path, id: &str) -> bool {
    dir.join(id).exists() || dir.join(format!("{id}.csv")).exists()
}

/// The identity a recording is sealed with when a model is trained on it: the SHA-256 of the single file, or of the pair of
/// files (or, for a folder converted from a single file, of the file it was made from: the data is the same).
pub(crate) fn dataset_sha(path: &std::path::Path) -> Result<String, String> {
    if path.is_dir() {
        let read = |name: &str| {
            fs::read_to_string(path.join(name))
                .map_err(|e| format!("could not read {}: {e}", path.join(name).display()))
        };
        let meta: Option<Meta> = fs::read_to_string(path.join(dataset_files::META_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        if let Some(original) = meta.and_then(|m| m.original_sha256) {
            return Ok(original);
        }
        return Ok(dataset_files::pair_sha(
            &read(dataset_files::PPG_FILE)?,
            &read(dataset_files::IMU_FILE)?,
        ));
    }
    fs::read(path)
        .map(|bytes| model_lab_core::sha256_hex(&bytes))
        .map_err(|e| format!("could not read {}: {e}", path.display()))
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(datasets_dir(app)?.join(INDEX_FILE_NAME))
}

pub(crate) fn load_index(app: &AppHandle) -> DatasetIndex {
    let path = match index_path(app) {
        Ok(path) => path,
        Err(error) => {
            warn!(%error, "failed to resolve model lab dataset index path; using empty index");
            return DatasetIndex::default();
        }
    };
    load_index_file(&path)
}

/// Reads an `index.json`; a missing or unreadable one is an empty index.
fn load_index_file(path: &std::path::Path) -> DatasetIndex {
    let Ok(contents) = fs::read_to_string(path) else {
        return DatasetIndex::default();
    };
    match serde_json::from_str::<DatasetIndex>(&contents) {
        Ok(mut index) => {
            number_unnumbered(&mut index);
            index
        }
        Err(error) => {
            warn!(%error, "failed to parse model lab dataset index; using empty index");
            DatasetIndex::default()
        }
    }
}

/// Writes `index.json` atomically: serialize to a sibling `.tmp` file, then
/// rename over the real path, matching `settings::write_atomic`.
pub(crate) fn write_index_atomic(app: &AppHandle, index: &DatasetIndex) -> Result<(), String> {
    write_index_file(&index_path(app)?, index)
}

fn write_index_file(path: &std::path::Path, index: &DatasetIndex) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "dataset index path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(&tmp_path, json).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn import_model_dataset(
    filename: String,
    csv_content: String,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<DatasetSummary, String> {
    let summary = ingest_dataset(&app, &runtime, filename, csv_content.clone(), None)?;
    Ok(with_viewer_session(&app, &runtime, summary, csv_content))
}

/// Makes the saved session that lets the Recordings tab show an imported recording, and links it. The recording is in
/// Datasets either way: one the viewer cannot read is only missing from that tab.
fn with_viewer_session(
    app: &AppHandle,
    runtime: &ModelLabRuntime,
    mut summary: DatasetSummary,
    csv: String,
) -> DatasetSummary {
    let session = match crate::recording_bundle::import_recording_text(csv, app) {
        Ok(session) => session.recording_id,
        Err(error) => {
            warn!(%error, "an imported recording could not be saved for the Recordings tab");
            return summary;
        }
    };
    let linked = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())
        .and_then(|_guard| {
            let mut index = load_index(app);
            if let Some(dataset) = index.datasets.iter_mut().find(|d| d.id == summary.id) {
                dataset.viewer_session_id = Some(session.clone());
            }
            write_index_atomic(app, &index)
        });
    match linked {
        Ok(()) => summary.viewer_session_id = Some(session),
        Err(error) => {
            warn!(%error, "could not link an imported recording to its saved session");
            let _ = crate::recording_bundle::remove_session(app, &session);
        }
    }
    summary
}

/// Validates a single-file dataset CSV and stores it as a new recording in Model Lab, as a folder of two dense files. When it
/// comes from a saved Recorder recording (`source_recording_id`), adding the same, unchanged recording twice is refused
/// rather than duplicated.
pub(crate) fn ingest_dataset(
    app: &AppHandle,
    runtime: &ModelLabRuntime,
    filename: String,
    csv_content: String,
    source_recording_id: Option<String>,
) -> Result<DatasetSummary, String> {
    ingest_dataset_in(
        &datasets_dir(app)?,
        |label| crate::label_registry::contains_label(app, label),
        &runtime.lock,
        filename,
        csv_content,
        source_recording_id,
    )
}

/// `ingest_dataset` for the datasets folder `dir`, with `known_label` saying which labels the catalogue has (see
/// `store_pair_in`).
pub(crate) fn ingest_dataset_in(
    dir: &std::path::Path,
    known_label: impl Fn(&str) -> bool,
    lock: &Mutex<()>,
    filename: String,
    csv_content: String,
    source_recording_id: Option<String>,
) -> Result<DatasetSummary, String> {
    validate_filename(&filename)?;
    if csv_content.len() > MAX_DATASET_CSV_BYTES {
        return Err(format!(
            "dataset CSV exceeds the {MAX_DATASET_CSV_BYTES}-byte import limit (got {} bytes)",
            csv_content.len()
        ));
    }
    let parsed = parse_csv(&csv_content)?;
    let pair = dataset_files::split_legacy_with(&parsed.csv, false)?;
    store_pair_in(
        dir,
        known_label,
        lock,
        filename,
        pair,
        source_recording_id,
        Some(&parsed.csv),
        None,
    )
}

/// Imports a recording folder (`ppg.csv` and `imu.csv`) and stores it as a new recording in Model Lab.
pub(crate) fn ingest_folder(
    app: &AppHandle,
    runtime: &ModelLabRuntime,
    folder: &std::path::Path,
) -> Result<DatasetSummary, String> {
    let name = folder
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("that is not a folder name this app can use")?
        .to_string();
    validate_filename(&name)?;
    if !folder.is_dir() {
        return Err("choose the folder that holds ppg.csv and imu.csv".into());
    }
    let read = |file: &str| -> Result<String, String> {
        let path = folder.join(file);
        let meta = fs::metadata(&path).map_err(|_| {
            format!("the folder has no {file}: a recording folder holds ppg.csv and imu.csv")
        })?;
        if meta.len() as usize > MAX_DATASET_CSV_BYTES {
            return Err(format!(
                "{file} exceeds the {MAX_DATASET_CSV_BYTES}-byte import limit"
            ));
        }
        fs::read_to_string(&path).map_err(|e| format!("could not read {file}: {e}"))
    };
    let ppg_csv = read(dataset_files::PPG_FILE)?;
    let imu_csv = read(dataset_files::IMU_FILE)?;
    let pair = dataset_files::parse_pair_with(&ppg_csv, &imu_csv, false)?;
    let summary = store_pair(app, runtime, name, pair, None, None, None)?;
    keep_camera_files(folder, &dataset_csv_path(&datasets_dir(app)?, &summary.id));
    match dataset_files::merge_to_legacy(&ppg_csv, &imu_csv) {
        Ok(merged) => Ok(with_viewer_session(app, runtime, summary, merged)),
        Err(error) => {
            warn!(%error, "an imported folder could not be merged for the Recordings tab");
            Ok(summary)
        }
    }
}

/// Copies the camera files an exported folder carries (`hand_landmarks.csv`, `hand_landmarks_2.csv`, `clock_sync.csv`)
/// into the recording just stored from it, so the Labelling page can draw the hand. Returns how many were copied; one that
/// cannot be copied is left out (the recording is kept either way).
fn keep_camera_files(from: &std::path::Path, to: &std::path::Path) -> usize {
    crate::recording_bundle::CAMERA_FILE_NAMES
        .iter()
        .filter(|name| from.join(name).is_file())
        .filter(|name| match fs::copy(from.join(name), to.join(name)) {
            Ok(_) => true,
            Err(error) => {
                warn!(%error, file = %name, "could not keep a camera file with the recording");
                false
            }
        })
        .count()
}

/// Whether a recording already stored holds exactly this data (so adding it again would only duplicate it). Compares like
/// with like: the two files' contents, whatever identity a converted folder keeps, and a single file's text either as text
/// or as the pair it splits into.
fn already_holds(dir: &std::path::Path, id: &str, pair: &Pair, legacy_text: Option<&str>) -> bool {
    let path = dataset_csv_path(dir, id);
    let incoming = dataset_files::pair_sha(&pair.ppg_csv, &pair.imu_csv);
    if path.is_dir() {
        let read = |name: &str| fs::read_to_string(path.join(name)).ok();
        // Compared as stored now: a folder from before manual labels gets the column, as the incoming pair has it.
        let same_files = read(dataset_files::PPG_FILE)
            .zip(read(dataset_files::IMU_FILE))
            .and_then(|(ppg, imu)| dataset_files::parse_pair_with(&ppg, &imu, false).ok())
            .is_some_and(|stored| {
                dataset_files::pair_sha(&stored.ppg_csv, &stored.imu_csv) == incoming
            });
        // A folder converted from a single file also holds that file's data.
        let same_original = legacy_text.is_some_and(|text| {
            read(dataset_files::META_FILE)
                .and_then(|meta| serde_json::from_str::<Meta>(&meta).ok())
                .and_then(|meta| meta.original_sha256)
                .is_some_and(|original| original == model_lab_core::sha256_hex(text.as_bytes()))
        });
        return same_files || same_original;
    }
    let Ok(saved) = fs::read_to_string(&path) else {
        return false;
    };
    legacy_text.is_some_and(|text| saved == text)
        || dataset_files::split_legacy(&saved).is_ok_and(|stored| {
            dataset_files::pair_sha(&stored.ppg_csv, &stored.imu_csv) == incoming
        })
}

/// Stores a validated pair as a new recording: its labels must exist, it is written whole or not at all, and it takes the next
/// import number. `derived_from` names the recording it is a new version of, when the Labelling page saved it.
pub(crate) fn store_pair(
    app: &AppHandle,
    runtime: &ModelLabRuntime,
    filename: String,
    pair: Pair,
    source_recording_id: Option<String>,
    legacy_text: Option<&str>,
    derived_from: Option<String>,
) -> Result<DatasetSummary, String> {
    let dir = datasets_dir(app)?;
    store_pair_in(
        &dir,
        |label| crate::label_registry::contains_label(app, label),
        &runtime.lock,
        filename,
        pair,
        source_recording_id,
        legacy_text,
        derived_from,
    )
}

/// `store_pair` for the datasets folder `dir`, with `known_label` saying which labels the catalogue has. The app calls it
/// through `store_pair`; the import tool below calls it with the app's data folder.
#[allow(clippy::too_many_arguments)]
pub(crate) fn store_pair_in(
    dir: &std::path::Path,
    known_label: impl Fn(&str) -> bool,
    lock: &Mutex<()>,
    filename: String,
    pair: Pair,
    source_recording_id: Option<String>,
    legacy_text: Option<&str>,
    derived_from: Option<String>,
) -> Result<DatasetSummary, String> {
    for label in &pair.labels {
        // A stretch left out needs no label of its own: it is never trained on.
        if label != dataset_files::LEFT_OUT_LABEL && !known_label(label) {
            return Err(format!(
                "unknown label '{label}'; create it on the Labels tab before adding recordings"
            ));
        }
    }
    let _guard = lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;

    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let index_file = dir.join(INDEX_FILE_NAME);
    let mut index = load_index_file(&index_file);
    if let Some(source) = &source_recording_id
        && index.datasets.iter().any(|existing| {
            existing.source_recording_id.as_ref() == Some(source)
                && already_holds(dir, &existing.id, &pair, legacy_text)
        })
    {
        return Err(
            "this recording was already added with the same labelled rows, so nothing changed"
                .to_string(),
        );
    }

    // The same data twice would count twice, in training and in every test.
    let incoming = dataset_files::rows_sha(&pair.ppg_csv, &pair.imu_csv);
    if fill_identities(dir, &mut index) {
        write_index_file(&index_file, &index)?;
    }
    if let Some(existing) = index
        .datasets
        .iter()
        .find(|d| d.content_sha.as_deref() == Some(incoming.as_str()))
    {
        return Err(format!(
            "this recording is already in Datasets as #{} {}, so nothing was added",
            existing.sequence, existing.original_filename
        ));
    }

    let id = loop {
        let candidate = Uuid::new_v4().to_string();
        if !dataset_exists(dir, &candidate) {
            break candidate;
        }
    };
    write_folder(dir, &id, &pair, None)?;
    let folder = dir.join(&id);

    let summary = DatasetSummary {
        id,
        original_filename: filename,
        imported_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        label: pair.labels.join(", "),
        labels: pair.labels.clone(),
        row_count: pair.ppg_rows + pair.imu_rows,
        sequence: index.next_sequence,
        two_files: true,
        gaps: Some(pair.gaps.clone()),
        source_recording_id,
        derived_from,
        context: pair.context.clone(),
        sealed: false,
        content_sha: Some(incoming),
        quality: dataset_files::quality_of(&pair).ok(),
        review: None,
        group: None,
        labels_from: None,
        name: None,
        viewer_session_id: None,
        camera: false,
        recorded_at: None,
    };

    index.next_sequence += 1;
    index.datasets.push(summary.clone());
    if let Err(error) = write_index_file(&index_file, &index) {
        let _ = fs::remove_dir_all(&folder);
        return Err(error);
    }
    Ok(summary)
}

/// Writes a recording's folder: the two files and `dataset.json`, in a temporary folder that is renamed into place so a
/// folder is there whole or not at all.
fn write_folder(
    dir: &std::path::Path,
    id: &str,
    pair: &Pair,
    original_sha256: Option<String>,
) -> Result<(), String> {
    let staging = dir.join(format!("{id}.staging"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let written = (|| -> Result<(), String> {
        fs::write(staging.join(dataset_files::PPG_FILE), &pair.ppg_csv)
            .map_err(|e| e.to_string())?;
        fs::write(staging.join(dataset_files::IMU_FILE), &pair.imu_csv)
            .map_err(|e| e.to_string())?;
        let meta = Meta {
            format_version: dataset_files::FORMAT_VERSION,
            ppg_rows: pair.ppg_rows,
            imu_rows: pair.imu_rows,
            labels: pair.labels.clone(),
            original_sha256,
            context: pair.context.clone(),
        };
        fs::write(
            staging.join(dataset_files::META_FILE),
            serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(&staging, dir.join(id)).map_err(|e| e.to_string())
    })();
    if written.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    written
}

#[tauri::command]
pub fn import_model_dataset_folder(
    path: String,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<DatasetSummary, String> {
    ingest_folder(&app, &runtime, std::path::Path::new(&path))
}

/// Writes a dataset exported from the Recorder as a folder of two dense files in `parent`, named after the session. A name that
/// is taken gets a number after it, so an export never overwrites another. Nothing is required of the labels here: an export
/// is for keeping and sharing, and Model Lab checks them when the folder is imported. Returns where it was written.
///
/// `camera_files` is the session's camera evidence as the recording bundle saves it (`hand_landmarks.csv`, optionally
/// `hand_landmarks_2.csv`, and `clock_sync.csv`). Each landmarks file is written with its frames also on the watch's clock
/// (`recording_bundle::landmarks_on_watch_clock`), and `clock_sync.csv` beside them, so the conversion can be redone.
#[tauri::command]
pub fn export_dataset_folder(
    parent: String,
    name: String,
    ppg_csv: String,
    imu_csv: String,
    ppg_clock_csv: Option<String>,
    camera_files: Option<std::collections::BTreeMap<String, String>>,
) -> Result<String, String> {
    validate_filename(&name)?;
    let camera = camera_export(camera_files.unwrap_or_default())?;
    let parent = PathBuf::from(&parent);
    if !parent.is_dir() {
        return Err("the export folder does not exist: choose another".into());
    }
    let mut target = parent.join(&name);
    let mut number = 2;
    while target.exists() {
        target = parent.join(format!("{name}-{number}"));
        number += 1;
    }
    let rows = |text: &str| {
        text.lines()
            .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
            .count()
            .saturating_sub(1)
    };
    // The labels the rows train on (their manual label where they have one); nothing more is required of them here.
    let (labels, context) = dataset_files::parse_pair_with(&ppg_csv, &imu_csv, false)
        .map(|pair| (pair.labels, pair.context))
        .unwrap_or_default();
    let meta = Meta {
        format_version: dataset_files::FORMAT_VERSION,
        ppg_rows: rows(&ppg_csv),
        imu_rows: rows(&imu_csv),
        labels,
        original_sha256: None,
        context,
    };
    let staging = parent.join(format!(
        ".{}.exporting",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("export")
    ));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let written = (|| -> Result<(), String> {
        fs::write(staging.join(dataset_files::PPG_FILE), &ppg_csv).map_err(|e| e.to_string())?;
        fs::write(staging.join(dataset_files::IMU_FILE), &imu_csv).map_err(|e| e.to_string())?;
        // How the pulse timestamps were mapped, so it can be redone (see `recording_bundle::PPG_CLOCK_HEADER`).
        if let Some(clock) = &ppg_clock_csv {
            fs::write(
                staging.join(crate::recording_bundle::PPG_CLOCK_FILE_NAME),
                clock,
            )
            .map_err(|e| e.to_string())?;
        }
        for (file, content) in &camera {
            fs::write(staging.join(file), content).map_err(|e| e.to_string())?;
        }
        fs::write(
            staging.join(dataset_files::META_FILE),
            serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(&staging, &target).map_err(|e| e.to_string())
    })();
    if let Err(error) = written {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok(target.display().to_string())
}

/// The camera files an exported folder gets: each landmarks file on the watch's clock, then `clock_sync.csv` itself.
/// Anything else is refused, and so is a landmarks file without the clock pairs that place it.
fn camera_export(
    files: std::collections::BTreeMap<String, String>,
) -> Result<Vec<(String, String)>, String> {
    use crate::recording_bundle::{CLOCK_SYNC_FILE_NAME, landmarks_on_watch_clock};
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let sync = files
        .get(CLOCK_SYNC_FILE_NAME)
        .ok_or_else(|| format!("the camera's landmarks came without {CLOCK_SYNC_FILE_NAME}, so they cannot be placed on the watch clock"))?;
    let mut out = Vec::new();
    for (name, content) in &files {
        if name != CLOCK_SYNC_FILE_NAME {
            out.push((name.clone(), landmarks_on_watch_clock(name, content, sync)?));
        }
    }
    out.push((CLOCK_SYNC_FILE_NAME.to_string(), sync.clone()));
    Ok(out)
}

/// What happened to one recording when converting older recordings to the two-file format.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    pub id: String,
    pub original_filename: String,
    /// `converted` or `failed`.
    pub outcome: String,
    pub message: String,
}

/// Converts every recording stored as a single file into a folder of two dense files, one at a time. The data is the same
/// (a row with both sensors' values becomes a row in each file), and a recording keeps the identity models trained on it were
/// sealed with. A recording is only replaced once its new folder is written and checked against the old file.
#[tauri::command]
pub fn convert_datasets_to_folders(
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<Vec<ConversionResult>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    let dir = datasets_dir(&app)?;
    let mut index = load_index(&app);
    let results = convert_all(&dir, &mut index);
    if results.iter().any(|r| r.outcome == "converted") {
        write_index_atomic(&app, &index)?;
        // Only now, with the index saying so, are the old files removed.
        remove_converted_files(&dir, &results);
    }
    Ok(results)
}

/// Converts every recording in `index` that is still a single file, one at a time, updating the index entries of the ones
/// that worked. The old files are left for [`remove_converted_files`], to be removed once the index has been saved.
fn convert_all(dir: &std::path::Path, index: &mut DatasetIndex) -> Vec<ConversionResult> {
    let mut results = Vec::new();
    for entry in index.datasets.iter_mut().filter(|d| !d.two_files) {
        results.push(match convert_one(dir, &entry.id) {
            Ok(gaps) => {
                entry.two_files = true;
                entry.gaps = Some(gaps);
                ConversionResult {
                    id: entry.id.clone(),
                    original_filename: entry.original_filename.clone(),
                    outcome: "converted".into(),
                    message: "now two dense files".into(),
                }
            }
            Err(message) => ConversionResult {
                id: entry.id.clone(),
                original_filename: entry.original_filename.clone(),
                outcome: "failed".into(),
                message,
            },
        });
    }
    results
}

fn remove_converted_files(dir: &std::path::Path, results: &[ConversionResult]) {
    for result in results.iter().filter(|r| r.outcome == "converted") {
        let _ = fs::remove_file(dir.join(format!("{}.csv", result.id)));
    }
}

/// Writes the folder for one single-file recording and checks it against the file; the file is left for the caller to remove.
fn convert_one(dir: &std::path::Path, id: &str) -> Result<GapReport, String> {
    let file = dir.join(format!("{id}.csv"));
    let text = fs::read_to_string(&file).map_err(|e| format!("could not read the file: {e}"))?;
    let original = model_lab_core::sha256_hex(text.as_bytes());
    let pair = dataset_files::split_legacy(&text)?;
    // Lossless by construction; this checks it: the rows that carried a pulse reading are the pulse file's, and the rows that
    // carried a motion reading are the motion file's.
    let (mut ppg_rows, mut imu_rows) = (0usize, 0usize);
    for line in text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .skip(1)
    {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() >= DATASET_CSV_HEADER.len() {
            ppg_rows += usize::from(fields[2..5].iter().any(|v| !v.trim().is_empty()));
            imu_rows += usize::from(fields[5..15].iter().any(|v| !v.trim().is_empty()));
        }
    }
    if (ppg_rows, imu_rows) != (pair.ppg_rows, pair.imu_rows) {
        return Err(format!(
            "the split did not keep every row ({ppg_rows} pulse and {imu_rows} motion rows expected, {} and {} found)",
            pair.ppg_rows, pair.imu_rows
        ));
    }
    // A folder can be left from an earlier attempt whose index update failed; the index still says this recording is the
    // single file, so that file decides. A folder that already holds exactly this conversion is kept; any other is replaced.
    let target = dir.join(id);
    if target.is_dir() {
        if holds_conversion(&target, &pair, &original) {
            return Ok(pair.gaps);
        }
        fs::remove_dir_all(&target)
            .map_err(|e| format!("could not replace a folder left by an earlier attempt: {e}"))?;
    }
    write_folder(dir, id, &pair, Some(original))?;
    Ok(pair.gaps)
}

/// Whether `folder` holds `pair` converted from the single file whose hash is `original`.
fn holds_conversion(folder: &std::path::Path, pair: &Pair, original: &str) -> bool {
    let read = |name: &str| fs::read_to_string(folder.join(name)).ok();
    let meta_matches = read(dataset_files::META_FILE)
        .and_then(|text| serde_json::from_str::<Meta>(&text).ok())
        .and_then(|meta| meta.original_sha256)
        .is_some_and(|sha| sha == original);
    meta_matches
        && read(dataset_files::PPG_FILE).as_deref() == Some(pair.ppg_csv.as_str())
        && read(dataset_files::IMU_FILE).as_deref() == Some(pair.imu_csv.as_str())
}

/// Every label on any imported recording.
pub(crate) fn dataset_labels_in_use(app: &AppHandle) -> std::collections::BTreeSet<String> {
    load_index(app)
        .datasets
        .iter()
        .flat_map(DatasetSummary::effective_labels)
        .collect()
}

#[tauri::command]
pub async fn list_model_datasets(app: AppHandle) -> Result<Vec<DatasetSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<ModelLabRuntime>();
        list_model_datasets_blocking(&app, &runtime)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_model_datasets_blocking(
    app: &AppHandle,
    runtime: &ModelLabRuntime,
) -> Result<Vec<DatasetSummary>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    let mut index = load_index(app);
    if let Ok(dir) = datasets_dir(app)
        && fill_identities(&dir, &mut index)
    {
        // Recordings added before identities and quality were kept get them once.
        if let Err(error) = write_index_atomic(app, &index) {
            warn!(%error, "could not save the recordings' identities");
        }
    }
    if let (Ok(dir), Ok(bundles)) = (
        datasets_dir(app),
        crate::recording_bundle::recording_bundles_dir(app),
    ) {
        describe(&mut index.datasets, &dir, &bundles);
    }
    Ok(index.datasets)
}

/// The index with what [`describe`] fills in (how each recording's labels were made, among others), for a replay that
/// reports camera-timed and estimated recordings apart.
pub(crate) fn described_index(app: &AppHandle) -> DatasetIndex {
    let mut index = load_index(app);
    if let (Ok(dir), Ok(bundles)) = (
        datasets_dir(app),
        crate::recording_bundle::recording_bundles_dir(app),
    ) {
        describe(&mut index.datasets, &dir, &bundles);
    }
    index
}

/// Fills in what the list shows but the index does not keep: whether the camera's landmarks are there, when the session
/// was recorded, and (unless the index says) how its labels were made. A new version saved from the Labelling page is
/// followed back to the recording it was made from, for the camera and the time; its labels are its own.
pub(crate) fn describe(
    datasets: &mut [DatasetSummary],
    dir: &std::path::Path,
    bundles: &std::path::Path,
) {
    let links: std::collections::HashMap<String, (Option<String>, Option<String>)> = datasets
        .iter()
        .map(|d| {
            (
                d.id.clone(),
                (d.source_recording_id.clone(), d.derived_from.clone()),
            )
        })
        .collect();
    for dataset in datasets.iter_mut() {
        let mut seen = std::collections::BTreeSet::new();
        let mut at = Some(dataset.id.clone());
        let mut source = None;
        while let Some(id) = at.filter(|id| seen.insert(id.clone())) {
            let Some((recording, from)) = links.get(&id) else {
                break;
            };
            if recording.is_some() {
                source = recording.clone();
                break;
            }
            at = from.clone();
        }
        let facts = source
            .filter(|id| {
                !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            .map(|id| crate::recording_bundle::source_facts(&bundles.join(id)))
            .unwrap_or_default();
        dataset.camera =
            facts.camera || crate::recording_bundle::has_landmarks(&dir.join(&dataset.id));
        dataset.recorded_at = facts.recorded_at;
        if dataset.labels_from.is_none() && dataset.derived_from.is_none() {
            dataset.labels_from = facts.labels_from.map(String::from);
        }
    }
}

/// Works out the content identity and quality report of every recording that lacks them. Returns whether any changed.
pub(crate) fn fill_identities(dir: &std::path::Path, index: &mut DatasetIndex) -> bool {
    let mut changed = false;
    for dataset in index
        .datasets
        .iter_mut()
        .filter(|d| d.content_sha.is_none() || d.quality.is_none())
    {
        let Ok(pair) = crate::labelling::pair_at(&dataset_csv_path(dir, &dataset.id)) else {
            continue;
        };
        dataset.content_sha = Some(dataset_files::rows_sha(&pair.ppg_csv, &pair.imu_csv));
        dataset.quality = dataset_files::quality_of(&pair).ok();
        changed = true;
    }
    changed
}

/// Seals or unseals recordings for the final test. A sealed recording cannot be trained on; unsealing one makes it ordinary
/// training data again, after which it is no longer an untouched test.
#[tauri::command]
pub fn set_datasets_sealed(
    ids: Vec<String>,
    sealed: bool,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<Vec<DatasetSummary>, String> {
    for id in &ids {
        validate_dataset_id(id)?;
    }
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    for id in &ids {
        let dataset = index
            .datasets
            .iter_mut()
            .find(|dataset| &dataset.id == id)
            .ok_or_else(|| format!("no dataset with id '{id}'"))?;
        dataset.sealed = sealed;
    }
    write_index_atomic(&app, &index)?;
    Ok(index.datasets)
}

/// The longest group name, in characters.
pub const MAX_GROUP_NAME_CHARS: usize = 60;

/// A group name as stored: trimmed, and None when blank. Refuses one that is too long or holds a control character.
fn clean_group_name(name: Option<&str>) -> Result<Option<String>, String> {
    let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if name.chars().count() > MAX_GROUP_NAME_CHARS {
        return Err(format!(
            "a group name can be at most {MAX_GROUP_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("a group name cannot hold a line break or other control character".to_string());
    }
    Ok(Some(name.to_string()))
}

const MAX_DATASET_NAME_CHARS: usize = 80;

/// A name as it is kept: trimmed, one line, at most [`MAX_DATASET_NAME_CHARS`]; None when blank.
fn clean_dataset_name(name: Option<&str>) -> Result<Option<String>, String> {
    let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if name.chars().count() > MAX_DATASET_NAME_CHARS {
        return Err(format!(
            "a name can be at most {MAX_DATASET_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("a name cannot hold a line break or other control character".to_string());
    }
    Ok(Some(name.to_string()))
}

fn rename_in(index: &mut DatasetIndex, id: &str, name: Option<String>) -> Result<(), String> {
    let dataset = index
        .datasets
        .iter_mut()
        .find(|dataset| dataset.id == id)
        .ok_or_else(|| format!("no dataset with id '{id}'"))?;
    dataset.name = name;
    Ok(())
}

/// Names a recording, or takes its name away (`name` None or blank) so it is shown by when it was recorded and what it
/// holds. The name is only for finding it: it changes nothing about the data, training or testing.
#[tauri::command]
pub fn set_dataset_name(
    id: String,
    name: Option<String>,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<Vec<DatasetSummary>, String> {
    validate_dataset_id(&id)?;
    let name = clean_dataset_name(name.as_deref())?;
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    rename_in(&mut index, &id, name)?;
    write_index_atomic(&app, &index)?;
    Ok(index.datasets)
}

/// The name of a new version of `parent` saved from the Labelling page: its name with the next version number ("Monday
/// pinches (v2)", then "(v3)"), or None when it has none.
pub(crate) fn version_name(datasets: &[DatasetSummary], parent: &str) -> Option<String> {
    let parent_name = datasets.iter().find(|d| d.id == parent)?.name.as_deref()?;
    let base = parent_name
        .rsplit_once(" (v")
        .filter(|(_, n)| {
            n.strip_suffix(')')
                .is_some_and(|n| n.parse::<u32>().is_ok())
        })
        .map_or(parent_name, |(base, _)| base);
    let taken = datasets
        .iter()
        .filter_map(|d| d.name.as_deref())
        .filter(|n| n.starts_with(&format!("{base} (v")))
        .count();
    Some(format!("{base} (v{})", taken + 2))
}

/// Names the recording `id` with `name`, as `set_dataset_name` does, for the app's own use (a new version's name).
pub(crate) fn name_dataset(
    app: &AppHandle,
    runtime: &ModelLabRuntime,
    id: &str,
    name: Option<String>,
) -> Result<(), String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    let mut index = load_index(app);
    rename_in(&mut index, id, name)?;
    write_index_atomic(app, &index)
}

/// Puts recordings in a group, or takes them out of their group (`group` None or blank). Every id must exist, or nothing changes.
#[tauri::command]
pub fn set_datasets_group(
    ids: Vec<String>,
    group: Option<String>,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<Vec<DatasetSummary>, String> {
    for id in &ids {
        validate_dataset_id(id)?;
    }
    let group = clean_group_name(group.as_deref())?;
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    put_in_group(&mut index, &ids, group)?;
    write_index_atomic(&app, &index)?;
    Ok(index.datasets)
}

fn put_in_group(
    index: &mut DatasetIndex,
    ids: &[String],
    group: Option<String>,
) -> Result<(), String> {
    if let Some(missing) = ids
        .iter()
        .find(|id| !index.datasets.iter().any(|dataset| &dataset.id == *id))
    {
        return Err(format!("no dataset with id '{missing}'"));
    }
    for dataset in index
        .datasets
        .iter_mut()
        .filter(|dataset| ids.contains(&dataset.id))
    {
        dataset.group = group.clone();
    }
    Ok(())
}

/// Marks a recording's labels as reviewed or as needing work (with a note), or clears that (`status` None).
#[tauri::command]
pub fn set_dataset_review(
    id: String,
    status: Option<String>,
    note: Option<String>,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<DatasetSummary, String> {
    validate_dataset_id(&id)?;
    let review = match status.as_deref() {
        None => None,
        Some(status @ ("reviewed" | "needs_work")) => Some(DatasetReview {
            status: status.to_string(),
            note: note.unwrap_or_default().trim().chars().take(500).collect(),
            at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
        Some(other) => return Err(format!("unknown review status '{other}'")),
    };
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    let mut index = load_index(&app);
    let dataset = index
        .datasets
        .iter_mut()
        .find(|dataset| dataset.id == id)
        .ok_or_else(|| format!("no dataset with id '{id}'"))?;
    dataset.review = review;
    let updated = dataset.clone();
    write_index_atomic(&app, &index)?;
    Ok(updated)
}

/// Takes a recording out of the list. New versions made from it are linked to where it came from instead, so they keep
/// their way back to the session's camera data and time.
fn remove_from_index(datasets: &mut Vec<DatasetSummary>, id: &str) -> Result<(), String> {
    let at = datasets
        .iter()
        .position(|dataset| dataset.id == id)
        .ok_or_else(|| format!("no dataset with id '{id}'"))?;
    let removed = datasets.remove(at);
    for version in datasets
        .iter_mut()
        .filter(|dataset| dataset.derived_from.as_deref() == Some(id))
    {
        version.derived_from.clone_from(&removed.derived_from);
        if version.source_recording_id.is_none() {
            version
                .source_recording_id
                .clone_from(&removed.source_recording_id);
        }
        if version.viewer_session_id.is_none() {
            version
                .viewer_session_id
                .clone_from(&removed.viewer_session_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_model_dataset(
    id: String,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<(), String> {
    validate_dataset_id(&id)?;

    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;

    let mut index = load_index(&app);
    let sessions: Vec<String> = index
        .datasets
        .iter()
        .filter(|dataset| dataset.id == id)
        .flat_map(|dataset| {
            [
                dataset.source_recording_id.clone(),
                dataset.viewer_session_id.clone(),
            ]
        })
        .flatten()
        .collect();
    remove_from_index(&mut index.datasets, &id)?;
    write_index_atomic(&app, &index)?;

    let dir = datasets_dir(&app)?;
    let path = dataset_csv_path(&dir, &id);
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
    } else if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    // Datasets owns the sessions behind it: the last recording of one takes the session's raw and camera files with it.
    for session in sessions {
        if !crate::recording_bundle::session_in_use(&index.datasets, &session) {
            crate::recording_bundle::remove_session(&app, &session)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One-off tool: adds recordings to Model Lab in the app's own data folder, through the same checks as Import (headers,
    /// labels in the catalogue, no duplicate, the next number). `APP_DATA` is the app's data folder (on macOS
    /// `~/Library/Application Support/dev.meanotaku.spatial-gesture-control`), `IMPORT_DIR` a folder of recording folders
    /// (`ppg.csv` and `imu.csv`) and single-file CSVs, and `ADD_LABELS` (optional) `id:Display name:description` entries
    /// separated by `;` to add to the catalogue first, as gestures. The app reads both files afresh on each action.
    #[test]
    #[ignore = "a tool: needs APP_DATA and IMPORT_DIR"]
    fn import_recordings_into_the_app() {
        let app_data = PathBuf::from(std::env::var("APP_DATA").expect("APP_DATA"));
        let import = PathBuf::from(std::env::var("IMPORT_DIR").expect("IMPORT_DIR"));
        let labels_file = app_data.join(MODEL_LAB_DIR_NAME).join("labels.json");
        let wanted: Vec<(String, String, String)> = std::env::var("ADD_LABELS")
            .unwrap_or_default()
            .split(';')
            .filter(|entry| !entry.trim().is_empty())
            .map(|entry| {
                let mut parts = entry.splitn(3, ':');
                let id = parts.next().unwrap_or_default().trim().to_string();
                let name = parts.next().unwrap_or(&id).trim().to_string();
                (
                    id,
                    name,
                    parts.next().unwrap_or_default().trim().to_string(),
                )
            })
            .collect();
        let refs: Vec<(&str, &str, &str)> = wanted
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
            .collect();
        println!(
            "labels added: {:?}",
            crate::label_registry::add_gesture_labels_at(&labels_file, &refs).unwrap()
        );
        let known = crate::label_registry::label_ids_at(&labels_file);
        let dir = app_data.join(MODEL_LAB_DIR_NAME).join(DATASETS_DIR_NAME);
        let lock = Mutex::new(());
        let mut entries: Vec<PathBuf> = fs::read_dir(&import)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let outcome = if path.is_dir() && path.join(dataset_files::IMU_FILE).is_file() {
                let read = |file: &str| fs::read_to_string(path.join(file)).unwrap();
                dataset_files::parse_pair(
                    &read(dataset_files::PPG_FILE),
                    &read(dataset_files::IMU_FILE),
                )
                .and_then(|pair| {
                    store_pair_in(
                        &dir,
                        |label| known.contains(label),
                        &lock,
                        name.clone(),
                        pair,
                        None,
                        None,
                        None,
                    )
                })
            } else if path.extension().is_some_and(|ext| ext == "csv") {
                let text = fs::read_to_string(&path).unwrap();
                parse_csv(&text).and_then(|parsed| {
                    let pair = dataset_files::split_legacy(&parsed.csv)?;
                    store_pair_in(
                        &dir,
                        |label| known.contains(label),
                        &lock,
                        name.clone(),
                        pair,
                        None,
                        Some(&parsed.csv),
                        None,
                    )
                })
            } else {
                continue;
            };
            match outcome {
                Ok(summary) => println!(
                    "added #{} {} ({})",
                    summary.sequence,
                    name,
                    summary.labels.join(", ")
                ),
                Err(error) => println!("not added: {name}: {error}"),
            }
        }
    }

    fn valid_csv() -> String {
        [
            "# gesture-dataset-export: 1",
            "# label: pinch_start",
            "# started_at: 2026-08-31T00:00:00.000Z",
            "# row_count: 2",
            &DATASET_CSV_HEADER.join(","),
            "1,1,0.1,0.2,0.3,0.0,0.0,1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,90,pinch_start",
            "2,2,0.1,0.2,0.3,0.0,0.0,1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,90,pinch_start",
        ]
        .join("\n")
    }

    #[test]
    fn parses_valid_csv() {
        let parsed = parse_csv(&valid_csv()).expect("valid CSV must parse");
        assert_eq!(parsed.labels, vec!["pinch_start".to_string()]);
        assert_eq!(parsed.row_count, 2);
        assert_eq!(
            parsed.csv,
            valid_csv(),
            "a single-label file is stored as-is"
        );
    }

    #[test]
    fn rejects_empty_csv() {
        assert!(parse_csv("").is_err());
        assert!(parse_csv("   \n\n").is_err());
    }

    #[test]
    fn a_file_with_no_label_anywhere_joins_to_be_labelled() {
        let csv = valid_csv()
            .replace("# label: pinch_start\n", "")
            .replace(",pinch_start", ",");
        assert!(parse_csv(&csv).unwrap().labels.is_empty());
    }

    /// D-M3-1: a Timeline Capture export has an empty `# label:` line and a
    /// blank label on every unannotated gap row. It used to be rejected at the
    /// `# label:` gate (and, past it, by the trainer's per-row label check).
    fn timeline_csv() -> String {
        let row = |t: u32, label: &str| {
            format!("{t},{t},0.1,0.2,0.3,0.0,0.0,1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,90,{label}")
        };
        [
            "# gesture-dataset-export: 1".to_string(),
            "# label: ".to_string(),
            DATASET_CSV_HEADER.join(","),
            row(1, ""),
            row(2, "idle"),
            row(3, "idle"),
            row(4, ""),
            row(5, "pinch_start"),
            row(6, ""),
        ]
        .join("\n")
    }

    #[test]
    fn a_timeline_capture_export_is_accepted_with_its_gap_rows_kept_unlabelled() {
        let parsed = parse_csv(&timeline_csv()).expect("timeline export must import");
        assert_eq!(
            parsed.labels,
            vec!["idle".to_string(), "pinch_start".to_string()]
        );
        // The time between intervals stays, with no label: the pulse model needs the recording continuous.
        assert_eq!(parsed.row_count, 6);
        let stored: Vec<&str> = parsed.csv.lines().collect();
        assert_eq!(stored.iter().filter(|l| l.starts_with("1,")).count(), 1);
        assert_eq!(stored.last().unwrap().split(',').next_back(), Some(""));
        // And the stored file is itself a valid dataset.
        assert_eq!(parse_csv(&parsed.csv).unwrap().row_count, 6);
    }

    #[test]
    fn a_comment_label_that_disagrees_with_the_rows_is_rejected() {
        let csv = valid_csv().replace("# label: pinch_start", "# label: idle");
        let error = parse_csv(&csv).unwrap_err();
        assert!(error.contains("declares"), "{error}");
    }

    #[test]
    fn a_single_label_session_with_a_blank_row_label_is_rejected() {
        let mut csv = valid_csv();
        csv = csv.replacen(",90,pinch_start", ",90,", 1);
        assert!(parse_csv(&csv).unwrap_err().contains("no label"));
    }

    #[test]
    fn deleting_a_recording_links_its_new_versions_to_where_it_came_from() {
        let entry = |id: &str, source: Option<&str>, from: Option<&str>| -> DatasetSummary {
            serde_json::from_value(serde_json::json!({
                "id": id, "originalFilename": "t.csv", "importedAt": "", "label": "", "rowCount": 0,
                "sourceRecordingId": source, "derivedFrom": from,
            }))
            .unwrap()
        };
        let mut list = vec![
            entry("first", Some("session"), None),
            entry("second", None, Some("first")),
            entry("third", None, Some("second")),
        ];
        remove_from_index(&mut list, "first").unwrap();
        assert_eq!(list[0].source_recording_id.as_deref(), Some("session"));
        assert_eq!(list[0].derived_from, None);
        remove_from_index(&mut list, "second").unwrap();
        assert_eq!(list[0].id, "third");
        assert_eq!(list[0].source_recording_id.as_deref(), Some("session"));
        assert!(remove_from_index(&mut list, "gone").is_err());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn a_recording_with_no_labels_is_stored_and_listed_to_be_labelled() {
        let dir = temp_dir("unlabelled-joins");
        let csv = valid_csv()
            .replace("# label: pinch_start\n", "")
            .replace(",pinch_start", ",");
        let made = ingest_dataset_in(
            &dir,
            |_| panic!("no label to look up"),
            &Mutex::new(()),
            "session.csv".into(),
            csv,
            Some("rec-1".into()),
        )
        .unwrap();
        assert!(made.labels.is_empty());
        assert_eq!(made.source_recording_id.as_deref(), Some("rec-1"));
        let index = load_index_file(&dir.join(INDEX_FILE_NAME));
        assert_eq!(index.datasets.len(), 1);
        assert!(index.datasets[0].effective_labels().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_stays_in_use_until_its_last_recording_is_deleted() {
        use crate::recording_bundle::session_in_use;
        let entry = |id: &str, source: Option<&str>, from: Option<&str>| -> DatasetSummary {
            serde_json::from_value(serde_json::json!({
                "id": id, "originalFilename": "t.csv", "importedAt": "", "label": "", "rowCount": 0,
                "sourceRecordingId": source, "derivedFrom": from,
            }))
            .unwrap()
        };
        let mut list = vec![
            entry("first", Some("session"), None),
            entry("again", Some("session"), None),
            entry("version", None, Some("first")),
            entry("elsewhere", Some("other"), None),
        ];
        remove_from_index(&mut list, "first").unwrap();
        assert!(session_in_use(&list, "session"), "added twice");
        remove_from_index(&mut list, "again").unwrap();
        assert!(
            session_in_use(&list, "session"),
            "a new version still needs it"
        );
        remove_from_index(&mut list, "version").unwrap();
        assert!(!session_in_use(&list, "session"));
        assert!(session_in_use(&list, "other"));
        // An imported recording's session is in use by that link, and goes to a new version made from it.
        let mut imported = entry("imported", None, None);
        imported.viewer_session_id = Some("viewer".into());
        let mut list = vec![imported, entry("version", None, Some("imported"))];
        assert!(session_in_use(&list, "viewer"));
        remove_from_index(&mut list, "imported").unwrap();
        assert!(
            session_in_use(&list, "viewer"),
            "the new version shows it now"
        );
        remove_from_index(&mut list, "version").unwrap();
        assert!(!session_in_use(&list, "viewer"));
    }

    #[test]
    fn a_multi_label_dataset_requires_every_label_to_have_a_training_role() {
        let dataset = DatasetSummary {
            id: "a".into(),
            original_filename: "t.csv".into(),
            imported_at: String::new(),
            label: "idle, pinch_start".into(),
            labels: vec!["idle".into(), "pinch_start".into()],
            row_count: 3,
            sequence: 1,
            two_files: false,
            gaps: None,
            source_recording_id: None,
            derived_from: None,
            context: Default::default(),
            sealed: false,
            content_sha: None,
            quality: None,
            review: None,
            group: None,
            labels_from: None,
            name: None,
            viewer_session_id: None,
            camera: false,
            recorded_at: None,
        };
        assert_eq!(dataset.effective_labels(), vec!["idle", "pinch_start"]);
        // An index written before multi-label datasets existed has no `labels`.
        let legacy: DatasetSummary = serde_json::from_str(
            r#"{"id":"a","originalFilename":"t.csv","importedAt":"","label":"idle","rowCount":3}"#,
        )
        .unwrap();
        assert_eq!(legacy.effective_labels(), vec!["idle"]);
    }

    #[test]
    fn parses_custom_label_for_registry_validation() {
        let csv = valid_csv().replace("pinch_start", "not_a_real_label");
        let parsed = parse_csv(&csv).expect("custom labels are resolved by the persisted registry");
        assert_eq!(parsed.labels, vec!["not_a_real_label".to_string()]);
    }

    #[test]
    fn rejects_mismatched_header() {
        let bad_header = valid_csv().replace("timestamp_ns", "timestamp_seconds");
        assert!(parse_csv(&bad_header).unwrap_err().contains("header"));
    }

    #[test]
    fn rejects_header_with_no_data_rows() {
        let header_only = ["# label: idle", &DATASET_CSV_HEADER.join(",")].join("\n");
        assert!(
            parse_csv(&header_only)
                .unwrap_err()
                .contains("no data rows")
        );
    }

    #[test]
    fn rejects_row_with_wrong_column_count() {
        let source = valid_csv();
        let mut lines: Vec<&str> = source.lines().collect();
        let last = lines.len() - 1;
        lines[last] = "1,2,3";
        let csv = lines.join("\n");
        assert!(parse_csv(&csv).unwrap_err().contains("expected 17 columns"));
    }

    #[test]
    fn filename_rejects_empty_and_path_separators() {
        assert!(validate_filename("").is_err());
        assert!(validate_filename("   ").is_err());
        assert!(validate_filename("../../etc/passwd").is_err());
        assert!(validate_filename("sub/dir.csv").is_err());
        assert!(validate_filename("sub\\dir.csv").is_err());
        assert!(validate_filename("session-1.csv").is_ok());
    }

    #[test]
    fn filename_rejects_control_characters() {
        assert!(validate_filename("evil\0.csv").is_err());
        assert!(validate_filename("evil\n.csv").is_err());
    }

    #[test]
    fn dataset_id_rejects_path_traversal() {
        assert!(validate_dataset_id("../../etc/passwd").is_err());
        assert!(validate_dataset_id("../secret").is_err());
        assert!(validate_dataset_id("/etc/passwd").is_err());
        assert!(validate_dataset_id("a/b").is_err());
        assert!(validate_dataset_id("").is_err());
        assert!(validate_dataset_id(&Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn dataset_csv_path_stays_inside_dir_for_valid_ids() {
        let dir = PathBuf::from("/tmp/model-lab-test/datasets");
        let id = Uuid::new_v4().to_string();
        validate_dataset_id(&id).expect("generated id must validate");
        let path = dataset_csv_path(&dir, &id);
        assert!(path.starts_with(&dir));
    }

    /// A one-off, read-only check on a real datasets folder: `MODEL_LAB_E2E_DATASETS`.
    #[test]
    #[ignore = "one-off: set MODEL_LAB_E2E_DATASETS"]
    fn identities_and_quality_of_a_real_datasets_folder() {
        let dir = PathBuf::from(std::env::var("MODEL_LAB_E2E_DATASETS").unwrap());
        let mut index: DatasetIndex =
            serde_json::from_slice(&fs::read(dir.join(INDEX_FILE_NAME)).unwrap()).unwrap();
        for dataset in &mut index.datasets {
            dataset.content_sha = None;
            dataset.quality = None;
        }
        assert!(fill_identities(&dir, &mut index));
        let mut by_sha: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
        for dataset in &index.datasets {
            by_sha
                .entry(dataset.content_sha.as_deref().unwrap())
                .or_default()
                .push(&dataset.id[..8]);
            let q = dataset.quality.as_ref().unwrap();
            println!(
                "{} holds {:?} short {} poor contact {:.1}%",
                &dataset.id[..8],
                q.holds,
                q.short_holds,
                q.poor_contact_share * 100.0
            );
        }
        let twins: Vec<&Vec<&str>> = by_sha.values().filter(|ids| ids.len() > 1).collect();
        println!("same data: {twins:?}");
    }

    #[test]
    fn a_recording_is_named_and_unnamed_and_its_new_versions_are_numbered_after_it() {
        let mut index: DatasetIndex = serde_json::from_str(
            r#"{"datasets":[{"id":"a","originalFilename":"a.csv","importedAt":"","label":"idle","rowCount":3},
                           {"id":"b","originalFilename":"b.csv","importedAt":"","label":"idle","rowCount":3}]}"#,
        )
        .unwrap();
        assert!(
            index.datasets.iter().all(|d| d.name.is_none()),
            "an index from before names reads as no name"
        );
        rename_in(
            &mut index,
            "a",
            clean_dataset_name(Some("  Monday pinches ")).unwrap(),
        )
        .unwrap();
        assert_eq!(index.datasets[0].name.as_deref(), Some("Monday pinches"));
        assert!(
            serde_json::to_string(&index)
                .unwrap()
                .contains(r#""name":"Monday pinches""#)
        );
        assert!(
            clean_dataset_name(Some("two\nlines")).is_err()
                && clean_dataset_name(Some(&"x".repeat(81))).is_err()
        );
        assert!(rename_in(&mut index, "gone", None).is_err());
        // Its first new version is v2, the next v3, also when saved from a version; an unnamed one gets no name.
        assert_eq!(
            version_name(&index.datasets, "a").as_deref(),
            Some("Monday pinches (v2)")
        );
        index.datasets.push(DatasetSummary {
            id: "c".into(),
            name: Some("Monday pinches (v2)".into()),
            ..index.datasets[1].clone()
        });
        assert_eq!(
            version_name(&index.datasets, "c").as_deref(),
            Some("Monday pinches (v3)")
        );
        assert_eq!(version_name(&index.datasets, "b"), None);
        // Blank takes the name away.
        rename_in(&mut index, "a", clean_dataset_name(Some("   ")).unwrap()).unwrap();
        assert_eq!(index.datasets[0].name, None);
    }

    #[test]
    fn recordings_are_put_in_a_group_and_taken_out_and_an_unknown_id_changes_nothing() {
        let mut index: DatasetIndex = serde_json::from_str(
            r#"{"datasets":[{"id":"a","originalFilename":"a.csv","importedAt":"","label":"idle","rowCount":3},
                           {"id":"b","originalFilename":"b.csv","importedAt":"","label":"idle","rowCount":3}]}"#,
        )
        .unwrap();
        assert!(
            index.datasets.iter().all(|d| d.group.is_none()),
            "an index from before groups reads as no group"
        );
        put_in_group(
            &mut index,
            &["a".into(), "b".into()],
            clean_group_name(Some("  old ")).unwrap(),
        )
        .unwrap();
        assert!(
            index
                .datasets
                .iter()
                .all(|d| d.group.as_deref() == Some("old"))
        );
        assert!(
            serde_json::to_string(&index)
                .unwrap()
                .contains(r#""group":"old""#)
        );
        assert!(put_in_group(&mut index, &["b".into(), "gone".into()], None).is_err());
        assert_eq!(
            index.datasets[1].group.as_deref(),
            Some("old"),
            "nothing changed"
        );
        put_in_group(
            &mut index,
            &["b".into()],
            clean_group_name(Some("   ")).unwrap(),
        )
        .unwrap();
        assert_eq!(index.datasets[1].group, None);
        assert!(
            !serde_json::to_string(&index.datasets[1])
                .unwrap()
                .contains("group")
        );
    }

    #[test]
    fn a_group_name_is_trimmed_and_refused_when_too_long_or_holding_a_line_break() {
        assert_eq!(clean_group_name(None), Ok(None));
        assert_eq!(
            clean_group_name(Some(" pinch day 2 ")),
            Ok(Some("pinch day 2".into()))
        );
        assert!(clean_group_name(Some(&"x".repeat(MAX_GROUP_NAME_CHARS))).is_ok());
        assert!(clean_group_name(Some(&"x".repeat(MAX_GROUP_NAME_CHARS + 1))).is_err());
        assert!(clean_group_name(Some("a\nb")).is_err());
    }

    #[test]
    fn recordings_are_numbered_in_the_order_stored_without_a_gap_after_a_delete() {
        let old = |id: &str| {
            format!(
                r#"{{"id":"{id}","originalFilename":"t.csv","importedAt":"","label":"idle","rowCount":3}}"#
            )
        };
        let mut index: DatasetIndex = serde_json::from_str(&format!(
            r#"{{"datasets":[{},{},{},{}]}}"#,
            old("a"),
            old("b"),
            old("c"),
            old("d")
        ))
        .unwrap();
        number_unnumbered(&mut index);
        assert_eq!(
            index
                .datasets
                .iter()
                .map(|d| d.sequence)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        index.datasets.retain(|d| d.id != "c");
        number_unnumbered(&mut index);
        assert_eq!(
            index
                .datasets
                .iter()
                .map(|d| (d.id.as_str(), d.sequence))
                .collect::<Vec<_>>(),
            [("a", 1), ("b", 2), ("d", 3)]
        );
        assert_eq!(index.next_sequence, 4);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("model-lab-{name}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const LEGACY: &str = "# gesture-dataset-export: 1\n# label: pinch\ntimestamp_ns,sequence,ppg_green,ppg_red,ppg_ir,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,quat_w,quat_x,quat_y,quat_z,contact_quality,label\n100,1,10,20,30,,,,,,,,,,,0,pinch\n120,2,,,,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,,pinch\n140,3,11,21,31,,,,,,,,,,,0,pinch\n";

    #[test]
    fn a_single_file_recording_is_converted_to_a_folder_that_keeps_its_identity_and_replaces_nothing_until_told()
     {
        let dir = temp_dir("convert");
        let id = Uuid::new_v4().to_string();
        let file = dir.join(format!("{id}.csv"));
        fs::write(&file, LEGACY).unwrap();
        let before_path = dataset_csv_path(&dir, &id);
        assert_eq!(before_path, file);
        let sealed = dataset_sha(&before_path).unwrap();

        let gaps = convert_one(&dir, &id).unwrap();
        assert_eq!((gaps.ppg.samples, gaps.imu.samples), (2, 1));
        assert!(
            file.exists(),
            "the old file is only removed by the caller, once the index agrees"
        );
        let after = dataset_csv_path(&dir, &id);
        assert_eq!(
            after,
            dir.join(&id),
            "the folder is what the trainer is now given"
        );
        assert!(
            after.join("ppg.csv").is_file()
                && after.join("imu.csv").is_file()
                && after.join("dataset.json").is_file()
        );
        assert_eq!(
            dataset_sha(&after).unwrap(),
            sealed,
            "models trained on it stay sealed to the same data"
        );
        assert_eq!(
            fs::read_to_string(after.join("ppg.csv"))
                .unwrap()
                .lines()
                .last()
                .unwrap(),
            "140,3,11,21,31,0,pinch,",
            "stored with the manual_label column, empty"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_made_from_scratch_is_identified_by_its_two_files_and_found_by_its_id() {
        let dir = temp_dir("fresh");
        let id = Uuid::new_v4().to_string();
        let pair = dataset_files::split_legacy(LEGACY).unwrap();
        write_folder(&dir, &id, &pair, None).unwrap();
        assert!(dataset_exists(&dir, &id) && dataset_csv_path(&dir, &id).is_dir());
        assert_eq!(
            dataset_sha(&dataset_csv_path(&dir, &id)).unwrap(),
            dataset_files::pair_sha(&pair.ppg_csv, &pair.imu_csv)
        );
        assert!(
            !dir.join(format!("{id}.staging")).exists(),
            "no half-written folder is left"
        );
        assert!(already_holds(&dir, &id, &pair, None));
        let other =
            dataset_files::split_legacy(&LEGACY.replace(",10,20,30,", ",10,20,31,")).unwrap();
        assert!(!already_holds(&dir, &id, &other, None));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_converted_recording_is_found_again_by_its_files_and_by_the_file_it_was_made_from() {
        // A converted folder keeps the old file's identity; adding the same data again, as a pair or as that old file, must
        // still be seen as a duplicate.
        let dir = temp_dir("converted-duplicate");
        let id = Uuid::new_v4().to_string();
        fs::write(dir.join(format!("{id}.csv")), LEGACY).unwrap();
        convert_one(&dir, &id).unwrap();
        let pair = dataset_files::split_legacy(LEGACY).unwrap();
        assert!(already_holds(&dir, &id, &pair, None));
        assert!(already_holds(&dir, &id, &pair, Some(LEGACY)));
        let other =
            dataset_files::split_legacy(&LEGACY.replace(",10,20,30,", ",10,20,31,")).unwrap();
        assert!(!already_holds(&dir, &id, &other, None));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_conversion_interrupted_before_the_index_was_saved_can_be_run_again() {
        let dir = temp_dir("retry-conversion");
        let id = Uuid::new_v4().to_string();
        fs::write(dir.join(format!("{id}.csv")), LEGACY).unwrap();
        // The first attempt wrote the folder; saving the index then failed, so the file is still the recording.
        convert_one(&dir, &id).unwrap();
        assert!(dir.join(&id).is_dir() && dir.join(format!("{id}.csv")).is_file());
        assert!(
            convert_one(&dir, &id).is_ok(),
            "the retry reuses the finished folder"
        );
        // A folder that does not match the file (left by something else) is replaced from the file.
        fs::write(dir.join(&id).join(dataset_files::PPG_FILE), "stale").unwrap();
        convert_one(&dir, &id).unwrap();
        let pair = dataset_files::split_legacy(LEGACY).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(&id).join(dataset_files::PPG_FILE)).unwrap(),
            pair.ppg_csv
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_file_recording_is_found_again_when_the_same_data_comes_as_a_pair() {
        let dir = temp_dir("legacy-duplicate");
        let id = Uuid::new_v4().to_string();
        fs::write(dir.join(format!("{id}.csv")), LEGACY).unwrap();
        let pair = dataset_files::split_legacy(LEGACY).unwrap();
        assert!(already_holds(&dir, &id, &pair, None));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_dataset_has_no_path_that_exists() {
        let dir = temp_dir("missing");
        assert!(!dataset_exists(&dir, "nothing-here"));
        assert!(dataset_sha(&dataset_csv_path(&dir, "nothing-here")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_exported_folder_never_overwrites_another_and_what_it_holds_can_be_imported_back() {
        let parent = temp_dir("export");
        let pair = dataset_files::split_legacy(LEGACY).unwrap();
        let first = export_dataset_folder(
            parent.display().to_string(),
            "session".into(),
            pair.ppg_csv.clone(),
            pair.imu_csv.clone(),
            None,
            None,
        )
        .unwrap();
        let second = export_dataset_folder(
            parent.display().to_string(),
            "session".into(),
            pair.ppg_csv.clone(),
            pair.imu_csv.clone(),
            None,
            None,
        )
        .unwrap();
        assert!(first.ends_with("session") && second.ends_with("session-2"));
        let meta: Meta =
            serde_json::from_slice(&fs::read(PathBuf::from(&first).join("dataset.json")).unwrap())
                .unwrap();
        assert_eq!(
            (meta.ppg_rows, meta.imu_rows, meta.labels),
            (2, 1, vec!["pinch".to_string()])
        );
        // What was written validates as a pair, exactly as it was.
        let back = dataset_files::parse_pair(
            &fs::read_to_string(PathBuf::from(&first).join("ppg.csv")).unwrap(),
            &fs::read_to_string(PathBuf::from(&first).join("imu.csv")).unwrap(),
        )
        .unwrap();
        assert_eq!((back.ppg_rows, back.imu_rows), (2, 1));
        assert!(
            fs::read_dir(&parent).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with('.')),
            "no staging folder is left"
        );
        assert!(
            export_dataset_folder(
                parent.display().to_string(),
                "../escape".into(),
                String::new(),
                String::new(),
                None,
                None
            )
            .is_err()
        );
        assert!(
            export_dataset_folder(
                "/no/such/folder".into(),
                "x".into(),
                String::new(),
                String::new(),
                None,
                None
            )
            .is_err()
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn an_exported_folder_carries_the_camera_landmarks_on_the_watch_clock() {
        use crate::recording_bundle::{
            CLOCK_SYNC_FILE_NAME, HAND_LANDMARKS_FILE_NAME, hand_landmarks_header,
        };
        let parent = temp_dir("export-camera");
        let pair = dataset_files::split_legacy(LEGACY).unwrap();
        let header = hand_landmarks_header();
        let landmarks = format!(
            "{header}\n0,1000.000{}",
            ",".repeat(header.matches(',').count() - 1)
        );
        let sync = "watch_timestamp_ns,browser_arrival_ms\n5000000000,1010.000".to_string();
        let files = |entries: &[(&str, &str)]| {
            Some(
                entries
                    .iter()
                    .map(|(name, text)| (name.to_string(), text.to_string()))
                    .collect(),
            )
        };
        let written = export_dataset_folder(
            parent.display().to_string(),
            "session".into(),
            pair.ppg_csv.clone(),
            pair.imu_csv.clone(),
            None,
            files(&[
                (HAND_LANDMARKS_FILE_NAME, &landmarks),
                (CLOCK_SYNC_FILE_NAME, &sync),
            ]),
        )
        .unwrap();
        let folder = PathBuf::from(&written);
        let saved = fs::read_to_string(folder.join(HAND_LANDMARKS_FILE_NAME)).unwrap();
        assert!(
            saved
                .lines()
                .next()
                .unwrap()
                .starts_with("watch_timestamp_ns,frame_index,capture_ms,")
        );
        assert!(
            saved
                .lines()
                .nth(1)
                .unwrap()
                .starts_with("4990000000,0,1000.000,")
        );
        assert_eq!(
            fs::read_to_string(folder.join(CLOCK_SYNC_FILE_NAME)).unwrap(),
            sync
        );
        // Labelling reads them back as the recording kept them.
        let evidence = crate::recording_bundle::folder_camera_evidence(&folder).unwrap();
        assert_eq!(evidence.hand_landmarks, Some(format!("{landmarks}\n")));
        assert_eq!(
            (evidence.hand_landmarks_second, evidence.clock_sync),
            (None, sync.clone())
        );
        assert!(
            crate::recording_bundle::folder_camera_evidence(&parent).is_none(),
            "no landmarks there"
        );
        // Importing the folder keeps them with the recording.
        let stored = parent.join("stored");
        fs::create_dir_all(&stored).unwrap();
        assert_eq!(
            keep_camera_files(&folder, &stored),
            2,
            "the landmarks and the clock samples"
        );
        assert_eq!(
            fs::read_to_string(stored.join(HAND_LANDMARKS_FILE_NAME)).unwrap(),
            saved
        );
        assert!(crate::recording_bundle::has_landmarks(&stored));
        // The pair still reads back exactly as before: the camera files sit beside it.
        assert!(
            dataset_files::parse_pair(
                &fs::read_to_string(folder.join("ppg.csv")).unwrap(),
                &fs::read_to_string(folder.join("imu.csv")).unwrap(),
            )
            .is_ok()
        );
        // Landmarks without the clock pairs, or a file that is not camera evidence, are refused and nothing is written.
        for bad in [
            files(&[(HAND_LANDMARKS_FILE_NAME, &landmarks)]),
            files(&[("notes.txt", "hello"), (CLOCK_SYNC_FILE_NAME, &sync)]),
        ] {
            assert!(
                export_dataset_folder(
                    parent.display().to_string(),
                    "refused".into(),
                    pair.ppg_csv.clone(),
                    pair.imu_csv.clone(),
                    None,
                    bad,
                )
                .is_err()
            );
        }
        assert!(!parent.join("refused").exists());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn converting_a_whole_index_updates_it_and_only_then_the_old_files_go() {
        let dir = temp_dir("convert-all");
        let ids: Vec<String> = (0..2).map(|_| Uuid::new_v4().to_string()).collect();
        for id in &ids {
            fs::write(dir.join(format!("{id}.csv")), LEGACY).unwrap();
        }
        let entry = |id: &String| DatasetSummary {
            id: id.clone(),
            original_filename: format!("{id}.csv"),
            imported_at: String::new(),
            label: "pinch".into(),
            labels: vec!["pinch".into()],
            row_count: 3,
            sequence: 1,
            two_files: false,
            gaps: None,
            source_recording_id: None,
            derived_from: None,
            context: Default::default(),
            sealed: false,
            content_sha: None,
            quality: None,
            review: None,
            group: None,
            labels_from: None,
            name: None,
            viewer_session_id: None,
            camera: false,
            recorded_at: None,
        };
        let mut index = DatasetIndex {
            datasets: ids.iter().map(entry).collect(),
            next_sequence: 3,
        };
        index.datasets.push(DatasetSummary {
            id: "broken".into(),
            ..entry(&"broken".to_string())
        }); // no file for this one
        let results = convert_all(&dir, &mut index);
        assert_eq!(
            results.iter().filter(|r| r.outcome == "converted").count(),
            2
        );
        assert_eq!(
            results.iter().find(|r| r.id == "broken").unwrap().outcome,
            "failed"
        );
        assert!(
            index.datasets.iter().filter(|d| d.two_files).count() == 2
                && !index.datasets[2].two_files
        );
        assert!(
            ids.iter().all(|id| dir.join(format!("{id}.csv")).exists()),
            "nothing removed yet"
        );
        write_index_file(&dir.join("index.json"), &index).unwrap();
        remove_converted_files(&dir, &results);
        assert!(
            ids.iter()
                .all(|id| !dir.join(format!("{id}.csv")).exists() && dir.join(id).is_dir())
        );
        let saved: DatasetIndex =
            serde_json::from_slice(&fs::read(dir.join("index.json")).unwrap()).unwrap();
        assert!(saved.datasets[0].two_files && saved.datasets[0].gaps.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "one-off: converts the recordings in REAL_DATASETS_DIR (a datasets folder with an index.json)"]
    fn converts_the_recordings_of_a_real_datasets_folder() {
        let dir = PathBuf::from(std::env::var("REAL_DATASETS_DIR").unwrap());
        let mut index: DatasetIndex =
            serde_json::from_slice(&fs::read(dir.join("index.json")).unwrap()).unwrap();
        let results = convert_all(&dir, &mut index);
        for r in &results {
            eprintln!(
                "{} {}: {} ({})",
                r.original_filename, r.id, r.outcome, r.message
            );
        }
        if results.iter().any(|r| r.outcome == "converted") {
            write_index_file(&dir.join("index.json"), &index).unwrap();
            remove_converted_files(&dir, &results);
        }
        assert!(results.iter().all(|r| r.outcome == "converted"));
    }
}
