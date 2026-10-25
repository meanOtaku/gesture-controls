//! A model's mistakes, one by one: every start of its gesture it missed and every time it fired when it should not, on the
//! recordings it was tested on (or trained on), so each can be opened on the Labelling page and looked at.
//!
//! The model runs over each recording as the app runs it live (`labelling::replay`), and its detections are matched to the
//! starts exactly as in the final test (`sealed_test::assign`).

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;

use crate::dataset_files;
use crate::labelling;
use crate::model_lab;
use crate::sealed_test;

/// A false activation this close before a start rose too early for it, and this long after, too late.
const NEAR_BEFORE_MS: f64 = 500.0;
const NEAR_AFTER_MS: f64 = 2500.0;
/// Training takes a decision 880 ms after the moment it describes: what was going on then is what fooled the model.
const DECISION_DELAY_MS: f64 = 880.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mistake {
    /// "missed": a start no detection caught. "false": a detection that caught no start.
    pub kind: &'static str,
    /// The start that was missed, or when the false detection rose (ms after the recording's first sample).
    pub at_ms: f64,
    /// The highest score the model reached: while it should have caught a missed start, or during a false detection.
    pub peak: f64,
    /// For a false detection: "early" or "late" (for a start nearby), "repeat" (a start already caught) or "elsewhere".
    pub why: Option<&'static str>,
    /// The label in effect at the moment the model was judging; None where nothing was labelled.
    pub during: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMistakes {
    pub id: String,
    pub name: String,
    /// "test" or "train": what the model used this recording for.
    pub role: &'static str,
    pub minutes: f64,
    pub starts: usize,
    pub caught: usize,
    pub mistakes: Vec<Mistake>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MistakesReport {
    pub version: String,
    pub label: String,
    pub threshold: f64,
    pub recordings: Vec<RecordingMistakes>,
    /// Recordings the model used that are no longer in Model Lab.
    pub missing: Vec<String>,
}

fn peak_between(times: &[f64], scores: &[f64], from: f64, to: f64) -> f64 {
    times
        .iter()
        .zip(scores)
        .filter(|(t, _)| (from..=to).contains(*t))
        .map(|(_, s)| *s)
        .fold(0.0, f64::max)
}

fn label_at(holds: &[dataset_files::Hold], at: f64) -> Option<String> {
    holds.iter().find(|hold| (hold.start_ms..=hold.end_ms).contains(&at)).map(|hold| hold.label.clone())
}

/// The mistakes in one recording: `starts` are the gesture's starts, `holds` every labelled stretch, `replay` the run.
fn mistakes_in(starts: &[f64], holds: &[dataset_files::Hold], replay: &labelling::ModelReplay) -> (usize, Vec<Mistake>) {
    let counted = sealed_test::outside_left_out(&replay.detections.iter().map(|d| d.start_ms).collect::<Vec<_>>(), holds);
    let detections: Vec<&labelling::ManualInterval> = replay.detections.iter().filter(|d| counted.contains(&d.start_ms)).collect();
    let rises: Vec<f64> = detections.iter().map(|d| d.start_ms).collect();
    let assigned = sealed_test::assign(&rises, starts);
    let caught: Vec<bool> = (0..starts.len()).map(|i| assigned.contains(&Some(i))).collect();
    let mut mistakes = Vec::new();
    for (i, &start) in starts.iter().enumerate() {
        if !caught[i] {
            mistakes.push(Mistake {
                kind: "missed",
                at_ms: start,
                peak: peak_between(&replay.times_ms, &replay.scores, start, start + 1280.0),
                why: None,
                during: Some(replay.label.clone()),
            });
        }
    }
    for (detection, start) in detections.iter().zip(&assigned) {
        if start.is_some() {
            continue;
        }
        let rise = detection.start_ms;
        let nearest = starts
            .iter()
            .enumerate()
            .filter(|(_, s)| (-NEAR_BEFORE_MS..=NEAR_AFTER_MS).contains(&(rise - **s)))
            .min_by(|a, b| (rise - a.1 - DECISION_DELAY_MS).abs().total_cmp(&(rise - b.1 - DECISION_DELAY_MS).abs()));
        let why = match nearest {
            None => "elsewhere",
            Some((i, s)) if caught[i] && (680.0..=1280.0).contains(&(rise - s)) => "repeat",
            Some((_, s)) if rise - s < 680.0 => "early",
            Some((i, _)) if caught[i] => "repeat",
            Some(_) => "late",
        };
        mistakes.push(Mistake {
            kind: "false",
            at_ms: rise,
            peak: peak_between(&replay.times_ms, &replay.scores, rise, detection.end_ms.max(rise)),
            why: Some(why),
            during: label_at(holds, rise - DECISION_DELAY_MS),
        });
    }
    mistakes.sort_by(|a, b| a.at_ms.total_cmp(&b.at_ms));
    (caught.iter().filter(|c| **c).count(), mistakes)
}

/// Every mistake model version `version_id` makes on the recordings it was tested on, and with `include_training` on those
/// it trained on too (where it should do well: mistakes there usually mean a wrong label).
#[tauri::command]
pub async fn model_mistakes(version_id: String, include_training: bool, app: AppHandle) -> Result<MistakesReport, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(model_lab::MODEL_LAB_DIR_NAME);
    let datasets_dir = model_lab::datasets_dir(&app)?;
    let index = model_lab::load_index(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let (registry, version) = sealed_test::version_for_test(&dir, &version_id)?;
        let model_lab_core::ModelOrigin::Trained { run_id } = &version.origin else {
            return Err("this model was imported, so the app does not know which recordings it was tested on".into());
        };
        let snapshot = registry
            .runs
            .get(run_id)
            .and_then(|run| registry.snapshots.get(&run.snapshot_id))
            .ok_or("the training run behind this model is no longer in the registry")?;
        let mut wanted: Vec<(String, &'static str)> = snapshot.split.evaluation.iter().map(|id| (id.to_string(), "test")).collect();
        if include_training {
            wanted.extend(snapshot.split.train.iter().map(|id| (id.to_string(), "train")));
        }
        let label = version.label.to_string();
        let mut recordings = Vec::new();
        let mut missing = Vec::new();
        for (id, role) in wanted {
            let Some(dataset) = index.datasets.iter().find(|d| d.id == id) else {
                missing.push(id);
                continue;
            };
            let pair = labelling::pair_at(&model_lab::dataset_csv_path(&datasets_dir, &id))?;
            let (starts, duration_ms) = sealed_test::starts_of(&pair, &label)?;
            let (holds, _) = dataset_files::holds(&pair)?;
            let model = label_inference::load_version(&version, &dir)?;
            let replay = labelling::replay(&pair, vec![model])?.into_iter().next().ok_or("the model gave no result")?;
            let (caught, mistakes) = mistakes_in(&starts, &holds, &replay);
            recordings.push(RecordingMistakes {
                id,
                name: dataset.original_filename.clone(),
                role,
                minutes: duration_ms / 60_000.0,
                starts: starts.len(),
                caught,
                mistakes,
            });
        }
        Ok(MistakesReport { version: version_id, label, threshold: version.thresholds.activation, recordings, missing })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdPoint {
    pub threshold: f64,
    pub starts: usize,
    pub caught: usize,
    pub false_activations: usize,
    pub minutes: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdSweep {
    pub version: String,
    pub label: String,
    /// The model's own threshold.
    pub threshold: f64,
    pub points: Vec<ThresholdPoint>,
    pub recordings: usize,
}

/// How many starts model version `version_id` catches, and how many false activations it makes, at each threshold from
/// 0.30 to 0.95, on the recordings it was tested on: the trade-off its threshold picks a point on.
#[tauri::command]
pub async fn threshold_sweep(version_id: String, app: AppHandle) -> Result<ThresholdSweep, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(model_lab::MODEL_LAB_DIR_NAME);
    let datasets_dir = model_lab::datasets_dir(&app)?;
    let index = model_lab::load_index(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let (registry, version) = sealed_test::version_for_test(&dir, &version_id)?;
        let model_lab_core::ModelOrigin::Trained { run_id } = &version.origin else {
            return Err("this model was imported, so the app does not know which recordings it was tested on".into());
        };
        let snapshot = registry
            .runs
            .get(run_id)
            .and_then(|run| registry.snapshots.get(&run.snapshot_id))
            .ok_or("the training run behind this model is no longer in the registry")?;
        let label = version.label.to_string();
        let mut points: Vec<ThresholdPoint> = Vec::new();
        let mut recordings = 0;
        for id in snapshot.split.evaluation.iter().map(ToString::to_string) {
            if !index.datasets.iter().any(|d| d.id == id) {
                continue;
            }
            recordings += 1;
            let pair = labelling::pair_at(&model_lab::dataset_csv_path(&datasets_dir, &id))?;
            let (starts, duration_ms) = sealed_test::starts_of(&pair, &label)?;
            let (holds, _) = dataset_files::holds(&pair)?;
            let model = label_inference::load_version(&version, &dir)?;
            let replay = labelling::replay(&pair, vec![model])?.into_iter().next().ok_or("the model gave no result")?;
            for (i, point) in replay.sweep.iter().enumerate() {
                let rises = sealed_test::outside_left_out(&point.rises_ms, &holds);
                let caught = sealed_test::assign(&rises, &starts).iter().filter(|a| a.is_some()).count();
                if points.len() <= i {
                    points.push(ThresholdPoint { threshold: point.threshold, starts: 0, caught: 0, false_activations: 0, minutes: 0.0 });
                }
                let total = &mut points[i];
                total.starts += starts.len();
                total.caught += caught;
                total.false_activations += rises.len() - caught;
                total.minutes += duration_ms / 60_000.0;
            }
        }
        if recordings == 0 {
            return Err("none of the recordings this model was tested on is in Model Lab any more".into());
        }
        Ok(ThresholdSweep { version: version_id, label, threshold: version.thresholds.activation, points, recordings })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComparedRecording {
    pub id: String,
    pub name: String,
    pub minutes: f64,
    pub starts: usize,
    /// Caught and false activations for each model, in the order asked, at its own threshold.
    pub caught: Vec<usize>,
    pub false_activations: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub models: Vec<ThresholdSweep>,
    pub recordings: Vec<ComparedRecording>,
}

/// The recordings two models can be compared on: those either was tested on and neither trained on. Sorted.
fn fair_recordings(splits: &[&model_lab_core::Split]) -> Vec<String> {
    let trained: std::collections::BTreeSet<String> = splits.iter().flat_map(|s| s.train.iter().map(ToString::to_string)).collect();
    let tested: std::collections::BTreeSet<String> = splits.iter().flat_map(|s| s.evaluation.iter().map(ToString::to_string)).collect();
    tested.difference(&trained).cloned().collect()
}

/// Two (or more) model versions on the same recordings, ones none of them trained on: each recording's catches and false
/// activations for each, and each one's threshold trade-off over them all.
#[tauri::command]
pub async fn compare_models(version_ids: Vec<String>, app: AppHandle) -> Result<Comparison, String> {
    if version_ids.len() < 2 || version_ids.len() > 4 {
        return Err("compare two to four models".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(model_lab::MODEL_LAB_DIR_NAME);
    let datasets_dir = model_lab::datasets_dir(&app)?;
    let index = model_lab::load_index(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut versions = Vec::new();
        let mut registry = None;
        for id in &version_ids {
            let (loaded, version) = sealed_test::version_for_test(&dir, id)?;
            versions.push(version);
            registry = Some(loaded);
        }
        let registry = registry.ok_or("no model to compare")?;
        if versions.iter().any(|v| v.label != versions[0].label) {
            return Err("compare models of the same label: each is measured on that label's starts".into());
        }
        let mut splits = Vec::new();
        for version in &versions {
            let model_lab_core::ModelOrigin::Trained { run_id } = &version.origin else {
                return Err(format!("'{}' was imported, so the app does not know what it trained on", version.id));
            };
            let snapshot = registry
                .runs
                .get(run_id)
                .and_then(|run| registry.snapshots.get(&run.snapshot_id))
                .ok_or_else(|| format!("the training run behind '{}' is no longer in the registry", version.id))?;
            splits.push(&snapshot.split);
        }
        let ids: Vec<String> = fair_recordings(&splits).into_iter().filter(|id| index.datasets.iter().any(|d| &d.id == id)).collect();
        if ids.is_empty() {
            return Err("there is no recording that none of these models trained on: compare them on a sealed day with the final test instead".into());
        }
        let mut sweeps: Vec<ThresholdSweep> = versions
            .iter()
            .map(|v| ThresholdSweep { version: v.id.to_string(), label: v.label.to_string(), threshold: v.thresholds.activation, points: Vec::new(), recordings: ids.len() })
            .collect();
        let mut recordings = Vec::new();
        for id in &ids {
            let dataset = index.datasets.iter().find(|d| &d.id == id).ok_or("a recording went missing")?;
            let pair = labelling::pair_at(&model_lab::dataset_csv_path(&datasets_dir, id))?;
            let (holds, duration_ms) = dataset_files::holds(&pair)?;
            let mut row = ComparedRecording { id: id.clone(), name: dataset.original_filename.clone(), minutes: duration_ms / 60_000.0, starts: 0, caught: Vec::new(), false_activations: Vec::new() };
            for (version, sweep) in versions.iter().zip(sweeps.iter_mut()) {
                let label = version.label.to_string();
                let (starts, _) = sealed_test::starts_of(&pair, &label)?;
                row.starts = starts.len();
                let model = label_inference::load_version(version, &dir)?;
                let replay = labelling::replay(&pair, vec![model])?.into_iter().next().ok_or("the model gave no result")?;
                let own = sealed_test::outside_left_out(&replay.detections.iter().map(|d| d.start_ms).collect::<Vec<_>>(), &holds);
                let caught = sealed_test::assign(&own, &starts).iter().filter(|a| a.is_some()).count();
                row.caught.push(caught);
                row.false_activations.push(own.len() - caught);
                for (i, point) in replay.sweep.iter().enumerate() {
                    let rises = sealed_test::outside_left_out(&point.rises_ms, &holds);
                    let hit = sealed_test::assign(&rises, &starts).iter().filter(|a| a.is_some()).count();
                    if sweep.points.len() <= i {
                        sweep.points.push(ThresholdPoint { threshold: point.threshold, starts: 0, caught: 0, false_activations: 0, minutes: 0.0 });
                    }
                    let total = &mut sweep.points[i];
                    total.starts += starts.len();
                    total.caught += hit;
                    total.false_activations += rises.len() - hit;
                    total.minutes += duration_ms / 60_000.0;
                }
            }
            recordings.push(row);
        }
        Ok(Comparison { models: sweeps, recordings })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replay(detections: &[(f64, f64)], times: &[f64], scores: &[f64]) -> labelling::ModelReplay {
        labelling::ModelReplay {
            label: "pinch".into(),
            version: "v".into(),
            threshold: 0.6,
            times_ms: times.to_vec(),
            scores: scores.to_vec(),
            detections: detections.iter().map(|&(start_ms, end_ms)| labelling::ManualInterval { start_ms, end_ms, label: "pinch".into() }).collect(),
            rejections: Vec::new(),
            sweep: Vec::new(),
        }
    }

    #[test]
    fn each_miss_and_false_detection_is_listed_with_why_and_what_was_going_on() {
        // Starts at 0, 10 s and 20 s. Caught: 0 (at 900 ms). Too early for 10 s (at 10.3 s); a repeat of 0 (at 1.2 s); and
        // at 35 s, during typing (labelled from 33 to 40 s).
        let starts = [0.0, 10_000.0, 20_000.0];
        let holds = vec![dataset_files::Hold { label: "typing".into(), start_ms: 33_000.0, end_ms: 40_000.0 }];
        let times = [900.0, 10_300.0, 20_500.0, 35_000.0];
        let scores = [0.9, 0.7, 0.4, 0.8];
        let run = replay(&[(900.0, 1000.0), (1200.0, 1300.0), (10_300.0, 10_400.0), (35_000.0, 35_100.0)], &times, &scores);
        let (caught, mistakes) = mistakes_in(&starts, &holds, &run);
        assert_eq!(caught, 1);
        let shown: Vec<_> = mistakes.iter().map(|m| (m.kind, m.at_ms, m.why, m.during.as_deref())).collect();
        assert_eq!(
            shown,
            [
                ("false", 1200.0, Some("repeat"), None),
                ("missed", 10_000.0, None, Some("pinch")),
                ("false", 10_300.0, Some("early"), None),
                ("missed", 20_000.0, None, Some("pinch")),
                ("false", 35_000.0, Some("elsewhere"), Some("typing")),
            ]
        );
        // The miss at 10 s peaked at 0.7 (its early detection), the one at 20 s only reached 0.4.
        assert_eq!(mistakes[1].peak, 0.7);
        assert_eq!(mistakes[3].peak, 0.4);
    }

    #[test]
    fn models_are_compared_only_on_recordings_none_of_them_trained_on() {
        let id = |s: &str| model_lab_core::RecordingId::new(s.to_string()).unwrap();
        let a = model_lab_core::Split { train: vec![id("r1"), id("r2")], evaluation: vec![id("r3"), id("r4")] };
        let b = model_lab_core::Split { train: vec![id("r1"), id("r3")], evaluation: vec![id("r2"), id("r5")] };
        // r3 trained b and r2 trained a: only r4 and r5 are new to both.
        assert_eq!(fair_recordings(&[&a, &b]), ["r4", "r5"]);
    }

    #[test]
    fn a_detection_judging_a_stretch_left_out_is_no_mistake() {
        let holds = vec![dataset_files::Hold { label: dataset_files::LEFT_OUT_LABEL.into(), start_ms: 30_000.0, end_ms: 40_000.0 }];
        let run = replay(&[(35_000.0, 35_100.0), (45_000.0, 45_100.0)], &[35_000.0, 45_000.0], &[0.8, 0.8]);
        let (_, mistakes) = mistakes_in(&[], &holds, &run);
        assert_eq!(mistakes.iter().map(|m| m.at_ms).collect::<Vec<_>>(), [45_000.0]);
    }
}
