//! The miss recorder: keeps the last 45 seconds of the watch's motion and pulse, and of what the models and recipes made
//! of them, so that "that was wrong" can be saved the moment it happens.
//!
//! Nothing is written until a miss is marked: `mark_miss` from the app's buttons, or Ctrl+Alt+M from any app
//! (`register_shortcut`). Then the buffer becomes an
//! ordinary recording in Datasets, in the group "Misses", in the same two files a Recorder session has (`ppg.csv` and
//! `imu.csv`, the pulse placed on the watch's clock the same way), so it can be labelled and trained on like any other.
//! Beside them goes `live_log.json`: every score, detection, rejection and recipe change of those seconds, each with how
//! long before the mark it happened, and a short summary of why nothing (or something) fired.
//!
//! 45 seconds, not 30: the CNN needs 11 s of signal before it scores anything, so a replay of the saved recording covers
//! about the last half minute.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use chrono::{Local, SecondsFormat, Utc};
use label_inference::{ClockMap, DetectionEvent, RuntimeOutput};
use serde::Serialize;
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

use crate::dataset_files;
use crate::label_runtime::LabelRuntimeHost;
use crate::model_lab::{self, MODEL_LAB_DIR_NAME, ModelLabRuntime};

pub const MISS_SAVED_EVENT: &str = "miss-saved";
/// A miss marked by the key could not be saved; the payload says why.
pub const MISS_FAILED_EVENT: &str = "miss-failed";
pub const LOG_FILE: &str = "live_log.json";
pub const GROUP: &str = "Misses";
const STAGING_DIR: &str = "misses";
const KEEP_NS: u64 = 45_000_000_000;
/// A watch clock that went back by more than this is a new clock (the watch restarted), not a late sample.
const CLOCK_RESTART_NS: u64 = 1_000_000_000;
const MAX_LOG: usize = 20_000;
const MAX_NOTE_CHARS: usize = 500;
/// A stream quiet for longer than this has a gap (the same quarter second the recordings and the models use).
const GAP_NS: u64 = 250_000_000;
const NS_PER_MS: u64 = 1_000_000;

#[derive(Debug, Clone, Copy)]
struct ImuRow {
    stamp: u64,
    sequence: u64,
    accel: [f64; 3],
    gyro: [f64; 3],
    quat: [f64; 4],
}

#[derive(Debug, Clone, Copy)]
struct PpgRow {
    /// On the watch's clock, like the motion rows.
    stamp: u64,
    sequence: u64,
    green: i32,
    red: i32,
    ir: i32,
    contact: i32,
}

#[derive(Debug, Clone)]
struct Entry {
    desktop_ns: u64,
    kind: &'static str,
    label: Option<String>,
    value: Option<f64>,
    detail: Option<String>,
}

/// One line of `live_log.json`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// How long before the mark it happened.
    pub ms_before_mark: u64,
    /// `score`, `detected`, `acted`, `ended`, `rejected`, `conflict`, `reset`, or what a caller of [`MissRecorder::note`]
    /// said (`recipe`, `head`, `button`, `watch`, `gesture`).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// What one label's model did in the saved seconds.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabelSummary {
    pub label: String,
    /// The score its detection starts at, when the label has an active model.
    pub activation: Option<f64>,
    pub scores: usize,
    pub peak: Option<f64>,
    pub peak_ms_before_mark: Option<u64>,
    /// Detections the model made.
    pub detected: usize,
    /// Detections that were let through to the recipes (none unless the runtime is Live).
    pub acted: usize,
    /// How often each kind of rejection came up, by its name (`HandNotStill`, `SourceStale`, ...).
    pub rejections: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSummary {
    pub samples: usize,
    pub seconds: f64,
    pub gaps: usize,
    pub longest_gap_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub motion: StreamSummary,
    pub pulse: StreamSummary,
    pub labels: Vec<LabelSummary>,
    /// The same, in sentences, most telling first.
    pub lines: Vec<String>,
}

/// The buffer at one moment, ready to write.
#[derive(Debug)]
pub struct Snapshot {
    pub ppg_csv: String,
    pub imu_csv: String,
    pub log: Vec<LogLine>,
    pub motion: StreamSummary,
    pub pulse: StreamSummary,
}

#[derive(Default)]
struct Buffer {
    imu: VecDeque<ImuRow>,
    ppg: VecDeque<PpgRow>,
    ppg_clock: ClockMap,
    log: VecDeque<Entry>,
}

