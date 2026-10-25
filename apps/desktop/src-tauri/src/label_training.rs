//! Trains a label's PPG + IMU pinch-start model from recordings you imported.
//!
//! Everything that has to be recorded and cannot change afterwards is decided here, in Rust, and sealed in the model
//! registry before anything runs (see `label_inference::begin_run`): which recordings train and which test, and what each
//! label means. The model itself is fixed: it reads the pulse sensor through the multi-scale z-score derivatives and the
//! motion sensors through window summaries (`label_inference::pinch_start_contract`), is an ExtraTrees ensemble, and
//! detects on the top of its score's climb (the peak trigger). The trainer (`tools/label-trainer`, run with
//! `uv`) is only told what to do, trains, tests on the recordings held out for it, and writes a bundle. The bundle then goes
//! through the same validation as an imported one and is recorded as a Draft that came from this run: a deployable one,
//! or, when it did not pass the checks for going live, a monitor-only one, which can run but never act. Nothing is
//! approved or activated by training.
//!
//! Training is a development workflow: it needs `uv` on the PATH and a repository checkout. Running a model needs
//! neither.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use label_inference::{
    RecordingInfo, RunPlan, begin_run, complete_run, fail_run, monitor_only_run,
    pinch_start_contract, plan_split, stage_bundle, trainer_backend,
};
use model_lab_core::{
    ArtifactRef, ExampleRole, InputContract, LabelId, LabelMapping, QualityRules, RecordingId,
    RunId, TrainerConfig,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::warn;
use uuid::Uuid;

use crate::dataset_files;
use crate::label_runtime::LabelRuntimeHost;
use crate::model_lab::{
    DatasetSummary, MODEL_LAB_DIR_NAME, dataset_csv_path, dataset_sha, datasets_dir, load_index,
};

pub const LABEL_TRAINING_EVENT: &str = "label-training-event";
const RUNS_DIR: &str = "training-runs";
const TRAINER_PROJECT_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tools/label-trainer");
const SPEC_VERSION: u32 = 1;
/// How far the labels may be moved in time, in milliseconds either way (the trainer's `MAX_LABEL_OFFSET_MS`).
const MAX_LABEL_OFFSET_MS: i32 = 1500;
/// The one model the app trains (the trainer's `BACKEND`).
pub(crate) const BACKEND: &str = "ppg-onset-trees";
/// The trees' seed (the research's).
const SEED: u32 = 17;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainRequest {
    /// The label to train a model for.
    pub label: String,
    pub dataset_ids: Vec<String>,
    /// Labels in those recordings that count as "not the target".
    pub negatives: Vec<String>,
    /// Labels in those recordings to leave out entirely.
    pub excludes: Vec<String>,
    /// Also retrain on less data and on all but one recording, to see how far the score can be trusted. Slower.
    #[serde(default)]
    pub research: bool,
    /// Moves the labels later in time by this many milliseconds (earlier when negative), for when the camera marked a hold
    /// a little before or after the signal showed it. From -1500 to 1500; absent or 0 leaves them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_offset_ms: Option<i32>,
}

/// A request checked against the recordings it names.
#[derive(Debug)]
struct Checked {
    target: LabelId,
    mapping: LabelMapping,
    input: InputContract,
    recordings: Vec<RecordingInfo>,
    research: bool,
    label_offset_ms: i32,
}

fn label_id(raw: &str) -> Result<LabelId, String> {
    LabelId::new(raw).map_err(|e| e.to_string())
}

/// Checks the request and turns it into the sealed decisions. `sha_of` reads a recording's SHA-256.
fn check_request(
    request: &TrainRequest,
    datasets: &[DatasetSummary],
    sha_of: &dyn Fn(&str) -> Result<String, String>,
) -> Result<Checked, String> {
    let target = label_id(&request.label)?;
    let negatives: Vec<LabelId> = request
        .negatives
        .iter()
        .map(|l| label_id(l))
        .collect::<Result<_, _>>()?;
    let excludes: Vec<LabelId> = request
        .excludes
        .iter()
        .map(|l| label_id(l))
        .collect::<Result<_, _>>()?;
    let mut entries: BTreeMap<LabelId, ExampleRole> = BTreeMap::new();
    entries.insert(target.clone(), ExampleRole::Positive);
    for (labels, role) in [
        (&negatives, ExampleRole::Negative),
        (&excludes, ExampleRole::Exclude),
    ] {
        for label in labels {
            if entries.insert(label.clone(), role).is_some() {
                return Err(format!(
                    "'{label}' is given more than one role (it is the target, a negative or excluded)"
                ));
            }
        }
    }
    let mut seen = BTreeSet::new();
    let mut recordings = Vec::new();
    for id in &request.dataset_ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let dataset = datasets
            .iter()
            .find(|d| &d.id == id)
            .ok_or_else(|| format!("there is no recording with id '{id}'"))?;
        if dataset.sealed {
            return Err(format!(
                "'{}' is sealed for the final test, so it cannot be trained on. Leave it out, or unseal it in Model Lab (it then stops being an untouched test)",
                dataset.original_filename
            ));
        }
        recordings.push(RecordingInfo {
            id: RecordingId::new(id.clone()).map_err(|e| e.to_string())?,
            sha256: sha_of(id)?,
            labels: dataset
                .effective_labels()
                .iter()
                .map(|l| label_id(l))
                .collect::<Result<_, _>>()?,
        });
    }
    // Two copies of the same data could land one in training and one in the test, which then measures nothing.
    let chosen: Vec<&DatasetSummary> = seen.iter().filter_map(|id| datasets.iter().find(|d| &d.id == id)).collect();
    for (i, a) in chosen.iter().enumerate() {
        if let Some(b) = chosen[i + 1..].iter().find(|b| a.content_sha.is_some() && b.content_sha == a.content_sha) {
            return Err(format!(
                "'{}' and '{}' hold the same data: leave one out (or delete it in Model Lab), or one could be trained on and the other tested on",
                a.original_filename, b.original_filename
            ));
        }
    }
    if recordings.is_empty() {
        return Err("choose at least one recording".into());
    }
    // A stretch left out on the Labelling page is never trained on, whatever the request says of it.
    let left_out = label_id(dataset_files::LEFT_OUT_LABEL)?;
    if recordings.iter().any(|r| r.labels.contains(&left_out)) {
        match entries.get(&left_out) {
            None | Some(ExampleRole::Exclude) => {
                entries.insert(left_out, ExampleRole::Exclude);
            }
            Some(_) => return Err(format!("'{}' marks stretches left out, so it can only be excluded", dataset_files::LEFT_OUT_LABEL)),
        }
    }
    let label_offset_ms = request.label_offset_ms.unwrap_or(0);
    if label_offset_ms.abs() > MAX_LABEL_OFFSET_MS {
        return Err(format!(
            "the label offset must be from -{MAX_LABEL_OFFSET_MS} to {MAX_LABEL_OFFSET_MS} milliseconds, got {label_offset_ms}"
        ));
    }
    Ok(Checked {
        target,
        mapping: LabelMapping { entries },
        input: pinch_start_contract(),
        recordings,
        research: request.research,
        label_offset_ms,
    })
}

