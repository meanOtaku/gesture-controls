//! The one shared path from raw telemetry to label scores.
//!
//! Telemetry is validated and buffered **once**, whatever number of models are running. Every model decides once for each
//! new pulse sample, in order, as the trainer decides at every sample of a recording; between samples (a timer tick) only
//! the streams' health is checked. A PPG + IMU model also reads the motion samples, and decides on a pulse sample only once
//! the motion up to it has arrived (the two streams are sent separately), so it sees the history the trainer saw.
//!
//! Time. Windows are cut on the desktop's receive clock. Pulse samples are placed on it by their own timestamps through a
//! [`ClockMap`], so samples that arrive together keep their real spacing. The pulse features are computed from the
//! samples' raw timestamps, as the trainer computes them from a recording (see [`pinch_inference::ppg_onset`]). The pulse
//! sensor's clock is not the one the motion samples are stamped with, so each pulse sample is also placed on the watch's
//! clock, from the time its batch was sent, exactly as the recorder does (`SourceClockMap`); the motion features of a
//! decision end there (see [`pinch_inference::imu_onset`]). Raw timestamps are never altered; a score is stamped with its
//! pulse sample's.

use std::collections::{BTreeMap, VecDeque};

use model_lab_core::{LabelId, ModelVersionId, StreamSource};
use pinch_inference::imu_onset::{self, MotionSample};
use pinch_inference::ppg_onset::{PpgSample as Sample, features};
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::clock::ClockMap;
use crate::model::{InputCheck, LoadedModel};