impl Buffer {
    fn clear_streams(&mut self) {
        self.imu.clear();
        self.ppg.clear();
        self.ppg_clock.reset();
    }

    fn orientation(&mut self, sample: &WatchOrientationSample) {
        // The models only use a motion sample that has both readings, so only those are kept.
        let (Some(accel), Some(gyro)) = (sample.accelerometer, sample.gyroscope) else {
            return;
        };
        if !accel
            .iter()
            .chain(&gyro)
            .chain(&sample.quaternion)
            .all(|v| v.is_finite())
        {
            return;
        }
        if let Some(last) = self.imu.back() {
            if sample.timestamp_ns + CLOCK_RESTART_NS < last.stamp {
                self.clear_streams();
            } else if sample.timestamp_ns <= last.stamp {
                return;
            }
        }
        self.imu.push_back(ImuRow {
            stamp: sample.timestamp_ns,
            sequence: sample.sequence,
            accel,
            gyro,
            quat: sample.quaternion,
        });
        while self
            .imu
            .front()
            .is_some_and(|first| sample.timestamp_ns.saturating_sub(first.stamp) > KEEP_NS)
        {
            self.imu.pop_front();
        }
    }

    fn pulse(&mut self, batch: &WatchPpgBatchSample) {
        let Some(&newest) = batch.timestamps_ns.last() else {
            return;
        };
        // The pulse sensor stamps its samples on its own clock; a batch is sent just after its newest sample, so the
        // smallest "sent - newest" is the offset to the watch's clock (the Recorder's `SourceClockMap` does the same).
        self.ppg_clock.observe(newest, batch.timestamp_ns);
        for (index, &taken) in batch.timestamps_ns.iter().enumerate() {
            let (Some(stamp), Some(&green), Some(&red), Some(&ir)) = (
                self.ppg_clock.map(taken),
                batch.green.get(index),
                batch.red.get(index),
                batch.ir.get(index),
            ) else {
                continue;
            };
            let status = |values: &[i32]| values.get(index).copied().unwrap_or(0);
            self.ppg.push_back(PpgRow {
                stamp,
                sequence: batch.sequence,
                green,
                red,
                ir,
                contact: status(&batch.green_status)
                    .max(status(&batch.red_status))
                    .max(status(&batch.ir_status)),
            });
        }
        let newest = self.ppg.iter().map(|row| row.stamp).max().unwrap_or(0);
        while self
            .ppg
            .front()
            .is_some_and(|first| newest.saturating_sub(first.stamp) > KEEP_NS)
        {
            self.ppg.pop_front();
        }
    }

    fn push(
        &mut self,
        now_ns: u64,
        kind: &'static str,
        label: Option<String>,
        value: Option<f64>,
        detail: Option<String>,
    ) {
        self.log.push_back(Entry {
            desktop_ns: now_ns,
            kind,
            label,
            value,
            detail,
        });
        while self.log.len() > MAX_LOG
            || self
                .log
                .front()
                .is_some_and(|first| now_ns.saturating_sub(first.desktop_ns) > KEEP_NS)
        {
            self.log.pop_front();
        }
    }

    fn output(&mut self, now_ns: u64, output: &RuntimeOutput) {
        for score in &output.scores {
            self.push(
                now_ns,
                "score",
                Some(score.label.to_string()),
                Some(score.confidence),
                None,
            );
        }
        for event in &output.events {
            match event {
                DetectionEvent::Rising {
                    label, confidence, ..
                } => self.push(
                    now_ns,
                    "detected",
                    Some(label.to_string()),
                    Some(*confidence),
                    None,
                ),
                DetectionEvent::Falling { label, reason, .. } => self.push(
                    now_ns,
                    "ended",
                    Some(label.to_string()),
                    None,
                    Some(format!("{reason:?}")),
                ),
                DetectionEvent::Active { .. } => {}
            }
        }
        for event in &output.actionable {
            if let DetectionEvent::Rising {
                label, confidence, ..
            } = event
            {
                self.push(
                    now_ns,
                    "acted",
                    Some(label.to_string()),
                    Some(*confidence),
                    None,
                );
            }
        }
        for rejection in &output.rejections {
            self.push(
                now_ns,
                "rejected",
                Some(rejection.label.to_string()),
                None,
                Some(format!("{:?}", rejection.reason)),
            );
        }
        for conflict in &output.conflicts {
            let labels: Vec<String> = conflict.labels.iter().map(ToString::to_string).collect();
            self.push(now_ns, "conflict", None, None, Some(labels.join(", ")));
        }
        if output.reset_interactions {
            self.push(now_ns, "reset", None, None, None);
        }
    }

