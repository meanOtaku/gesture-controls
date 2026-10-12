//! Records the usual range of each input for models trained before the manifest kept one, so the "values it was never
//! trained on" warning can watch them too.
//!
//! The range is worked out by the trainer from the very windows the model was trained on, from the recordings the run
//! used (checked against the hashes sealed when it was trained), and written into the model's manifest. The model file, its
//! hash and its answers are never touched, and a model whose recordings are gone or have changed is left as it is.

use std::path::{Path, PathBuf};

use model_lab_core::{ModelOrigin, Registry};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::Command;

use crate::label_runtime::{LABEL_MODELS_EVENT, LabelRuntimeHost};
use crate::model_lab::{MODEL_LAB_DIR_NAME, dataset_csv_path, datasets_dir};

const TRAINER_PROJECT_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tools/label-trainer");

/// A trained model with no recorded range, and what is needed to work it out.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub model_id: String,
    pub label: String,
    /// The run's `spec.json`: the settings and recordings it was trained with.
    pub spec: PathBuf,
    /// Every manifest to write the range into: the model's own, and the run's copy of it.
    pub manifests: Vec<PathBuf>,
    /// The recordings the run used (id, SHA-256 when it was selected).
    pub recordings: Vec<(String, String)>,
}

/// What happened to one model.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackfillResult {
    pub model_id: String,
    /// `added`, `none` (nothing to record for this kind of model), `skipped` (its recordings are gone or changed) or `failed`.
    pub outcome: String,
    pub message: String,
}

/// Whether a manifest already records the training range.
pub fn has_range(manifest: &Value) -> bool {
    manifest
        .get("input")
        .and_then(|input| input.get("trainingRange"))
        .is_some_and(|range| !range.is_null())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The trained models whose manifest has no range yet, in the order the registry lists them.
pub fn jobs(registry: &Registry, model_lab_dir: &Path) -> Vec<Job> {
    let mut found = Vec::new();
    for version in registry.versions.values() {
        let ModelOrigin::Trained { run_id } = &version.origin else {
            continue; // an imported model has no recordings of ours to work from
        };
        let manifest = model_lab_dir
            .join(&version.artifact_dir)
            .join("manifest.json");
        let Some(json) = read_json(&manifest) else {
            continue;
        };
        if has_range(&json) {
            continue;
        }
        let Some(snapshot) = registry
            .runs
            .get(run_id)
            .and_then(|run| registry.snapshots.get(&run.snapshot_id))
        else {
            continue;
        };
        let run_dir = model_lab_dir.join("training-runs").join(run_id.to_string());
        let mut manifests = vec![manifest];
        let copy = run_dir.join("bundle").join("manifest.json");
        if copy.is_file() {
            manifests.push(copy);
        }
        found.push(Job {
            model_id: version.id.to_string(),
            label: version.label.to_string(),
            spec: run_dir.join("spec.json"),
            manifests,
            recordings: snapshot
                .recordings
                .iter()
                .map(|r| (r.id.to_string(), r.sha256.clone()))
                .collect(),
        });
    }
    found
}

/// Why a job cannot be done, or `None`: its recordings must still be there and be exactly what they were.
pub fn problem_with(job: &Job, sha_of: &dyn Fn(&str) -> Result<String, String>) -> Option<String> {
    if !job.spec.is_file() {
        return Some("the settings this model was trained with were not kept".into());
    }
    for (id, sealed) in &job.recordings {
        match sha_of(id) {
            Err(_) => {
                return Some(format!(
                    "recording {id}, which this model was trained on, is no longer in Model Lab"
                ));
            }
            Ok(now) if &now != sealed => {
                return Some(format!(
                    "recording {id} has changed since this model was trained, so its range would not be the one it learned"
                ));
            }
            Ok(_) => {}
        }
    }
    None
}

/// What the trainer's last line of output says happened.
/// The saved training settings with every recording pointed at where it is now. A recording converted to a folder since the
/// model was trained has the same identity (checked by [`problem_with`]) but no longer lives at the path the spec names.
pub fn with_current_paths(mut spec: Value, path_of: &dyn Fn(&str) -> PathBuf) -> Value {
    if let Some(recordings) = spec.get_mut("recordings").and_then(Value::as_object_mut) {
        for (id, path) in recordings.iter_mut() {
            *path = Value::String(path_of(id).display().to_string());
        }
    }
    spec
}

pub fn result_of(model_id: &str, output_line: Option<&str>, exit_ok: bool) -> BackfillResult {
    let parsed: Option<Value> = output_line.and_then(|line| serde_json::from_str(line).ok());
    let message = parsed
        .as_ref()
        .and_then(|v| v.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("the trainer gave no answer")
        .to_string();
    let outcome = match parsed
        .as_ref()
        .and_then(|v| v.get("outcome"))
        .and_then(Value::as_str)
    {
        Some("written") if exit_ok => "added",
        Some("none") if exit_ok => "none",
        _ => "failed",
    };
    BackfillResult {
        model_id: model_id.into(),
        outcome: outcome.into(),
        message,
    }
}

fn registry_of(host: &LabelRuntimeHost) -> Result<Registry, String> {
    host.with_store(|store| Ok(store.registry().clone()))
}

fn model_lab_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(MODEL_LAB_DIR_NAME))
        .map_err(|e| e.to_string())
}

