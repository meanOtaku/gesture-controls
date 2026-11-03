//! The final test: a trained model run over the recordings sealed for it, as the app runs it live.
//!
//! A sealed recording (`DatasetSummary::sealed`) is never trained on, so the model, its threshold and its trigger were all
//! chosen without it: how the model does here is the closest thing to how it will do on a new day. Each test is logged
//! (`sealed-tests.json`), and the report says how often the sealed recordings were tested before, since every look makes
//! them a little less untouched.
//!
//! A gesture's starts are counted as the trainer counts them: runs of the label each row trains on (its hand label where it
//! has one), joined across gaps under 400 ms, kept when they last at least 200 ms. A detection catches a start when it rises
//! 680 to 1,280 ms after it (the one closest to 880 ms, each start caught once); any other is a repeat, late, or a false
//! activation, as `detector_events` counts them.

use std::fs;
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::dataset_files::{self, Pair};
use crate::detector_events::{self, EventTotals, Judged};
use crate::labelling;
use crate::model_lab;

const LOG_FILE: &str = "sealed-tests.json";
const CATCH_FROM_MS: f64 = 680.0;
pub(crate) const CATCH_TO_MS: f64 = 1280.0;
const CATCH_AT_MS: f64 = 880.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SealedRecordingResult {
    pub id: String,
    pub name: String,
    /// "camera", "estimated", "unknown" or "noGesture" (`detector_events::timing_of`).
    pub label_timing: &'static str,
    #[serde(flatten)]
    pub events: EventTotals,
    pub minutes: f64,
    /// Median delay from a start to the detection that caught it.
    pub median_latency_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SealedTestReport {
    pub version: String,
    pub label: String,
    pub threshold: f64,
    pub tested_at: String,
    pub recordings: Vec<SealedRecordingResult>,
    /// The totals, judged on the camera-timed recordings when there are enough of them (`detector_events::judge`).
    pub events: Judged,
    pub minutes: f64,
    /// How many earlier final tests used any of these recordings.
    pub earlier_tests: usize,
}

/// One line of the test log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SealedTestLog {
    pub tested_at: String,
    pub version: String,
    pub label: String,
    pub recordings: Vec<String>,
    pub starts: usize,
    pub caught: usize,
    pub false_activations: usize,
    pub minutes: f64,
    /// Time with no gesture under way, the denominator of the false activations; None in a test logged before it was kept,
    /// whose false activations were counted against the whole recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub negative_seconds: Option<f64>,
    #[serde(default)]
    pub repeats: usize,
    #[serde(default)]
    pub late: usize,
    /// Which recordings the totals cover ("camera" or "all"); None before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cohort: Option<String>,
}

/// The starts of `label` in a recording (ms after its first sample), as the trainer counts them, and how long it is.
pub(crate) fn starts_of(pair: &Pair, label: &str) -> Result<(Vec<f64>, f64), String> {
    let (all, duration) = dataset_files::holds(pair)?;
    let starts = all
        .into_iter()
        .filter(|hold| hold.label == label && hold.end_ms - hold.start_ms >= dataset_files::MIN_HOLD_MS)
        .map(|hold| hold.start_ms)
        .collect();
    Ok((starts, duration))
}

/// For each detection, in order, the unmatched start it catches: one it rises 680 to 1,280 ms after (the one closest to
/// 880 ms). None for a false activation.
pub(crate) fn assign(detections: &[f64], starts: &[f64]) -> Vec<Option<usize>> {
    let mut used = vec![false; starts.len()];
    detections
        .iter()
        .map(|&detection| {
            let best = starts
                .iter()
                .enumerate()
                .filter(|(i, start)| !used[*i] && (CATCH_FROM_MS..=CATCH_TO_MS).contains(&(detection - **start)))
                .min_by(|a, b| ((detection - a.1) - CATCH_AT_MS).abs().total_cmp(&((detection - b.1) - CATCH_AT_MS).abs()))
                .map(|(i, _)| i);
            if let Some(i) = best {
                used[i] = true;
            }
            best
        })
        .collect()
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 1 { values[mid] } else { (values[mid - 1] + values[mid]) / 2.0 })
}