    fn snapshot(
        &self,
        now_ns: u64,
        context: &BTreeMap<String, String>,
    ) -> Result<Snapshot, String> {
        if self.imu.is_empty() || self.ppg.is_empty() {
            let missing = match (self.imu.is_empty(), self.ppg.is_empty()) {
                (true, true) => "motion or pulse",
                (true, false) => "motion",
                _ => "pulse",
            };
            return Err(format!(
                "the watch sent no {missing} in the last 45 seconds, so there is nothing to save: check the watch is connected and measuring"
            ));
        }
        // The pulse rows of a batch can land a little before the end of the batch before, when the clock estimate
        // improves; a recording's rows are in time order.
        let mut ppg: Vec<PpgRow> = self.ppg.iter().copied().collect();
        ppg.sort_by_key(|row| row.stamp);
        let comments: String = dataset_files::context_lines(context)
            .iter()
            .map(|line| format!("{line}\n"))
            .collect();
        let mut ppg_csv = format!("{comments}{}\n", dataset_files::ppg_header());
        for row in &ppg {
            ppg_csv.push_str(&format!(
                "{},{},{},{},{},{},,\n",
                row.stamp, row.sequence, row.green, row.red, row.ir, row.contact
            ));
        }
        let mut imu_csv = format!("{comments}{}\n", dataset_files::imu_header());
        for row in &self.imu {
            let [ax, ay, az] = row.accel;
            let [gx, gy, gz] = row.gyro;
            let [qw, qx, qy, qz] = row.quat;
            imu_csv.push_str(&format!(
                "{},{},{ax},{ay},{az},{gx},{gy},{gz},{qw},{qx},{qy},{qz},,\n",
                row.stamp, row.sequence
            ));
        }
        let log = self
            .log
            .iter()
            .filter(|entry| now_ns.saturating_sub(entry.desktop_ns) <= KEEP_NS)
            .map(|entry| LogLine {
                ms_before_mark: now_ns.saturating_sub(entry.desktop_ns) / NS_PER_MS,
                kind: entry.kind.to_string(),
                label: entry.label.clone(),
                value: entry.value,
                detail: entry.detail.clone(),
            })
            .collect();
        Ok(Snapshot {
            ppg_csv,
            imu_csv,
            log,
            motion: stream_summary(self.imu.iter().map(|row| row.stamp)),
            pulse: stream_summary(ppg.iter().map(|row| row.stamp)),
        })
    }
}

fn stream_summary(stamps: impl Iterator<Item = u64>) -> StreamSummary {
    let mut summary = StreamSummary::default();
    let (mut first, mut previous) = (None, None::<u64>);
    for stamp in stamps {
        summary.samples += 1;
        first.get_or_insert(stamp);
        if let Some(before) = previous {
            let gap = stamp.saturating_sub(before);
            if gap > GAP_NS {
                summary.gaps += 1;
                summary.longest_gap_ms = summary.longest_gap_ms.max(gap / NS_PER_MS);
            }
        }
        previous = Some(stamp);
    }
    if let (Some(first), Some(last)) = (first, previous) {
        summary.seconds = last.saturating_sub(first) as f64 / 1e9;
    }
    summary
}

/// The name of a rejection, without its numbers: `SourceStale { source: WatchPpg, age_ms: 1200 }` is `SourceStale`.
fn rejection_name(detail: &str) -> String {
    detail
        .split(|c: char| !c.is_ascii_alphanumeric())
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("Unknown")
        .to_string()
}

fn seconds_ago(ms: u64) -> String {
    format!("{:.1} s before the mark", ms as f64 / 1000.0)
}

