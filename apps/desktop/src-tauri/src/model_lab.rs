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

/// Exact column order the Milestone 9 dataset recorder writes. Mirrors
/// `DATASET_CSV_COLUMNS` in telemetryStore.ts and `HEADER_COLUMNS` in
/// tools/label-trainer/src/label_trainer/schema.py. A dataset whose
/// header does not match this exactly is rejected on import.
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
}

impl DatasetSummary {
    /// The labels this dataset trains on: what registry and training-role
    /// coverage checks must be applied to.
    pub fn effective_labels(&self) -> Vec<String> {
        if self.labels.is_empty() {
            vec![self.label.clone()]
        } else {
            self.labels.clone()
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
    lock: Mutex<()>,
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
    /// The CSV to persist: `content` unchanged, or, for a multi-label
    /// (Timeline Capture) export, with its unlabeled gap rows removed.
    csv: String,
}

/// Validates a dataset CSV against the Milestone 9 export contract: optional
/// leading `#` metadata lines, then the exact header row, then data rows with
/// the right column count, each carrying its own `label`.
///
/// Two shapes are accepted:
/// - A single-label session (Quick Capture): `# label: <value>` is present, so
///   every row must carry exactly that label.
/// - A multi-label session (Timeline Capture), whose `# label:` line is empty
///   because its labels live on the rows: rows with no label are the
///   unannotated gaps between intervals and are dropped, and the remaining
///   rows' labels are what the dataset is attributed to. Rows are never
///   relabeled; at least one labeled row is required.
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

    let expected_header = DATASET_CSV_HEADER.join(",");
    if *header_line != expected_header {
        return Err(format!(
            "header does not match the Milestone 9 dataset export contract\n  expected: {expected_header}\n  actual:   {header_line}"
        ));
    }

    let data_lines: Vec<&str> = lines[index + 1..]
        .iter()
        .copied()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if data_lines.is_empty() {
        return Err("header present but no data rows".to_string());
    }

    let mut row_labels: Vec<&str> = Vec::with_capacity(data_lines.len());
    for (offset, line) in data_lines.iter().enumerate() {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != DATASET_CSV_HEADER.len() {
            return Err(format!(
                "row {}: expected {} columns, got {}",
                offset + 1,
                DATASET_CSV_HEADER.len(),
                fields.len()
            ));
        }
        row_labels.push(fields[fields.len() - 1].trim());
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
        return Ok(ParsedDataset {
            labels: vec![comment_label.clone()],
            row_count: data_lines.len(),
            csv: content.to_string(),
        });
    }

    let kept: Vec<&str> = data_lines
        .iter()
        .zip(&row_labels)
        .filter(|(_, label)| !label.is_empty())
        .map(|(line, _)| *line)
        .collect();
    if kept.is_empty() {
        return Err(
            "no labeled rows: add a '# label: <value>' line for a single-label session, or label the rows"
                .to_string(),
        );
    }
    let labels: Vec<String> = row_labels
        .iter()
        .filter(|label| !label.is_empty())
        .map(|label| label.to_string())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let csv = if kept.len() == data_lines.len() {
        content.to_string()
    } else {
        let mut out: Vec<&str> = comment_lines.clone();
        out.push(header_line);
        out.extend(kept.iter().copied());
        out.join("\n") + "\n"
    };
    Ok(ParsedDataset {
        labels,
        row_count: kept.len(),
        csv,
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
    let Ok(contents) = fs::read_to_string(&path) else {
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
fn write_index_atomic(app: &AppHandle, index: &DatasetIndex) -> Result<(), String> {
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
    ingest_dataset(&app, &runtime, filename, csv_content, None)
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
    validate_filename(&filename)?;
    if csv_content.len() > MAX_DATASET_CSV_BYTES {
        return Err(format!(
            "dataset CSV exceeds the {MAX_DATASET_CSV_BYTES}-byte import limit (got {} bytes)",
            csv_content.len()
        ));
    }
    let parsed = parse_csv(&csv_content)?;
    let pair = dataset_files::split_legacy(&parsed.csv)?;
    store_pair(
        app,
        runtime,
        filename,
        pair,
        source_recording_id,
        Some(&parsed.csv),
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
    let pair = dataset_files::parse_pair(
        &read(dataset_files::PPG_FILE)?,
        &read(dataset_files::IMU_FILE)?,
    )?;
    store_pair(app, runtime, name, pair, None, None)
}

/// Whether a recording already stored holds exactly this data (so adding it again would only duplicate it). Compares like
/// with like: the two files' contents, whatever identity a converted folder keeps, and a single file's text either as text
/// or as the pair it splits into.
fn already_holds(dir: &std::path::Path, id: &str, pair: &Pair, legacy_text: Option<&str>) -> bool {
    let path = dataset_csv_path(dir, id);
    let incoming = dataset_files::pair_sha(&pair.ppg_csv, &pair.imu_csv);
    if path.is_dir() {
        let read = |name: &str| fs::read_to_string(path.join(name)).ok();
        let same_files = read(dataset_files::PPG_FILE)
            .zip(read(dataset_files::IMU_FILE))
            .is_some_and(|(ppg, imu)| dataset_files::pair_sha(&ppg, &imu) == incoming);
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
/// import number.
fn store_pair(
    app: &AppHandle,
    runtime: &ModelLabRuntime,
    filename: String,
    pair: Pair,
    source_recording_id: Option<String>,
    legacy_text: Option<&str>,
) -> Result<DatasetSummary, String> {
    for label in &pair.labels {
        if !crate::label_registry::contains_label(app, label) {
            return Err(format!(
                "unknown label '{label}'; create it on the Labels tab before adding recordings"
            ));
        }
    }
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;

    let dir = datasets_dir(app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let mut index = load_index(app);
    if let Some(source) = &source_recording_id
        && index.datasets.iter().any(|existing| {
            existing.source_recording_id.as_ref() == Some(source)
                && already_holds(&dir, &existing.id, &pair, legacy_text)
        })
    {
        return Err(
            "this recording was already added with the same labelled rows, so nothing changed"
                .to_string(),
        );
    }

    let id = loop {
        let candidate = Uuid::new_v4().to_string();
        if !dataset_exists(&dir, &candidate) {
            break candidate;
        }
    };
    write_folder(&dir, &id, &pair, None)?;
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
    };

    index.next_sequence += 1;
    index.datasets.push(summary.clone());
    if let Err(error) = write_index_atomic(app, &index) {
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
#[tauri::command]
pub fn export_dataset_folder(
    parent: String,
    name: String,
    ppg_csv: String,
    imu_csv: String,
) -> Result<String, String> {
    validate_filename(&name)?;
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
    let labels: std::collections::BTreeSet<String> = [&ppg_csv, &imu_csv]
        .iter()
        .flat_map(|text| {
            text.lines()
                .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
                .skip(1)
        })
        .filter_map(|line| line.rsplit(',').next())
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty())
        .collect();
    let meta = Meta {
        format_version: dataset_files::FORMAT_VERSION,
        ppg_rows: rows(&ppg_csv),
        imu_rows: rows(&imu_csv),
        labels: labels.into_iter().collect(),
        original_sha256: None,
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
        if fields.len() == 17 {
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
pub fn list_model_datasets(
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<Vec<DatasetSummary>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    Ok(load_index(&app).datasets)
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
    let before = index.datasets.len();
    index.datasets.retain(|dataset| dataset.id != id);
    if index.datasets.len() == before {
        return Err(format!("no dataset with id '{id}'"));
    }
    write_index_atomic(&app, &index)?;

    let dir = datasets_dir(&app)?;
    let path = dataset_csv_path(&dir, &id);
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
    } else if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_file_with_no_label_anywhere_is_rejected() {
        let csv = valid_csv()
            .replace("# label: pinch_start\n", "")
            .replace(",pinch_start", ",");
        assert!(parse_csv(&csv).unwrap_err().contains("no labeled rows"));
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
    fn a_timeline_capture_export_is_accepted_with_its_gap_rows_dropped() {
        let parsed = parse_csv(&timeline_csv()).expect("timeline export must import");
        assert_eq!(
            parsed.labels,
            vec!["idle".to_string(), "pinch_start".to_string()]
        );
        assert_eq!(parsed.row_count, 3);
        let stored: Vec<&str> = parsed.csv.lines().collect();
        assert_eq!(stored.iter().filter(|l| l.starts_with("1,")).count(), 0);
        assert_eq!(
            stored.last().unwrap().split(',').next_back(),
            Some("pinch_start")
        );
        // Every stored data row carries a label, which the trainer requires.
        assert!(
            stored
                .iter()
                .skip(3)
                .all(|line| !line.split(',').next_back().unwrap().is_empty())
        );
        // And the stored file is itself a valid dataset.
        assert_eq!(parse_csv(&parsed.csv).unwrap().row_count, 3);
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
            "140,3,11,21,31,0,pinch"
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
        )
        .unwrap();
        let second = export_dataset_folder(
            parent.display().to_string(),
            "session".into(),
            pair.ppg_csv.clone(),
            pair.imu_csv.clone(),
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
                String::new()
            )
            .is_err()
        );
        assert!(
            export_dataset_folder(
                "/no/such/folder".into(),
                "x".into(),
                String::new(),
                String::new()
            )
            .is_err()
        );
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
