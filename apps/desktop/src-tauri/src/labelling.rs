//! The Labelling page's backend: opens a recording (a Model Lab recording, a dataset folder or a single dataset CSV) for
//! labelling by hand, saves the labels as a new version of it in Model Lab, and exports it.
//!
//! The page owns the manual labels while you work, as intervals of time over the whole recording; they are applied here to
//! every row of both files that falls inside one (`manual_label`, see `dataset_files::effective_label`). The source is never
//! changed: saving makes a new recording that names the one it came from, so models trained on the original stay tied to
//! the data they learned from.
//!
//! Times cross to the page as milliseconds after the recording's first sample, which a JavaScript number holds exactly
//! enough; the watch's nanosecond timestamps would not fit.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::dataset_files::{self, NO_LABEL, Pair};
use crate::model_lab::{self, DatasetSummary, ModelLabRuntime};

/// The largest file opened for labelling: a long session at the watch's rates is well under this.
const MAX_SOURCE_BYTES: u64 = 200 * 1024 * 1024;

/// What to label: a recording in Model Lab, or a dataset folder or CSV file on disk.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LabellingSource {
    Dataset { id: String },
    File { path: String },
}

/// A span of the recording labelled by hand, in milliseconds after its first sample. `label` is a label id, [`NO_LABEL`]
/// ("nothing here"), or empty to take a hand label away (the row then trains on its `label` again).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualInterval {
    pub start_ms: f64,
    pub end_ms: f64,
    pub label: String,
}

/// One column of one sensor's file: a value per row, `None` where it was blank.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabellingColumn {
    pub name: String,
    pub values: Vec<Option<f64>>,
}

/// One sensor's rows: when each was taken (milliseconds after the recording's first sample) and its columns.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabellingStream {
    pub times_ms: Vec<f64>,
    pub columns: Vec<LabellingColumn>,
}

/// A recording opened for labelling.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabellingRecording {
    pub name: String,
    pub source: LabellingSource,
    pub duration_ms: f64,
    /// The first sample's timestamp (watch clock, ns), the zero of every time here. A string: JavaScript cannot hold it exactly.
    pub origin_ns: String,
    pub ppg: LabellingStream,
    pub imu: LabellingStream,
    /// The spans of each `label` (from the recorder or the camera), over both files in time order.
    pub label_intervals: Vec<ManualInterval>,
    /// The spans of each manual label already in the files.
    pub manual_intervals: Vec<ManualInterval>,
    /// How the session was recorded, from the files' `# context.` lines.
    pub context: std::collections::BTreeMap<String, String>,
}

/// Where an export goes: a new folder of two files in `parent` (named `name`, numbered if taken), or one CSV file at `path`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportTarget {
    Folder { parent: String, name: String },
    Csv { path: String },
}

fn read_limited(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|_| format!("{} does not exist", path.display()))?;
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "{} is over the {} MB a recording opened for labelling may be",
            path.display(),
            MAX_SOURCE_BYTES / 1024 / 1024
        ));
    }
    fs::read_to_string(path).map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// A folder's two files, or a single dataset CSV, as a validated pair (no label required).
pub(crate) fn pair_at(path: &Path) -> Result<Pair, String> {
    if path.is_dir() {
        dataset_files::parse_pair_with(
            &read_limited(&path.join(dataset_files::PPG_FILE))?,
            &read_limited(&path.join(dataset_files::IMU_FILE))?,
            false,
        )
    } else {
        dataset_files::split_legacy_with(&read_limited(path)?, false)
    }
}

/// The source's files and the name it is shown and saved under.
fn load(app: &AppHandle, source: &LabellingSource) -> Result<(Pair, String), String> {
    match source {
        LabellingSource::Dataset { id } => {
            let index = model_lab::load_index(app);
            let summary = index
                .datasets
                .iter()
                .find(|d| &d.id == id)
                .ok_or("that recording is no longer in Model Lab")?;
            let dir = model_lab::datasets_dir(app)?;
            let pair = pair_at(&model_lab::dataset_csv_path(&dir, id))?;
            Ok((pair, summary.original_filename.clone()))
        }
        LabellingSource::File { path } => {
            let path = PathBuf::from(path);
            let name = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("recording")
                .to_string();
            Ok((pair_at(&path)?, name))
        }
    }
}