/// The detections that count: not those judging a moment inside a stretch left out on the Labelling page, which is
/// neither the gesture nor not it. A detection judges the moment 880 ms before it, as training does.
pub(crate) fn outside_left_out(detections: &[f64], holds: &[dataset_files::Hold]) -> Vec<f64> {
    detections
        .iter()
        .copied()
        .filter(|&at| {
            !holds
                .iter()
                .any(|hold| hold.label == dataset_files::LEFT_OUT_LABEL && (hold.start_ms..=hold.end_ms).contains(&(at - CATCH_AT_MS)))
        })
        .collect()
}

/// The stretch a replay judged: its first and last score, or the whole recording when it scored nothing.
pub(crate) fn judged_span(replay: &labelling::ModelReplay, duration_ms: f64) -> (f64, f64) {
    match (replay.times_ms.first(), replay.times_ms.last()) {
        (Some(first), Some(last)) => (*first, *last),
        _ => (0.0, duration_ms),
    }
}

/// The labels the training behind `version` left out (mapped to Exclude); none for an imported model.
pub(crate) fn excluded_labels(registry: &model_lab_core::Registry, version: &model_lab_core::ModelVersion) -> Vec<String> {
    let model_lab_core::ModelOrigin::Trained { run_id } = &version.origin else {
        return Vec::new();
    };
    registry
        .runs
        .get(run_id)
        .and_then(|run| registry.snapshots.get(&run.snapshot_id))
        .map(|snapshot| snapshot.mapping.labels_with(model_lab_core::ExampleRole::Exclude).map(ToString::to_string).collect())
        .unwrap_or_default()
}

/// One recording's result for a model: its counted detections, its length in minutes, and the delay of each catch.
fn test_recording(pair: &Pair, model: label_inference::LoadedModel, excluded: &[String]) -> Result<(EventTotals, f64, Vec<f64>), String> {
    let label = model.label.to_string();
    let (starts, duration_ms) = starts_of(pair, &label)?;
    let replay = labelling::replay(pair, vec![model])?.into_iter().next().ok_or("the model gave no result")?;
    let (holds, _) = dataset_files::holds(pair)?;
    let rises: Vec<f64> = replay.detections.iter().map(|d| d.start_ms).collect();
    let counted = detector_events::count(&rises, &starts, &holds, &label, excluded, judged_span(&replay, duration_ms));
    let delays = counted.latencies(&starts);
    Ok((counted.totals, duration_ms / 60_000.0, delays))
}

/// The registry and model version `version_id`, made loadable for a test whatever its state: nothing is saved, and
/// nothing acts on it.
pub(crate) fn version_for_test(dir: &Path, version_id: &str) -> Result<(model_lab_core::Registry, model_lab_core::ModelVersion), String> {
    let registry = model_lab_core::load_registry_file(&dir.join("registry-v2.json"))
        .map_err(|e| e.to_string())?
        .ok_or("there is no model registry yet")?;
    let id = model_lab_core::ModelVersionId::new(version_id.to_string()).map_err(|e| e.to_string())?;
    let mut version = registry.versions.get(&id).cloned().ok_or_else(|| format!("there is no model '{version_id}'"))?;
    version.state = model_lab_core::LifecycleState::Active;
    version.monitor_only = true;
    Ok((registry, version))
}

fn read_log(path: &Path) -> Vec<SealedTestLog> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Every final test so far, newest last.
#[tauri::command]
pub fn list_sealed_tests(app: AppHandle) -> Result<Vec<SealedTestLog>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(model_lab::MODEL_LAB_DIR_NAME);
    Ok(read_log(&dir.join(LOG_FILE)))
}

