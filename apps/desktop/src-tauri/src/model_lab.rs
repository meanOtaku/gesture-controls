use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tracing::warn;
use uuid::Uuid;

const DATASETS_DIR_NAME: &str = "datasets";
pub(crate) const MODEL_LAB_DIR_NAME: &str = "model-lab";
const INDEX_FILE_NAME: &str = "index.json";
const MAX_DATASET_CSV_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILENAME_LEN: usize = 255;
const METADATA_COMMENT_PREFIX: char = '#';

/// Exact column order the Milestone 9 dataset recorder writes. Mirrors
/// `DATASET_CSV_COLUMNS` in telemetryStore.ts and `HEADER_COLUMNS` in
/// tools/pinch-classifier/src/pinch_classifier/schema.py. A dataset whose
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

pub(crate) fn dataset_csv_path(dir: &std::path::Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.csv"))
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
        Ok(index) => index,
        Err(error) => {
            warn!(%error, "failed to parse model lab dataset index; using empty index");
            DatasetIndex::default()
        }
    }
}

/// Writes `index.json` atomically: serialize to a sibling `.tmp` file, then
/// rename over the real path, matching `settings::write_atomic`.
fn write_index_atomic(app: &AppHandle, index: &DatasetIndex) -> Result<(), String> {
    let path = index_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "dataset index path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(&tmp_path, json).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|error| error.to_string())?;
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

/// Validates a dataset CSV and stores it as a new recording in Model Lab. When it comes from a saved Recorder
/// recording (`source_recording_id`), adding the same, unchanged recording twice is refused rather than duplicated.
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
    for label in &parsed.labels {
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
                && fs::read_to_string(dataset_csv_path(&dir, &existing.id))
                    .is_ok_and(|saved| saved == parsed.csv)
        })
    {
        return Err(
            "this recording was already added with the same labelled rows, so nothing changed"
                .to_string(),
        );
    }

    let id = loop {
        let candidate = Uuid::new_v4().to_string();
        if !dataset_csv_path(&dir, &candidate).exists() {
            break candidate;
        }
    };

    let csv_path = dataset_csv_path(&dir, &id);
    let tmp_path = csv_path.with_extension("csv.tmp");
    fs::write(&tmp_path, &parsed.csv).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &csv_path).map_err(|error| error.to_string())?;

    let summary = DatasetSummary {
        id,
        original_filename: filename,
        imported_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        label: parsed.labels.join(", "),
        labels: parsed.labels,
        row_count: parsed.row_count,
        source_recording_id,
    };

    index.datasets.push(summary.clone());
    if let Err(error) = write_index_atomic(app, &index) {
        let _ = fs::remove_file(&csv_path);
        return Err(error);
    }

    Ok(summary)
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
    let csv_path = dataset_csv_path(&dir, &id);
    if csv_path.exists() {
        fs::remove_file(&csv_path).map_err(|error| error.to_string())?;
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
}