const NS_PER_MS: u64 = 1_000_000;
const MAX_BUFFERED_SAMPLES: usize = 20_000;
/// The most pulse samples one model decides on in one evaluation; older ones waiting longer are skipped.
const MAX_DECISIONS_PER_ROUND: usize = 50;
/// The motion stream is stale when nothing has arrived for this long (it is sent every 100 ms).
const MOTION_STALE_MS: u64 = 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct LabelScore {
    pub label: LabelId,
    pub model_version: ModelVersionId,
    /// Probability that the label just started, in [0, 1].
    pub confidence: f64,
    /// Raw timestamp of the newest pulse sample (watch clock, unaltered).
    pub timestamp_ns: u64,
    /// When the desktop scored it, on the desktop's receive clock.
    pub received_ns: u64,
    /// How this decision's inputs compare with what the model was trained on, when the model's manifest says.
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
    /// The pulse stream has produced nothing recently enough.
    SourceStale {
        source: StreamSource,
        age_ms: u64,
    },
    /// The pulse stream has a gap longer than the model allows inside its window.
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
struct PpgSample {
    /// When it was taken, on the receive clock (see [`ClockMap`]; the pulse sensor's own clock is unrelated to the rest).
    at_ns: u64,
    raw_ts_ns: u64,
    green: f64,
    red: f64,
    ir: f64,
    /// The worst of the three channels' status codes (0 = valid, higher is worse).
    quality: f64,
    /// When it was taken on the watch's clock (the motion samples'), or `None` before any batch placed the pulse clock.
    watch_ns: Option<u64>,
}

#[derive(Debug, Clone)]
struct MotionEntry {
    /// When it arrived, on the receive clock (for freshness only).
    received_ns: u64,
    sample: MotionSample,
}

#[derive(Debug, Default)]
pub struct LabelPipeline {
    ppg: VecDeque<PpgSample>,
    /// Motion samples with an accelerometer and gyroscope reading, in the watch's time order.
    motion: VecDeque<MotionEntry>,
    device_id: Option<String>,
    last_orientation_raw: Option<u64>,
    last_ppg_raw: Option<u64>,
    ppg_clock: ClockMap,
    /// The pulse sensor's clock onto the watch's, from each batch's send time.
    ppg_to_watch: ClockMap,
    /// The longest history any loaded model needs, so the buffer is bounded by what is used.
    retention_ns: u64,
    /// The newest sample each model has decided on, so it decides on each sample once.
    last_decided_raw: BTreeMap<LabelId, u64>,
    /// After a rejection, a model is not tried again (or reported again) before this, its stride later.
    quiet_until_ns: BTreeMap<LabelId, u64>,
}

fn finite3(v: &[f64; 3]) -> bool {
    v.iter().all(|c| c.is_finite())
}

impl LabelPipeline {
    /// Sets how much history to keep, from the models now loaded, and restarts every model's schedule.
    pub fn configure(&mut self, models: &[&LoadedModel]) {
        self.retention_ns = models
            .iter()
            .map(|m| (u64::from(m.input.window_ms) + u64::from(m.input.max_gap_ms)) * NS_PER_MS)
            .max()
            .unwrap_or(0)
            + 1_000 * NS_PER_MS;
        self.last_decided_raw.clear();
        self.quiet_until_ns.clear();
    }

    /// Forgets all buffered telemetry and the ordering state (the watch went away, or the runtime was reset).
    pub fn reset(&mut self) {
        self.ppg.clear();
        self.motion.clear();
        self.device_id = None;
        self.last_orientation_raw = None;
        self.last_ppg_raw = None;
        self.ppg_clock.reset();
        self.ppg_to_watch.reset();
        self.last_decided_raw.clear();
        self.quiet_until_ns.clear();
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
        while self.ppg.front().is_some_and(|s| s.at_ns < oldest)
            || self.ppg.len() > MAX_BUFFERED_SAMPLES
        {
            self.ppg.pop_front();
        }
        while self.motion.front().is_some_and(|m| m.received_ns < oldest)
            || self.motion.len() > MAX_BUFFERED_SAMPLES
        {
            self.motion.pop_front();
        }
    }

    /// Validates one orientation sample and keeps its accelerometer and gyroscope reading for the models that read motion.
    /// An out-of-order, repeated or non-finite sample is refused, and the caller must treat that as a fault.
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
        if let (Some(accel), Some(gyro)) = (sample.accelerometer, sample.gyroscope) {
            self.motion.push_back(MotionEntry {
                received_ns,
                sample: MotionSample {
                    ts_ns: sample.timestamp_ns,
                    accel,
                    gyro,
                },
            });
            self.prune(received_ns);
        }
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
        self.ppg_to_watch.observe(last_raw, batch.timestamp_ns);
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
                watch_ns: self.ppg_to_watch.map(batch.timestamps_ns[i]),
            });
        }
        self.prune(received_ns);
        Ok(())
    }

    /// Scores every model on each pulse sample it has not decided on yet, in order, and checks every model's streams are
    /// healthy. A window that cannot be scored is reported (at most once a stride), never guessed at.
    pub fn evaluate(
        &mut self,
        models: &[&LoadedModel],
        now_ns: u64,
    ) -> (Vec<LabelScore>, Vec<WindowRejection>) {
        let mut scores = Vec::new();
        let mut rejections = Vec::new();
        for model in models {
            if self
                .quiet_until_ns
                .get(&model.label)
                .is_some_and(|&until| now_ns < until)
            {
                continue;
            }
            let last = self.last_decided_raw.get(&model.label).copied();
            match self.score(model, now_ns, last) {
                Ok((decided, through)) => {
                    if let Some(through) = through {
                        self.last_decided_raw.insert(model.label.clone(), through);
                    }
                    scores.extend(decided);
                }
                Err(reason) => {
                    self.quiet_until_ns.insert(
                        model.label.clone(),
                        now_ns + u64::from(model.input.stride_ms) * NS_PER_MS,
                    );
                    rejections.push(WindowRejection {
                        label: model.label.clone(),
                        model_version: model.version_id.clone(),
                        reason,
                    });
                }
            }
        }
        (scores, rejections)
    }

    /// The scores of the pulse samples after `last_decided` (only the newest, the first time), oldest first, and the raw
    /// timestamp of the last one decided on, whether or not it had inputs. Nothing while the buffer does not yet hold the
    /// model's history (it is warming up). A PPG + IMU model stops at the first sample whose motion has not all arrived.
    fn score(
        &self,
        model: &LoadedModel,
        now_ns: u64,
        last_decided: Option<u64>,
    ) -> Result<(Vec<LabelScore>, Option<u64>), Rejection> {
        let source = StreamSource::WatchPpg;
        if model.input.sources != model.kind.sources() {
            return Err(Rejection::Model(format!(
                "the model's contract reads {:?}, but a model of its kind reads {:?}",
                model.input.sources,
                model.kind.sources()
            )));
        }
        let window_ns = u64::from(model.input.window_ms) * NS_PER_MS;
        let max_gap_ns = u64::from(model.input.max_gap_ms) * NS_PER_MS;
        let start = now_ns.saturating_sub(window_ns);
        let nothing = Ok((Vec::new(), None));
        let Some(first) = self.ppg.front() else {
            return nothing;
        };
        // Not enough history to cover the window yet (allowing for one gap at its start). Not an error.
        if now_ns.saturating_sub(first.at_ns) + max_gap_ns < window_ns {
            return nothing;
        }
        let newest = self.ppg.back().expect("non-empty");
        if now_ns.saturating_sub(newest.at_ns) > max_gap_ns {
            return Err(Rejection::SourceStale {
                source,
                age_ms: now_ns.saturating_sub(newest.at_ns) / NS_PER_MS,
            });
        }
        let inside: Vec<&PpgSample> = self
            .ppg
            .iter()
            .filter(|s| s.at_ns >= start && s.at_ns <= now_ns)
            .collect();
        let need = model.input.min_samples as usize;
        if inside.len() < need {
            return Err(Rejection::TooFewSamples {
                source,
                have: inside.len(),
                need,
            });
        }
        let mut previous = start;
        for at in inside.iter().map(|s| s.at_ns).chain(std::iter::once(now_ns)) {
            if at.saturating_sub(previous) > max_gap_ns {
                return Err(Rejection::Gap {
                    source,
                    gap_ms: at.saturating_sub(previous) / NS_PER_MS,
                });
            }
            previous = at;
        }
        if inside.len() < model.quality.min_sample_count as usize {
            return Err(Rejection::LowSampleCount {
                actual: inside.len(),
                required: model.quality.min_sample_count as usize,
            });
        }
        let contact_quality_mean =
            inside.iter().map(|s| s.quality).sum::<f64>() / inside.len() as f64;
        if contact_quality_mean > model.quality.max_contact_quality {
            return Err(Rejection::DegradedContactQuality {
                actual: contact_quality_mean,
                max_allowed: model.quality.max_contact_quality,
            });
        }
        let motion_through = if model.kind.reads_motion() {
            let Some(latest) = self.motion.back() else {
                return nothing; // no motion yet: warming up
            };
            let age = now_ns.saturating_sub(latest.received_ns);
            if age > MOTION_STALE_MS * NS_PER_MS {
                return Err(Rejection::SourceStale {
                    source: StreamSource::WatchOrientation,
                    age_ms: age / NS_PER_MS,
                });
            }
            Some(latest.sample.ts_ns)
        } else {
            None
        };

        // A sample can be decided on once all its inputs have arrived: for a motion model, the motion up to it.
        let ready = |s: &PpgSample| match motion_through {
            None => true,
            Some(through) => s.watch_ns.is_some_and(|at| at <= through),
        };
        // The samples to decide on: those after the last one decided that are ready, oldest first (the newest ready one
        // alone, the first time).
        let pending: Vec<&PpgSample> = match last_decided {
            Some(last) => self
                .ppg
                .iter()
                .filter(|s| s.raw_ts_ns > last)
                .take_while(|s| ready(s))
                .collect(),
            None => self
                .ppg
                .iter()
                .rev()
                .find(|s| ready(s))
                .into_iter()
                .collect(),
        };
        let pending = &pending[pending.len().saturating_sub(MAX_DECISIONS_PER_ROUND)..];
        let samples: Vec<Sample> = self
            .ppg
            .iter()
            .map(|s| Sample {
                ts_ns: s.raw_ts_ns,
                green: s.green,
                red: s.red,
                ir: s.ir,
            })
            .collect();
        let motion: Vec<MotionSample> = if motion_through.is_some() {
            self.motion.iter().map(|m| m.sample).collect()
        } else {
            Vec::new()
        };
        let mut scores = Vec::new();
        let mut through = None;
        for sample in pending {
            // The model's inputs, from the samples' own timestamps, for a decision at this sample: what the trainer computes.
            let inputs = match (motion_through, sample.watch_ns) {
                (Some(_), Some(at)) => {
                    features(&samples, sample.raw_ts_ns).and_then(|mut pulse| {
                        pulse.extend(imu_onset::features(&motion, at)?);
                        Some(pulse)
                    })
                }
                _ => features(&samples, sample.raw_ts_ns),
            };
            through = Some(sample.raw_ts_ns);
            let Some(inputs) = inputs else {
                continue;
            };
            let input_check = model.check_input(&inputs);
            let confidence = model
                .predict(&inputs)
                .map_err(|e| Rejection::Model(e.to_string()))?;
            scores.push(LabelScore {
                label: model.label.clone(),
                model_version: model.version_id.clone(),
                confidence,
                timestamp_ns: sample.raw_ts_ns,
                received_ns: now_ns,
                input_check,
            });
        }
        Ok((scores, through))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::tests::{expected, expected_motion, loaded, loaded_motion};

    /// One PPG batch of the samples `from..to` of `trace` (statuses all valid).
    pub fn batch(trace: &[Sample], from: usize, to: usize) -> WatchPpgBatchSample {
        let part = &trace[from..to];
        WatchPpgBatchSample {
            device_id: "watch-1".into(),
            sequence: from as u64,
            timestamp_ns: part.last().unwrap().ts_ns,
            sample_count: part.len() as u32,
            timestamps_ns: part.iter().map(|s| s.ts_ns).collect(),
            green: part.iter().map(|s| s.green as i32).collect(),
            green_status: vec![0; part.len()],
            red: part.iter().map(|s| s.red as i32).collect(),
            red_status: vec![0; part.len()],
            ir: part.iter().map(|s| s.ir as i32).collect(),
            ir_status: vec![0; part.len()],
        }
    }

    fn configured() -> (LabelPipeline, LoadedModel) {
        let model = loaded();
        let mut pipeline = LabelPipeline::default();
        pipeline.configure(&[&model]);
        (pipeline, model)
    }

    /// Feeds the trace one sample per batch, each received 5 ms after it was taken (shifted onto the receive clock), and
    /// evaluates after each: the scores and rejections.
    fn replay(trace: &[Sample]) -> (Vec<LabelScore>, Vec<WindowRejection>) {
        let (mut p, model) = configured();
        let origin = trace[0].ts_ns;
        let (mut scores, mut rejected) = (Vec::new(), Vec::new());
        for i in 0..trace.len() {
            let received = trace[i].ts_ns - origin + 10_000_000_000 + 5 * NS_PER_MS;
            p.observe_ppg(&batch(trace, i, i + 1), received).unwrap();
            let (s, r) = p.evaluate(&[&model], received);
            scores.extend(s);
            rejected.extend(r);
        }
        (scores, rejected)
    }

    #[test]
    fn the_live_path_scores_the_trace_as_the_trainer_did() {
        let (trace, probabilities) = expected();
        let (scores, rejected) = replay(&trace);
        assert!(rejected.is_empty(), "{rejected:?}");
        assert!(scores.len() > 300);
        let model = loaded();
        for score in &scores {
            let i = trace.iter().position(|s| s.ts_ns == score.timestamp_ns).unwrap();
            let want = probabilities[i].expect("the trainer scored it too");
            assert!((score.confidence - want).abs() < 1e-6, "{} vs {want}", score.confidence);
            assert_eq!(score.model_version, model.version_id);
        }
    }

    /// A one-off check of a model the trainer made from real recordings: `PPG_E2E_BUNDLE` (a bundle folder) and
    /// `PPG_E2E_TRACE` (a recording's pulse samples, the trainer's probability for each, and for a PPG + IMU model its motion
    /// samples, as `expected.json` holds them). The streams arrive as the watch sends them: each pulse sample 5 ms after it
    /// was taken, each motion sample 60 ms after.
    #[test]
    #[ignore = "one-off: set PPG_E2E_BUNDLE and PPG_E2E_TRACE"]
    fn a_real_bundle_scores_a_real_recording_as_the_trainer_did() {
        let bundle_dir = std::env::var("PPG_E2E_BUNDLE").expect("PPG_E2E_BUNDLE");
        let bundle = crate::bundle::validate_bundle(std::path::Path::new(&bundle_dir), None).unwrap();
        let version = crate::model::tests::active_version(&bundle);
        let model = LoadedModel::load(bundle, &version).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var("PPG_E2E_TRACE").unwrap()).unwrap()).unwrap();
        let trace: Vec<Sample> = raw["samples"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| Sample {
                ts_ns: r[0].as_u64().unwrap(),
                green: r[1].as_f64().unwrap(),
                red: r[2].as_f64().unwrap(),
                ir: r[3].as_f64().unwrap(),
            })
            .collect();
        let want: Vec<Option<f64>> = raw["probabilities"].as_array().unwrap().iter().map(serde_json::Value::as_f64).collect();
        let motion: Vec<MotionSample> = raw["motion"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        let v = |i: usize| r[i].as_f64().unwrap();
                        MotionSample { ts_ns: r[0].as_u64().unwrap(), accel: [v(1), v(2), v(3)], gyro: [v(4), v(5), v(6)] }
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(model.kind.reads_motion(), !motion.is_empty(), "a PPG + IMU model needs the motion samples, and only it");
        // A recording can repeat a timestamp, which the watch never sends live: keep the last sample at each, as the
        // trainer's zero-order hold does (both decide the same at that time).
        let keep: Vec<usize> = (0..trace.len())
            .filter(|&i| i + 1 == trace.len() || trace[i + 1].ts_ns > trace[i].ts_ns)
            .collect();
        let repeated = trace.len() - keep.len();
        let trace: Vec<Sample> = keep.iter().map(|&i| trace[i]).collect();
        let want: Vec<Option<f64>> = keep.iter().map(|&i| want[i]).collect();
        let motion: Vec<MotionSample> = (0..motion.len())
            .filter(|&j| j + 1 == motion.len() || motion[j + 1].ts_ns > motion[j].ts_ns)
            .map(|j| motion[j])
            .collect();
        let origin = trace[0].ts_ns.min(motion.first().map_or(u64::MAX, |m| m.ts_ns));
        let received = |ts: u64, delay_ms: u64| ts - origin + 10_000_000_000 + delay_ms * NS_PER_MS;
        let mut arrivals: Vec<(u64, bool, usize)> = (0..trace.len()).map(|i| (received(trace[i].ts_ns, 5), true, i)).collect();
        arrivals.extend((0..motion.len()).map(|j| (received(motion[j].ts_ns, 60), false, j)));
        arrivals.sort();
        let mut p = LabelPipeline::default();
        p.configure(&[&model]);
        let (mut scored, mut worst, mut rejected) = (0, 0.0f64, 0);
        for (at, pulse, i) in arrivals {
            if pulse {
                let mut b = batch(&trace, i, i + 1);
                b.timestamp_ns = trace[i].ts_ns;
                p.observe_ppg(&b, at).unwrap();
            } else {
                p.observe_orientation(&motion_sample(&motion[i], i as u64), at).unwrap();
            }
            let (scores, rejections) = p.evaluate(&[&model], at);
            rejected += rejections.len();
            for score in scores {
                let index = trace.iter().position(|s| s.ts_ns == score.timestamp_ns).unwrap();
                let expected = want[index].expect("the trainer scored this decision too");
                worst = worst.max((score.confidence - expected).abs());
                scored += 1;
            }
        }
        println!("scored {scored} decisions live ({repeated} repeated timestamps dropped), largest difference from the trainer {worst:e}, {rejected} rejected");
        assert!(scored > 1000 && worst < 1e-6);
    }

    /// The pulse sensor's clock runs this far behind the watch's in the motion tests.
    const SDK_BEHIND_NS: u64 = 7_000_000_000;

    /// One motion sample as the watch sends it.
    pub fn motion_sample(m: &MotionSample, sequence: u64) -> WatchOrientationSample {
        WatchOrientationSample {
            device_id: "watch-1".into(),
            sequence,
            timestamp_ns: m.ts_ns,
            quaternion: [1.0, 0.0, 0.0, 0.0],
            accelerometer: Some(m.accel),
            gyroscope: Some(m.gyro),
        }
    }

    /// Feeds the motion fixture's trace as the watch sends it: each pulse sample in a batch of its own, stamped on the pulse
    /// sensor's clock and sent the moment it was taken, and each motion sample `motion_delay_ms` after it was taken (the
    /// streams are sent separately). Evaluates after each arrival.
    fn replay_motion(motion_delay_ms: u64) -> (Vec<LabelScore>, Vec<WindowRejection>) {
        let model = loaded_motion();
        let mut p = LabelPipeline::default();
        p.configure(&[&model]);
        let (trace, motion, _) = expected_motion();
        let origin = trace[0].ts_ns;
        let received = |ts: u64, delay_ms: u64| ts - origin + 10_000_000_000 + delay_ms * NS_PER_MS;
        let mut arrivals: Vec<(u64, bool, usize)> = (0..trace.len())
            .map(|i| (received(trace[i].ts_ns, 5), true, i))
            .collect();
        arrivals.extend(
            (0..motion.len()).map(|j| (received(motion[j].ts_ns, motion_delay_ms), false, j)),
        );
        arrivals.sort();
        let (mut scores, mut rejected) = (Vec::new(), Vec::new());
        for (at, pulse, i) in arrivals {
            if pulse {
                let mut b = batch(&trace, i, i + 1);
                b.timestamp_ns = trace[i].ts_ns; // sent on the watch's clock
                b.timestamps_ns = vec![trace[i].ts_ns - SDK_BEHIND_NS];
                p.observe_ppg(&b, at).unwrap();
            } else {
                p.observe_orientation(&motion_sample(&motion[i], i as u64), at)
                    .unwrap();
            }
            let (s, r) = p.evaluate(&[&model], at);
            scores.extend(s);
            rejected.extend(r);
        }
        (scores, rejected)
    }

    #[test]
    fn a_motion_model_scores_the_live_streams_as_the_trainer_did() {
        let (trace, _, probabilities) = expected_motion();
        // Motion arriving 60 ms after it was taken, later than the pulse: each decision waits for its motion.
        let (scores, rejected) = replay_motion(60);
        assert!(rejected.is_empty(), "{rejected:?}");
        assert!(scores.len() > 300, "{}", scores.len());
        for pair in scores.windows(2) {
            assert!(
                pair[1].timestamp_ns > pair[0].timestamp_ns,
                "each sample once, in order"
            );
        }
        for score in &scores {
            let i = trace
                .iter()
                .position(|s| s.ts_ns - SDK_BEHIND_NS == score.timestamp_ns)
                .unwrap();
            let want = probabilities[i].expect("the trainer scored it too");
            assert!(
                (score.confidence - want).abs() < 1e-6,
                "sample {i}: {} vs {want}",
                score.confidence
            );
        }
        // From the first live decision (once the buffer held a window), every decision the trainer made was made live.
        let first = trace
            .iter()
            .position(|s| s.ts_ns - SDK_BEHIND_NS == scores[0].timestamp_ns)
            .unwrap();
        let made = probabilities[first..]
            .iter()
            .filter(|p| p.is_some())
            .count();
        assert_eq!(scores.len(), made);
    }

    #[test]
    fn a_motion_model_waits_for_motion_and_reports_a_stalled_motion_stream() {
        let model = loaded_motion();
        let (trace, motion, _) = expected_motion();
        let origin = trace[0].ts_ns;
        let at = |ts: u64| ts - origin + 10_000_000_000;
        let mut p = LabelPipeline::default();
        p.configure(&[&model]);
        let mut b = batch(&trace, 0, 250);
        b.timestamp_ns = trace[249].ts_ns;
        // The pulse for 10 s, but motion only for the first 8: the newest pulse sample's motion has not arrived.
        // The pulse for 10 s, but the motion (arriving now) only for its first 8: the newest pulse samples wait for theirs.
        let now = at(trace[249].ts_ns);
        let cut = motion
            .iter()
            .position(|m| m.ts_ns > trace[199].ts_ns)
            .unwrap();
        for (j, m) in motion[..cut].iter().enumerate() {
            p.observe_orientation(&motion_sample(m, j as u64), now)
                .unwrap();
        }
        p.observe_ppg(&b, now).unwrap();
        let (scores, rejected) = p.evaluate(&[&model], now);
        assert!(rejected.is_empty(), "{rejected:?}");
        assert_eq!(scores.len(), 1, "the newest sample whose motion is in");
        assert!(
            scores[0].timestamp_ns <= trace[199].ts_ns
                && scores[0].timestamp_ns >= trace[198].ts_ns
        );
        let (scores, _) = p.evaluate(&[&model], now + 10 * NS_PER_MS);
        assert!(scores.is_empty(), "nothing new is ready");
        // The pulse goes on, but motion silent for over a second is a stale stream.
        let later = now + 1_100 * NS_PER_MS;
        let mut more = batch(&trace, 250, 278);
        more.timestamp_ns = trace[277].ts_ns;
        p.observe_ppg(&more, later).unwrap();
        let (_, rejected) = p.evaluate(&[&model], later);
        assert!(
            matches!(
                rejected[0].reason,
                Rejection::SourceStale {
                    source: StreamSource::WatchOrientation,
                    ..
                }
            ),
            "{rejected:?}"
        );
    }

    #[test]
    fn nothing_is_scored_until_the_buffer_holds_the_models_history() {
        let (trace, _) = expected();
        let (scores, _) = replay(&trace[..120]); // 4.8 s: less than the 5.6 s a decision reads
        assert!(scores.is_empty());
    }

    #[test]
    fn a_model_decides_once_on_each_new_sample_and_a_rejection_is_reported_once_a_stride() {
        let (trace, _) = expected();
        let (mut p, model) = configured();
        let origin = trace[0].ts_ns;
        let at = |i: usize| trace[i].ts_ns - origin + 10_000_000_000;
        p.observe_ppg(&batch(&trace, 0, 200), at(199)).unwrap();
        assert_eq!(p.evaluate(&[&model], at(199)).0.len(), 1);
        assert!(p.evaluate(&[&model], at(199) + 10 * NS_PER_MS).0.is_empty(), "nothing new");
        // A sample arriving sooner than a stride after the last is still decided on.
        p.observe_ppg(&batch(&trace, 200, 201), at(199) + 30 * NS_PER_MS).unwrap();
        assert_eq!(p.evaluate(&[&model], at(199) + 30 * NS_PER_MS).0.len(), 1);
        // A stalled stream is reported, then not again until a stride has passed.
        let late = at(200) + 600 * NS_PER_MS;
        assert_eq!(p.evaluate(&[&model], late).1.len(), 1);
        assert!(p.evaluate(&[&model], late + 10 * NS_PER_MS).1.is_empty());
        assert_eq!(p.evaluate(&[&model], late + 40 * NS_PER_MS).1.len(), 1);
    }

    #[test]
    fn a_stale_stream_or_a_gap_in_the_window_is_rejected() {
        let (trace, _) = expected();
        let (mut p, model) = configured();
        let origin = trace[0].ts_ns;
        let at = |i: usize| trace[i].ts_ns - origin + 10_000_000_000;
        p.observe_ppg(&batch(&trace, 0, 200), at(199)).unwrap();
        let (_, stale) = p.evaluate(&[&model], at(199) + 600 * NS_PER_MS);
        assert!(matches!(stale[0].reason, Rejection::SourceStale { .. }));
        // 400 ms without samples, then the stream resumes: the window holds a gap.
        let (mut p, _) = configured();
        p.observe_ppg(&batch(&trace, 0, 180), at(179)).unwrap();
        p.observe_ppg(&batch(&trace, 190, 220), at(219)).unwrap();
        let (_, gap) = p.evaluate(&[&model], at(219));
        assert!(matches!(gap[0].reason, Rejection::Gap { .. }), "{gap:?}");
    }

    #[test]
    fn out_of_order_or_malformed_samples_are_refused_and_not_buffered() {
        let (trace, _) = expected();
        let (mut p, _) = configured();
        p.observe_ppg(&batch(&trace, 10, 20), 1).unwrap();
        assert!(p.observe_ppg(&batch(&trace, 5, 15), 2).is_err());
        let mut short = batch(&trace, 20, 30);
        short.red.pop();
        assert!(p.observe_ppg(&short, 3).is_err());
        assert_eq!(p.ppg.len(), 10);
        let mut motion = WatchOrientationSample {
            device_id: "watch-1".into(),
            sequence: 1,
            timestamp_ns: 5,
            quaternion: [1.0, 0.0, 0.0, 0.0],
            accelerometer: Some([0.0, f64::NAN, 0.0]),
            gyroscope: None,
        };
        assert!(p.observe_orientation(&motion, 4).is_err());
        motion.accelerometer = None;
        assert!(p.observe_orientation(&motion, 4).is_ok());
        assert!(p.observe_orientation(&motion, 5).is_err(), "a repeated timestamp");
    }

    #[test]
    fn another_watch_never_mixes_into_the_window_and_the_buffer_stays_bounded() {
        let (trace, _) = expected();
        let (mut p, _) = configured();
        p.observe_ppg(&batch(&trace, 0, 100), 1).unwrap();
        let mut other = batch(&trace, 100, 110);
        other.device_id = "watch-2".into();
        p.observe_ppg(&other, 2).unwrap();
        assert_eq!(p.ppg.len(), 10);
        // Hours of samples keep only the model's history.
        let (mut p, _) = configured();
        let long: Vec<Sample> = (0..20_000u64)
            .map(|i| Sample { ts_ns: i * 40 * NS_PER_MS, green: 1.0, red: 2.0, ir: 3.0 })
            .collect();
        for i in (0..long.len()).step_by(25) {
            p.observe_ppg(&batch(&long, i, i + 25), long[i + 24].ts_ns).unwrap();
        }
        assert!(p.ppg.len() < 200, "{}", p.ppg.len());
    }
}
