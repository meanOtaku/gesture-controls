//! Trains a model for one label from recordings you imported.
//!
//! Everything that has to be recorded and cannot change afterwards is decided here, in Rust, and sealed in the model
//! registry before anything runs (see `label_inference::begin_run`): which recordings train and which test, what each
//! label means, which streams the model may read, and the window. The trainer (`tools/label-trainer`, run with `uv`)
//! is only told what to do, trains, tests on the recordings held out for it, and writes a bundle. The bundle then goes
//! through the same validation as an imported one and is recorded as a Draft that came from this run. Nothing is
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
    RecordingInfo, RunPlan, begin_run, canonical_features_for, complete_run, evaluation_only_run,
    fail_run, plan_split, stage_bundle, trainer_backend,
};
use model_lab_core::{
    ArtifactRef, ExampleRole, InputContract, LabelId, LabelMapping, QualityRules, RecordingId,
    RunId, StreamSource, TrainerConfig,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::warn;
use uuid::Uuid;

use crate::label_runtime::LabelRuntimeHost;
use crate::model_lab::{
    DatasetSummary, MODEL_LAB_DIR_NAME, dataset_csv_path, datasets_dir, load_index,
};

pub const LABEL_TRAINING_EVENT: &str = "label-training-event";
const RUNS_DIR: &str = "training-runs";
const TRAINER_PROJECT_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tools/label-trainer");
const SPEC_VERSION: u32 = 1;

/// The backends offered, which extra packages the trainer needs for each.
const BACKENDS: [&str; 3] = ["logreg", "mlp", "torch-mlp"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainRequest {
    /// The label to train a model for.
    pub label: String,
    pub dataset_ids: Vec<String>,
    /// Labels in those recordings that count as "not the target".
    pub negatives: Vec<String>,
    /// Labels in those recordings to leave out entirely.
    pub excludes: Vec<String>,
    pub backend: String,
    pub sources: Vec<StreamSource>,
    #[serde(default = "default_window_ms")]
    pub window_ms: u32,
    #[serde(default = "default_stride_ms")]
    pub stride_ms: u32,
    #[serde(default = "default_max_gap_ms")]
    pub max_gap_ms: u32,
    #[serde(default = "default_min_samples")]
    pub min_samples: u32,
    #[serde(default)]
    pub seed: Option<u32>,
    /// Only features about how things change, not their absolute levels (see `is_movement_feature`).
    #[serde(default)]
    pub movement_only: bool,
}

fn default_window_ms() -> u32 {
    500
}
fn default_stride_ms() -> u32 {
    150
}
fn default_max_gap_ms() -> u32 {
    250
}
fn default_min_samples() -> u32 {
    3
}

/// A request checked against the recordings it names.
#[derive(Debug)]
struct Checked {
    target: LabelId,
    mapping: LabelMapping,
    input: InputContract,
    recordings: Vec<RecordingInfo>,
    backend: String,
    seed: u32,
    movement_only: bool,
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
    if !BACKENDS.contains(&request.backend.as_str()) {
        return Err(format!(
            "unknown training method '{}'; choose one of {BACKENDS:?}",
            request.backend
        ));
    }
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
    if recordings.is_empty() {
        return Err("choose at least one recording".into());
    }
    let mut sources = request.sources.clone();
    sources.sort_by_key(|s| format!("{s:?}"));
    sources.dedup();
    if sources.is_empty() {
        return Err("choose at least one data stream for the model to read".into());
    }
    let features = canonical_features_for(&sources, request.movement_only);
    if features.is_empty() {
        return Err("none of the chosen data streams can feed a model (head pose is not available to trained models)".into());
    }
    let input = InputContract {
        sources,
        features,
        window_ms: request.window_ms,
        stride_ms: request.stride_ms,
        max_gap_ms: request.max_gap_ms,
        min_samples: request.min_samples,
    };
    input.validate().map_err(|e| e.to_string())?;
    Ok(Checked {
        target,
        mapping: LabelMapping { entries },
        input,
        recordings,
        backend: request.backend.clone(),
        seed: request.seed.unwrap_or(7),
        movement_only: request.movement_only,
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
        "window": {
            "windowMs": checked.input.window_ms,
            "strideMs": checked.input.stride_ms,
            "maxGapMs": checked.input.max_gap_ms,
            "minSamples": checked.input.min_samples,
        },
        "backend": checked.backend,
        "seed": checked.seed,
        "movementOnly": checked.movement_only,
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
        /// `deployable`, `evaluationOnly` (trained, but not worth keeping), `failed` or `cancelled`.
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

fn runs_dir(app: &AppHandle) -> Result<PathBuf, String> {
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
        sha256_of_file(&dataset_csv_path(&dir, id))
    })
}

/// Says how a request would be split, or why it cannot be, without recording or starting anything.
#[tauri::command]
pub fn plan_label_training(app: AppHandle, request: TrainRequest) -> PlanView {
    let result = recordings_for(&app, &request).and_then(|checked| {
        plan_split(&checked.recordings, &checked.mapping, &checked.target)
            .map_err(|e| e.to_string())
    });
    match result {
        Ok(split) => PlanView {
            train: split.train.iter().map(ToString::to_string).collect(),
            evaluation: split.evaluation.iter().map(ToString::to_string).collect(),
            problem: None,
        },
        Err(problem) => PlanView {
            train: Vec::new(),
            evaluation: Vec::new(),
            problem: Some(problem),
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
            backend: trainer_backend(&checked.backend).ok_or("unknown training method")?,
            params: BTreeMap::from([(
                "method".to_string(),
                serde_json::Value::String(checked.backend.clone()),
            )]),
        },
        recordings: checked.recordings.clone(),
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

    let mut command = Command::new("uv");
    command
        .args(["run", "--project", TRAINER_PROJECT_DIR, "--extra", "onnx"])
        .args(if checked.backend == "torch-mlp" {
            vec!["--extra", "torch"]
        } else {
            vec![]
        })
        .arg("label-classifier-train")
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
            backend: checked.backend.clone(),
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
    if result["outcome"] == "evaluationOnly" {
        let message = result["message"]
            .as_str()
            .unwrap_or("the model was not good enough to keep")
            .to_string();
        let run_dir = format!("{RUNS_DIR}/{run_id}");
        let artifacts: Vec<ArtifactRef> = [("evaluation", "evaluation.json")]
            .iter()
            .filter_map(|(kind, file)| {
                sha256_of_file(&out.join(file))
                    .ok()
                    .map(|sha256| ArtifactRef {
                        kind: (*kind).into(),
                        path: format!("{run_dir}/{file}"),
                        sha256,
                    })
            })
            .collect();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let host = app.state::<LabelRuntimeHost>();
        if let Err(error) = host.with_store(|store| {
            evaluation_only_run(store, run_id, &message, artifacts, &now).map_err(|e| e.to_string())
        }) {
            return failed("failed", error);
        }
        return TrainingEvent::Finished {
            run_id: id,
            label,
            outcome: "evaluationOnly".into(),
            message,
            version_id: None,
            metrics: Some(result["metrics"].clone()),
        };
    }
    if result["outcome"] != "deployable" {
        let message = result["message"]
            .as_str()
            .unwrap_or("the trainer gave no reason")
            .to_string();
        return failed("failed", message);
    }
    let published = (|| -> Result<(String, serde_json::Value), String> {
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
            path: format!("{run_dir}/bundle/model.onnx"),
            sha256: staged.model_sha256.clone(),
        }];
        for (kind, file) in [
            ("manifest", "bundle/manifest.json"),
            ("evaluation", "evaluation.json"),
            ("parity", "parity.json"),
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
            complete_run(store, staged, &lab, run_id, artifacts, &now).map_err(|e| e.to_string())
        })?;
        Ok((outcome.version_id.to_string(), result["metrics"].clone()))
    })();
    match published {
        Ok((version, metrics)) => TrainingEvent::Finished {
            run_id: id,
            label,
            outcome: "deployable".into(),
            message: String::new(),
            version_id: Some(version),
            metrics: Some(metrics),
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

    fn dataset(id: &str, labels: &[&str]) -> DatasetSummary {
        DatasetSummary {
            id: id.into(),
            original_filename: format!("{id}.csv"),
            imported_at: "2026-10-01".into(),
            label: labels.join(", "),
            labels: labels.iter().map(ToString::to_string).collect(),
            row_count: 100,
            source_recording_id: None,
        }
    }

    fn request() -> TrainRequest {
        TrainRequest {
            label: "snap".into(),
            dataset_ids: ["s1", "s2", "s3", "i1", "i2", "i3"]
                .map(String::from)
                .to_vec(),
            negatives: vec!["idle".into()],
            excludes: vec![],
            backend: "logreg".into(),
            sources: vec![
                StreamSource::WatchGyroscope,
                StreamSource::WatchAcceleration,
            ],
            window_ms: 500,
            stride_ms: 150,
            max_gap_ms: 250,
            min_samples: 3,
            seed: None,
            movement_only: false,
        }
    }

    fn datasets() -> Vec<DatasetSummary> {
        ["s1", "s2", "s3"]
            .iter()
            .map(|id| dataset(id, &["snap"]))
            .chain(["i1", "i2", "i3"].iter().map(|id| dataset(id, &["idle"])))
            .collect()
    }

    fn sha(id: &str) -> Result<String, String> {
        Ok(model_lab_core::sha256_hex(id.as_bytes()))
    }

    #[test]
    fn a_request_becomes_explicit_roles_ordered_streams_and_the_features_they_allow() {
        let checked = check_request(&request(), &datasets(), &sha).unwrap();
        assert_eq!(
            checked.mapping.entries[&LabelId::new("snap").unwrap()],
            ExampleRole::Positive
        );
        assert_eq!(
            checked.mapping.entries[&LabelId::new("idle").unwrap()],
            ExampleRole::Negative
        );
        // Streams are put in a fixed order, so the same choice always makes the same contract.
        assert_eq!(
            checked.input.sources,
            vec![
                StreamSource::WatchAcceleration,
                StreamSource::WatchGyroscope
            ]
        );
        assert!(
            checked
                .input
                .features
                .iter()
                .all(|f| f.starts_with("accel_") || f.starts_with("gyro_"))
        );
        assert_eq!(checked.recordings.len(), 6);
        assert_eq!(checked.seed, 7);
    }

    #[test]
    fn it_refuses_what_cannot_be_trained_and_says_why() {
        let data = datasets();
        let refuse = |change: &dyn Fn(&mut TrainRequest)| {
            let mut r = request();
            change(&mut r);
            check_request(&r, &data, &sha).unwrap_err()
        };
        assert!(refuse(&|r| r.backend = "keras".into()).contains("unknown training method"));
        assert!(refuse(&|r| r.label = "Bad Label".into()).contains("label id"));
        assert!(refuse(&|r| r.negatives.push("snap".into())).contains("more than one role"));
        assert!(refuse(&|r| r.dataset_ids.push("nope".into())).contains("no recording"));
        assert!(refuse(&|r| r.dataset_ids.clear()).contains("at least one recording"));
        assert!(refuse(&|r| r.sources.clear()).contains("at least one data stream"));
        assert!(
            refuse(&|r| r.sources = vec![StreamSource::HeadPose])
                .contains("none of the chosen data streams")
        );
        // A recording that cannot be read is not silently skipped.
        let unreadable = check_request(&request(), &data, &|_| Err("gone".into())).unwrap_err();
        assert_eq!(unreadable, "gone");
    }

    #[test]
    fn movement_only_narrows_the_features_the_contract_lists() {
        let mut r = request();
        r.movement_only = true;
        let checked = check_request(&r, &datasets(), &sha).unwrap();
        assert!(checked.input.features.iter().all(|f| f.ends_with("_std")));
        assert_eq!(checked.input.features.len(), 8);
    }

    #[test]
    fn a_recording_listed_twice_counts_once() {
        let mut r = request();
        r.dataset_ids.push("s1".into());
        assert_eq!(
            check_request(&r, &datasets(), &sha)
                .unwrap()
                .recordings
                .len(),
            6
        );
    }

    #[test]
    fn the_spec_carries_the_sealed_split_roles_and_window_for_the_trainer() {
        let checked = check_request(&request(), &datasets(), &sha).unwrap();
        let split = plan_split(&checked.recordings, &checked.mapping, &checked.target).unwrap();
        let paths: BTreeMap<String, PathBuf> = checked
            .recordings
            .iter()
            .map(|r| {
                (
                    r.id.to_string(),
                    PathBuf::from(format!("/data/{}.csv", r.id)),
                )
            })
            .collect();
        let spec = build_spec(&checked, &split, &paths);
        assert_eq!(spec["version"], 1);
        assert_eq!(spec["target"], "snap");
        assert_eq!(spec["negatives"], serde_json::json!(["idle"]));
        assert_eq!(spec["excludes"], serde_json::json!([]));
        assert_eq!(
            spec["sources"],
            serde_json::json!(["watchAcceleration", "watchGyroscope"])
        );
        assert_eq!(spec["window"]["windowMs"], 500);
        assert_eq!(spec["backend"], "logreg");
        assert_eq!(spec["movementOnly"], false);
        let listed = |key: &str| spec[key].as_array().unwrap().len();
        assert_eq!(listed("train") + listed("evaluation"), 6);
        assert_eq!(spec["recordings"].as_object().unwrap().len(), 6);
        assert_eq!(spec["recordings"]["s1"], "/data/s1.csv");
    }
}