/// The first sample of either file, the time every other is measured from.
pub(crate) fn origin_of(ppg: &dataset_files::Rows, imu: &dataset_files::Rows) -> i128 {
    ppg.rows
        .iter()
        .chain(&imu.rows)
        .map(|row| row.stamp)
        .min()
        .unwrap_or(0)
}

pub(crate) fn ms_after(stamp: i128, origin: i128) -> f64 {
    (stamp - origin) as f64 / 1e6
}

/// The columns of a file that hold values: every one but the timestamp, the sequence and the two labels.
fn stream(rows: &dataset_files::Rows, header: &[&str], origin: i128) -> LabellingStream {
    let values = 2..header.len() - 2;
    let mut columns: Vec<LabellingColumn> = header[values.clone()]
        .iter()
        .map(|name| LabellingColumn {
            name: (*name).to_string(),
            values: Vec::with_capacity(rows.rows.len()),
        })
        .collect();
    for row in &rows.rows {
        let fields: Vec<&str> = row.line.split(',').collect();
        for (column, field) in columns.iter_mut().zip(&fields[values.clone()]) {
            column.values.push(field.trim().parse::<f64>().ok().filter(|v| v.is_finite()));
        }
    }
    LabellingStream {
        times_ms: rows.rows.iter().map(|row| ms_after(row.stamp, origin)).collect(),
        columns,
    }
}

/// The spans of one kind of label over both files in time order: a span runs while consecutive rows carry the same
/// non-empty label, from the first such row to the last.
fn spans(
    ppg: &dataset_files::Rows,
    imu: &dataset_files::Rows,
    origin: i128,
    which: impl Fn(&dataset_files::Row) -> &str,
) -> Vec<ManualInterval> {
    let mut rows: Vec<&dataset_files::Row> = ppg.rows.iter().chain(&imu.rows).collect();
    rows.sort_by_key(|row| row.stamp);
    let mut out: Vec<ManualInterval> = Vec::new();
    let mut open: Option<ManualInterval> = None;
    for row in rows {
        let label = which(row);
        let at = ms_after(row.stamp, origin);
        match &mut open {
            Some(span) if span.label == label => span.end_ms = at,
            _ => {
                out.extend(open.take());
                if !label.is_empty() {
                    open = Some(ManualInterval {
                        start_ms: at,
                        end_ms: at,
                        label: label.to_string(),
                    });
                }
            }
        }
    }
    out.extend(open);
    out
}

/// The recording as the page shows it.
fn view(pair: &Pair, name: String, source: LabellingSource) -> Result<LabellingRecording, String> {
    let ppg = dataset_files::read_ppg(&pair.ppg_csv)?;
    let imu = dataset_files::read_imu(&pair.imu_csv)?;
    let origin = origin_of(&ppg, &imu);
    let end = ppg
        .rows
        .iter()
        .chain(&imu.rows)
        .map(|row| row.stamp)
        .max()
        .unwrap_or(origin);
    Ok(LabellingRecording {
        name,
        source,
        duration_ms: ms_after(end, origin),
        origin_ns: origin.to_string(),
        ppg: stream(&ppg, &dataset_files::PPG_HEADER, origin),
        imu: stream(&imu, &dataset_files::IMU_HEADER, origin),
        label_intervals: spans(&ppg, &imu, origin, |row| row.label.as_str()),
        manual_intervals: spans(&ppg, &imu, origin, |row| row.manual.as_str()),
        context: pair.context.clone(),
    })
}

