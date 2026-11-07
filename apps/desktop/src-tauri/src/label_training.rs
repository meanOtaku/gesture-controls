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
    RecordingInfo, RunPlan, begin_run, cnn_contract, complete_run, fail_run, monitor_only_run,
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
/// The model the app trains unless asked for another (the trainer's `BACKEND`): trees on PPG and motion summaries.
pub(crate) const BACKEND: &str = "ppg-onset-trees";
/// The CNN on the last second of motion and pulse (the trainer's `CNN_BACKEND`). Training it needs PyTorch, which the
/// trainer's `cnn` extra installs.
pub(crate) const CNN_BACKEND: &str = "ppg-imu-cnn";
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
    /// Which model to train: [`BACKEND`] (absent) or [`CNN_BACKEND`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// Train again with the moments the model fired by mistake on its training recordings (everyday noise teaches most).
    #[serde(default)]
    pub hard_negatives: bool,
}

/// The trainer backend a request asks for, and what its model reads.
fn method_of(request: &TrainRequest) -> Result<(&'static str, InputContract), String> {
    match request.method.as_deref() {
        None | Some(BACKEND) => Ok((BACKEND, pinch_start_contract())),
        Some(CNN_BACKEND) => Ok((CNN_BACKEND, cnn_contract())),
        Some(other) => Err(format!("there is no training method '{other}'")),
    }
}

/// A request checked against the recordings it names.
#[derive(Debug)]
struct Checked {
    target: LabelId,
    mapping: LabelMapping,
    /// The trainer backend.
    backend: &'static str,
    input: InputContract,
    recordings: Vec<RecordingInfo>,
    research: bool,
    hard_negatives: bool,
    label_offset_ms: i32,
    /// How each recording's labels were timed, for the trainer to judge on the trusted ones (`label_timing_of`).
    label_timing: BTreeMap<String, &'static str>,
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
    if crate::label_registry::is_standard(&request.label) {
        return Err(format!(
            "'{}' is a standard label, there to show a model what is not a gesture: choose a gesture to train",
            request.label
        ));
    }
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
    let chosen: Vec<&DatasetSummary> = seen
        .iter()
        .filter_map(|id| datasets.iter().find(|d| &d.id == id))
        .collect();
    for (i, a) in chosen.iter().enumerate() {
        if let Some(b) = chosen[i + 1..]
            .iter()
            .find(|b| a.content_sha.is_some() && b.content_sha == a.content_sha)
        {
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
            Some(_) => {
                return Err(format!(
                    "'{}' marks stretches left out, so it can only be excluded",
                    dataset_files::LEFT_OUT_LABEL
                ));
            }
        }
    }
    // The standard labels are not the gesture for every model: something else, unless the request leaves them out.
    for (standard, ..) in crate::label_registry::STANDARD_LABELS {
        let id = label_id(standard)?;
        if recordings.iter().any(|r| r.labels.contains(&id)) {
            entries.entry(id).or_insert(ExampleRole::Negative);
        }
    }
    let label_offset_ms = request.label_offset_ms.unwrap_or(0);
    if label_offset_ms.abs() > MAX_LABEL_OFFSET_MS {
        return Err(format!(
            "the label offset must be from -{MAX_LABEL_OFFSET_MS} to {MAX_LABEL_OFFSET_MS} milliseconds, got {label_offset_ms}"
        ));
    }
    let (backend, input) = method_of(request)?;
    let label_timing = label_timing_of(&recordings_ids(&recordings), datasets, &target.to_string());
    Ok(Checked {
        target,
        mapping: LabelMapping { entries },
        backend,
        input,
        recordings,
        research: request.research,
        hard_negatives: request.hard_negatives,
        label_offset_ms,
        label_timing,
    })
}

fn recordings_ids(recordings: &[RecordingInfo]) -> Vec<String> {
    recordings.iter().map(|r| r.id.to_string()).collect()
}

/// "camera" for a recording whose labels the camera marked, "estimated" for one whose labels were estimated from motion,
/// "noGesture" for one with no `target` in it (everyday noise); a recording that says none of these is left out (the trainer
/// counts it as unknown). See `detector_events::timing_of`.
fn label_timing_of(
    ids: &[String],
    datasets: &[DatasetSummary],
    target: &str,
) -> BTreeMap<String, &'static str> {
    ids.iter()
        .filter_map(|id| {
            let dataset = datasets.iter().find(|d| &d.id == id)?;
            match crate::detector_events::timing_of(dataset, target) {
                "unknown" => None,
                timing => Some((id.clone(), timing)),
            }
        })
        .collect()
}