/// The spec the trainer reads. Everything in it was decided (and, for the split, sealed) before the trainer started.
fn build_spec(
    checked: &Checked,
    split: &model_lab_core::Split,
    paths: &BTreeMap<String, PathBuf>,
) -> serde_json::Value {
    let ids = |list: &[RecordingId]| list.iter().map(ToString::to_string).collect::<Vec<_>>();
    let labels_with = |role: ExampleRole| {
        checked
            .mapping
            .entries
            .iter()
            .filter(|(_, r)| **r == role)
            .map(|(l, _)| l.to_string())
            .collect::<Vec<_>>()
    };
    serde_json::json!({
        "version": SPEC_VERSION,
        "target": checked.target.to_string(),
        "negatives": labels_with(ExampleRole::Negative),
        "excludes": labels_with(ExampleRole::Exclude),
        "recordings": paths,
        "train": ids(&split.train),
        "evaluation": ids(&split.evaluation),
        "sources": checked.input.sources,
        "backend": BACKEND,
        "seed": SEED,
        "research": checked.research,
        "labelOffsetMs": checked.label_offset_ms,
    })
}

fn sha256_of_file(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| model_lab_core::sha256_hex(&bytes))
        .map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// Only what a person needs to see about a plan before training.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub train: Vec<String>,
    pub evaluation: Vec<String>,
    /// Why this cannot be trained, in words; `None` when it can.
    pub problem: Option<String>,
    /// How many inputs the model reads (always the PPG pinch-start features).
    pub inputs: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TrainingEvent {
    Started {
        run_id: String,
        label: String,
        backend: String,
    },
    Log {
        run_id: String,
        message: String,
    },
    Finished {
        run_id: String,
        label: String,
        /// `deployable`, `monitorOnly` (trained, but it may only run in Monitor), `failed` or `cancelled`.
        outcome: String,
        message: String,
        version_id: Option<String>,
        metrics: Option<serde_json::Value>,
    },
}

