use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::warn;
use uuid::Uuid;

const DATASETS_DIR_NAME: &str = "datasets";
const MODELS_DIR_NAME: &str = "models";
const MODEL_LAB_DIR_NAME: &str = "model-lab";
const INDEX_FILE_NAME: &str = "index.json";
const MODEL_CARD_FILE_NAME: &str = "model_card.json";
const MAX_DATASET_CSV_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILENAME_LEN: usize = 255;
const METADATA_COMMENT_PREFIX: char = '#';

/// `model-lab-training-event` payload discriminant. This is a local
/// development runner, not a packaged sidecar: it shells out to
/// `uv run --project <repo>/tools/pinch-classifier pinch-classifier-train`,
/// so it only ever works against datasets already imported into the model
/// lab (never an arbitrary path from the webview) and requires `uv`
/// (https://docs.astral.sh/uv/) on PATH plus a full repository checkout.
pub const TRAINING_EVENT: &str = "model-lab-training-event";

/// Repo-relative path to the offline trainer package, resolved at compile
/// time from this crate's manifest directory (`apps/desktop/src-tauri`).
const PINCH_CLASSIFIER_PROJECT_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tools/pinch-classifier"
);

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

/// Current state of the single allowed training job. Mirrors the
/// `model-lab-training-event` "phase" a client would derive from the event
/// stream, so a client that (re)opens the tab mid-run can catch up via
/// `get_training_status` instead of only via live events.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum TrainingStatus {
    #[default]
    Idle,
    Running {
        job_id: String,
        dataset_ids: Vec<String>,
        started_at: String,
    },
    Completed {
        job_id: String,
        model_id: String,
        model_card: serde_json::Value,
    },
    Failed {
        job_id: String,
        message: String,
    },
}

/// Structured events emitted on [`TRAINING_EVENT`] over the lifetime of a
/// training job. `Log` lines are the trainer's own stdout/stderr, forwarded
/// verbatim as the only "progress" signal the CLI provides today.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TrainingEvent {
    Started {
        job_id: String,
        dataset_ids: Vec<String>,
    },
    Log {
        job_id: String,
        message: String,
    },
    Completed {
        job_id: String,
        model_id: String,
        model_card: serde_json::Value,
    },
    Failed {
        job_id: String,
        message: String,
    },
    Cancelled {
        job_id: String,
    },
}

fn emit_training_event(app: &AppHandle, event: &TrainingEvent) {
    if let Err(error) = app.emit(TRAINING_EVENT, event) {
        warn!(%error, "failed to emit model lab training event");
    }
}