/// Whether new models train only on moments the hand was still before, as the `steadyStartsOnly` setting asks.
fn steady_starts(app: &AppHandle) -> bool {
    app.try_state::<crate::settings::SettingsRuntime>()
        .and_then(|settings| settings.get().ok())
        .is_some_and(|settings| settings.steady_starts_only)
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
        "backend": checked.backend,
        "seed": SEED,
        "research": checked.research,
        "hardNegatives": checked.hard_negatives,
        "labelOffsetMs": checked.label_offset_ms,
        "labelTiming": checked.label_timing,
        // Train and test only on moments the runtime's steadiness gate would let a gesture start at (`steadiness.py`),
        // when the setting asks for the gate (`steady_starts_only`, set by the caller).
        "steadyStarts": false,
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
    let mut index = load_index(app);
    let dir = datasets_dir(app)?;
    // How each recording's labels were made is worked out from its Recorder recording, as the list shows it.
    if let Ok(bundles) = crate::recording_bundle::recording_bundles_dir(app) {
        crate::model_lab::describe(&mut index.datasets, &dir, &bundles);
    }
    let checked = check_request(request, &index.datasets, &|id| {
        dataset_sha(&dataset_csv_path(&dir, id))
    })?;
    let stamps = checked
        .recordings
        .iter()
        .map(|r| {
            let name = index
                .datasets
                .iter()
                .find(|d| d.id == r.id.as_str())
                .map_or_else(|| r.id.to_string(), |d| d.original_filename.clone());
            Ok((
                name,
                session_stamps(&dataset_csv_path(&dir, r.id.as_str()))?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if let Some((a, b)) = same_session(&stamps) {
        return Err(format!(
            "'{a}' and '{b}' are the same session (they hold the same watch samples): leave one out, or one could be trained on and the other tested on, and their labels may disagree"
        ));
    }
    Ok(checked)
}

/// The watch timestamps of a recording's motion rows (every row, for a single-file recording).
fn session_stamps(path: &Path) -> Result<Vec<i64>, String> {
    let file = if path.is_dir() {
        path.join(dataset_files::IMU_FILE)
    } else {
        path.to_path_buf()
    };
    let text =
        fs::read_to_string(&file).map_err(|e| format!("could not read {}: {e}", file.display()))?;
    Ok(text
        .lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split(',').next()?.trim().parse().ok())
        .collect())
}

/// Every two recordings that hold one session, by position: at least half of the shorter one's timestamps are also the
/// other's. Two copies of a session labelled differently are different files, so the duplicate check passes them; two
/// sessions never share exact timestamps, even when the watch clock restarted between them.
fn same_session_pairs(recordings: &[(String, Vec<i64>)]) -> Vec<(usize, usize)> {
    let sets: Vec<std::collections::HashSet<i64>> = recordings
        .iter()
        .map(|(_, stamps)| stamps.iter().copied().collect())
        .collect();
    let mut pairs = Vec::new();
    for i in 0..sets.len() {
        for j in i + 1..sets.len() {
            let (small, big) = if sets[i].len() <= sets[j].len() {
                (&sets[i], &sets[j])
            } else {
                (&sets[j], &sets[i])
            };
            if !small.is_empty()
                && small.iter().filter(|t| big.contains(t)).count() * 2 >= small.len()
            {
                pairs.push((i, j));
            }
        }
    }
    pairs
}

/// The first two recordings, by name, that hold one session.
fn same_session(recordings: &[(String, Vec<i64>)]) -> Option<(&str, &str)> {
    same_session_pairs(recordings)
        .first()
        .map(|&(i, j)| (recordings[i].0.as_str(), recordings[j].0.as_str()))
}

/// The recordings that hold one session, set by set, each set in the order given; only sets of two or more. A recording
/// sharing a session with either of two others puts all three in one set.
fn session_sets(recordings: &[(String, Vec<i64>)]) -> Vec<Vec<String>> {
    let mut set_of: Vec<usize> = (0..recordings.len()).collect();
    for (i, j) in same_session_pairs(recordings) {
        let (from, to) = (set_of[j], set_of[i]);
        for set in &mut set_of {
            if *set == from {
                *set = to;
            }
        }
    }
    let mut sets = BTreeMap::<usize, Vec<String>>::new();
    for (i, (id, _)) in recordings.iter().enumerate() {
        sets.entry(set_of[i]).or_default().push(id.clone());
    }
    sets.into_values().filter(|set| set.len() > 1).collect()
}

/// The recordings in Model Lab that hold one session, by the check training refuses them with, whether or not their labels
/// agree. It reads every recording's motion rows, so it runs when asked. A recording that cannot be read is left out.
#[tauri::command]
pub async fn find_same_session_recordings(app: AppHandle) -> Result<Vec<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = datasets_dir(&app)?;
        let stamps: Vec<(String, Vec<i64>)> = load_index(&app)
            .datasets
            .iter()
            .filter_map(|d| match session_stamps(&dataset_csv_path(&dir, &d.id)) {
                Ok(stamps) => Some((d.id.clone(), stamps)),
                Err(error) => {
                    warn!(%error, "could not read a recording while looking for copies");
                    None
                }
            })
            .collect();
        Ok(session_sets(&stamps))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The trainer, with PyTorch installed for the CNN.
fn trainer_command(backend: &str) -> Command {
    let mut command = Command::new("uv");
    command.args(["run", "--project", TRAINER_PROJECT_DIR]);
    if backend == CNN_BACKEND {
        command.args(["--extra", "cnn"]);
    }
    command.arg("label-classifier-train");
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

/// The labels a run may map: the catalogue's, and `left_out`, which the Labelling page gives a stretch it leaves out and
/// which is never in the catalogue (recordings are imported with it on the same terms).
fn labels_known_to_training(catalogue: BTreeSet<String>) -> BTreeSet<LabelId> {
    catalogue
        .iter()
        .map(String::as_str)
        .chain([dataset_files::LEFT_OUT_LABEL])
        .filter_map(|l| LabelId::new(l).ok())
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
    // The timing check always uses quick trees, whichever model will be trained.
    spec["backend"] = serde_json::json!(BACKEND);
    spec["steadyStarts"] = serde_json::json!(steady_starts(&app));
    let work = runs_dir(&app)?.join(format!(".timing-{}", Uuid::new_v4().simple()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let spec_path = work.join("spec.json");
    let done = async {
        fs::write(&spec_path, serde_json::to_vec(&spec).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let output = trainer_command(BACKEND)
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
pub async fn plan_label_training(
    app: AppHandle,
    request: TrainRequest,
) -> Result<PlanView, String> {
    tauri::async_runtime::spawn_blocking(move || plan_label_training_blocking(&app, &request))
        .await
        .map_err(|e| e.to_string())
}

fn plan_label_training_blocking(app: &AppHandle, request: &TrainRequest) -> PlanView {
    let inputs = method_of(request)
        .map_or(pinch_start_contract().features.len(), |(_, contract)| {
            contract.features.len()
        });
    let result = recordings_for(app, request).and_then(|checked| {
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
    let known = labels_known_to_training(crate::label_registry::catalogue_ids(&app));
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let unique = Uuid::new_v4().simple().to_string()[..10].to_string();
    let plan = RunPlan {
        target: checked.target.clone(),
        mapping: checked.mapping.clone(),
        input: checked.input.clone(),
        quality: QualityRules::default(),
        trainer: TrainerConfig {
            backend: trainer_backend(checked.backend).ok_or("unknown training method")?,
            // What else shaped the run, so the training history can say what changed from one run to the next.
            params: BTreeMap::from([
                (
                    "method".to_string(),
                    serde_json::Value::String(checked.backend.into()),
                ),
                (
                    "labelOffsetMs".to_string(),
                    serde_json::Value::from(checked.label_offset_ms),
                ),
                (
                    "research".to_string(),
                    serde_json::Value::Bool(checked.research),
                ),
                (
                    "hardNegatives".to_string(),
                    serde_json::Value::Bool(checked.hard_negatives),
                ),
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
        let mut spec = build_spec(&checked, &begun.split, &paths);
        spec["steadyStarts"] = serde_json::json!(steady_starts(&app));
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

    let mut command = trainer_command(checked.backend);
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
            backend: checked.backend.into(),
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
            path: format!("{run_dir}/bundle/{}", staged.manifest.model.file),
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
            outcome: if deployable {
                "deployable"
            } else {
                "monitorOnly"
            }
            .into(),
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
            group: None,
            labels_from: None,
            name: None,
            viewer_session_id: None,
            camera: false,
            recorded_at: None,
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
            method: None,
            hard_negatives: false,
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
    fn two_copies_of_one_session_are_refused_but_two_sessions_on_a_restarted_clock_are_not() {
        let session = |from: i64, n: i64| (0..n).map(|k| from + k * 20_000_123).collect::<Vec<_>>();
        let named = |list: &[(&str, Vec<i64>)]| {
            list.iter()
                .map(|(n, s)| (n.to_string(), s.clone()))
                .collect::<Vec<_>>()
        };
        let a = session(1_725_454_345_507_365, 3000);
        // A copy that lost a few rows at each end, as an export with other labels may.
        let copy = a[40..2900].to_vec();
        let other = session(2_025_806_369_310_949, 3000);
        assert_eq!(
            same_session(&named(&[
                ("a.csv", a.clone()),
                ("other.csv", other.clone()),
                ("copy.csv", copy)
            ])),
            Some(("a.csv", "copy.csv"))
        );
        // After a restart the clock covers the same span again, but no sample falls on the same nanosecond.
        let restarted = (0..3000)
            .map(|k| 1_725_454_345_507_365 + 7_919 + k * 19_998_877)
            .collect::<Vec<_>>();
        assert_eq!(
            same_session(&named(&[
                ("a.csv", a),
                ("restarted.csv", restarted),
                ("other.csv", other),
                ("empty.csv", vec![])
            ])),
            None
        );
    }

    #[test]
    fn recordings_sharing_a_session_are_gathered_into_one_set() {
        let stamps = |from: i64, to: i64| (from..to).map(|k| k * 19_998_877).collect::<Vec<_>>();
        let recordings: Vec<(String, Vec<i64>)> = [
            ("a", stamps(0, 100)),
            ("other", stamps(1_000, 1_100)),
            ("relabelled a", stamps(0, 100)),
            ("end of a", stamps(40, 100)),
            ("copy of other", stamps(1_000, 1_100)),
            ("alone", stamps(5_000, 5_100)),
            ("empty", vec![]),
        ]
        .into_iter()
        .map(|(name, stamps)| (name.to_string(), stamps))
        .collect();
        assert_eq!(
            session_sets(&recordings),
            [
                vec!["a", "relabelled a", "end of a"],
                vec!["other", "copy of other"]
            ]
        );
        assert!(session_sets(&recordings[5..]).is_empty());
    }

    #[test]
    fn session_stamps_reads_the_motion_rows_of_a_folder_and_every_row_of_a_single_file() {
        let dir = std::env::temp_dir().join(format!("session-stamps-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(dataset_files::IMU_FILE),
            "# label: \ntimestamp_ns,sequence\n100,1\n120,1\n",
        )
        .unwrap();
        assert_eq!(session_stamps(&dir).unwrap(), vec![100, 120]);
        let single = dir.join("legacy.csv");
        fs::write(&single, "timestamp_ns,label\n5,a\n6,\n").unwrap();
        assert_eq!(session_stamps(&single).unwrap(), vec![5, 6]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_run_may_map_left_out_though_the_catalogue_never_has_it() {
        let known = labels_known_to_training(BTreeSet::from(["pinch_in".to_string()]));
        assert!(known.contains(&LabelId::new("pinch_in").unwrap()));
        assert!(known.contains(&LabelId::new(dataset_files::LEFT_OUT_LABEL).unwrap()));
    }

    #[test]
    fn stretches_left_out_are_always_excluded() {
        let mut data = datasets();
        data[0].labels.push(dataset_files::LEFT_OUT_LABEL.into());
        let checked = check_request(&request(), &data, &sha).unwrap();
        assert_eq!(
            checked.mapping.entries[&LabelId::new("left_out").unwrap()],
            ExampleRole::Exclude
        );
        let mut r = request();
        r.negatives.push("left_out".into());
        assert!(
            check_request(&r, &data, &sha)
                .unwrap_err()
                .contains("can only be excluded")
        );
        // With none left out, nothing is added.
        assert!(
            !check_request(&request(), &datasets(), &sha)
                .unwrap()
                .mapping
                .entries
                .contains_key(&LabelId::new("left_out").unwrap())
        );
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
    fn the_spec_carries_the_sealed_split_roles_and_the_one_backend_for_the_trainer() {
        let mut r = request();
        r.label_offset_ms = Some(-250);
        r.research = true;
        let checked = check_request(&r, &datasets(), &sha).unwrap();
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
        assert_eq!(spec["target"], "pinch");
        assert_eq!(spec["negatives"], serde_json::json!(["fist"]));
        assert_eq!(
            spec["steadyStarts"],
            serde_json::json!(false),
            "the caller sets it from the setting"
        );
        assert_eq!(
            spec["sources"],
            serde_json::json!(["watchPpg", "watchOrientation"])
        );
        assert_eq!(spec["backend"], BACKEND);
        assert_eq!(
            (spec["labelOffsetMs"].as_i64(), spec["research"].as_bool()),
            (Some(-250), Some(true))
        );
        assert_eq!(spec["hardNegatives"], serde_json::json!(false));
        let listed = |key: &str| spec[key].as_array().unwrap().len();
        assert_eq!(listed("train") + listed("evaluation"), 6);
        assert_eq!(spec["recordings"]["s1"], "/data/s1.csv");
        assert_eq!(
            spec["labelTiming"],
            serde_json::json!({"i1": "noGesture", "i2": "noGesture", "i3": "noGesture"}),
            "only the recordings with no pinch say anything: none says how its labels were made"
        );
    }

    #[test]
    fn the_standard_labels_are_not_the_gesture_without_being_asked_and_cannot_be_trained() {
        let mut list = datasets();
        list.push(dataset("n1", &["everyday_noise", "still", "supported"]));
        let mut r = request();
        r.dataset_ids.push("n1".into());
        let checked = check_request(&r, &list, &sha).unwrap();
        for standard in ["everyday_noise", "still", "supported"] {
            assert_eq!(
                checked.mapping.entries[&LabelId::new(standard).unwrap()],
                ExampleRole::Negative
            );
        }
        // Left out when asked.
        r.excludes = vec!["still".into()];
        assert_eq!(
            check_request(&r, &list, &sha).unwrap().mapping.entries
                [&LabelId::new("still").unwrap()],
            ExampleRole::Exclude
        );
        r.label = "everyday_noise".into();
        assert!(
            check_request(&r, &list, &sha)
                .unwrap_err()
                .contains("standard label")
        );
    }

    #[test]
    fn the_trainer_is_told_which_recordings_the_camera_timed_and_which_were_estimated() {
        let mut list = datasets();
        list[0].labels_from = Some("camera".into());
        list[1].labels_from = Some("motion".into());
        list[2].labels_from = Some("recorder".into());
        let ids: Vec<String> = list.iter().map(|d| d.id.clone()).collect();
        let timing = label_timing_of(&ids, &list, "pinch");
        // The fist recordings hold no pinch: everyday noise as far as a pinch model goes.
        assert_eq!(
            timing,
            BTreeMap::from([
                (list[0].id.clone(), "camera"),
                (list[1].id.clone(), "estimated"),
                (list[3].id.clone(), "noGesture"),
                (list[4].id.clone(), "noGesture"),
                (list[5].id.clone(), "noGesture")
            ])
        );
        let checked = check_request(&request(), &list, &sha).unwrap();
        assert!(
            checked
                .label_timing
                .values()
                .all(|t| ["camera", "estimated", "noGesture"].contains(t))
        );
    }

    #[test]
    fn a_request_for_the_cnn_reads_the_cnn_s_inputs_and_tells_the_trainer() {
        let mut r = request();
        r.method = Some(CNN_BACKEND.into());
        let checked = check_request(&r, &datasets(), &sha).unwrap();
        assert_eq!(checked.backend, CNN_BACKEND);
        assert_eq!(checked.input, cnn_contract());
        let split = plan_split(&checked.recordings, &checked.mapping, &checked.target).unwrap();
        assert_eq!(
            build_spec(&checked, &split, &BTreeMap::new())["backend"],
            CNN_BACKEND
        );
        assert_eq!(
            trainer_backend(CNN_BACKEND),
            Some(model_lab_core::TrainerBackend::PyTorch)
        );
        let args: Vec<String> = trainer_command(CNN_BACKEND)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|w| w == ["--extra", "cnn"]), "{args:?}");
        assert!(
            !trainer_command(BACKEND)
                .as_std()
                .get_args()
                .any(|a| a == "--extra")
        );
        r.method = Some("svm".into());
        assert!(
            check_request(&r, &datasets(), &sha)
                .unwrap_err()
                .contains("no training method 'svm'")
        );
    }

    #[test]
    fn the_trainers_timing_scores_become_the_numbers_shown_and_a_refusal_becomes_its_reason() {
        let line = r#"{"outcome":"ok","scores":[{"offsetMs":0,"auc":0.8,"windows":900,"positives":500},{"offsetMs":250,"auc":null,"windows":0,"positives":0}]}"#;
        let scores = offsets_from(Some(line)).unwrap();
        assert_eq!(
            (scores[0].offset_ms, scores[0].auc, scores[0].windows),
            (0, Some(0.8), 900)
        );
        assert_eq!(scores[1].auc, None);
        let refused = offsets_from(Some(
            r#"{"outcome":"refused","message":"too few recordings"}"#,
        ))
        .unwrap_err();
        assert_eq!(refused, "too few recordings");
        assert!(offsets_from(None).is_err() && offsets_from(Some("not json")).is_err());
    }
}