/// The manual label of a row at `at_ms`: that of the last interval covering it, or none.
fn manual_at(intervals: &[ManualInterval], at_ms: f64) -> &str {
    intervals
        .iter()
        .rev()
        .find(|span| span.start_ms <= at_ms && at_ms <= span.end_ms)
        .map_or("", |span| span.label.as_str())
}

/// The pair with its manual labels replaced by `intervals` (later ones over earlier ones), every other cell as it was.
fn with_manual(pair: &Pair, intervals: &[ManualInterval]) -> Result<(String, String), String> {
    for span in intervals {
        let label = span.label.as_str();
        let plain = label.is_empty()
            || label == NO_LABEL
            || label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !plain || !(span.start_ms.is_finite() && span.end_ms.is_finite()) || span.end_ms < span.start_ms {
            return Err(format!("the span '{label}' from {} to {} ms is not one that can be saved", span.start_ms, span.end_ms));
        }
    }
    let ppg = dataset_files::read_ppg(&pair.ppg_csv)?;
    let imu = dataset_files::read_imu(&pair.imu_csv)?;
    let origin = origin_of(&ppg, &imu);
    let rewrite = |rows: &dataset_files::Rows, header: String| {
        let mut out: Vec<String> = rows.comments.iter().map(ToString::to_string).collect();
        out.push(header);
        for row in &rows.rows {
            // Every column but the last (the manual label) is kept as it was.
            let kept = &row.line[..row.line.rfind(',').unwrap_or(row.line.len())];
            out.push(format!("{kept},{}", manual_at(intervals, ms_after(row.stamp, origin))));
        }
        out.join("\n") + "\n"
    };
    Ok((
        rewrite(&ppg, dataset_files::ppg_header()),
        rewrite(&imu, dataset_files::imu_header()),
    ))
}

/// Opens a recording for labelling. Nothing is required of its labels: a recording with none is what this page is for.
#[tauri::command]
pub fn open_labelling_recording(source: LabellingSource, app: AppHandle) -> Result<LabellingRecording, String> {
    let (pair, name) = load(&app, &source)?;
    view(&pair, name, source)
}

/// Saves the recording with these manual labels as a new recording in Model Lab, named after the source, which stays as it
/// was. Its labels must be in the catalogue and at least one row must train on one, as for any recording added to Model Lab.
#[tauri::command]
pub fn save_labelling_version(
    source: LabellingSource,
    intervals: Vec<ManualInterval>,
    app: AppHandle,
    runtime: State<'_, ModelLabRuntime>,
) -> Result<DatasetSummary, String> {
    let (pair, name) = load(&app, &source)?;
    let (ppg_csv, imu_csv) = with_manual(&pair, &intervals)?;
    let labelled = dataset_files::parse_pair(&ppg_csv, &imu_csv)?;
    let derived_from = match &source {
        LabellingSource::Dataset { id } => Some(id.clone()),
        LabellingSource::File { .. } => None,
    };
    let filename = format!("{name} (labelled)");
    model_lab::store_pair(&app, &runtime, filename, labelled, None, None, derived_from)
}

/// Exports the recording with these manual labels: as a folder of two files (`ppg.csv`, `imu.csv`, `dataset.json`), never
/// overwriting one, or as one CSV with both `label` and `manual_label`. Returns where it was written.
#[tauri::command]
pub fn export_labelling_recording(
    source: LabellingSource,
    intervals: Vec<ManualInterval>,
    target: ExportTarget,
    app: AppHandle,
) -> Result<String, String> {
    let (pair, _) = load(&app, &source)?;
    let (ppg_csv, imu_csv) = with_manual(&pair, &intervals)?;
    match target {
        ExportTarget::Folder { parent, name } => model_lab::export_dataset_folder(parent, name, ppg_csv, imu_csv, None),
        ExportTarget::Csv { path } => {
            let single = dataset_files::merge_to_single(&ppg_csv, &imu_csv)?;
            fs::write(&path, single).map_err(|e| format!("could not write {path}: {e}"))?;
            Ok(path)
        }
    }
}