/// A cancel handle for the one training job currently allowed to run.
/// Cancellation works by dropping/sending on `cancel_tx`, which wakes the
/// `tokio::select!` in [`run_training_job`] so it can kill the real child
/// process instead of merely flipping a flag no one reads.
struct ActiveJob {
    id: String,
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

/// Serializes writes to the on-disk dataset index/files so two concurrent
/// import/delete invocations from the UI never race each other, and tracks
/// the single training job (if any) currently running.
#[derive(Default)]
pub struct ModelLabRuntime {
    lock: Mutex<()>,
    status: Mutex<TrainingStatus>,
    active_job: Mutex<Option<ActiveJob>>,
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

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    Ok(base.join(MODEL_LAB_DIR_NAME).join(MODELS_DIR_NAME))
}

/// Resolves selected dataset ids against the on-disk index, in order,
/// de-duplicating repeats. Rejects anything that isn't a real, already
/// imported dataset id — this is the only thing that ever becomes a
/// `--input` path for the trainer, so the webview can never smuggle an
/// arbitrary filesystem path into the subprocess.
fn resolve_training_inputs(
    index: &DatasetIndex,
    datasets_dir: &std::path::Path,
    dataset_ids: &[String],
) -> Result<Vec<PathBuf>, String> {
    if dataset_ids.is_empty() {
        return Err("select at least one dataset".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut paths = Vec::with_capacity(dataset_ids.len());
    for id in dataset_ids {
        validate_dataset_id(id)?;
        if !seen.insert(id.clone()) {
            continue;
        }
        if !index.datasets.iter().any(|dataset| &dataset.id == id) {
            return Err(format!("no dataset with id '{id}'"));
        }
        paths.push(dataset_csv_path(datasets_dir, id));
    }
    Ok(paths)
}

fn read_model_card(output_dir: &std::path::Path) -> Result<serde_json::Value, String> {
    let path = output_dir.join(MODEL_CARD_FILE_NAME);
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read model card at {}: {error}", path.display()))?;
    serde_json::from_str(&contents).map_err(|error| format!("failed to parse model card: {error}"))
}

/// Best-effort scan of the models directory: each subdirectory is one
/// completed training run, named by model id, holding `model.joblib` and
/// `model_card.json`. Entries with an unreadable card are skipped (logged)
/// rather than failing the whole list.
fn read_trained_models(dir: &std::path::Path) -> Vec<TrainedModelSummary> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut models = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        match read_model_card(&path) {
            Ok(model_card) => models.push(TrainedModelSummary {
                id: id.to_string(),
                model_card,
            }),
            Err(error) => {
                warn!(%error, model_id = id, "skipping trained model with unreadable model card");
            }
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainedModelSummary {
    pub id: String,
    pub model_card: serde_json::Value,
}

fn spawn_output_forwarder<R>(app: AppHandle, job_id: String, pipe: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => emit_training_event(
                    &app,
                    &TrainingEvent::Log {
                        job_id: job_id.clone(),
                        message: line,
                    },
                ),
                Ok(None) | Err(_) => break,
            }
        }
    });
}

/// Owns the trainer subprocess for its whole lifetime: waits for it to exit
/// while racing a cancellation signal, reports the outcome as a
/// [`TrainingEvent`], and clears the runtime's job slot so a new run can
/// start. Fetches `ModelLabRuntime` fresh from `app` (rather than holding a
/// `State` across the spawn) because a Tauri `State` borrow does not outlive
/// the command call that produced it.
async fn run_training_job(
    app: AppHandle,
    job_id: String,
    model_id: String,
    output_dir: PathBuf,
    mut child: tokio::process::Child,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let event = tokio::select! {
        result = child.wait() => match result {
            Ok(status) if status.success() => match read_model_card(&output_dir) {
                Ok(model_card) => TrainingEvent::Completed {
                    job_id: job_id.clone(),
                    model_id: model_id.clone(),
                    model_card,
                },
                Err(error) => TrainingEvent::Failed {
                    job_id: job_id.clone(),
                    message: error,
                },
            },
            Ok(status) => TrainingEvent::Failed {
                job_id: job_id.clone(),
                message: format!("trainer exited with {status}"),
            },
            Err(error) => TrainingEvent::Failed {
                job_id: job_id.clone(),
                message: format!("failed to wait for trainer process: {error}"),
            },
        },
        _ = cancel_rx => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            TrainingEvent::Cancelled { job_id: job_id.clone() }
        }
    };

    let new_status = match &event {
        TrainingEvent::Completed {
            job_id,
            model_id,
            model_card,
        } => TrainingStatus::Completed {
            job_id: job_id.clone(),
            model_id: model_id.clone(),
            model_card: model_card.clone(),
        },
        TrainingEvent::Failed { job_id, message } => TrainingStatus::Failed {
            job_id: job_id.clone(),
            message: message.clone(),
        },
        TrainingEvent::Cancelled { .. }
        | TrainingEvent::Started { .. }
        | TrainingEvent::Log { .. } => TrainingStatus::Idle,
    };

    let runtime = app.state::<ModelLabRuntime>();
    if let Ok(mut active) = runtime.active_job.lock() {
        *active = None;
    }
    if let Ok(mut status) = runtime.status.lock() {
        *status = new_status;
    }

    emit_training_event(&app, &event);
}

