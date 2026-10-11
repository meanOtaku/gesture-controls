//! Saved fine-tune plans: named, model-independent settings for carrying on training a trained model (how many rounds, how
//! fast, what stays frozen). Built-in plans come with the app; the person's own are kept in
//! `app_data/model-lab/fine-tune-plans.json`. A plan becomes the trainer's fine-tuning settings
//! (see [`FineTunePlan::settings`]); which model it is used on is chosen when it is used.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tracing::warn;
use uuid::Uuid;

use crate::model_lab::MODEL_LAB_DIR_NAME;

const FILE_NAME: &str = "fine-tune-plans.json";
pub const MAX_PLANS: usize = 100;
const MAX_NAME_CHARS: usize = 40;
const MAX_DESCRIPTION_CHARS: usize = 300;
pub const BUILT_IN_PREFIX: &str = "builtin-";
const FREEZE_MODES: [&str; 2] = ["none", "allButOutput"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FineTunePlan {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Rounds of training, 1 to 500.
    pub epochs: u32,
    /// Absent means a third of the rate the model was trained at.
    #[serde(default)]
    pub learning_rate: Option<f64>,
    /// `none` or `allButOutput` (every layer but the output layer stays as it is).
    pub freeze: String,
    #[serde(default)]
    pub built_in: bool,
}

impl FineTunePlan {
    /// The settings the trainer reads (`fine_tune_model` in `edits.py`).
    pub fn settings(&self) -> serde_json::Value {
        let mut settings = serde_json::json!({ "epochs": self.epochs, "freeze": self.freeze });
        if let Some(rate) = self.learning_rate {
            settings["learningRate"] = serde_json::json!(rate);
        }
        settings
    }
}

pub fn validate(plan: &FineTunePlan) -> Result<(), String> {
    let name = plan.name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(format!("the name must be 1 to {MAX_NAME_CHARS} characters"));
    }
    if plan.description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!(
            "the description can be at most {MAX_DESCRIPTION_CHARS} characters"
        ));
    }
    if !(1..=500).contains(&plan.epochs) {
        return Err("rounds must be from 1 to 500".into());
    }
    if let Some(rate) = plan.learning_rate
        && !(rate.is_finite() && (0.00001..=0.1).contains(&rate))
    {
        return Err("the learning rate must be from 0.00001 to 0.1".into());
    }
    if !FREEZE_MODES.contains(&plan.freeze.as_str()) {
        return Err(format!("freeze must be one of {FREEZE_MODES:?}"));
    }
    Ok(())
}

fn built_in(
    id: &str,
    name: &str,
    description: &str,
    epochs: u32,
    rate: Option<f64>,
    freeze: &str,
) -> FineTunePlan {
    FineTunePlan {
        id: format!("{BUILT_IN_PREFIX}{id}"),
        name: name.into(),
        description: description.into(),
        epochs,
        learning_rate: rate,
        freeze: freeze.into(),
        built_in: true,
    }
}

pub fn built_in_plans() -> Vec<FineTunePlan> {
    vec![
        built_in(
            "continue",
            "Keep training",
            "30 more rounds at a gentle rate, every layer free to change.",
            30,
            None,
            "none",
        ),
        built_in(
            "polish",
            "Light polish",
            "10 rounds at a very small step: a nudge, not a retrain.",
            10,
            Some(0.0005),
            "none",
        ),
        built_in(
            "head",
            "Retrain the output layer",
            "30 rounds with every layer but the output layer kept as it is.",
            30,
            None,
            "allButOutput",
        ),
    ]
}

pub fn read_plans(path: &Path) -> Vec<FineTunePlan> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(all) = serde_json::from_str::<Vec<FineTunePlan>>(&text) else {
        warn!(path = %path.display(), "the fine-tune plans file could not be read; starting empty");
        return Vec::new();
    };
    let mut kept: Vec<FineTunePlan> = Vec::new();
    for mut plan in all {
        plan.built_in = false;
        let fine = validate(&plan).is_ok()
            && !plan.id.is_empty()
            && !plan.id.starts_with(BUILT_IN_PREFIX)
            && !kept.iter().any(|p| p.id == plan.id);
        if fine {
            kept.push(plan);
        } else {
            warn!(id = %plan.id, "dropped an invalid saved fine-tune plan");
        }
    }
    kept.truncate(MAX_PLANS);
    kept
}

pub fn write_plans(path: &Path, plans: &[FineTunePlan]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(plans).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Adds a plan (an empty id gets `new_id`) or replaces the saved one with its id. Built-ins are never replaced and names
/// stay unique (ignoring case, built-ins included).
pub fn upsert(
    saved: &[FineTunePlan],
    mut plan: FineTunePlan,
    new_id: impl FnOnce() -> String,
) -> Result<Vec<FineTunePlan>, String> {
    if plan.id.starts_with(BUILT_IN_PREFIX) {
        return Err("a built-in plan cannot be changed: duplicate it and change the copy".into());
    }
    plan.built_in = false;
    plan.name = plan.name.trim().to_string();
    validate(&plan)?;
    if plan.id.is_empty() {
        plan.id = new_id();
    } else if plan.id.len() > 64
        || !plan
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("the plan id is not valid".into());
    }
    if saved
        .iter()
        .chain(built_in_plans().iter())
        .any(|p| p.id != plan.id && p.name.eq_ignore_ascii_case(&plan.name))
    {
        return Err(format!("a plan called '{}' already exists", plan.name));
    }
    let mut next = saved.to_vec();
    if let Some(position) = next.iter().position(|p| p.id == plan.id) {
        next[position] = plan;
    } else if next.len() >= MAX_PLANS {
        return Err(format!("at most {MAX_PLANS} plans can be saved"));
    } else {
        next.push(plan);
    }
    Ok(next)
}