/// One active model run over the recording as the app runs it live: its score at each decision and its detections, in
/// milliseconds after the recording's first sample.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReplay {
    pub label: String,
    pub version: String,
    /// The score a detection starts at (its activation threshold).
    pub threshold: f64,
    pub times_ms: Vec<f64>,
    pub scores: Vec<f64>,
    pub detections: Vec<ManualInterval>,
    /// Why some stretches were not scored (a gap in the data, a stream that stopped), if any were; at most a few.
    pub rejections: Vec<String>,
    /// Where detections would start at other thresholds: these scores through the same detection rule, from `SWEEP_FROM`
    /// to `SWEEP_TO`. Close to a run at that threshold, but not exact where a stretch was not scored.
    pub sweep: Vec<SweepPoint>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SweepPoint {
    pub threshold: f64,
    pub rises_ms: Vec<f64>,
}

const SWEEP_FROM: f64 = 0.30;
const SWEEP_TO: f64 = 0.95;
const SWEEP_STEP: f64 = 0.05;

/// Where detections start when `scores` (at `times_ms`) go through the detection rule of `thresholds` with the activation
/// threshold at `activation` (and the release as far below it as before).
pub(crate) fn rises_at(times_ms: &[f64], scores: &[f64], thresholds: &model_lab_core::Thresholds, activation: f64) -> Vec<f64> {
    let gap = (thresholds.activation - thresholds.release).max(0.0);
    let moved = model_lab_core::Thresholds { activation, release: (activation - gap).max(0.0), ..*thresholds };
    let mut detector = label_inference::TemporalDetector::new(moved);
    times_ms
        .iter()
        .zip(scores)
        .filter(|(t, s)| detector.observe(**s, (**t * 1_000_000.0).max(0.0) as u64))
        .map(|(t, _)| *t)
        .collect()
}

fn sweep_of(times_ms: &[f64], scores: &[f64], thresholds: &model_lab_core::Thresholds) -> Vec<SweepPoint> {
    let steps = ((SWEEP_TO - SWEEP_FROM) / SWEEP_STEP).round() as usize;
    (0..=steps)
        .map(|i| (SWEEP_FROM + i as f64 * SWEEP_STEP) * 100.0)
        .map(|pct| pct.round() / 100.0)
        .map(|threshold| SweepPoint { threshold, rises_ms: rises_at(times_ms, scores, thresholds, threshold) })
        .collect()
}

