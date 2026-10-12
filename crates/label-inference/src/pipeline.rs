//! The one shared path from raw telemetry to label scores.
//!
//! Telemetry is validated and buffered **once**, whatever number of models are running. Each model has its own window
//! (length, stride) and quality rules, so each is evaluated on its own schedule against the shared buffers: nothing
//! is re-validated and no stream is stored twice.
//!
//! Time. Windows are cut on the desktop's receive clock, the only one the watch's streams share (their own clocks are
//! not comparable). Each stream's samples are placed on it by their own timestamps through a [`ClockMap`] (the fastest
//! delivery recently seen gives the offset), so samples that arrive together keep their real spacing, as the trainer
//! sees it. Raw sensor timestamps are never altered: they are checked for order and carried through, and a score is
//! stamped with the raw timestamp of the newest sample of the model's primary stream.

use std::collections::{BTreeMap, VecDeque};

use model_lab_core::{LabelId, ModelVersionId, StreamSource};
use pinch_inference::{
    BASELINE_MIN_SAMPLES, BASELINE_SLACK_MS, FusedWindow, OrientationSnapshot, PpgBaseline,
    build_grid, extract_features_with,
};
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::clock::ClockMap;
use crate::model::{InputCheck, LoadedModel};

const NS_PER_MS: u64 = 1_000_000;
const MAX_BUFFERED_SAMPLES: usize = 20_000;

#[derive(Debug, Clone, PartialEq)]
pub struct LabelScore {
    pub label: LabelId,
    pub model_version: ModelVersionId,
    /// Probability that the label is present, in [0, 1].
    pub confidence: f64,
    /// Raw timestamp of the newest sample of the model's primary stream (watch clock, unaltered).
    pub timestamp_ns: u64,
    /// When the desktop scored it, on the desktop's receive clock.
    pub received_ns: u64,
    /// How this window's inputs compare with what the model was trained on, when the model's manifest says what that was.
    pub input_check: Option<InputCheck>,
}

