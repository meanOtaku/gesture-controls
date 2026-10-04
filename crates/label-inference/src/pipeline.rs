//! The one shared path from raw telemetry to label scores.
//!
//! Telemetry is validated and buffered **once**, whatever number of models are running. Each model has its own window
//! (length, stride) and quality rules, so each is evaluated on its own schedule against the shared buffers: nothing
//! is re-validated and no stream is stored twice.
//!
//! Time. Windows are cut on the desktop's receive clock, the only one the watch's streams share (their own clocks are
//! not comparable). Raw sensor timestamps are never altered: they are checked for order and carried through, and a
//! score is stamped with the raw timestamp of the newest sample of the model's primary stream.

use std::collections::{BTreeMap, VecDeque};

use model_lab_core::{LabelId, ModelVersionId, StreamSource};
use pinch_inference::{FusedWindow, OrientationSnapshot, extract_features};
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::model::LoadedModel;

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
    accel: Option<[f64; 3]>,
    gyro: Option<[f64; 3]>,
    quat: [f64; 4],
    raw_ts_ns: u64,
}

#[derive(Debug, Clone)]
struct PpgSample {
    /// Aligned to the desktop's receive clock: the batch's receive time, less how long before the batch's last sample
    /// this one was taken (an interval, so the watch's unrelated absolute clock does not matter).
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
    /// The longest history any loaded model needs, so buffers are bounded by what is used.
    retention_ns: u64,
    next_due_ns: BTreeMap<LabelId, u64>,
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
        self.next_due_ns.clear();
    }

    /// Forgets all buffered telemetry and the ordering state (the watch went away, or the runtime was reset).
    pub fn reset(&mut self) {
        self.orientation.clear();
        self.ppg.clear();
        self.device_id = None;
        self.last_orientation_raw = None;
        self.last_ppg_raw = None;
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
        self.orientation.push_back(OrientationSample {
            received_ns,
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
        for i in 0..n {
            let age = last_raw - batch.timestamps_ns[i];
            self.ppg.push_back(PpgSample {
                at_ns: received_ns.saturating_sub(age),
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
                    .map(|s| (s.received_ns, s.raw_ts_ns))
                    .collect(),
                StreamSource::WatchGyroscope => self
                    .orientation
                    .iter()
                    .filter(|s| s.gyro.is_some())
                    .map(|s| (s.received_ns, s.raw_ts_ns))
                    .collect(),
                StreamSource::WatchOrientation => self
                    .orientation
                    .iter()
                    .map(|s| (s.received_ns, s.raw_ts_ns))
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

        // Orientation samples in the window, with a missing acceleration or gyroscope carried forward from the last
        // one that had it, as the live fusion has always done.
        let mut carried_accel = [0.0; 3];
        let mut carried_gyro = [0.0; 3];
        for sample in self.orientation.iter().filter(|s| s.received_ns < start) {
            carried_accel = sample.accel.unwrap_or(carried_accel);
            carried_gyro = sample.gyro.unwrap_or(carried_gyro);
        }
        let in_window: Vec<OrientationSnapshot> = self
            .orientation
            .iter()
            .filter(|s| s.received_ns >= start && s.received_ns <= now_ns)
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
            contact_quality_mean,
        };
        let canonical = extract_features(&window);
        let confidence = model
            .predict(&canonical)
            .map_err(|e| Rejection::Model(e.to_string()))?;
        Ok(Some(LabelScore {
            label: model.label.clone(),
            model_version: model.version_id.clone(),
            confidence,
            timestamp_ns: primary_raw.unwrap_or(0),
            received_ns: now_ns,
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
}