/// The rows of a pair as the watch sends them, in the order they arrive: each pulse sample in a batch of its own sent the
/// moment it was taken, each motion sample 60 ms after it was taken (the streams are sent separately). The recording's
/// timestamps are all on the watch's clock, so a batch's send time is its sample's own.
pub(crate) fn replay(pair: &Pair, models: Vec<label_inference::LoadedModel>) -> Result<Vec<ModelReplay>, String> {
    use label_inference::{DetectionEvent, LabelRuntime, RuntimeMode};
    use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

    let ppg = dataset_files::read_ppg(&pair.ppg_csv)?;
    let imu = dataset_files::read_imu(&pair.imu_csv)?;
    let origin = origin_of(&ppg, &imu);
    let ms = |stamp: i128| ms_after(stamp, origin);
    let field = |line: &str, i: usize| line.split(',').nth(i).and_then(|v| v.trim().parse::<f64>().ok());
    // (arrival, pulse first on a tie, index)
    let mut arrivals: Vec<(i128, u8, usize)> = ppg.rows.iter().enumerate().map(|(i, r)| (r.stamp + 5_000_000, 0, i)).collect();
    arrivals.extend(imu.rows.iter().enumerate().map(|(i, r)| (r.stamp + 60_000_000, 1, i)));
    arrivals.sort();

    let mut results: Vec<ModelReplay> = models
        .iter()
        .map(|model| ModelReplay {
            label: model.label.to_string(),
            version: model.version_id.to_string(),
            threshold: model.thresholds.activation,
            times_ms: Vec::new(),
            scores: Vec::new(),
            detections: Vec::new(),
            rejections: Vec::new(),
            sweep: Vec::new(),
        })
        .collect();
    let thresholds: Vec<model_lab_core::Thresholds> = models.iter().map(|model| model.thresholds).collect();
    let mut runtime = LabelRuntime::default();
    runtime.set_models(models);
    runtime.set_mode(RuntimeMode::Monitor);
    let base: i128 = 10_000_000_000 - origin;
    let mut open: std::collections::BTreeMap<String, f64> = std::collections::BTreeMap::new();
    let mut previous_motion: Option<u64> = None;
    let mut previous_pulse: Option<u64> = None;
    for (arrival, kind, index) in arrivals {
        let received = u64::try_from(arrival + base).unwrap_or(0);
        let output = if kind == 0 {
            let row = &ppg.rows[index];
            let Ok(stamp) = u64::try_from(row.stamp) else { continue };
            if previous_pulse.is_some_and(|p| stamp <= p) {
                continue; // a repeated timestamp, which the watch never sends live
            }
            previous_pulse = Some(stamp);
            let value = |i| field(&row.line, i).unwrap_or(0.0) as i32;
            let status = field(&row.line, 5).unwrap_or(0.0) as i32;
            runtime.observe_ppg(
                &WatchPpgBatchSample {
                    device_id: "recording".into(),
                    sequence: index as u64,
                    timestamp_ns: stamp,
                    sample_count: 1,
                    timestamps_ns: vec![stamp],
                    green: vec![value(2)],
                    green_status: vec![status],
                    red: vec![value(3)],
                    red_status: vec![status],
                    ir: vec![value(4)],
                    ir_status: vec![status],
                },
                received,
            )
        } else {
            let row = &imu.rows[index];
            let Ok(stamp) = u64::try_from(row.stamp) else { continue };
            if previous_motion.is_some_and(|p| stamp <= p) {
                continue;
            }
            previous_motion = Some(stamp);
            let three = |from: usize| -> Option<[f64; 3]> { Some([field(&row.line, from)?, field(&row.line, from + 1)?, field(&row.line, from + 2)?]) };
            let quaternion = [8, 9, 10, 11].map(|i| field(&row.line, i).unwrap_or(0.0));
            runtime.observe_orientation(
                &WatchOrientationSample {
                    device_id: "recording".into(),
                    sequence: index as u64,
                    timestamp_ns: stamp,
                    quaternion,
                    accelerometer: three(2),
                    gyroscope: three(5),
                },
                received,
            )
        };
        for score in &output.scores {
            if let Some(result) = results.iter_mut().find(|r| r.label == score.label.as_str()) {
                result.times_ms.push(ms(i128::from(score.timestamp_ns)));
                result.scores.push(score.confidence);
            }
        }
        for event in &output.events {
            match event {
                DetectionEvent::Rising { label, timestamp_ns, .. } => {
                    open.insert(label.to_string(), ms(i128::from(*timestamp_ns)));
                }
                DetectionEvent::Falling { label, timestamp_ns, .. } => {
                    if let (Some(start), Some(result)) =
                        (open.remove(label.as_str()), results.iter_mut().find(|r| r.label == label.as_str()))
                    {
                        result.detections.push(ManualInterval {
                            start_ms: start,
                            end_ms: ms(i128::from(*timestamp_ns)).max(start),
                            label: label.to_string(),
                        });
                    }
                }
                DetectionEvent::Active { .. } => {}
            }
        }
        for rejection in &output.rejections {
            if let Some(result) = results.iter_mut().find(|r| r.label == rejection.label.as_str())
                && result.rejections.len() < 5
            {
                let text = rejection.reason.to_string();
                if !result.rejections.contains(&text) {
                    result.rejections.push(text);
                }
            }
        }
    }
    // A detection still on at the end lasts to the last decision.
    for (label, start) in open {
        if let Some(result) = results.iter_mut().find(|r| r.label == label) {
            let end = result.times_ms.last().copied().unwrap_or(start);
            result.detections.push(ManualInterval { start_ms: start, end_ms: end, label });
        }
    }
    for (result, thresholds) in results.iter_mut().zip(&thresholds) {
        result.sweep = sweep_of(&result.times_ms, &result.scores, thresholds);
    }
    Ok(results)
}