/// Why a window was not scored. Every one of these ends the label's detection.
#[derive(Debug, Clone, PartialEq)]
pub enum Rejection {
    /// A stream's raw timestamps went backwards or repeated, or its values were not finite or were malformed.
    BadStream {
        source: StreamSource,
        detail: String,
    },
    /// A stream the model reads has produced nothing recently enough.
    SourceStale {
        source: StreamSource,
        age_ms: u64,
    },
    /// A stream has a gap longer than the model allows inside the window.
    Gap {
        source: StreamSource,
        gap_ms: u64,
    },
    TooFewSamples {
        source: StreamSource,
        have: usize,
        need: usize,
    },
    LowSampleCount {
        actual: usize,
        required: usize,
    },
    DegradedContactQuality {
        actual: f64,
        max_allowed: f64,
    },
    Model(String),
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadStream { source, detail } => write!(f, "{source:?} stream is bad: {detail}"),
            Self::SourceStale { source, age_ms } => write!(f, "{source:?} data is {age_ms} ms old"),
            Self::Gap { source, gap_ms } => write!(f, "{source:?} has a {gap_ms} ms gap"),
            Self::TooFewSamples { source, have, need } => {
                write!(f, "{source:?} has {have} samples, needs {need}")
            }
            Self::LowSampleCount { actual, required } => {
                write!(f, "{actual} PPG samples, quality rules need {required}")
            }
            Self::DegradedContactQuality {
                actual,
                max_allowed,
            } => {
                write!(
                    f,
                    "contact quality {actual} is worse than the allowed {max_allowed}"
                )
            }
            Self::Model(detail) => write!(f, "model error: {detail}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowRejection {
    pub label: LabelId,
    pub model_version: ModelVersionId,
    pub reason: Rejection,
}

#[derive(Debug, Clone)]
struct OrientationSample {
    received_ns: u64,
    /// When it was taken, on the receive clock (see [`ClockMap`]).
    at_ns: u64,
    accel: Option<[f64; 3]>,
    gyro: Option<[f64; 3]>,
    quat: [f64; 4],
    raw_ts_ns: u64,
}

#[derive(Debug, Clone)]
struct PpgSample {
    /// When it was taken, on the receive clock (see [`ClockMap`]; the pulse sensor's own clock is unrelated to the rest).
    at_ns: u64,
    raw_ts_ns: u64,
    green: f64,
    red: f64,
    ir: f64,
    /// The worst of the three channels' status codes (0 = valid, higher is worse).
    quality: f64,
}

#[derive(Debug, Default)]
pub struct LabelPipeline {
    orientation: VecDeque<OrientationSample>,
    ppg: VecDeque<PpgSample>,
    device_id: Option<String>,
    last_orientation_raw: Option<u64>,
    last_ppg_raw: Option<u64>,
    orientation_clock: ClockMap,
    ppg_clock: ClockMap,
    /// The longest history any loaded model needs, so buffers are bounded by what is used.
    retention_ns: u64,
    next_due_ns: BTreeMap<LabelId, u64>,
}

/// The real pulse samples in the `baseline_ms` before `start`, or `None` while there are not enough of them or they do not
/// reach back to the baseline's start (give or take [`BASELINE_SLACK_MS`]): the same rule the trainer uses to keep a window.
fn baseline_before(ppg: &VecDeque<PpgSample>, start: u64, baseline_ms: u32) -> Option<PpgBaseline> {
    // Not even that much time has passed since the clock began: nothing to compare with yet.
    let from = start.checked_sub(u64::from(baseline_ms) * NS_PER_MS)?;
    let past: Vec<&PpgSample> = ppg
        .iter()
        .filter(|s| s.at_ns >= from && s.at_ns < start)
        .collect();
    let reaches_back = past
        .first()
        .is_some_and(|s| s.at_ns <= from + BASELINE_SLACK_MS * NS_PER_MS);
    if past.len() < BASELINE_MIN_SAMPLES || !reaches_back {
        return None;
    }
    Some(PpgBaseline {
        green: past.iter().map(|s| s.green).collect(),
        red: past.iter().map(|s| s.red).collect(),
        ir: past.iter().map(|s| s.ir).collect(),
    })
}

fn finite3(v: &[f64; 3]) -> bool {
    v.iter().all(|c| c.is_finite())
}

impl LabelPipeline {
    /// Sets how much history to keep, from the models now loaded, and restarts every model's schedule.
    pub fn configure(&mut self, models: &[&LoadedModel]) {
        self.retention_ns = models
            .iter()
            .map(|m| {
                (u64::from(m.input.window_ms)
                    + u64::from(m.input.max_gap_ms)
                    + u64::from(m.baseline_ms.unwrap_or(0)))
                    * NS_PER_MS
            })
            .max()
            .unwrap_or(0)
            + 1_000 * NS_PER_MS;
        self.next_due_ns.clear();
    }

    /// Forgets all buffered telemetry and the ordering state (the watch went away, or the runtime was reset).
    pub fn reset(&mut self) {
        self.orientation.clear();
        self.ppg.clear();
        self.device_id = None;
        self.last_orientation_raw = None;
        self.last_ppg_raw = None;
        self.orientation_clock.reset();
        self.ppg_clock.reset();
        self.next_due_ns.clear();
    }

    fn adopt_device(&mut self, device_id: &str) {
        if self.device_id.as_deref() != Some(device_id) {
            // Another watch's samples must never be blended into this one's windows.
            self.reset();
            self.device_id = Some(device_id.to_string());
        }
    }

    fn prune(&mut self, now_ns: u64) {
        let oldest = now_ns.saturating_sub(self.retention_ns);
        while self
            .orientation
            .front()
            .is_some_and(|s| s.received_ns < oldest)
            || self.orientation.len() > MAX_BUFFERED_SAMPLES
        {
            self.orientation.pop_front();
        }
        while self.ppg.front().is_some_and(|s| s.at_ns < oldest)
            || self.ppg.len() > MAX_BUFFERED_SAMPLES
        {
            self.ppg.pop_front();
        }
    }