/// The trained models that have no recorded range, so the warning cannot watch them yet.
#[tauri::command]
pub fn list_models_without_range(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
) -> Result<Vec<String>, String> {
    Ok(jobs(&registry_of(&host)?, &model_lab_dir(&app)?)
        .into_iter()
        .map(|job| job.model_id)
        .collect())
}

/// Works out and records the range of every trained model that has none, one at a time, and says what happened to each.
/// Models already running pick up their range straight away.
#[tauri::command]
pub async fn backfill_model_ranges(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
) -> Result<Vec<BackfillResult>, String> {
    if !Path::new(TRAINER_PROJECT_DIR)
        .join("pyproject.toml")
        .is_file()
    {
        return Err("the trainer was not found, so ranges cannot be worked out here".into());
    }
    let work = jobs(&registry_of(&host)?, &model_lab_dir(&app)?);
    let data = datasets_dir(&app)?;
    let mut results = Vec::new();
    for job in work {
        let sha_of = |id: &str| crate::model_lab::dataset_sha(&dataset_csv_path(&data, id));
        if let Some(problem) = problem_with(&job, &sha_of) {
            results.push(BackfillResult {
                model_id: job.model_id,
                outcome: "skipped".into(),
                message: problem,
            });
            continue;
        }
        let spec = match read_json(&job.spec) {
            Some(spec) => with_current_paths(spec, &|id| dataset_csv_path(&data, id)),
            None => {
                results.push(BackfillResult {
                    model_id: job.model_id,
                    outcome: "failed".into(),
                    message: "the settings this model was trained with could not be read".into(),
                });
                continue;
            }
        };
        let current_spec = job.spec.with_file_name("spec.backfill.json");
        if let Err(error) = serde_json::to_vec(&spec)
            .map_err(|e| e.to_string())
            .and_then(|bytes| std::fs::write(&current_spec, bytes).map_err(|e| e.to_string()))
        {
            results.push(BackfillResult {
                model_id: job.model_id,
                outcome: "failed".into(),
                message: format!("could not prepare the training settings: {error}"),
            });
            continue;
        }
        let mut command = Command::new("uv");
        command
            .args(["run", "--project", TRAINER_PROJECT_DIR, "--extra", "onnx"])
            .arg("label-classifier-train")
            .arg("--backfill-range")
            .arg("--spec")
            .arg(&current_spec);
        for manifest in &job.manifests {
            command.arg("--manifest").arg(manifest);
        }
        let output = command.kill_on_drop(true).output().await;
        let _ = std::fs::remove_file(&current_spec);
        results.push(match output {
            Ok(done) => {
                let text = String::from_utf8_lossy(&done.stdout).into_owned();
                result_of(&job.model_id, text.lines().rev().find(|l| !l.trim().is_empty()), done.status.success())
            }
            Err(error) => BackfillResult {
                model_id: job.model_id,
                outcome: "failed".into(),
                message: format!("could not start the trainer: {error}. It needs uv (https://docs.astral.sh/uv/) on the PATH"),
            },
        });
    }
    if results.iter().any(|r| r.outcome == "added") {
        host.reload(&app);
        let _ = app.emit(LABEL_MODELS_EVENT, ());
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trainer_is_given_where_each_recording_is_now() {
        // Trained when recording r1 was a single file; it has since been converted to a folder.
        let saved = serde_json::json!({
            "label": "pinch",
            "recordings": {"r1": "/data/datasets/r1.csv", "r2": "/data/datasets/r2"},
        });
        let now = with_current_paths(saved, &|id| PathBuf::from(format!("/data/datasets/{id}")));
        assert_eq!(now["recordings"]["r1"], "/data/datasets/r1");
        assert_eq!(now["recordings"]["r2"], "/data/datasets/r2");
        assert_eq!(now["label"], "pinch");
    }

    #[test]
    fn a_manifest_with_a_range_is_recognised_and_one_without_is_not() {
        let with: Value = serde_json::json!({"input": {"features": [], "trainingRange": {"low": [], "high": []}}});
        let without: Value = serde_json::json!({"input": {"features": []}});
        let null: Value = serde_json::json!({"input": {"trainingRange": null}});
        assert!(has_range(&with));
        assert!(!has_range(&without) && !has_range(&null));
    }

    fn job(spec: &Path) -> Job {
        Job {
            model_id: "m".into(),
            label: "pinch".into(),
            spec: spec.to_path_buf(),
            manifests: Vec::new(),
            recordings: vec![("a".into(), "sha-a".into()), ("b".into(), "sha-b".into())],
        }
    }

    #[test]
    fn a_job_is_only_done_when_every_recording_is_still_exactly_what_it_was() {
        let spec = std::env::temp_dir().join(format!(
            "backfill-spec-{}.json",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&spec, "{}").unwrap();
        let all_there = |id: &str| Ok(format!("sha-{id}"));
        assert_eq!(problem_with(&job(&spec), &all_there), None);
        let changed = |id: &str| {
            Ok(if id == "b" {
                "other".into()
            } else {
                format!("sha-{id}")
            })
        };
        assert!(
            problem_with(&job(&spec), &changed)
                .unwrap()
                .contains("recording b has changed")
        );
        let gone = |id: &str| {
            if id == "a" {
                Err("no file".into())
            } else {
                Ok("sha-b".into())
            }
        };
        assert!(
            problem_with(&job(&spec), &gone)
                .unwrap()
                .contains("recording a")
        );
        std::fs::remove_file(&spec).unwrap();
        assert!(
            problem_with(&job(&spec), &all_there)
                .unwrap()
                .contains("not kept")
        );
    }

    #[test]
    fn the_trainers_last_line_becomes_what_is_told_about_the_model() {
        let written = r#"{"outcome":"written","message":"recorded the range of 3 inputs"}"#;
        assert_eq!(result_of("m", Some(written), true).outcome, "added");
        assert_eq!(
            result_of("m", Some(r#"{"outcome":"none","message":"x"}"#), true).outcome,
            "none"
        );
        let refused = result_of(
            "m",
            Some(r#"{"outcome":"refused","message":"a recording is gone"}"#),
            false,
        );
        assert_eq!(
            (refused.outcome.as_str(), refused.message.as_str()),
            ("failed", "a recording is gone")
        );
        // Success claimed by a trainer that then failed is not believed, and silence is a failure.
        assert_eq!(result_of("m", Some(written), false).outcome, "failed");
        assert_eq!(result_of("m", None, true).outcome, "failed");
    }
}