/// Runs every active model over the recording, as the app runs it live (in Monitor: nothing acts on it), to show where it
/// fires and where it does not. Read-only: nothing about the models or the recording changes.
#[tauri::command]
pub async fn labelling_model_replay(source: LabellingSource, app: AppHandle) -> Result<Vec<ModelReplay>, String> {
    use tauri::Manager;
    let (pair, _) = load(&app, &source)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(model_lab::MODEL_LAB_DIR_NAME);
    tauri::async_runtime::spawn_blocking(move || {
        let registry = model_lab_core::load_registry_file(&dir.join("registry-v2.json"))
            .map_err(|e| e.to_string())?
            .ok_or("there is no model registry yet: train or import a model first")?;
        let (models, failures) = label_inference::load_active_models(&registry, &dir);
        if models.is_empty() {
            return Err(match failures.first() {
                Some(failure) => format!("the active model for '{}' could not be loaded: {}", failure.label, failure.detail),
                None => "no model is active: activate one under Label models in Model Lab".to_string(),
            });
        }
        replay(&pair, models)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_sweep_runs_the_scores_through_the_same_detection_rule_at_each_threshold() {
        let thresholds = model_lab_core::Thresholds {
            activation: 0.6,
            release: 0.5,
            debounce_ms: 0,
            cooldown_ms: 0,
            trigger: model_lab_core::Trigger::Peak,
        };
        // Two bumps: up to 0.7 (peaking at 40 ms) and up to 0.9 (peaking at 140 ms).
        let times = [0.0, 20.0, 40.0, 60.0, 80.0, 100.0, 120.0, 140.0, 160.0, 180.0];
        let scores = [0.1, 0.5, 0.7, 0.4, 0.1, 0.3, 0.8, 0.9, 0.6, 0.1];
        // The peak trigger fires on the first fall after reaching the threshold.
        assert_eq!(rises_at(&times, &scores, &thresholds, 0.6), [60.0, 160.0]);
        assert_eq!(rises_at(&times, &scores, &thresholds, 0.85), [160.0]);
        assert!(rises_at(&times, &scores, &thresholds, 0.95).is_empty());
        let sweep = sweep_of(&times, &scores, &thresholds);
        assert_eq!(sweep.first().map(|p| p.threshold), Some(0.3));
        assert_eq!(sweep.last().map(|p| p.threshold), Some(0.95));
        assert_eq!(sweep.len(), 14);
    }

    use super::*;

    fn pair() -> Pair {
        // Pulse at 0, 40, 80 ms; motion at 20, 60 ms. The recorder labelled 40-80 ms pinch; 80 ms carries a manual fist.
        dataset_files::parse_pair_with(
            &format!(
                "{}\n1000000000,1,1,2,3,0,,\n1040000000,2,1,2,3,0,pinch,\n1080000000,3,1,2,3,0,pinch,fist\n",
                dataset_files::ppg_header()
            ),
            &format!(
                "{}\n1020000000,4,0.1,0.2,0.3,0,0,0,1,0,0,0,,\n1060000000,5,0.1,,0.3,0,0,0,1,0,0,0,pinch,\n",
                dataset_files::imu_header()
            ),
            false,
        )
        .unwrap()
    }

    #[test]
    fn a_recording_is_shown_as_columns_over_time_with_its_label_and_manual_spans() {
        let shown = view(&pair(), "session".into(), LabellingSource::File { path: "x".into() }).unwrap();
        assert_eq!(shown.duration_ms, 80.0);
        assert_eq!(shown.ppg.times_ms, [0.0, 40.0, 80.0]);
        assert_eq!(shown.imu.times_ms, [20.0, 60.0]);
        let names: Vec<&str> = shown.imu.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names[..3], ["accel_x", "accel_y", "accel_z"]);
        assert_eq!(names.len(), 10, "no timestamp, sequence or labels");
        assert_eq!(shown.imu.columns[1].values, [Some(0.2), None], "a blank cell stays blank");
        assert_eq!(
            shown.label_intervals,
            [ManualInterval { start_ms: 40.0, end_ms: 80.0, label: "pinch".into() }]
        );
        assert_eq!(
            shown.manual_intervals,
            [ManualInterval { start_ms: 80.0, end_ms: 80.0, label: "fist".into() }]
        );
    }

    #[test]
    fn manual_spans_label_every_row_of_both_files_inside_them_and_change_nothing_else() {
        let span = |start_ms: f64, end_ms: f64, label: &str| ManualInterval { start_ms, end_ms, label: label.into() };
        // fist over 10-50 ms, then "nothing here" over 50-70 ms; the later span wins where they meet.
        let (ppg, imu) = with_manual(&pair(), &[span(10.0, 50.0, "fist"), span(50.0, 70.0, NO_LABEL)]).unwrap();
        let manual = |text: &str| -> Vec<String> {
            text.lines().skip(1).map(|l| l.rsplit(',').next().unwrap().to_string()).collect()
        };
        assert_eq!(manual(&ppg), ["", "fist", ""], "the hand label the file had at 80 ms is replaced by the spans");
        assert_eq!(manual(&imu), ["fist", "-"]);
        assert!(ppg.contains("\n1040000000,2,1,2,3,0,pinch,fist\n"));
        let saved = dataset_files::parse_pair(&ppg, &imu).unwrap();
        assert_eq!(saved.labels, ["fist", "pinch"], "the 80 ms row trains on its pinch again");
        // A span that is not a label, or runs backwards, is refused.
        assert!(with_manual(&pair(), &[span(0.0, 10.0, "a,b")]).is_err());
        assert!(with_manual(&pair(), &[span(10.0, 0.0, "fist")]).is_err());
    }

    /// A one-off check on a real recording: `LABELLING_E2E_SOURCE` (a Model Lab recording folder, a dataset folder or CSV).
    #[test]
    #[ignore = "one-off: set LABELLING_E2E_SOURCE"]
    fn a_real_recording_opens_takes_hand_labels_and_round_trips() {
        let path = PathBuf::from(std::env::var("LABELLING_E2E_SOURCE").unwrap());
        let pair = pair_at(&path).unwrap();
        let shown = view(&pair, "real".into(), LabellingSource::File { path: path.display().to_string() }).unwrap();
        let (ppg_rows, imu_rows) = (shown.ppg.times_ms.len(), shown.imu.times_ms.len());
        println!(
            "{ppg_rows} pulse and {imu_rows} motion rows over {:.1} s; {} recorded spans, {} hand spans",
            shown.duration_ms / 1000.0,
            shown.label_intervals.len(),
            shown.manual_intervals.len()
        );
        // Label the middle tenth "fist" and the first second "nothing here".
        let middle = shown.duration_ms / 2.0;
        let spans = [
            ManualInterval { start_ms: 0.0, end_ms: 1000.0, label: NO_LABEL.into() },
            ManualInterval { start_ms: middle, end_ms: middle + shown.duration_ms / 10.0, label: "fist".into() },
        ];
        let (ppg, imu) = with_manual(&pair, &spans).unwrap();
        let labelled = dataset_files::parse_pair_with(&ppg, &imu, false).unwrap();
        assert_eq!((labelled.ppg_rows, labelled.imu_rows), (ppg_rows, imu_rows), "no row lost or added");
        let reopened = view(&labelled, "again".into(), LabellingSource::File { path: String::new() }).unwrap();
        assert_eq!(reopened.manual_intervals.len(), 2, "{:?}", reopened.manual_intervals);
        assert_eq!(reopened.label_intervals, shown.label_intervals, "the recorded labels are untouched");
        let single = dataset_files::merge_to_single(&ppg, &imu).unwrap();
        let back = dataset_files::split_legacy_with(&single, false).unwrap();
        // The rows come back exactly; of the `#` lines only `# label:` is kept, as for any single file read back.
        let rows = |text: &str| text.lines().filter(|l| !l.starts_with('#')).map(str::to_string).collect::<Vec<_>>();
        assert_eq!((rows(&back.ppg_csv), rows(&back.imu_csv)), (rows(&ppg), rows(&imu)), "the one-file export splits back into the same rows");
        println!("hand spans after a round trip: {:?}", reopened.manual_intervals);
    }

    /// A one-off check with real models: `LABELLING_E2E_BUNDLE` (a trained bundle) or `LABELLING_E2E_MODEL_LAB` (the app's
    /// model-lab folder, for its active models), and `LABELLING_E2E_SOURCE` (a recording).
    #[test]
    #[ignore = "one-off: set LABELLING_E2E_BUNDLE (or LABELLING_E2E_MODEL_LAB) and LABELLING_E2E_SOURCE"]
    fn the_active_models_replay_a_real_recording() {
        let models = if let Ok(bundle) = std::env::var("LABELLING_E2E_BUNDLE") {
            // A bundle the trainer made, approved here as the registry would.
            use model_lab_core::{LifecycleState, ModelOrigin, ModelVersion, ModelVersionId, ProjectId};
            let bundle = label_inference::validate_bundle(std::path::Path::new(&bundle), None).unwrap();
            let mut version = ModelVersion::new(
                ModelVersionId::new("e2e-v1").unwrap(),
                ProjectId::new("p-e2e").unwrap(),
                bundle.manifest.target_label.clone(),
                ModelOrigin::Imported,
                true,
                Some(bundle.model_sha256.clone()),
                "models/e2e".into(),
                bundle.manifest.input_contract(),
                bundle.manifest.threshold_config(),
                bundle.manifest.quality,
                "2026-10-24T00:00:00Z",
            )
            .unwrap();
            version.state = LifecycleState::Active;
            vec![label_inference::LoadedModel::load(bundle, &version).unwrap()]
        } else {
            let dir = PathBuf::from(std::env::var("LABELLING_E2E_MODEL_LAB").unwrap());
            let registry = model_lab_core::load_registry_file(&dir.join("registry-v2.json")).unwrap().unwrap();
            let (models, failures) = label_inference::load_active_models(&registry, &dir);
            assert!(failures.is_empty(), "{failures:?}");
            models
        };
        assert!(!models.is_empty(), "no active model");
        let pair = pair_at(&PathBuf::from(std::env::var("LABELLING_E2E_SOURCE").unwrap())).unwrap();
        let started = std::time::Instant::now();
        for model in replay(&pair, models).unwrap() {
            println!(
                "{} ({}): {} decisions, highest score {:.2}, threshold {}, {} detections at {:?} ms; rejections {:?}; {:.1} s",
                model.label,
                model.version,
                model.scores.len(),
                model.scores.iter().copied().fold(0.0, f64::max),
                model.threshold,
                model.detections.len(),
                model.detections.iter().map(|d| d.start_ms.round()).collect::<Vec<_>>(),
                model.rejections,
                started.elapsed().as_secs_f64()
            );
            assert!(model.scores.len() > 1000);
        }
    }

    #[test]
    fn an_export_as_one_file_holds_both_labels_and_splits_back_into_the_same_files() {
        let span = ManualInterval { start_ms: 0.0, end_ms: 30.0, label: "fist".into() };
        let (ppg, imu) = with_manual(&pair(), &[span]).unwrap();
        let single = dataset_files::merge_to_single(&ppg, &imu).unwrap();
        assert!(single.lines().next().unwrap().ends_with("contact_quality,label,manual_label"));
        let back = dataset_files::split_legacy(&single).unwrap();
        assert_eq!((back.ppg_csv, back.imu_csv), (ppg, imu));
    }
}
