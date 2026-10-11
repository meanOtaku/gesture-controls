//! The rounds of correcting a model with the camera: after each recording the camera marked, how the model did against it
//! (holds the camera saw, how many the model found or missed, false alarms), so improvement from round to round can be
//! seen. Kept in `app_data/model-lab/correction-rounds.json`; nothing here affects any model.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::model_lab::MODEL_LAB_DIR_NAME;

const FILE_NAME: &str = "correction-rounds.json";
const MAX_ROUNDS: usize = 500;

/// How a model did against the camera over a round.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub model_id: String,
    pub holds: u32,
    pub found: u32,
    pub missed: u32,
    pub false_alarms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionRound {
    #[serde(default)]
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub saved_at: String,
    /// The recording the round made, when it was added to the training data.
    #[serde(default)]
    pub recording_id: Option<String>,
    /// The active model during the round.
    pub active: Tally,
    /// A model run beside it, when there was one.
    #[serde(default)]
    pub candidate: Option<Tally>,
}

#[derive(Default)]
pub struct CorrectionRoundRuntime {
    lock: Mutex<()>,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(MODEL_LAB_DIR_NAME).join(FILE_NAME))
        .map_err(|e| e.to_string())
}

fn read(path: &std::path::Path) -> Vec<CorrectionRound> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn check(round: &CorrectionRound) -> Result<(), String> {
    let tally_ok = |t: &Tally| {
        !t.model_id.is_empty() && t.model_id.len() <= 80 && t.found + t.missed == t.holds
    };
    if round.label.is_empty() || round.label.len() > 80 {
        return Err("a round needs a label".into());
    }
    if !tally_ok(&round.active) || !round.candidate.as_ref().is_none_or(tally_ok) {
        return Err(
            "a round's counts do not add up: the holds are the ones found plus the ones missed"
                .into(),
        );
    }
    Ok(())
}

/// Adds a round (the oldest are dropped past a limit) and returns that label's rounds, oldest first.
pub fn add(
    rounds: &mut Vec<CorrectionRound>,
    mut round: CorrectionRound,
    now: &str,
    id: String,
) -> Result<(), String> {
    check(&round)?;
    round.id = id;
    round.saved_at = now.to_string();
    rounds.push(round);
    if rounds.len() > MAX_ROUNDS {
        rounds.remove(0);
    }
    Ok(())
}

#[tauri::command]
pub fn save_correction_round(
    round: CorrectionRound,
    app: AppHandle,
    runtime: State<'_, CorrectionRoundRuntime>,
) -> Result<(), String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the rounds lock was poisoned")?;
    let path = path(&app)?;
    let mut rounds = read(&path);
    add(
        &mut rounds,
        round,
        &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        format!("round-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_string_pretty(&rounds).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The rounds for a label, oldest first.
#[tauri::command]
pub fn list_correction_rounds(
    label: String,
    app: AppHandle,
    runtime: State<'_, CorrectionRoundRuntime>,
) -> Result<Vec<CorrectionRound>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the rounds lock was poisoned")?;
    Ok(read(&path(&app)?)
        .into_iter()
        .filter(|r| r.label == label)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tally(model: &str, found: u32, missed: u32, false_alarms: u32) -> Tally {
        Tally {
            model_id: model.into(),
            holds: found + missed,
            found,
            missed,
            false_alarms,
        }
    }

    fn round(label: &str) -> CorrectionRound {
        CorrectionRound {
            id: String::new(),
            label: label.into(),
            saved_at: String::new(),
            recording_id: None,
            active: tally("m1", 4, 2, 3),
            candidate: Some(tally("m2", 5, 1, 0)),
        }
    }

    #[test]
    fn a_round_is_stamped_and_kept_and_the_oldest_go_past_the_limit() {
        let mut rounds = Vec::new();
        add(
            &mut rounds,
            round("snap"),
            "2026-10-12T10:00:00Z",
            "round-1".into(),
        )
        .unwrap();
        assert_eq!(
            (rounds[0].id.as_str(), rounds[0].saved_at.as_str()),
            ("round-1", "2026-10-12T10:00:00Z")
        );
        for n in 0..MAX_ROUNDS {
            add(&mut rounds, round("snap"), "t", format!("r{n}")).unwrap();
        }
        assert_eq!(rounds.len(), MAX_ROUNDS);
        assert_eq!(rounds[0].id, "r0");
    }

    #[test]
    fn counts_that_do_not_add_up_or_a_missing_label_are_refused() {
        let mut rounds = Vec::new();
        let mut bad = round("snap");
        bad.active.holds = 99;
        assert!(add(&mut rounds, bad, "t", "x".into()).is_err());
        let mut bad = round("snap");
        bad.candidate.as_mut().unwrap().holds = 1;
        assert!(add(&mut rounds, bad, "t", "x".into()).is_err());
        assert!(add(&mut rounds, round(""), "t", "x".into()).is_err());
        assert!(rounds.is_empty());
    }
}