fn emit(app: &AppHandle, event: &TrainingEvent) {
    if let Err(error) = app.emit(LABEL_TRAINING_EVENT, event) {
        warn!(%error, "failed to emit a training event");
    }
}

struct ActiveJob {
    run_id: String,
    label: String,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct LabelTrainingRuntime {
    active: Mutex<Option<ActiveJob>>,
    /// How the last run ended, so a view opened afterwards can show it.
    last: Mutex<Option<TrainingEvent>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingStatusView {
    pub running: Option<RunningView>,
    pub last: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningView {
    pub run_id: String,
    pub label: String,
}

pub(crate) fn runs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|base| base.join(MODEL_LAB_DIR_NAME).join(RUNS_DIR))
        .map_err(|e| e.to_string())
}

fn model_lab_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|base| base.join(MODEL_LAB_DIR_NAME))
        .map_err(|e| e.to_string())
}

fn recordings_for(app: &AppHandle, request: &TrainRequest) -> Result<Checked, String> {
    let index = load_index(app);
    let dir = datasets_dir(app)?;
    check_request(request, &index.datasets, &|id| {
        dataset_sha(&dataset_csv_path(&dir, id))
    })
}

fn trainer_command() -> Command {
    let mut command = Command::new("uv");
    command.args(["run", "--project", TRAINER_PROJECT_DIR, "label-classifier-train"]);
    command
}

/// How well the recordings separate the gesture's starts from the rest when the labels are moved to each of a range of
/// offsets.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OffsetScore {
    pub offset_ms: i32,
    /// ROC AUC over every recording judged by a model that never saw it; absent when it could not be worked out.
    pub auc: Option<f64>,
    pub windows: u32,
    pub positives: u32,
}

/// The trainer's last line of output about a timing check, as the scores or the reason it could not be done.
pub fn offsets_from(line: Option<&str>) -> Result<Vec<OffsetScore>, String> {
    let parsed: serde_json::Value = line
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or("the trainer gave no answer")?;
    if parsed.get("outcome").and_then(serde_json::Value::as_str) != Some("ok") {
        return Err(parsed
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the trainer could not check the timing")
            .to_string());
    }
    let scores = parsed
        .get("scores")
        .and_then(serde_json::Value::as_array)
        .ok_or("the trainer gave no scores")?;
    scores
        .iter()
        .map(|s| {
            Ok(OffsetScore {
                offset_ms: s["offsetMs"].as_i64().ok_or("a score has no offset")? as i32,
                auc: s["auc"].as_f64(),
                windows: s["windows"].as_u64().unwrap_or(0) as u32,
                positives: s["positives"].as_u64().unwrap_or(0) as u32,
            })
        })
        .collect()
}