/// What the saved seconds say, per label and in sentences. `activations` is each active model's starting score.
pub fn summarise(snapshot: &Snapshot, activations: &BTreeMap<String, f64>) -> Summary {
    let mut by_label: BTreeMap<String, LabelSummary> = activations
        .iter()
        .map(|(label, activation)| (label.clone(), blank(label, Some(*activation))))
        .collect();
    for line in &snapshot.log {
        let Some(label) = &line.label else { continue };
        let entry = by_label
            .entry(label.clone())
            .or_insert_with(|| blank(label, None));
        match line.kind.as_str() {
            "score" => {
                entry.scores += 1;
                if let Some(value) = line.value
                    && entry.peak.is_none_or(|peak| value > peak)
                {
                    entry.peak = Some(value);
                    entry.peak_ms_before_mark = Some(line.ms_before_mark);
                }
            }
            "detected" => entry.detected += 1,
            "acted" => entry.acted += 1,
            "rejected" => {
                *entry
                    .rejections
                    .entry(rejection_name(line.detail.as_deref().unwrap_or("")))
                    .or_default() += 1;
            }
            _ => {}
        }
    }
    let labels: Vec<LabelSummary> = by_label.into_values().collect();

    let mut lines = Vec::new();
    for (name, stream) in [("motion", &snapshot.motion), ("pulse", &snapshot.pulse)] {
        if stream.gaps > 0 {
            lines.push(format!(
                "The watch's {name} stopped arriving {} time{}, for up to {} ms. A model scores nothing across a gap, and the CNN needs 11 s of unbroken signal after one.",
                stream.gaps,
                if stream.gaps == 1 { "" } else { "s" },
                stream.longest_gap_ms
            ));
        }
    }
    if labels.is_empty() {
        lines.push("No model was running, so nothing was scored.".into());
    }
    for label in &labels {
        let name = &label.label;
        let Some(peak) = label.peak else {
            lines.push(format!(
                "{name}: its model scored nothing in these seconds."
            ));
            continue;
        };
        let when = seconds_ago(label.peak_ms_before_mark.unwrap_or(0));
        let against = label
            .activation
            .map(|a| format!(" (it starts at {a:.2})"))
            .unwrap_or_default();
        lines.push(match (label.detected, label.acted) {
            (0, _) => format!("{name}: never detected. Its highest score was {peak:.2}, {when}{against}."),
            (detected, 0) => format!(
                "{name}: detected {detected} time{}, but none was acted on (highest score {peak:.2}, {when}). The runtime is not Live, or the start was withheld.",
                if detected == 1 { "" } else { "s" }
            ),
            (detected, acted) => format!(
                "{name}: detected {detected} time{}, {acted} acted on (highest score {peak:.2}, {when}{against}).",
                if detected == 1 { "" } else { "s" }
            ),
        });
        if !label.rejections.is_empty() {
            let reasons: Vec<String> = label
                .rejections
                .iter()
                .map(|(reason, count)| format!("{reason} x{count}"))
                .collect();
            lines.push(format!("{name}: rejections: {}.", reasons.join(", ")));
        }
    }
    Summary {
        motion: snapshot.motion.clone(),
        pulse: snapshot.pulse.clone(),
        labels,
        lines,
    }
}

fn blank(label: &str, activation: Option<f64>) -> LabelSummary {
    LabelSummary {
        label: label.to_string(),
        activation,
        scores: 0,
        peak: None,
        peak_ms_before_mark: None,
        detected: 0,
        acted: 0,
        rejections: BTreeMap::new(),
    }
}

pub struct MissRecorder {
    started_at: Instant,
    buffer: Mutex<Buffer>,
}

impl Default for MissRecorder {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            buffer: Mutex::new(Buffer::default()),
        }
    }
}

impl MissRecorder {
    fn now_ns(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64
    }

    pub fn observe_orientation(&self, sample: &WatchOrientationSample) {
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.orientation(sample);
        }
    }

    pub fn observe_ppg(&self, batch: &WatchPpgBatchSample) {
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.pulse(batch);
        }
    }

    /// What the active models just made of the signals.
    pub fn observe_output(&self, output: &RuntimeOutput) {
        let now = self.now_ns();
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.output(now, output);
        }
    }

    /// Something else worth knowing later: a recipe changing phase, the head reaching a location, the button, the link.
    pub fn note(&self, kind: &'static str, detail: impl Into<String>) {
        let now = self.now_ns();
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.push(now, kind, None, None, Some(detail.into()));
        }
    }

    fn snapshot(&self, context: &BTreeMap<String, String>) -> Result<Snapshot, String> {
        let now = self.now_ns();
        self.buffer
            .lock()
            .map_err(|_| "the miss recorder's buffer is unusable".to_string())?
            .snapshot(now, context)
    }
}

/// Notes something in the miss recorder, wherever the app's state can be reached from.
pub fn note(app: &AppHandle, kind: &'static str, detail: impl Into<String>) {
    if let Some(recorder) = app.try_state::<MissRecorder>() {
        recorder.note(kind, detail);
    }
}