/// Runs model version `version_id` over every sealed recording, as the app runs it live, and logs the test. The version need
/// not be active: it is loaded for this test only, and nothing about it changes.
#[tauri::command]
pub async fn test_model_on_sealed(version_id: String, app: AppHandle) -> Result<SealedTestReport, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(model_lab::MODEL_LAB_DIR_NAME);
    let datasets_dir = model_lab::datasets_dir(&app)?;
    let sealed: Vec<model_lab::DatasetSummary> = model_lab::described_index(&app).datasets.into_iter().filter(|d| d.sealed).collect();
    if sealed.is_empty() {
        return Err("no recording is sealed: seal the recordings of a day you have not trained on, then test".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (registry, version) = version_for_test(&dir, &version_id)?;
        let excluded = excluded_labels(&registry, &version);
        let mut recordings = Vec::new();
        for dataset in &sealed {
            let pair = labelling::pair_at(&model_lab::dataset_csv_path(&datasets_dir, &dataset.id))?;
            let model = label_inference::load_version(&version, &dir)?;
            let (events, minutes, mut delays) = test_recording(&pair, model, &excluded)?;
            recordings.push(SealedRecordingResult {
                id: dataset.id.clone(),
                name: dataset.original_filename.clone(),
                label_timing: detector_events::timing_of(dataset, &version.label.to_string()),
                events,
                minutes,
                median_latency_ms: median(&mut delays),
            });
        }
        let log_path = dir.join(LOG_FILE);
        let mut log = read_log(&log_path);
        let ids: Vec<String> = recordings.iter().map(|r| r.id.clone()).collect();
        let earlier_tests = log.iter().filter(|entry| entry.recordings.iter().any(|id| ids.contains(id))).count();
        let report = SealedTestReport {
            version: version_id.clone(),
            label: version.label.to_string(),
            threshold: version.thresholds.activation,
            tested_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            events: detector_events::judge(&recordings.iter().map(|r| (r.label_timing, r.events.clone())).collect::<Vec<_>>()),
            minutes: recordings.iter().map(|r| r.minutes).sum(),
            recordings,
            earlier_tests,
        };
        log.push(SealedTestLog {
            tested_at: report.tested_at.clone(),
            version: report.version.clone(),
            label: report.label.clone(),
            recordings: ids,
            starts: report.events.totals.starts,
            caught: report.events.totals.caught,
            false_activations: report.events.totals.false_activations,
            minutes: report.minutes,
            negative_seconds: Some(report.events.totals.negative_seconds),
            repeats: report.events.totals.repeats,
            late: report.events.totals.late,
            cohort: Some(report.events.cohort.to_string()),
        });
        let tmp = log_path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&log).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &log_path).map_err(|e| e.to_string())?;
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_are_counted_as_the_trainer_counts_them() {
        // pinch 0-300 ms, a 100 ms gap, pinch again to 600 ms (one hold); then a 100 ms pinch (too short) at 1000 ms; a
        // hand-labelled pinch at 2000-2400 ms over a recorded fist; and a recorded pinch at 3000-3400 ms marked "nothing here".
        let mut ppg = vec![dataset_files::ppg_header()];
        let mut push = |ms: i64, label: &str, manual: &str| ppg.push(format!("{},1,1,2,3,0,{label},{manual}", 1_000_000_000 + ms * 1_000_000));
        for ms in (0..=300).step_by(20) { push(ms, "pinch", ""); }
        for ms in (320..=380).step_by(20) { push(ms, "", ""); }
        for ms in (400..=600).step_by(20) { push(ms, "pinch", ""); }
        for ms in (620..=980).step_by(20) { push(ms, "", ""); }
        for ms in (1000..=1100).step_by(20) { push(ms, "pinch", ""); }
        for ms in (1120..=1980).step_by(20) { push(ms, "", ""); }
        for ms in (2000..=2400).step_by(20) { push(ms, "fist", "pinch"); }
        for ms in (2420..=2980).step_by(20) { push(ms, "", ""); }
        for ms in (3000..=3400).step_by(20) { push(ms, "pinch", dataset_files::NO_LABEL); }
        let pair = dataset_files::parse_pair_with(&(ppg.join("\n") + "\n"), &format!("{}\n", dataset_files::imu_header()), false).unwrap();
        let (starts, duration) = starts_of(&pair, "pinch").unwrap();
        assert_eq!(starts, [0.0, 2000.0]);
        assert_eq!(duration, 3400.0);
    }

    #[test]
    fn a_detection_catches_the_start_it_rises_680_to_1280_ms_after_and_each_start_once() {
        // 900 ms catches the start at 0; 950 ms finds it taken; 5 s is near no start; 9.2 s catches the start at 8 s, and 9.3 s
        // would be too late for it.
        assert_eq!(assign(&[900.0, 950.0, 5000.0, 9200.0], &[0.0, 8000.0]), [Some(0), None, None, Some(1)]);
        assert_eq!(assign(&[9300.0], &[8000.0]), [None]);
    }

    #[test]
    fn a_test_logged_before_false_activations_were_counted_per_hour_still_reads() {
        let old = r#"[{"testedAt":"2026-10-23T10:00:00Z","version":"v1","label":"pinch","recordings":["s1"],"starts":20,"caught":5,"falseActivations":3,"minutes":2.0}]"#;
        let log: Vec<SealedTestLog> = serde_json::from_str(old).unwrap();
        assert_eq!((log[0].negative_seconds, log[0].repeats, log[0].cohort.as_deref()), (None, 0, None));
    }
}