    /// Validates and buffers one orientation sample (which carries acceleration and gyroscope when the watch sent
    /// them). An out-of-order, repeated or non-finite sample is refused, and the caller must treat that as a fault.
    pub fn observe_orientation(
        &mut self,
        sample: &WatchOrientationSample,
        received_ns: u64,
    ) -> Result<(), Rejection> {
        self.adopt_device(&sample.device_id);
        let bad = |detail: &str| Rejection::BadStream {
            source: StreamSource::WatchOrientation,
            detail: detail.into(),
        };
        if !sample.quaternion.iter().all(|c| c.is_finite())
            || sample.accelerometer.as_ref().is_some_and(|a| !finite3(a))
            || sample.gyroscope.as_ref().is_some_and(|g| !finite3(g))
        {
            return Err(bad("a value is not finite"));
        }
        if self
            .last_orientation_raw
            .is_some_and(|last| sample.timestamp_ns <= last)
        {
            return Err(bad("timestamps did not increase"));
        }
        self.last_orientation_raw = Some(sample.timestamp_ns);
        self.orientation_clock
            .observe(sample.timestamp_ns, received_ns);
        let at_ns = self
            .orientation_clock
            .map(sample.timestamp_ns)
            .unwrap_or(received_ns);
        self.orientation.push_back(OrientationSample {
            received_ns,
            at_ns,
            accel: sample.accelerometer,
            gyro: sample.gyroscope,
            quat: sample.quaternion,
            raw_ts_ns: sample.timestamp_ns,
        });
        self.prune(received_ns);
        Ok(())
    }

    /// Validates and buffers one PPG batch.
    pub fn observe_ppg(
        &mut self,
        batch: &WatchPpgBatchSample,
        received_ns: u64,
    ) -> Result<(), Rejection> {
        self.adopt_device(&batch.device_id);
        let bad = |detail: &str| Rejection::BadStream {
            source: StreamSource::WatchPpg,
            detail: detail.into(),
        };
        let n = batch.timestamps_ns.len();
        let lengths = [
            batch.green.len(),
            batch.red.len(),
            batch.ir.len(),
            batch.green_status.len(),
            batch.red_status.len(),
            batch.ir_status.len(),
        ];
        if n == 0 || lengths.iter().any(|&l| l != n) {
            return Err(bad("channel lengths do not match the timestamps"));
        }
        if batch.timestamps_ns.windows(2).any(|w| w[1] <= w[0])
            || self
                .last_ppg_raw
                .is_some_and(|last| batch.timestamps_ns[0] <= last)
        {
            return Err(bad("timestamps did not increase"));
        }
        let last_raw = batch.timestamps_ns[n - 1];
        self.last_ppg_raw = Some(last_raw);
        // The batch left the watch just after its newest sample was taken; the others are placed by their own times.
        self.ppg_clock.observe(last_raw, received_ns);
        for i in 0..n {
            let age = last_raw - batch.timestamps_ns[i];
            self.ppg.push_back(PpgSample {
                at_ns: self
                    .ppg_clock
                    .map(batch.timestamps_ns[i])
                    .unwrap_or(received_ns.saturating_sub(age)),
                raw_ts_ns: batch.timestamps_ns[i],
                green: f64::from(batch.green[i]),
                red: f64::from(batch.red[i]),
                ir: f64::from(batch.ir[i]),
                quality: f64::from(
                    batch.green_status[i]
                        .max(batch.red_status[i])
                        .max(batch.ir_status[i]),
                ),
            });
        }
        self.prune(received_ns);
        Ok(())
    }

    /// Scores every model whose next window is due at `now_ns`. A window that cannot be scored is reported, never
    /// guessed at.
    pub fn evaluate(
        &mut self,
        models: &[&LoadedModel],
        now_ns: u64,
    ) -> (Vec<LabelScore>, Vec<WindowRejection>) {
        let mut scores = Vec::new();
        let mut rejections = Vec::new();
        for model in models {
            let due = self.next_due_ns.get(&model.label).copied().unwrap_or(0);
            if now_ns < due {
                continue;
            }
            match self.score(model, now_ns) {
                Ok(Some(score)) => scores.push(score),
                Ok(None) => continue, // not enough history yet: try again next tick
                Err(reason) => rejections.push(WindowRejection {
                    label: model.label.clone(),
                    model_version: model.version_id.clone(),
                    reason,
                }),
            }
            self.next_due_ns.insert(
                model.label.clone(),
                now_ns + u64::from(model.input.stride_ms) * NS_PER_MS,
            );
        }
        (scores, rejections)
    }