/// Starts training on the given already-imported dataset ids. Only one job
/// may run at a time. Never accepts a file path or executable from the
/// webview: dataset ids are resolved to CSV paths under this app's own data
/// directory via [`resolve_training_inputs`], and the trainer is always the
/// fixed `pinch-classifier-train` console script inside
/// `tools/pinch-classifier`, run through `uv`.
#[tauri::command]
pub async fn start_training_job(
    dataset_ids: Vec<String>,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<String, String> {
    {
        let active = runtime
            .active_job
            .lock()
            .map_err(|_| "model lab lock was poisoned".to_string())?;
        if active.is_some() {
            return Err("a training job is already running".to_string());
        }
    }

    let index = load_index(&app);
    let datasets_dir = datasets_dir(&app)?;
    let input_paths = resolve_training_inputs(&index, &datasets_dir, &dataset_ids)?;

    let job_id = Uuid::new_v4().to_string();
    let model_id = Uuid::new_v4().to_string();
    let output_dir = models_dir(&app)?.join(&model_id);
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;

    let mut command = Command::new("uv");
    command
        .arg("run")
        .arg("--project")
        .arg(PINCH_CLASSIFIER_PROJECT_DIR)
        .arg("pinch-classifier-train")
        .arg("--input")
        .args(&input_paths)
        .arg("--output-dir")
        .arg(&output_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "failed to start the pinch-classifier trainer: {error}. This is a local \
             development runner, not a packaged app feature: install uv \
             (https://docs.astral.sh/uv/) and make sure it is on PATH."
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "trainer process has no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "trainer process has no stderr pipe".to_string())?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut active = runtime
            .active_job
            .lock()
            .map_err(|_| "model lab lock was poisoned".to_string())?;
        *active = Some(ActiveJob {
            id: job_id.clone(),
            cancel_tx: Some(cancel_tx),
        });
    }
    {
        let mut status = runtime
            .status
            .lock()
            .map_err(|_| "model lab lock was poisoned".to_string())?;
        *status = TrainingStatus::Running {
            job_id: job_id.clone(),
            dataset_ids: dataset_ids.clone(),
            started_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        };
    }
    emit_training_event(
        &app,
        &TrainingEvent::Started {
            job_id: job_id.clone(),
            dataset_ids,
        },
    );

    spawn_output_forwarder(app.clone(), job_id.clone(), stdout);
    spawn_output_forwarder(app.clone(), job_id.clone(), stderr);

    let job_id_for_task = job_id.clone();
    tauri::async_runtime::spawn(async move {
        run_training_job(app, job_id_for_task, model_id, output_dir, child, cancel_rx).await;
    });

    Ok(job_id)
}

/// Cancels the running job if (and only if) `job_id` matches it. This
/// really cancels: it wakes [`run_training_job`], which kills the actual
/// `uv` child process rather than just flipping UI state.
#[tauri::command]
pub fn cancel_training_job(
    job_id: String,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<(), String> {
    let mut active = runtime
        .active_job
        .lock()
        .map_err(|_| "model lab lock was poisoned".to_string())?;
    match active.as_mut() {
        Some(job) if job.id == job_id => match job.cancel_tx.take() {
            Some(tx) => {
                let _ = tx.send(());
                Ok(())
            }
            None => Err("cancellation already requested".to_string()),
        },
        Some(_) => Err("job id does not match the running job".to_string()),
        None => Err("no training job is running".to_string()),
    }
}

#[tauri::command]
pub fn get_training_status(runtime: State<'_, ModelLabRuntime>) -> Result<TrainingStatus, String> {
    runtime
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "model lab lock was poisoned".to_string())
}

#[tauri::command]
pub fn list_trained_models(app: AppHandle) -> Result<Vec<TrainedModelSummary>, String> {
    Ok(read_trained_models(&models_dir(&app)?))
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

    fn sample_index() -> DatasetIndex {
        DatasetIndex {
            datasets: vec![
                DatasetSummary {
                    id: "aaaaaaaa-0000-0000-0000-000000000001".to_string(),
                    original_filename: "session-1.csv".to_string(),
                    imported_at: "2026-08-31T00:00:00Z".to_string(),
                    label: "pinch_start".to_string(),
                    row_count: 10,
                },
                DatasetSummary {
                    id: "bbbbbbbb-0000-0000-0000-000000000002".to_string(),
                    original_filename: "session-2.csv".to_string(),
                    imported_at: "2026-08-31T00:00:00Z".to_string(),
                    label: "idle".to_string(),
                    row_count: 20,
                },
            ],
        }
    }

    #[test]
    fn resolve_training_inputs_rejects_empty_selection() {
        let index = sample_index();
        let dir = PathBuf::from("/tmp/model-lab-test/datasets");
        assert!(resolve_training_inputs(&index, &dir, &[]).is_err());
    }

    #[test]
    fn resolve_training_inputs_rejects_unknown_dataset_id() {
        let index = sample_index();
        let dir = PathBuf::from("/tmp/model-lab-test/datasets");
        let error =
            resolve_training_inputs(&index, &dir, &["not-a-real-id".to_string()]).unwrap_err();
        assert!(error.contains("no dataset"));
    }

    #[test]
    fn resolve_training_inputs_rejects_path_traversal_ids() {
        let index = sample_index();
        let dir = PathBuf::from("/tmp/model-lab-test/datasets");
        assert!(resolve_training_inputs(&index, &dir, &["../../etc/passwd".to_string()]).is_err());
    }

    #[test]
    fn resolve_training_inputs_maps_known_ids_to_csv_paths_and_dedupes() {
        let index = sample_index();
        let dir = PathBuf::from("/tmp/model-lab-test/datasets");
        let ids = vec![index.datasets[0].id.clone(), index.datasets[0].id.clone()];
        let paths = resolve_training_inputs(&index, &dir, &ids).expect("known ids must resolve");
        assert_eq!(paths, vec![dataset_csv_path(&dir, &index.datasets[0].id)]);
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("model-lab-test-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("must create temp dir");
        dir
    }

    #[test]
    fn read_model_card_parses_written_json() {
        let dir = unique_temp_dir("model-card");
        fs::write(dir.join(MODEL_CARD_FILE_NAME), r#"{"accuracy": 0.9}"#).unwrap();
        let card = read_model_card(&dir).expect("valid model card must parse");
        assert_eq!(card["accuracy"], 0.9);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_model_card_errors_when_missing() {
        let dir = unique_temp_dir("missing-card");
        assert!(read_model_card(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_trained_models_skips_unreadable_entries_and_sorts_by_id() {
        let root = unique_temp_dir("models-root");
        let good_a = root.join("b-model");
        let good_b = root.join("a-model");
        let bad = root.join("broken-model");
        fs::create_dir_all(&good_a).unwrap();
        fs::create_dir_all(&good_b).unwrap();
        fs::create_dir_all(&bad).unwrap();
        fs::write(good_a.join(MODEL_CARD_FILE_NAME), r#"{"accuracy": 0.5}"#).unwrap();
        fs::write(good_b.join(MODEL_CARD_FILE_NAME), r#"{"accuracy": 0.6}"#).unwrap();
        // `bad` has no model_card.json at all, so it must be skipped rather than failing the list.

        let models = read_trained_models(&root);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "a-model");
        assert_eq!(models[1].id, "b-model");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_trained_models_returns_empty_for_missing_directory() {
        let dir = std::env::temp_dir().join(format!("model-lab-test-missing-{}", Uuid::new_v4()));
        assert!(read_trained_models(&dir).is_empty());
    }
}