/// What was wrong, as the user said it.
fn kind_text(kind: &str) -> Result<&'static str, String> {
    match kind {
        "missed" => Ok("did not fire"),
        "falseActivation" => Ok("fired by itself"),
        "unspecified" => Ok("something was wrong"),
        other => Err(format!("'{other}' is not a kind of miss")),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissSaved {
    /// The recording it became in Datasets.
    pub dataset_id: String,
    pub name: String,
    pub kind: String,
    pub summary: Summary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogFile<'a> {
    format_version: u32,
    saved_at: String,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'a str>,
    /// The model runtime as it was at the mark: its mode, the labels loaded, the last scores.
    runtime: crate::label_runtime::LabelRuntimeStatus,
    /// Each label's active model and the scores it starts and ends a detection at.
    models: Vec<ActiveModel>,
    summary: &'a Summary,
    /// Oldest first.
    entries: &'a [LogLine],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveModel {
    label: String,
    model_id: String,
    activation: f64,
    release: f64,
}

fn staging_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    Ok(base.join(MODEL_LAB_DIR_NAME).join(STAGING_DIR))
}

fn write_folder(folder: &Path, snapshot: &Snapshot, log_json: &[u8]) -> Result<(), String> {
    fs::create_dir_all(folder)
        .map_err(|e| format!("could not create {}: {e}", folder.display()))?;
    for (name, bytes) in [
        (dataset_files::PPG_FILE, snapshot.ppg_csv.as_bytes()),
        (dataset_files::IMU_FILE, snapshot.imu_csv.as_bytes()),
        (LOG_FILE, log_json),
    ] {
        fs::write(folder.join(name), bytes).map_err(|e| format!("could not write {name}: {e}"))?;
    }
    Ok(())
}

/// Saves the last 45 seconds as a recording in Datasets (group "Misses") with its `live_log.json`, and says what the
/// models did in them. `kind` is `missed`, `falseActivation` or `unspecified`.
#[tauri::command]
pub fn mark_miss(kind: String, note: Option<String>, app: AppHandle) -> Result<MissSaved, String> {
    save(&app, kind, note)
}

/// The key that marks a miss from any app: Ctrl+Alt+M (Control-Option-M on a Mac). What was wrong is not said, so the
/// recording is named "something was wrong". If another app has the key, the app's own buttons still work.
pub fn register_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM);
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, pressed, event| {
            if pressed != &shortcut || event.state() != ShortcutState::Pressed {
                return;
            }
            // Saving reads and writes files, so it is kept off the thread the key arrives on.
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = save(&app, "unspecified".into(), None) {
                    warn!(%error, "the miss marked by the key was not saved");
                    let _ = app.emit(MISS_FAILED_EVENT, error);
                }
            });
        })
        .build();
    if let Err(error) = app.plugin(plugin) {
        warn!(%error, "the key that marks a miss is unavailable");
        return;
    }
    if let Err(error) = app.global_shortcut().register(shortcut) {
        warn!(%error, "Ctrl+Alt+M could not be taken as the key that marks a miss");
    }
}