/// Tries moving the labels to a range of offsets and says how well the chosen recordings separate the gesture's starts from
/// the rest at each, judged on recordings left out. Nothing is recorded or trained.
#[tauri::command]
pub async fn suggest_label_offset(
    app: AppHandle,
    request: TrainRequest,
) -> Result<Vec<OffsetScore>, String> {
    let checked = recordings_for(&app, &request)?;
    let split = plan_split(&checked.recordings, &checked.mapping, &checked.target)
        .map_err(|e| e.to_string())?;
    if !Path::new(TRAINER_PROJECT_DIR)
        .join("pyproject.toml")
        .is_file()
    {
        return Err("the trainer was not found, so the timing cannot be checked here".into());
    }
    let data = datasets_dir(&app)?;
    let paths: BTreeMap<String, PathBuf> = checked
        .recordings
        .iter()
        .map(|r| (r.id.to_string(), dataset_csv_path(&data, r.id.as_str())))
        .collect();
    let mut spec = build_spec(&checked, &split, &paths);
    spec["labelOffsetMs"] = serde_json::json!(0);
    let work = runs_dir(&app)?.join(format!(".timing-{}", Uuid::new_v4().simple()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let spec_path = work.join("spec.json");
    let done = async {
        fs::write(&spec_path, serde_json::to_vec(&spec).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let output = trainer_command()
            .arg("--suggest-offset")
            .arg("--spec")
            .arg(&spec_path)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| format!("could not start the trainer: {e}. It needs uv (https://docs.astral.sh/uv/) on the PATH"))?;
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        offsets_from(text.lines().rev().find(|l| !l.trim().is_empty()))
    }
    .await;
    let _ = fs::remove_dir_all(&work);
    done
}

/// Says how a request would be split, or why it cannot be, without recording or starting anything.
#[tauri::command]
pub fn plan_label_training(app: AppHandle, request: TrainRequest) -> PlanView {
    let inputs = pinch_start_contract().features.len();
    let result = recordings_for(&app, &request).and_then(|checked| {
        plan_split(&checked.recordings, &checked.mapping, &checked.target)
            .map_err(|e| e.to_string())
    });
    match result {
        Ok(split) => PlanView {
            train: split.train.iter().map(ToString::to_string).collect(),
            evaluation: split.evaluation.iter().map(ToString::to_string).collect(),
            problem: None,
            inputs,
        },
        Err(problem) => PlanView {
            train: Vec::new(),
            evaluation: Vec::new(),
            problem: Some(problem),
            inputs,
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainerEnvironment {
    pub available: bool,
    pub detail: String,
}

/// Whether training can run here. Using a model never needs this.
#[tauri::command]
pub async fn check_label_trainer() -> TrainerEnvironment {
    if !Path::new(TRAINER_PROJECT_DIR)
        .join("pyproject.toml")
        .is_file()
    {
        return TrainerEnvironment {
            available: false,
            detail: "The trainer project is missing from this checkout (tools/label-trainer)."
                .into(),
        };
    }
    match Command::new("uv").arg("--version").output().await {
        Ok(output) if output.status.success() => TrainerEnvironment {
            available: true,
            detail: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        },
        _ => TrainerEnvironment {
            available: false,
            detail: "Training needs uv (https://docs.astral.sh/uv/) on the PATH. Models you import or have trained already run without it.".into(),
        },
    }
}

fn spawn_forwarder<R>(app: AppHandle, run_id: String, pipe: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit(
                &app,
                &TrainingEvent::Log {
                    run_id: run_id.clone(),
                    message: line,
                },
            );
        }
    });
}

/// Starts training. Records the sealed plan first (so a run that cannot be started leaves no trace), then runs the
/// trainer in the background and reports through `label-training-event`. One run at a time.
#[tauri::command]
pub async fn start_label_training(
    app: AppHandle,
    runtime: State<'_, LabelTrainingRuntime>,
    host: State<'_, LabelRuntimeHost>,
    request: TrainRequest,
) -> Result<String, String> {
    {
        let active = runtime
            .active
            .lock()
            .map_err(|_| "training state is unavailable")?;
        if active.is_some() {
            return Err("a model is already being trained".into());
        }
    }
    let checked = recordings_for(&app, &request)?;
    let known: BTreeSet<LabelId> = crate::label_registry::catalogue_ids(&app)
        .iter()
        .filter_map(|l| LabelId::new(l.as_str()).ok())
        .collect();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let unique = Uuid::new_v4().simple().to_string()[..10].to_string();
    let plan = RunPlan {
        target: checked.target.clone(),
        mapping: checked.mapping.clone(),
        input: checked.input.clone(),
        quality: QualityRules::default(),
        trainer: TrainerConfig {
            backend: trainer_backend(BACKEND).ok_or("unknown training method")?,
            // What else shaped the run, so the training history can say what changed from one run to the next.
            params: BTreeMap::from([
                ("method".to_string(), serde_json::Value::String(BACKEND.into())),
                ("labelOffsetMs".to_string(), serde_json::Value::from(checked.label_offset_ms)),
                ("research".to_string(), serde_json::Value::Bool(checked.research)),
            ]),
        },
        recordings: checked.recordings.clone(),
        train_only: Vec::new(),
        unique,
    };
    let begun =
        host.with_store(|store| begin_run(store, &plan, &known, &now).map_err(|e| e.to_string()))?;
    LabelRuntimeHost::announce_models_changed(&app);
    let run_id = begun.run_id.to_string();

    // From here a failure must be recorded against the run, not just returned.
    let setup = (|| -> Result<(PathBuf, PathBuf), String> {
        let out = runs_dir(&app)?.join(&run_id);
        fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let dir = datasets_dir(&app)?;
        let paths: BTreeMap<String, PathBuf> = checked
            .recordings
            .iter()
            .map(|r| (r.id.to_string(), dataset_csv_path(&dir, r.id.as_str())))
            .collect();
        let spec = build_spec(&checked, &begun.split, &paths);
        // Kept so this model can be trained again from the same recordings and roles.
        fs::write(
            out.join("request.json"),
            serde_json::to_vec_pretty(&request).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let spec_path = out.join("spec.json");
        fs::write(
            &spec_path,
            serde_json::to_vec_pretty(&spec).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok((out, spec_path))
    })();
    let (out, spec_path) = match setup {
        Ok(paths) => paths,
        Err(message) => {
            record_failure(&app, &begun.run_id, &message);
            return Err(message);
        }
    };

    let mut command = trainer_command();
    command
        .arg("--spec")
        .arg(&spec_path)
        .arg("--out")
        .arg(&out)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!(
                "could not start the trainer: {error}. Training needs uv (https://docs.astral.sh/uv/) on the PATH"
            );
            record_failure(&app, &begun.run_id, &message);
            return Err(message);
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    if let Ok(mut active) = runtime.active.lock() {
        *active = Some(ActiveJob {
            run_id: run_id.clone(),
            label: checked.target.to_string(),
            cancel: Some(cancel_tx),
        });
    }
    emit(
        &app,
        &TrainingEvent::Started {
            run_id: run_id.clone(),
            label: checked.target.to_string(),
            backend: BACKEND.into(),
        },
    );
    if let Some(pipe) = stdout {
        spawn_forwarder(app.clone(), run_id.clone(), pipe);
    }
    if let Some(pipe) = stderr {
        spawn_forwarder(app.clone(), run_id.clone(), pipe);
    }

    let task_app = app.clone();
    let features = checked.input.features.clone();
    let target = checked.target.clone();
    let task_run = begun.run_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = tokio::select! {
            status = child.wait() => match status {
                Ok(status) if status.success() => Ok(()),
                Ok(status) => Err(format!("the trainer stopped with {status}")),
                Err(error) => Err(format!("could not wait for the trainer: {error}")),
            },
            _ = cancel_rx => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Err("cancelled".to_string())
            }
        };
        let event = finish(&task_app, &task_run, &target, &features, &out, outcome);
        if let Some(runtime) = task_app.try_state::<LabelTrainingRuntime>() {
            if let Ok(mut active) = runtime.active.lock() {
                *active = None;
            }
            if let Ok(mut last) = runtime.last.lock() {
                *last = Some(event.clone());
            }
        }
        emit(&task_app, &event);
        LabelRuntimeHost::announce_models_changed(&task_app);
    });
    Ok(run_id)
}

fn record_failure(app: &AppHandle, run_id: &RunId, message: &str) {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let host = app.state::<LabelRuntimeHost>();
    if let Err(error) =
        host.with_store(|store| fail_run(store, run_id, message, &now).map_err(|e| e.to_string()))
    {
        warn!(%error, "could not record a failed training run");
    }
    LabelRuntimeHost::announce_models_changed(app);
}

/// Reads what the trainer wrote and records the end of the run. Whatever happened, the run is left finished.
fn finish(
    app: &AppHandle,
    run_id: &RunId,
    target: &LabelId,
    expected_features: &[String],
    out: &Path,
    exit: Result<(), String>,
) -> TrainingEvent {
    let id = run_id.to_string();
    let label = target.to_string();
    let failed = |outcome: &str, message: String| {
        record_failure(app, run_id, &message);
        TrainingEvent::Finished {
            run_id: id.clone(),
            label: label.clone(),
            outcome: outcome.into(),
            message,
            version_id: None,
            metrics: None,
        }
    };
    if let Err(message) = &exit
        && message == "cancelled"
    {
        return failed("cancelled", "You cancelled the training.".into());
    }
    let result: serde_json::Value = match fs::read(out.join("result.json"))
        .map_err(|e| e.to_string())
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
    {
        Ok(result) => result,
        Err(_) => {
            return failed(
                "failed",
                exit.err()
                    .unwrap_or_else(|| "the trainer left no result".into()),
            );
        }
    };
    let deployable = match result["outcome"].as_str() {
        Some("deployable") => true,
        Some("evaluationOnly") => false,
        _ => {
            let message = result["message"]
                .as_str()
                .unwrap_or("the trainer gave no reason")
                .to_string();
            return failed("failed", message);
        }
    };
    let message = result["message"].as_str().unwrap_or_default().to_string();
    let published = (|| -> Result<String, String> {
        let lab = model_lab_dir(app)?;
        let staged = stage_bundle(&out.join("bundle"), &lab).map_err(|e| e.to_string())?;
        if staged.label() != target {
            return Err("the trainer wrote a model for a different label".into());
        }
        if staged.manifest.input.features != expected_features {
            return Err("the trainer used a different set of features than was planned".into());
        }
        let run_dir = format!("{RUNS_DIR}/{run_id}");
        let mut artifacts = vec![ArtifactRef {
            kind: "model".into(),
            path: format!("{run_dir}/bundle/model.trees"),
            sha256: staged.model_sha256.clone(),
        }];
        for (kind, file) in [
            ("manifest", "bundle/manifest.json"),
            ("evaluation", "evaluation.json"),
            ("parity", "parity.json"),
            ("inspection", "inspection.json"),
        ] {
            if let Ok(hash) = sha256_of_file(&out.join(file)) {
                artifacts.push(ArtifactRef {
                    kind: kind.into(),
                    path: format!("{run_dir}/{file}"),
                    sha256: hash,
                });
            }
        }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let host = app.state::<LabelRuntimeHost>();
        let outcome = host.with_store(|store| {
            if deployable {
                complete_run(store, staged, &lab, run_id, artifacts, &now)
            } else {
                monitor_only_run(store, staged, &lab, run_id, &message, artifacts, &now)
            }
            .map_err(|e| e.to_string())
        })?;
        Ok(outcome.version_id.to_string())
    })();
    match published {
        Ok(version) => TrainingEvent::Finished {
            run_id: id,
            label,
            outcome: if deployable { "deployable" } else { "monitorOnly" }.into(),
            message,
            version_id: Some(version),
            metrics: Some(result["metrics"].clone()),
        },
        Err(message) => failed("failed", message),
    }
}

#[tauri::command]
pub fn cancel_label_training(runtime: State<'_, LabelTrainingRuntime>) -> Result<(), String> {
    let mut active = runtime
        .active
        .lock()
        .map_err(|_| "training state is unavailable")?;
    match active.as_mut().and_then(|job| job.cancel.take()) {
        Some(cancel) => {
            let _ = cancel.send(());
            Ok(())
        }
        None => Err("no model is being trained".into()),
    }
}

#[tauri::command]
pub fn get_label_training_status(runtime: State<'_, LabelTrainingRuntime>) -> TrainingStatusView {
    let running = runtime.active.lock().ok().and_then(|active| {
        active.as_ref().map(|job| RunningView {
            run_id: job.run_id.clone(),
            label: job.label.clone(),
        })
    });
    let last = runtime.last.lock().ok().and_then(|last| {
        last.as_ref()
            .and_then(|event| serde_json::to_value(event).ok())
    });
    TrainingStatusView { running, last }
}

#[cfg(test)]
mod tests {
    use super::*;
    use model_lab_core::StreamSource;

    fn dataset(id: &str, labels: &[&str]) -> DatasetSummary {
        DatasetSummary {
            id: id.into(),
            original_filename: format!("{id}.csv"),
            imported_at: "2026-10-01".into(),
            label: labels.join(", "),
            labels: labels.iter().map(ToString::to_string).collect(),
            row_count: 100,
            sequence: 0,
            two_files: false,
            gaps: None,
            source_recording_id: None,
            derived_from: None,
            context: Default::default(),
            sealed: false,
            content_sha: None,
            quality: None,
            review: None,
        }
    }

    fn request() -> TrainRequest {
        TrainRequest {
            label: "pinch".into(),
            dataset_ids: ["s1", "s2", "s3", "i1", "i2", "i3"]
                .map(String::from)
                .to_vec(),
            negatives: vec!["fist".into()],
            excludes: vec![],
            research: false,
            label_offset_ms: None,
        }
    }

    fn datasets() -> Vec<DatasetSummary> {
        ["s1", "s2", "s3"]
            .iter()
            .map(|id| dataset(id, &["pinch"]))
            .chain(["i1", "i2", "i3"].iter().map(|id| dataset(id, &["fist"])))
            .collect()
    }

    fn sha(id: &str) -> Result<String, String> {
        Ok(model_lab_core::sha256_hex(id.as_bytes()))
    }

    #[test]
    fn a_request_becomes_explicit_roles_and_the_pulse_models_fixed_contract() {
        let checked = check_request(&request(), &datasets(), &sha).unwrap();
        assert_eq!(
            checked.mapping.entries[&LabelId::new("pinch").unwrap()],
            ExampleRole::Positive
        );
        assert_eq!(
            checked.mapping.entries[&LabelId::new("fist").unwrap()],
            ExampleRole::Negative
        );
        assert_eq!(checked.input, pinch_start_contract());
        assert_eq!(
            checked.input.sources,
            [StreamSource::WatchPpg, StreamSource::WatchOrientation]
        );
        assert_eq!(checked.recordings.len(), 6);
    }

    #[test]
    fn it_refuses_what_cannot_be_trained_and_says_why() {
        let data = datasets();
        let refuse = |change: &dyn Fn(&mut TrainRequest)| {
            let mut r = request();
            change(&mut r);
            check_request(&r, &data, &sha).unwrap_err()
        };
        assert!(refuse(&|r| r.label = "Bad Label".into()).contains("label id"));
        assert!(refuse(&|r| r.negatives.push("pinch".into())).contains("more than one role"));
        assert!(refuse(&|r| r.dataset_ids.push("nope".into())).contains("no recording"));
        assert!(refuse(&|r| r.dataset_ids.clear()).contains("at least one recording"));
        assert!(refuse(&|r| r.label_offset_ms = Some(1501)).contains("label offset"));
        let unreadable = check_request(&request(), &data, &|_| Err("gone".into())).unwrap_err();
        assert_eq!(unreadable, "gone");
    }

    #[test]
    fn a_sealed_recording_is_never_trained_on() {
        let mut data = datasets();
        data[0].sealed = true;
        let refused = check_request(&request(), &data, &sha).unwrap_err();
        assert!(refused.contains("sealed for the final test"), "{refused}");
    }

    #[test]
    fn two_recordings_with_the_same_data_are_not_trained_on_together() {
        let mut data = datasets();
        data[0].content_sha = Some("same".into());
        data[1].content_sha = Some("same".into());
        let refused = check_request(&request(), &data, &sha).unwrap_err();
        assert!(refused.contains("hold the same data"), "{refused}");
    }

    #[test]
    fn stretches_left_out_are_always_excluded() {
        let mut data = datasets();
        data[0].labels.push(dataset_files::LEFT_OUT_LABEL.into());
        let checked = check_request(&request(), &data, &sha).unwrap();
        assert_eq!(checked.mapping.entries[&LabelId::new("left_out").unwrap()], ExampleRole::Exclude);
        let mut r = request();
        r.negatives.push("left_out".into());
        assert!(check_request(&r, &data, &sha).unwrap_err().contains("can only be excluded"));
        // With none left out, nothing is added.
        assert!(!check_request(&request(), &datasets(), &sha).unwrap().mapping.entries.contains_key(&LabelId::new("left_out").unwrap()));
    }

    #[test]
    fn a_recording_listed_twice_counts_once() {
        let mut r = request();
        r.dataset_ids.push("s1".into());
        assert_eq!(check_request(&r, &datasets(), &sha).unwrap().recordings.len(), 6);
    }

    #[test]
    fn the_spec_carries_the_sealed_split_roles_and_the_one_backend_for_the_trainer() {
        let mut r = request();
        r.label_offset_ms = Some(-250);
        r.research = true;
        let checked = check_request(&r, &datasets(), &sha).unwrap();
        let split = plan_split(&checked.recordings, &checked.mapping, &checked.target).unwrap();
        let paths: BTreeMap<String, PathBuf> = checked
            .recordings
            .iter()
            .map(|r| (r.id.to_string(), PathBuf::from(format!("/data/{}.csv", r.id))))
            .collect();
        let spec = build_spec(&checked, &split, &paths);
        assert_eq!(spec["version"], 1);
        assert_eq!(spec["target"], "pinch");
        assert_eq!(spec["negatives"], serde_json::json!(["fist"]));
        assert_eq!(
            spec["sources"],
            serde_json::json!(["watchPpg", "watchOrientation"])
        );
        assert_eq!(spec["backend"], BACKEND);
        assert_eq!((spec["labelOffsetMs"].as_i64(), spec["research"].as_bool()), (Some(-250), Some(true)));
        let listed = |key: &str| spec[key].as_array().unwrap().len();
        assert_eq!(listed("train") + listed("evaluation"), 6);
        assert_eq!(spec["recordings"]["s1"], "/data/s1.csv");
    }

    #[test]
    fn the_trainers_timing_scores_become_the_numbers_shown_and_a_refusal_becomes_its_reason() {
        let line = r#"{"outcome":"ok","scores":[{"offsetMs":0,"auc":0.8,"windows":900,"positives":500},{"offsetMs":250,"auc":null,"windows":0,"positives":0}]}"#;
        let scores = offsets_from(Some(line)).unwrap();
        assert_eq!((scores[0].offset_ms, scores[0].auc, scores[0].windows), (0, Some(0.8), 900));
        assert_eq!(scores[1].auc, None);
        let refused = offsets_from(Some(r#"{"outcome":"refused","message":"too few recordings"}"#)).unwrap_err();
        assert_eq!(refused, "too few recordings");
        assert!(offsets_from(None).is_err() && offsets_from(Some("not json")).is_err());
    }
}