    /// `Ok(None)`: the buffers do not yet cover the window.
    fn score(&self, model: &LoadedModel, now_ns: u64) -> Result<Option<LabelScore>, Rejection> {
        let window_ns = u64::from(model.input.window_ms) * NS_PER_MS;
        let max_gap_ns = u64::from(model.input.max_gap_ms) * NS_PER_MS;
        let start = now_ns.saturating_sub(window_ns);
        let need = model.input.min_samples as usize;

        // Times, on the receive clock, of each source's samples inside the window.
        let mut primary_raw: Option<u64> = None;
        for (index, source) in model.input.sources.iter().enumerate() {
            let times: Vec<(u64, u64)> = match source {
                StreamSource::WatchPpg => self.ppg.iter().map(|s| (s.at_ns, s.raw_ts_ns)).collect(),
                StreamSource::WatchAcceleration => self
                    .orientation
                    .iter()
                    .filter(|s| s.accel.is_some())
                    .map(|s| (s.at_ns, s.raw_ts_ns))
                    .collect(),
                StreamSource::WatchGyroscope => self
                    .orientation
                    .iter()
                    .filter(|s| s.gyro.is_some())
                    .map(|s| (s.at_ns, s.raw_ts_ns))
                    .collect(),
                StreamSource::WatchOrientation => self
                    .orientation
                    .iter()
                    .map(|s| (s.at_ns, s.raw_ts_ns))
                    .collect(),
                StreamSource::HeadPose => {
                    return Err(Rejection::Model(
                        "head pose is not a readable stream yet".into(),
                    ));
                }
            };
            let Some(&(first_at, _)) = times.first() else {
                return Ok(None);
            };
            // Not enough history to cover the window yet (allowing for one gap at its start). Not an error.
            if now_ns.saturating_sub(first_at) + max_gap_ns < window_ns {
                return Ok(None);
            }
            let &(newest_at, newest_raw) = times.last().expect("non-empty");
            if now_ns.saturating_sub(newest_at) > max_gap_ns {
                return Err(Rejection::SourceStale {
                    source: *source,
                    age_ms: now_ns.saturating_sub(newest_at) / NS_PER_MS,
                });
            }
            let inside: Vec<u64> = times
                .iter()
                .map(|&(at, _)| at)
                .filter(|&at| at >= start && at <= now_ns)
                .collect();
            if inside.len() < need {
                return Err(Rejection::TooFewSamples {
                    source: *source,
                    have: inside.len(),
                    need,
                });
            }
            let mut previous = start;
            for &at in inside.iter().chain(std::iter::once(&now_ns)) {
                if at.saturating_sub(previous) > max_gap_ns {
                    return Err(Rejection::Gap {
                        source: *source,
                        gap_ms: at.saturating_sub(previous) / NS_PER_MS,
                    });
                }
                previous = at;
            }
            if index == 0 {
                primary_raw = Some(newest_raw);
            }
        }

        let ppg: Vec<&PpgSample> = self
            .ppg
            .iter()
            .filter(|s| s.at_ns >= start && s.at_ns <= now_ns)
            .collect();
        let uses_ppg = model.input.sources.contains(&StreamSource::WatchPpg);
        let contact_quality_mean = if ppg.is_empty() {
            0.0
        } else {
            ppg.iter().map(|s| s.quality).sum::<f64>() / ppg.len() as f64
        };
        if uses_ppg {
            if ppg.len() < model.quality.min_sample_count as usize {
                return Err(Rejection::LowSampleCount {
                    actual: ppg.len(),
                    required: model.quality.min_sample_count as usize,
                });
            }
            if contact_quality_mean > model.quality.max_contact_quality {
                return Err(Rejection::DegradedContactQuality {
                    actual: contact_quality_mean,
                    max_allowed: model.quality.max_contact_quality,
                });
            }
        }

        // A model that compares the window's pulse level with the recent past needs that past: the real pulse samples in the
        // `baseline_ms` before the window, reaching back to its start (give or take the slack). Until then it is warming up,
        // not failing: nothing is scored, and nothing is reported.
        let baseline = match model.baseline_ms.filter(|_| uses_ppg) {
            None => None,
            Some(baseline_ms) => match baseline_before(&self.ppg, start, baseline_ms) {
                Some(baseline) => Some(baseline),
                None => return Ok(None),
            },
        };

        // Orientation samples in the window, with a missing acceleration or gyroscope carried forward from the last
        // one that had it, as the live fusion has always done.
        let mut carried_accel = [0.0; 3];
        let mut carried_gyro = [0.0; 3];
        for sample in self.orientation.iter().filter(|s| s.at_ns < start) {
            carried_accel = sample.accel.unwrap_or(carried_accel);
            carried_gyro = sample.gyro.unwrap_or(carried_gyro);
        }
        let in_window: Vec<OrientationSnapshot> = self
            .orientation
            .iter()
            .filter(|s| s.at_ns >= start && s.at_ns <= now_ns)
            .map(|s| {
                carried_accel = s.accel.unwrap_or(carried_accel);
                carried_gyro = s.gyro.unwrap_or(carried_gyro);
                OrientationSnapshot {
                    accel: carried_accel,
                    gyro: carried_gyro,
                    quat: s.quat,
                }
            })
            .collect();
        let orientation_timestamps_ns: Vec<u64> = self
            .orientation
            .iter()
            .filter(|s| s.at_ns >= start && s.at_ns <= now_ns)
            .map(|s| s.raw_ts_ns)
            .collect();
        let latest = in_window.last().copied().unwrap_or(OrientationSnapshot {
            accel: carried_accel,
            gyro: carried_gyro,
            quat: [1.0, 0.0, 0.0, 0.0],
        });
        let window = FusedWindow {
            ppg_green: ppg.iter().map(|s| s.green).collect(),
            ppg_red: ppg.iter().map(|s| s.red).collect(),
            ppg_ir: ppg.iter().map(|s| s.ir).collect(),
            ppg_timestamps_ns: ppg.iter().map(|s| s.raw_ts_ns).collect(),
            orientation: latest,
            orientation_in_window: in_window,
            orientation_timestamps_ns,
            contact_quality_mean,
            baseline,
        };
        let selected = match &model.grid {
            // A convolutional model reads the window itself, as a grid of channels over time.
            Some(grid) => build_grid(
                &window,
                &grid.channels,
                grid.steps,
                model.spike_method,
                grid.timing,
                grid.pulse,
            ),
            None => model.select(&extract_features_with(&window, model.spike_method)),
        };
        let input_check = model.check_input(&selected);
        let confidence = model
            .predict_input(selected)
            .map_err(|e| Rejection::Model(e.to_string()))?;
        Ok(Some(LabelScore {
            label: model.label.clone(),
            model_version: model.version_id.clone(),
            confidence,
            timestamp_ns: primary_raw.unwrap_or(0),
            received_ns: now_ns,
            input_check,
        }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::tests::loaded;

    /// An orientation sample at 50 Hz whose acceleration shakes (`amplitude`) or is still (0). The strength varies from
    /// sample to sample so every axis and the magnitude all have a spread, as real shaking does.
    pub fn orientation(n: u64, amplitude: f64) -> WatchOrientationSample {
        let swing = if n.is_multiple_of(2) {
            amplitude
        } else {
            -amplitude
        } * (1.0 + (n % 3) as f64);
        WatchOrientationSample {
            device_id: "watch-1".into(),
            sequence: n,
            timestamp_ns: 1_000_000_000 + n * 20_000_000,
            quaternion: [1.0, 0.0, 0.0, 0.0],
            accelerometer: Some([swing, -swing * 0.8, swing * 1.2]),
            gyroscope: Some([0.0; 3]),
        }
    }

    /// Feeds `count` samples at 50 Hz starting at receive time `from_ms`, returning the last receive time in ns.
    pub fn feed(pipeline: &mut LabelPipeline, from_n: u64, count: u64, amplitude: f64) -> u64 {
        let mut last = 0;
        for n in from_n..from_n + count {
            last = n * 20_000_000;
            pipeline
                .observe_orientation(&orientation(n, amplitude), last)
                .unwrap();
        }
        last
    }

    fn configured() -> (LabelPipeline, LoadedModel) {
        let model = loaded();
        let mut pipeline = LabelPipeline::default();
        pipeline.configure(&[&model]);
        (pipeline, model)
    }

    #[test]
    fn motion_samples_delivered_together_keep_their_real_spacing() {
        let (mut p, _) = configured();
        // 50 Hz samples sent five at a time, every 100 ms, arriving 7 ms (one batch 30 ms) after the newest was taken.
        for batch in 0..10u64 {
            let newest = batch * 5 + 4;
            let delay_ms = if batch == 3 { 30 } else { 7 };
            let received = 10_000_000_000 + newest * 20_000_000 + delay_ms * NS_PER_MS;
            for n in batch * 5..=newest {
                p.observe_orientation(&orientation(n, 1.0), received)
                    .unwrap();
            }
        }
        let spacing: Vec<u64> = p
            .orientation
            .iter()
            .skip(5) // the first batch is placed before the estimate has settled on the fastest delivery
            .map(|s| s.at_ns)
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| w[1] - w[0])
            .collect();
        assert!(
            spacing.iter().all(|&gap| gap == 20 * NS_PER_MS),
            "{spacing:?}"
        );
        assert!(p.orientation.iter().all(|s| s.at_ns <= s.received_ns));
    }

    #[test]
    fn nothing_is_scored_until_the_buffers_cover_the_models_window() {
        let (mut p, model) = configured();
        let now = feed(&mut p, 0, 10, 5.0); // 200 ms of a 1000 ms window
        let (scores, rejections) = p.evaluate(&[&model], now);
        assert!(scores.is_empty() && rejections.is_empty());
    }

    #[test]
    fn shaking_scores_high_and_stillness_low_through_the_whole_path() {
        let (mut p, model) = configured();
        let now = feed(&mut p, 0, 60, 5.0); // 1.2 s of vigorous shaking
        let (scores, rejections) = p.evaluate(&[&model], now);
        assert!(rejections.is_empty(), "{rejections:?}");
        assert_eq!(scores.len(), 1);
        assert!(scores[0].confidence > 0.9, "{}", scores[0].confidence);
        // The score carries the raw watch timestamp of the newest sample, untouched.
        assert_eq!(scores[0].timestamp_ns, 1_000_000_000 + 59 * 20_000_000);
        assert_eq!(scores[0].received_ns, now);

        let (mut p, model) = configured();
        let now = feed(&mut p, 0, 60, 0.0);
        let (scores, _) = p.evaluate(&[&model], now);
        assert!(scores[0].confidence < 0.1, "{}", scores[0].confidence);
    }

    /// A convolutional model is fed the window as a grid, through the same shared buffers, and tells vigorous shaking
    /// from stillness (the fixture was trained on exactly that).
    #[test]
    fn a_convolutional_model_scores_the_window_as_a_grid() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/trained_cnn_bundle");
        let bundle = crate::bundle::validate_bundle(&dir, None).unwrap();
        let version = crate::model::tests::active_version(&bundle);
        let model = LoadedModel::load(bundle, &version).unwrap();
        let score = |amplitude: f64| {
            let mut pipeline = LabelPipeline::default();
            pipeline.configure(&[&model]);
            let now = feed(&mut pipeline, 0, 60, amplitude);
            let (scores, rejections) = pipeline.evaluate(&[&model], now);
            assert!(rejections.is_empty(), "{rejections:?}");
            scores[0].confidence
        };
        let shaking = score(5.0);
        let still = score(0.0);
        assert!(shaking > still, "{shaking} vs {still}");
        assert!(shaking > 0.5 && still < 0.5, "{shaking} vs {still}");
    }

    #[test]
    fn a_model_is_evaluated_once_per_stride_not_on_every_sample() {
        let (mut p, model) = configured();
        let now = feed(&mut p, 0, 60, 5.0);
        assert_eq!(p.evaluate(&[&model], now).0.len(), 1);
        // 100 ms later is inside the 200 ms stride.
        assert!(p.evaluate(&[&model], now + 100 * NS_PER_MS).0.is_empty());
        let later = feed(&mut p, 60, 12, 5.0);
        assert_eq!(p.evaluate(&[&model], later).0.len(), 1);
    }

    #[test]
    fn a_source_that_has_gone_quiet_rejects_the_window() {
        let (mut p, model) = configured();
        let now = feed(&mut p, 0, 60, 5.0);
        p.evaluate(&[&model], now);
        // Nothing arrives for a second, well past the 300 ms maximum gap.
        let (scores, rejections) = p.evaluate(&[&model], now + 1_200 * NS_PER_MS);
        assert!(scores.is_empty());
        assert!(
            matches!(rejections[0].reason, Rejection::SourceStale { .. }),
            "{rejections:?}"
        );
        assert_eq!(rejections[0].label.as_str(), "shake_fixture");
    }

    #[test]
    fn a_gap_in_the_middle_of_a_window_and_too_few_samples_are_rejected() {
        let (mut p, model) = configured();
        feed(&mut p, 0, 20, 5.0);
        // A 500 ms hole (25 samples missing), then samples again: the window straddles the gap.
        let now = feed(&mut p, 45, 20, 5.0);
        let (scores, rejections) = p.evaluate(&[&model], now);
        assert!(scores.is_empty());
        assert!(
            matches!(rejections[0].reason, Rejection::Gap { .. }),
            "{rejections:?}"
        );
    }

    #[test]
    fn out_of_order_repeated_and_non_finite_samples_are_refused_and_not_buffered() {
        let (mut p, _) = configured();
        p.observe_orientation(&orientation(5, 1.0), 100).unwrap();
        assert!(
            matches!(
                p.observe_orientation(&orientation(5, 1.0), 200),
                Err(Rejection::BadStream { .. })
            ),
            "a repeat"
        );
        assert!(
            matches!(
                p.observe_orientation(&orientation(4, 1.0), 300),
                Err(Rejection::BadStream { .. })
            ),
            "going backwards"
        );
        let mut nan = orientation(6, 1.0);
        nan.quaternion[0] = f64::NAN;
        assert!(matches!(
            p.observe_orientation(&nan, 400),
            Err(Rejection::BadStream { .. })
        ));
        let mut inf = orientation(7, 1.0);
        inf.accelerometer = Some([f64::INFINITY, 0.0, 0.0]);
        assert!(p.observe_orientation(&inf, 500).is_err());
        assert_eq!(p.orientation.len(), 1);
    }

    #[test]
    fn another_watch_never_mixes_into_the_windows() {
        let (mut p, _) = configured();
        p.observe_orientation(&orientation(1, 1.0), 10).unwrap();
        let mut other = orientation(2, 1.0);
        other.device_id = "watch-2".into();
        p.observe_orientation(&other, 20).unwrap();
        assert_eq!(
            p.orientation.len(),
            1,
            "the first watch's samples were dropped when the second appeared"
        );
    }

    #[test]
    fn malformed_ppg_batches_are_refused() {
        let (mut p, _) = configured();
        let batch = |ts: Vec<u64>, green: Vec<i32>| WatchPpgBatchSample {
            device_id: "watch-1".into(),
            sequence: 1,
            timestamp_ns: 0,
            sample_count: ts.len() as u32,
            green_status: vec![0; green.len()],
            red: green.clone(),
            red_status: vec![0; green.len()],
            ir: green.clone(),
            ir_status: vec![0; green.len()],
            timestamps_ns: ts,
            green,
        };
        assert!(p.observe_ppg(&batch(vec![], vec![]), 1).is_err(), "empty");
        assert!(
            p.observe_ppg(&batch(vec![1, 2, 3], vec![1, 2]), 1).is_err(),
            "lengths differ"
        );
        assert!(
            p.observe_ppg(&batch(vec![2, 2, 3], vec![1, 2, 3]), 1)
                .is_err(),
            "timestamps repeat"
        );
        assert!(
            p.observe_ppg(&batch(vec![10, 20, 30], vec![1, 2, 3]), 1)
                .is_ok()
        );
        assert!(
            p.observe_ppg(&batch(vec![30, 40], vec![1, 2]), 2).is_err(),
            "overlaps the last batch"
        );
    }

    #[test]
    fn buffers_stay_bounded() {
        let (mut p, model) = configured();
        let now = feed(&mut p, 0, 5000, 1.0); // 100 s of samples
        assert!(
            p.orientation.len() < 100 * 50 / 4,
            "{} samples kept",
            p.orientation.len()
        );
        assert!(p.evaluate(&[&model], now).1.is_empty());
    }

    fn ppg_at(at_ms: u64, level: f64) -> PpgSample {
        PpgSample {
            at_ns: at_ms * NS_PER_MS,
            raw_ts_ns: at_ms * NS_PER_MS,
            green: level,
            red: level + 1.0,
            ir: level + 2.0,
            quality: 0.0,
        }
    }

    #[test]
    fn the_baseline_is_the_real_pulse_samples_just_before_the_window_and_waits_until_it_reaches_back()
     {
        // A pulse sample every 60 ms from 0 to 5000 ms.
        let ppg: VecDeque<PpgSample> = (0..84).map(|i| ppg_at(i * 60, 100.0 + i as f64)).collect();
        let start = 5_000 * NS_PER_MS;
        let past = baseline_before(&ppg, start, 2000).expect("2 s of past is there");
        assert!(past.green.len() >= 30 && past.green.len() <= 34);
        assert!(past.green.iter().all(|v| *v < 100.0 + 84.0)); // nothing from the window itself or later
        assert_eq!(
            (past.red[0] - past.green[0], past.ir[0] - past.green[0]),
            (1.0, 2.0)
        );
        // The same window with only 1.5 s of history: not there yet (a warm-up), not an error.
        let young: VecDeque<PpgSample> = ppg
            .iter()
            .filter(|s| s.at_ns >= 3_500 * NS_PER_MS)
            .cloned()
            .collect();
        assert!(baseline_before(&young, start, 2000).is_none());
        // Too few samples even when they reach back.
        let sparse: VecDeque<PpgSample> = [3_000, 3_900, 4_900]
            .iter()
            .map(|t| ppg_at(*t, 1.0))
            .collect();
        assert!(baseline_before(&sparse, start, 2000).is_none());
        // A longer baseline needs more history.
        assert!(baseline_before(&ppg, start, 8000).is_none());
    }

    #[test]
    fn the_buffers_keep_a_models_baseline_as_well_as_its_window() {
        let mut model = loaded();
        let mut pipeline = LabelPipeline::default();
        pipeline.configure(&[&model]);
        let without = pipeline.retention_ns;
        model.baseline_ms = Some(4000);
        pipeline.configure(&[&model]);
        assert_eq!(pipeline.retention_ns, without + 4_000 * NS_PER_MS);
    }

    /// A model from the real trainer that reads the pulse sensor's level against its recent past, run through the whole
    /// live path: it waits until it has the baseline, then scores a held level shift high and the rest low, at a level
    /// (90 000) unlike the sessions it was trained on.
    #[test]
    fn a_model_on_the_level_against_the_recent_past_warms_up_then_tells_a_held_shift_from_rest() {
        use crate::bundle::validate_bundle;
        use crate::model::tests::active_version;
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/trained_baseline_bundle");
        let bundle = validate_bundle(&dir, Some(&LabelId::new("pinch").unwrap())).unwrap();
        let version = active_version(&bundle);
        let model = LoadedModel::load(bundle, &version).unwrap();
        assert_eq!(model.baseline_ms, Some(4000));
        let mut pipeline = LabelPipeline::default();
        pipeline.configure(&[&model]);

        let mut scores: Vec<(u64, f64)> = Vec::new();
        let mut first_score_ms = None;
        for n in 0..170u64 {
            let at_ms = n * 60;
            let shifted = (6_000..8_400).contains(&at_ms);
            // A little noise that repeats, so the run is the same every time.
            let noise = [-120.0, 40.0, 90.0, -60.0, 140.0, -20.0][(n % 6) as usize];
            let level = 90_000.0 + noise + if shifted { 3_000.0 } else { 0.0 };
            let batch = WatchPpgBatchSample {
                device_id: "watch-1".into(),
                sequence: n,
                timestamp_ns: at_ms * NS_PER_MS,
                sample_count: 1,
                timestamps_ns: vec![at_ms * NS_PER_MS],
                green: vec![level as i32],
                green_status: vec![0],
                red: vec![level as i32],
                red_status: vec![0],
                ir: vec![level as i32],
                ir_status: vec![0],
            };
            pipeline.observe_ppg(&batch, at_ms * NS_PER_MS).unwrap();
            let (got, rejected) = pipeline.evaluate(&[&model], at_ms * NS_PER_MS);
            assert!(rejected.is_empty(), "{at_ms} ms: {rejected:?}");
            for score in got {
                first_score_ms.get_or_insert(at_ms);
                scores.push((at_ms, score.confidence));
            }
        }
        // 4 s of past plus a 0.5 s window must have passed before anything is scored.
        assert!(first_score_ms.unwrap() >= 4_000, "{first_score_ms:?}");
        let mean = |from: u64, to: u64| {
            let in_range: Vec<f64> = scores
                .iter()
                .filter(|(t, _)| (from..to).contains(t))
                .map(|(_, c)| *c)
                .collect();
            assert!(!in_range.is_empty(), "no scores in {from}..{to}");
            in_range.iter().sum::<f64>() / in_range.len() as f64
        };
        let rest = mean(4_500, 5_800);
        let held = mean(6_800, 8_400);
        assert!(held > 0.8 && rest < 0.3, "held {held}, rest {rest}");
    }
}