fn save(app: &AppHandle, kind: String, note: Option<String>) -> Result<MissSaved, String> {
    let recorder = app.state::<MissRecorder>();
    let host = app.state::<LabelRuntimeHost>();
    let model_lab = app.state::<ModelLabRuntime>();
    let what = kind_text(&kind)?;
    let note = note
        .map(|text| text.trim().chars().take(MAX_NOTE_CHARS).collect::<String>())
        .filter(|text| !text.is_empty());
    let context = BTreeMap::from([
        ("capture".to_string(), "miss recorder".to_string()),
        ("miss".to_string(), what.to_string()),
    ]);
    let snapshot = recorder.snapshot(&context)?;
    let models: Vec<ActiveModel> = host
        .list_models(LabelRuntimeHost::model_lab_dir(app).ok().as_deref())
        .into_iter()
        .filter(|model| model.active)
        .map(|model| ActiveModel {
            label: model.label,
            model_id: model.id,
            activation: model.activation,
            release: model.release,
        })
        .collect();
    let activations = models
        .iter()
        .map(|model| (model.label.clone(), model.activation))
        .collect();
    let summary = summarise(&snapshot, &activations);
    let now = Utc::now();
    let log_json = serde_json::to_vec_pretty(&LogFile {
        format_version: 1,
        saved_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        kind: &kind,
        note: note.as_deref(),
        runtime: host.status(),
        models,
        summary: &summary,
        entries: &snapshot.log,
    })
    .map_err(|e| e.to_string())?;

    let folder = staging_root(app)?.join(format!("miss-{}", now.format("%Y-%m-%dT%H-%M-%S%.3fZ")));
    write_folder(&folder, &snapshot, &log_json)?;
    let dataset = model_lab::ingest_folder(app, &model_lab, &folder).map_err(|error| {
        format!(
            "the miss was saved in {} but could not be added to Datasets: {error}",
            folder.display()
        )
    })?;
    let stored = model_lab::dataset_csv_path(&model_lab::datasets_dir(app)?, &dataset.id);
    if let Err(error) = fs::write(stored.join(LOG_FILE), &log_json) {
        warn!(%error, "could not keep the live log with the miss's recording");
    }
    let name = format!(
        "Miss: {what}, {}",
        now.with_timezone(&Local).format("%-d %b %H:%M:%S")
    );
    if let Err(error) = model_lab::file_miss(app, &model_lab, &dataset.id, &name, GROUP) {
        warn!(%error, "could not name the miss's recording");
    }
    let _ = fs::remove_dir_all(&folder);

    let saved = MissSaved {
        dataset_id: dataset.id,
        name,
        kind,
        summary,
    };
    let _ = app.emit(MISS_SAVED_EVENT, &saved);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use label_inference::{LabelScore, Rejection, WindowRejection};

    use model_lab_core::{LabelId, ModelVersionId};

    const MS: u64 = 1_000_000;

    fn label_id(label: &str) -> LabelId {
        LabelId::new(label).unwrap()
    }

    fn motion(at_ms: u64) -> WatchOrientationSample {
        WatchOrientationSample {
            device_id: "watch".into(),
            sequence: at_ms / 10,
            timestamp_ns: at_ms * MS,
            quaternion: [1.0, 0.0, 0.0, 0.0],
            accelerometer: Some([0.1, 0.2, 0.3]),
            gyroscope: Some([0.01, 0.02, 0.03]),
        }
    }

    /// Four pulse samples 40 ms apart on the sensor's own clock (`sdk_ms`), sent `wait_ms` after the newest at `sent_ms`
    /// on the watch's clock.
    fn pulse(sequence: u64, sdk_ms: u64, sent_ms: u64) -> WatchPpgBatchSample {
        let stamps: Vec<u64> = (0..4).map(|i| (sdk_ms + i * 40) * MS).collect();
        WatchPpgBatchSample {
            device_id: "watch".into(),
            sequence,
            timestamp_ns: sent_ms * MS,
            sample_count: 4,
            timestamps_ns: stamps,
            green: vec![1, 2, 3, 4],
            green_status: vec![0, 0, 0, 0],
            red: vec![5, 6, 7, 8],
            red_status: vec![0, 0, 1, 0],
            ir: vec![9, 10, 11, 12],
            ir_status: vec![0, 0, 0, 0],
        }
    }

    fn filled(seconds: u64) -> Buffer {
        let mut buffer = Buffer::default();
        for at in (0..seconds * 1000).step_by(10) {
            buffer.orientation(&motion(1_000 + at));
        }
        for batch in 0..seconds * 1000 / 160 {
            // The sensor's clock is 5,000,000 ms ahead of the watch's; each batch waits 20 ms.
            let newest_watch = 1_000 + batch * 160 + 120;
            buffer.pulse(&pulse(batch, 5_001_000 + batch * 160, newest_watch + 20));
        }
        buffer
    }

    fn score(label: &str, confidence: f64) -> LabelScore {
        LabelScore {
            label: label_id(label),
            model_version: ModelVersionId::new("v1").unwrap(),
            confidence,
            timestamp_ns: 0,
            received_ns: 0,
            watch_ns: None,
            input_check: None,
        }
    }

    fn output_with(scores: Vec<LabelScore>) -> RuntimeOutput {
        RuntimeOutput {
            reset_interactions: false,
            blocked_labels: Vec::new(),
            scores,
            rejections: Vec::new(),
            events: Vec::new(),
            conflicts: Vec::new(),
            actionable: Vec::new(),
            input_warnings: None,
        }
    }

    #[test]
    fn keeps_only_the_last_45_seconds_of_each_stream() {
        let buffer = filled(70);
        let span = |first: u64, last: u64| (last - first) as f64 / 1e9;
        let motion = span(
            buffer.imu.front().unwrap().stamp,
            buffer.imu.back().unwrap().stamp,
        );
        let pulse = span(
            buffer.ppg.front().unwrap().stamp,
            buffer.ppg.back().unwrap().stamp,
        );
        assert!((44.9..=45.0).contains(&motion), "{motion}");
        assert!((44.7..=45.0).contains(&pulse), "{pulse}");
    }

    #[test]
    fn the_saved_files_are_a_recording_the_app_can_read_with_the_pulse_on_the_watch_clock() {
        let buffer = filled(20);
        let context = BTreeMap::from([("miss".to_string(), "did not fire".to_string())]);
        let snapshot = buffer.snapshot(0, &context).unwrap();
        let pair =
            dataset_files::parse_pair_with(&snapshot.ppg_csv, &snapshot.imu_csv, false).unwrap();
        assert_eq!(pair.imu_rows, 2000);
        assert_eq!(pair.ppg_rows, 500);
        assert_eq!(
            pair.context.get("miss").map(String::as_str),
            Some("did not fire")
        );
        assert!(pair.labels.is_empty(), "{:?}", pair.labels);
        // The first pulse sample was taken at 1,000 ms on the watch's clock. Every batch waited 20 ms to be sent, and the
        // shortest wait cannot be told from the clocks' offset, so it lands at 1,020 ms (as in a Recorder session).
        let first = snapshot
            .ppg_csv
            .lines()
            .find(|l| l.starts_with(char::is_numeric))
            .unwrap();
        assert!(first.starts_with("1020000000,0,1,5,9,0,"), "{first}");
        // The worst of the three colours' statuses is the contact quality.
        assert!(snapshot.ppg_csv.contains(",3,7,11,1,,"));
        assert_eq!(snapshot.motion.gaps, 0);
        assert_eq!(snapshot.pulse.gaps, 0);
        assert!((snapshot.motion.seconds - 19.99).abs() < 0.01);
    }

    #[test]
    fn datasets_takes_a_saved_miss_as_a_recording_with_no_labels() {
        let snapshot = filled(45).snapshot(0, &BTreeMap::new()).unwrap();
        let pair =
            dataset_files::parse_pair_with(&snapshot.ppg_csv, &snapshot.imu_csv, false).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let stored = model_lab::store_pair_in(
            dir.path(),
            |_| true,
            &Mutex::new(()),
            "miss-2026-11-12T10-00-00.000Z".into(),
            pair,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(stored.two_files && stored.labels.is_empty(), "{stored:?}");
        let folder = model_lab::dataset_csv_path(dir.path(), &stored.id);
        assert!(
            folder.join(dataset_files::PPG_FILE).is_file()
                && folder.join(dataset_files::IMU_FILE).is_file()
        );
        let gaps = stored.gaps.unwrap();
        assert_eq!((gaps.imu.gaps, gaps.ppg.gaps), (0, 0));
        assert!(
            (gaps.imu.rate_hz - 100.0).abs() < 1.0 && (gaps.ppg.rate_hz - 25.0).abs() < 1.0,
            "{gaps:?}"
        );
    }

    #[test]
    fn nothing_to_save_without_both_streams_and_bad_samples_are_left_out() {
        let mut buffer = Buffer::default();
        assert!(
            buffer
                .snapshot(0, &BTreeMap::new())
                .unwrap_err()
                .contains("motion or pulse")
        );
        buffer.orientation(&motion(1_000));
        assert!(
            buffer
                .snapshot(0, &BTreeMap::new())
                .unwrap_err()
                .contains("no pulse")
        );
        // No gyroscope, a value that is not a number, and a sample out of order: none is kept.
        buffer.orientation(&WatchOrientationSample {
            gyroscope: None,
            ..motion(1_010)
        });
        buffer.orientation(&WatchOrientationSample {
            accelerometer: Some([f64::NAN, 0.0, 0.0]),
            ..motion(1_020)
        });
        buffer.orientation(&motion(990));
        assert_eq!(buffer.imu.len(), 1);
    }

    #[test]
    fn a_watch_clock_that_starts_again_starts_the_buffer_again() {
        let mut buffer = filled(5);
        buffer.orientation(&motion(50));
        assert_eq!(buffer.imu.len(), 1);
        assert!(buffer.ppg.is_empty());
    }

    #[test]
    fn a_gap_in_a_stream_is_counted_and_said() {
        let mut buffer = filled(5);
        buffer.orientation(&motion(6_000 + 900));
        let snapshot = buffer.snapshot(0, &BTreeMap::new()).unwrap();
        assert_eq!(snapshot.motion.gaps, 1);
        assert_eq!(snapshot.motion.longest_gap_ms, 910);
        let summary = summarise(&snapshot, &BTreeMap::new());
        assert!(
            summary.lines[0].contains("motion stopped arriving 1 time, for up to 910 ms"),
            "{:?}",
            summary.lines
        );
    }

    #[test]
    fn the_log_says_how_long_before_the_mark_and_forgets_what_is_older_than_45_seconds() {
        let mut buffer = filled(2);
        buffer.output(1_000 * MS, &output_with(vec![score("pinch_in", 0.2)]));
        buffer.output(50_000 * MS, &output_with(vec![score("pinch_in", 0.97)]));
        buffer.push(51_000 * MS, "recipe", None, None, Some("armed".into()));
        let snapshot = buffer.snapshot(52_000 * MS, &BTreeMap::new()).unwrap();
        let seen: Vec<(u64, &str)> = snapshot
            .log
            .iter()
            .map(|l| (l.ms_before_mark, l.kind.as_str()))
            .collect();
        assert_eq!(seen, vec![(2_000, "score"), (1_000, "recipe")]);
    }

    #[test]
    fn the_summary_says_why_a_pinch_did_not_fire() {
        let mut buffer = filled(2);
        let mut output = output_with(vec![score("pinch_in", 0.4), score("pinch_out", 0.1)]);
        buffer.output(10_000 * MS, &output);
        output.scores = vec![score("pinch_in", 0.97)];
        output.rejections = vec![WindowRejection {
            label: label_id("pinch_in"),
            model_version: ModelVersionId::new("v1").unwrap(),
            reason: Rejection::NoMovement("nothing moved".into()),
        }];
        buffer.output(18_000 * MS, &output);
        let snapshot = buffer.snapshot(20_000 * MS, &BTreeMap::new()).unwrap();
        let activations = BTreeMap::from([
            ("pinch_in".to_string(), 0.99),
            ("pinch_out".to_string(), 0.95),
        ]);
        let summary = summarise(&snapshot, &activations);
        let pinch_in = &summary.labels[0];
        assert_eq!(
            (pinch_in.scores, pinch_in.peak, pinch_in.peak_ms_before_mark),
            (2, Some(0.97), Some(2_000))
        );
        assert_eq!(pinch_in.rejections.get("NoMovement"), Some(&1));
        assert_eq!(
            summary.lines,
            vec![
                "pinch_in: never detected. Its highest score was 0.97, 2.0 s before the mark (it starts at 0.99).",
                "pinch_in: rejections: NoMovement x1.",
                "pinch_out: never detected. Its highest score was 0.10, 10.0 s before the mark (it starts at 0.95).",
            ]
        );
    }

    #[test]
    fn detections_and_those_acted_on_are_counted_apart() {
        let mut buffer = filled(2);
        let rising = DetectionEvent::Rising {
            label: label_id("pinch_in"),
            confidence: 0.995,
            timestamp_ns: 0,
        };
        let mut output = output_with(vec![score("pinch_in", 0.995)]);
        output.events = vec![rising.clone()];
        buffer.output(5_000 * MS, &output);
        let monitor = summarise(
            &buffer.snapshot(6_000 * MS, &BTreeMap::new()).unwrap(),
            &BTreeMap::new(),
        );
        assert!(
            monitor.lines[0].contains("detected 1 time, but none was acted on"),
            "{:?}",
            monitor.lines
        );
        output.actionable = vec![rising];
        buffer.output(5_500 * MS, &output);
        let live = summarise(
            &buffer.snapshot(6_000 * MS, &BTreeMap::new()).unwrap(),
            &BTreeMap::new(),
        );
        assert_eq!((live.labels[0].detected, live.labels[0].acted), (2, 1));
    }

    #[test]
    fn with_no_model_running_the_summary_says_so_and_unknown_kinds_are_refused() {
        let snapshot = filled(2).snapshot(0, &BTreeMap::new()).unwrap();
        assert_eq!(
            summarise(&snapshot, &BTreeMap::new()).lines,
            vec!["No model was running, so nothing was scored."]
        );
        assert!(kind_text("missed").is_ok() && kind_text("falseActivation").is_ok());
        assert!(kind_text("nonsense").is_err());
    }
}