#[derive(Default)]
pub struct FineTunePlanRuntime {
    lock: Mutex<()>,
}

fn plans_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(MODEL_LAB_DIR_NAME).join(FILE_NAME))
        .map_err(|e| e.to_string())
}

fn everything(saved: Vec<FineTunePlan>) -> Vec<FineTunePlan> {
    let mut all = built_in_plans();
    all.extend(saved);
    all
}

/// The trainer's settings for the plan with this id (built-in or saved).
pub fn settings_of(app: &AppHandle, id: &str) -> Result<serde_json::Value, String> {
    everything(read_plans(&plans_path(app)?))
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.settings())
        .ok_or_else(|| "that fine-tune plan no longer exists: choose another".into())
}

#[tauri::command]
pub fn list_fine_tune_plans(
    app: AppHandle,
    runtime: State<'_, FineTunePlanRuntime>,
) -> Result<Vec<FineTunePlan>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the fine-tune plans lock was poisoned")?;
    Ok(everything(read_plans(&plans_path(&app)?)))
}

#[tauri::command]
pub fn save_fine_tune_plan(
    plan: FineTunePlan,
    app: AppHandle,
    runtime: State<'_, FineTunePlanRuntime>,
) -> Result<Vec<FineTunePlan>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the fine-tune plans lock was poisoned")?;
    let path = plans_path(&app)?;
    let next = upsert(&read_plans(&path), plan, || {
        format!("plan-{}", &Uuid::new_v4().simple().to_string()[..8])
    })?;
    write_plans(&path, &next)?;
    Ok(everything(next))
}

#[tauri::command]
pub fn delete_fine_tune_plan(
    id: String,
    app: AppHandle,
    runtime: State<'_, FineTunePlanRuntime>,
) -> Result<Vec<FineTunePlan>, String> {
    if id.starts_with(BUILT_IN_PREFIX) {
        return Err("a built-in plan cannot be deleted".into());
    }
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the fine-tune plans lock was poisoned")?;
    let path = plans_path(&app)?;
    let mut saved = read_plans(&path);
    let before = saved.len();
    saved.retain(|p| p.id != id);
    if saved.len() == before {
        return Err("there is no such plan".into());
    }
    write_plans(&path, &saved)?;
    Ok(everything(saved))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mine() -> FineTunePlan {
        FineTunePlan {
            id: String::new(),
            name: "Mine".into(),
            description: String::new(),
            epochs: 20,
            learning_rate: Some(0.001),
            freeze: "none".into(),
            built_in: false,
        }
    }

    #[test]
    fn the_built_in_plans_are_valid_and_become_trainer_settings() {
        for plan in built_in_plans() {
            validate(&plan).unwrap();
            assert!(plan.built_in && plan.id.starts_with(BUILT_IN_PREFIX));
        }
        let head = built_in_plans()
            .into_iter()
            .find(|p| p.id == "builtin-head")
            .unwrap();
        assert_eq!(
            head.settings(),
            serde_json::json!({ "epochs": 30, "freeze": "allButOutput" })
        );
        assert_eq!(
            mine().settings(),
            serde_json::json!({ "epochs": 20, "freeze": "none", "learningRate": 0.001 })
        );
    }

    #[test]
    fn invalid_plans_are_refused() {
        for bad in [
            FineTunePlan {
                name: " ".into(),
                ..mine()
            },
            FineTunePlan {
                epochs: 0,
                ..mine()
            },
            FineTunePlan {
                epochs: 501,
                ..mine()
            },
            FineTunePlan {
                learning_rate: Some(1.0),
                ..mine()
            },
            FineTunePlan {
                learning_rate: Some(f64::NAN),
                ..mine()
            },
            FineTunePlan {
                freeze: "some".into(),
                ..mine()
            },
        ] {
            assert!(validate(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn upsert_keeps_names_unique_and_built_ins_untouched() {
        let first = upsert(&[], mine(), || "plan-1".into()).unwrap();
        assert_eq!(first[0].id, "plan-1");
        assert!(
            upsert(
                &first,
                FineTunePlan {
                    name: "mine".into(),
                    ..mine()
                },
                || "plan-2".into()
            )
            .is_err()
        );
        assert!(
            upsert(
                &first,
                FineTunePlan {
                    name: "keep training".into(),
                    ..mine()
                },
                || "plan-2".into()
            )
            .is_err()
        );
        let renamed = upsert(
            &first,
            FineTunePlan {
                id: "plan-1".into(),
                name: "Renamed".into(),
                ..mine()
            },
            || unreachable!(),
        )
        .unwrap();
        assert_eq!((renamed.len(), renamed[0].name.as_str()), (1, "Renamed"));
        assert!(
            upsert(
                &first,
                FineTunePlan {
                    id: "builtin-head".into(),
                    ..mine()
                },
                || unreachable!()
            )
            .is_err()
        );
    }

    #[test]
    fn saved_plans_round_trip_and_unusable_ones_are_dropped() {
        let path =
            std::env::temp_dir().join(format!("plans-test-{}.json", Uuid::new_v4().simple()));
        let saved = upsert(&[], mine(), || "plan-1".into()).unwrap();
        write_plans(&path, &saved).unwrap();
        assert_eq!(read_plans(&path), saved);
        fs::write(&path, r#"[{"id":"builtin-x","name":"A","epochs":5,"freeze":"none"},{"id":"ok","name":"B","epochs":5,"freeze":"none"},{"id":"bad","name":"C","epochs":0,"freeze":"none"}]"#).unwrap();
        let kept = read_plans(&path);
        assert_eq!(
            kept.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["ok"]
        );
        let _ = fs::remove_file(&path);
        assert!(read_plans(&path).is_empty());
    }
}
