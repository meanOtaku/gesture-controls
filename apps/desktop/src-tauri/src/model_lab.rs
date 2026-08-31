use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tracing::warn;
use uuid::Uuid;

const DATASETS_DIR_NAME: &str = "datasets";
const MODEL_LAB_DIR_NAME: &str = "model-lab";
const INDEX_FILE_NAME: &str = "index.json";
const MAX_DATASET_CSV_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILENAME_LEN: usize = 255;
const METADATA_COMMENT_PREFIX: char = '#';

/// Exact column order the Milestone 9 dataset recorder writes. Mirrors
/// `DATASET_CSV_COLUMNS` in telemetryStore.ts and `HEADER_COLUMNS` in
/// tools/pinch-classifier/src/pinch_classifier/schema.py. A dataset whose
/// header does not match this exactly is rejected on import.
const DATASET_CSV_HEADER: [&str; 17] = [
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

/// Mirrors `GESTURE_DATASET_LABELS` in telemetryStore.ts / schema.py.
const GESTURE_DATASET_LABELS: [&str; 14] = [
    "idle",
    "pinch_start",
    "pinch_hold",
    "pinch_release",
    "walking",
    "typing",
    "using_mouse",
    "touching_face",
    "adjusting_headphones",
    "picking_up_cup",
    "scratching",
    "normal_wrist_rotation",
    "standing",
    "sitting",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSummary {
    pub id: String,
    pub original_filename: String,
    pub imported_at: String,
    pub label: String,
    pub row_count: usize,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatasetIndex {
    datasets: Vec<DatasetSummary>,
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

/// Validates a dataset CSV against the Milestone 9 export contract: optional
/// leading `#` metadata lines (one of which must be `# label: <value>`),
/// then the exact header row, then at least one data row with the right
/// column count. Returns `(label, row_count)` on success.
fn parse_csv(content: &str) -> Result<(String, usize), String> {
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

    for (offset, line) in data_lines.iter().enumerate() {
        let column_count = line.split(',').count();
        if column_count != DATASET_CSV_HEADER.len() {
            return Err(format!(
                "row {}: expected {} columns, got {column_count}",
                offset + 1,
                DATASET_CSV_HEADER.len(),
            ));
        }
    }

    let label = extract_label(&comment_lines).ok_or_else(|| {
        "missing '# label: <value>' metadata line required to import a dataset".to_string()
    })?;
    if !GESTURE_DATASET_LABELS.contains(&label.as_str()) {
        return Err(format!("unknown label '{label}'"));
    }

    Ok((label, data_lines.len()))
}

fn datasets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    Ok(base.join(MODEL_LAB_DIR_NAME).join(DATASETS_DIR_NAME))
}

fn dataset_csv_path(dir: &std::path::Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.csv"))
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(datasets_dir(app)?.join(INDEX_FILE_NAME))
}

fn load_index(app: &AppHandle) -> DatasetIndex {
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
    validate_filename(&filename)?;
    if csv_content.len() > MAX_DATASET_CSV_BYTES {
        return Err(format!(
            "dataset CSV exceeds the {MAX_DATASET_CSV_BYTES}-byte import limit (got {} bytes)",
            csv_content.len()
        ));
    }
    let (label, row_count) = parse_csv(&csv_content)?;

    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;

    let dir = datasets_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let id = loop {
        let candidate = Uuid::new_v4().to_string();
        if !dataset_csv_path(&dir, &candidate).exists() {
            break candidate;
        }
    };

    let csv_path = dataset_csv_path(&dir, &id);
    let tmp_path = csv_path.with_extension("csv.tmp");
    fs::write(&tmp_path, &csv_content).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &csv_path).map_err(|error| error.to_string())?;

    let summary = DatasetSummary {
        id,
        original_filename: filename,
        imported_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        label,
        row_count,
    };

    let mut index = load_index(&app);
    index.datasets.push(summary.clone());
    if let Err(error) = write_index_atomic(&app, &index) {
        let _ = fs::remove_file(&csv_path);
        return Err(error);
    }

    Ok(summary)
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
        let (label, row_count) = parse_csv(&valid_csv()).expect("valid CSV must parse");
        assert_eq!(label, "pinch_start");
        assert_eq!(row_count, 2);
    }

    #[test]
    fn rejects_empty_csv() {
        assert!(parse_csv("").is_err());
        assert!(parse_csv("   \n\n").is_err());
    }

    #[test]
    fn rejects_missing_label_metadata() {
        let csv = valid_csv().replace("# label: pinch_start\n", "");
        assert!(parse_csv(&csv).unwrap_err().contains("label"));
    }

    #[test]
    fn rejects_unknown_label() {
        let csv = valid_csv().replace("pinch_start", "not_a_real_label");
        let error = parse_csv(&csv).unwrap_err();
        assert!(error.contains("unknown label") || error.contains("header"));
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
