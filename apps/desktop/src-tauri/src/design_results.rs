//! Results by design: for every model trained here, which saved network design it was trained with and how it scored on
//! its held-out recordings, so designs can be compared by what they actually produced.
//!
//! Everything is read from what a training run already keeps: `request.json` (which names the design) and
//! `inspection.json` (the scores). Nothing new is written.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::label_runtime::LabelRuntimeHost;

/// One trained model and the design it came from.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesignResult {
    pub model_id: String,
    pub label: String,
    pub created_at: String,
    /// Absent for a model trained before designs existed, or with settings chosen another way.
    pub design_id: Option<String>,
    /// The design's current name, absent when it has since been deleted.
    pub design_name: Option<String>,
    pub method: Option<String>,
    /// Made by hand-editing or fine-tuning another model rather than trained from scratch.
    pub edited: bool,
    /// The scores on held-out windows (`rocAuc`, `f1`, `precision`, `recall`, `falseActivationRate`), when kept.
    pub metrics: Option<Value>,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// What a run kept about its model. `design_name` finds the current name of a design id.
pub fn result_of(
    runs_dir: &Path,
    model_id: &str,
    label: &str,
    created_at: &str,
    run_id: &str,
    design_name: impl Fn(&str) -> Option<String>,
) -> DesignResult {
    let dir = runs_dir.join(run_id);
    let request = read_json(&dir.join("request.json"));
    let inspection = read_json(&dir.join("inspection.json"));
    let design_id = request
        .as_ref()
        .and_then(|r| r.get("designId"))
        .and_then(Value::as_str)
        .map(String::from);
    DesignResult {
        model_id: model_id.into(),
        label: label.into(),
        created_at: created_at.into(),
        design_name: design_id.as_deref().and_then(design_name),
        design_id,
        method: inspection
            .as_ref()
            .and_then(|i| i.get("backend"))
            .or_else(|| request.as_ref().and_then(|r| r.get("backend")))
            .and_then(Value::as_str)
            .map(String::from),
        edited: inspection
            .as_ref()
            .is_some_and(|i| i.get("edit").is_some_and(|e| !e.is_null())),
        metrics: inspection
            .as_ref()
            .and_then(|i| i.get("evaluation"))
            .and_then(|e| e.get("metrics"))
            .filter(|m| m.is_object())
            .cloned(),
    }
}

/// Every model trained in this app, newest first, with its design and scores.
#[tauri::command]
pub fn list_design_results(
    app: AppHandle,
    host: State<'_, LabelRuntimeHost>,
) -> Result<Vec<DesignResult>, String> {
    let runs = host.runs_dir_of(&app)?;
    let designs = crate::network_designs::all_designs(&app)?;
    let mut rows: Vec<DesignResult> = host
        .trained_models()
        .into_iter()
        .map(|(id, label, created, run)| {
            result_of(&runs, &id, &label, &created, &run, |design| {
                designs
                    .iter()
                    .find(|d| d.id == design)
                    .map(|d| d.name.clone())
            })
        })
        .collect();
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("design-results-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(dir.join("run-1")).unwrap();
        dir
    }

    #[test]
    fn reads_the_design_and_the_scores_a_run_kept() {
        let dir = temp();
        fs::write(
            dir.join("run-1/request.json"),
            r#"{"label":"snap","backend":"mlp","designId":"d1"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("run-1/inspection.json"),
            r#"{"backend":"torch-mlp","evaluation":{"metrics":{"rocAuc":0.8,"f1":0.7}}}"#,
        )
        .unwrap();
        let found = result_of(&dir, "snap-1", "snap", "2026-10-01", "run-1", |id| {
            (id == "d1").then(|| "Mine".to_string())
        });
        assert_eq!(
            (
                found.design_id.as_deref(),
                found.design_name.as_deref(),
                found.method.as_deref()
            ),
            (Some("d1"), Some("Mine"), Some("torch-mlp"))
        );
        assert!(!found.edited);
        assert_eq!(found.metrics.unwrap()["rocAuc"], 0.8);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_model_without_a_design_or_with_a_deleted_one_is_still_listed() {
        let dir = temp();
        fs::write(
            dir.join("run-1/request.json"),
            r#"{"label":"snap","backend":"logreg"}"#,
        )
        .unwrap();
        let old = result_of(&dir, "a", "snap", "t", "run-1", |_| None);
        assert_eq!(
            (old.design_id, old.method.as_deref(), old.metrics),
            (None, Some("logreg"), None)
        );
        fs::write(dir.join("run-1/request.json"), r#"{"designId":"gone"}"#).unwrap();
        fs::write(
            dir.join("run-1/inspection.json"),
            r#"{"edit":{"edits":[]}}"#,
        )
        .unwrap();
        let gone = result_of(&dir, "b", "snap", "t", "run-1", |_| None);
        assert_eq!(
            (gone.design_id.as_deref(), gone.design_name, gone.edited),
            (Some("gone"), None, true)
        );
        assert_eq!(
            result_of(&dir, "c", "snap", "t", "missing", |_| None).metrics,
            None
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
