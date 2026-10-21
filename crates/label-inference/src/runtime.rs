//! Ties the pipeline, the loaded models and the detection hub together, and applies the safety rules.
//!
//! * **Off** does nothing at all. **Monitor** scores and reports but never lets a *start* through. **Live** forwards
//!   detections from the models that are loaded, and only validated, approved, active ones can be. A monitor-only model
//!   (one that did not pass the checks for going live) is treated as in Monitor even in Live.
//! * A falling edge always gets through in every mode: releasing is the safe direction, so it is never withheld.
//! * A model replaced, removed or rolled back is released *before* the new one is used.
//! * A stale or bad stream, a failed window, a model error, a mode change or a lost runtime clears the affected
//!   labels and reports a falling edge for each, so anything depending on them lets go.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use model_lab_core::{InferenceMode, LabelId, ModelVersionId, StreamSource};
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::detection::{ClearReason, Conflict, DetectionEvent, DetectionHub, ExclusivityGroup};
use crate::model::{LoadedModel, OutsideInput};
use crate::pipeline::{LabelPipeline, LabelScore, Rejection, WindowRejection};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMode {
    Off,
    Monitor,
    Live,
}

impl From<InferenceMode> for RuntimeMode {
    fn from(mode: InferenceMode) -> Self {
        match mode {
            InferenceMode::Off => Self::Off,
            InferenceMode::Monitor => Self::Monitor,
            InferenceMode::Live => Self::Live,
        }
    }
}

/// How long a stretch of windows is judged together when deciding whether a model is seeing something it never trained on.
const FAMILIARITY_SPAN_NS: u64 = 3_000_000_000;
/// Fewer windows than this in that stretch and nothing is said.
const FAMILIARITY_MIN_WINDOWS: usize = 6;
/// The warning goes up when at least this share of the stretch's windows are unfamiliar, and comes down at or below the other.
const WARN_SHARE: f64 = 0.7;
const CLEAR_SHARE: f64 = 0.3;
/// While a warning stands it is re-sent this often, so the numbers in it stay current.
const WARNING_REFRESH_NS: u64 = 1_000_000_000;

/// A model that is being given inputs far outside what it was trained on: its answers mean little. Raised when most
/// recent windows have an input far outside its training range or at least half of them well outside it, lowered when most
/// are back.
#[derive(Debug, Clone, PartialEq)]
pub struct InputWarning {
    pub label: LabelId,
    pub model_version: ModelVersionId,
    /// The share of the last few seconds' windows that were unfamiliar.
    pub unfamiliar_share: f64,
    /// The inputs furthest outside their training range in the latest unfamiliar window.
    pub worst: Vec<OutsideInput>,
}

#[derive(Debug, Default)]
struct Familiarity {
    version: Option<ModelVersionId>,
    /// (when, whether the window was unfamiliar) for the last few seconds.
    recent: VecDeque<(u64, bool)>,
    raised: bool,
    worst: Vec<OutsideInput>,
}

impl Familiarity {
    fn share(&self) -> f64 {
        if self.recent.is_empty() {
            return 0.0;
        }
        self.recent
            .iter()
            .filter(|(_, unfamiliar)| *unfamiliar)
            .count() as f64
            / self.recent.len() as f64
    }

    fn see(&mut self, now_ns: u64, unfamiliar: bool, worst: &[OutsideInput]) {
        self.recent.push_back((now_ns, unfamiliar));
        while self
            .recent
            .front()
            .is_some_and(|(at, _)| now_ns.saturating_sub(*at) > FAMILIARITY_SPAN_NS)
        {
            self.recent.pop_front();
        }
        if unfamiliar {
            self.worst = worst.to_vec();
        }
        if self.recent.len() >= FAMILIARITY_MIN_WINDOWS {
            let share = self.share();
            if !self.raised && share >= WARN_SHARE {
                self.raised = true;
            } else if self.raised && share <= CLEAR_SHARE {
                self.raised = false;
            }
        }
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct RuntimeOutput {
    pub scores: Vec<LabelScore>,
    pub rejections: Vec<WindowRejection>,
    /// Every detection change, for display and diagnostics.
    pub events: Vec<DetectionEvent>,
    pub conflicts: Vec<Conflict>,
    /// What may be acted on: in Live everything, otherwise only falling edges (releasing is always safe).
    pub actionable: Vec<DetectionEvent>,
    /// Every model now being given inputs unlike its training ones; present only when that changed (a warning went up or
    /// down) or its numbers are due a refresh, and empty when none does.
    pub input_warnings: Option<Vec<InputWarning>>,
}

pub struct LabelRuntime {
    models: BTreeMap<LabelId, LoadedModel>,
    pipeline: LabelPipeline,
    hub: DetectionHub,
    mode: RuntimeMode,
    familiarity: BTreeMap<LabelId, Familiarity>,
    /// What was last sent as the warnings, and when.
    warned: Vec<InputWarning>,
    warned_at_ns: u64,
}

impl Default for LabelRuntime {
    fn default() -> Self {
        Self {
            models: BTreeMap::new(),
            pipeline: LabelPipeline::default(),
            hub: DetectionHub::default(),
            mode: RuntimeMode::Off,
            familiarity: BTreeMap::new(),
            warned: Vec::new(),
            warned_at_ns: 0,
        }
    }
}

/// What may be acted on: a falling edge always; anything else only in Live, and never from a monitor-only model.
fn allow(
    mode: RuntimeMode,
    monitor_only: &BTreeSet<LabelId>,
    events: &[DetectionEvent],
) -> Vec<DetectionEvent> {
    events
        .iter()
        .filter(|e| match e {
            DetectionEvent::Falling { .. } => true,
            DetectionEvent::Rising { label, .. } | DetectionEvent::Active { label, .. } => {
                mode == RuntimeMode::Live && !monitor_only.contains(label)
            }
        })
        .cloned()
        .collect()
}

impl LabelRuntime {
    pub fn mode(&self) -> RuntimeMode {
        self.mode
    }

    pub fn loaded_labels(&self) -> Vec<LabelId> {
        self.models.keys().cloned().collect()
    }

    pub fn is_active(&self, label: &LabelId) -> bool {
        self.hub.is_active(label)
    }

    pub fn set_exclusivity(&mut self, groups: Vec<ExclusivityGroup>) {
        self.hub.set_exclusivity(groups);
    }

    fn release(&mut self, events: Vec<DetectionEvent>) -> RuntimeOutput {
        RuntimeOutput {
            actionable: events.clone(),
            events,
            input_warnings: self.warnings_changed(0, false),
            ..RuntimeOutput::default()
        }
    }

    /// The warnings standing now.
    fn standing_warnings(&self) -> Vec<InputWarning> {
        self.familiarity
            .iter()
            .filter(|(_, f)| f.raised)
            .filter_map(|(label, f)| {
                Some(InputWarning {
                    label: label.clone(),
                    model_version: f.version.clone()?,
                    unfamiliar_share: f.share(),
                    worst: f.worst.clone(),
                })
            })
            .collect()
    }

    /// The standing warnings if they differ from what was last sent (a warning went up or down), or, with `refresh`, if it has
    /// been a while since they were sent.
    fn warnings_changed(&mut self, now_ns: u64, refresh: bool) -> Option<Vec<InputWarning>> {
        let now = self.standing_warnings();
        let same_set = now.len() == self.warned.len()
            && now
                .iter()
                .zip(&self.warned)
                .all(|(a, b)| a.label == b.label && a.model_version == b.model_version);
        let due = refresh
            && !now.is_empty()
            && now_ns.saturating_sub(self.warned_at_ns) >= WARNING_REFRESH_NS;
        if same_set && !due {
            return None;
        }
        self.warned.clone_from(&now);
        self.warned_at_ns = now_ns;
        Some(now)
    }

    /// Changes the mode. Any change ends every detection, so a mode downgrade can never leave something held.
    pub fn set_mode(&mut self, mode: RuntimeMode) -> RuntimeOutput {
        if mode == self.mode {
            return RuntimeOutput::default();
        }
        self.mode = mode;
        self.pipeline.reset();
        self.familiarity.clear();
        let events = self
            .hub
            .clear_all(&ClearReason::Runtime(format!("mode changed to {mode:?}")));
        self.release(events)
    }

    /// Replaces the loaded models with exactly these (one per label). A label whose model changed or went away is
    /// released **before** the new model is used.
    pub fn set_models(&mut self, models: Vec<LoadedModel>) -> RuntimeOutput {
        let mut events = Vec::new();
        let next: BTreeMap<LabelId, LoadedModel> =
            models.into_iter().map(|m| (m.label.clone(), m)).collect();
        for (label, old) in &self.models {
            let unchanged = next.get(label).is_some_and(|new| {
                new.version_id == old.version_id && new.model_sha256 == old.model_sha256
            });
            if !unchanged {
                events.extend(self.hub.untrack(label, ClearReason::ModelChanged));
            }
        }
        for (label, new) in &next {
            let unchanged = self
                .models
                .get(label)
                .is_some_and(|old| old.version_id == new.version_id);
            if !unchanged {
                self.hub.track(label.clone(), new.thresholds);
            }
        }
        // A model that is new to its label starts with a clean slate; one that is gone leaves nothing behind.
        self.familiarity.retain(|label, f| {
            next.get(label)
                .is_some_and(|new| f.version.as_ref() == Some(&new.version_id))
        });
        self.models = next;
        let refs: Vec<&LoadedModel> = self.models.values().collect();
        self.pipeline.configure(&refs);
        self.release(events)
    }

    /// The runtime itself failed (a crash, a lost backend): end everything and drop buffered telemetry.
    pub fn fail(&mut self, detail: &str) -> RuntimeOutput {
        self.pipeline.reset();
        self.familiarity.clear();
        let events = self
            .hub
            .clear_all(&ClearReason::Runtime(detail.to_string()));
        self.release(events)
    }

    /// The watch went away.
    pub fn watch_lost(&mut self) -> RuntimeOutput {
        self.fail("the watch disconnected")
    }

    /// The labels whose models read `source` (every model reads the pulse sensor, a PPG + IMU model also the motion).
    fn depends_on(&self, source: StreamSource) -> Vec<LabelId> {
        self.models
            .values()
            .filter(|m| m.input.sources.contains(&source))
            .map(|m| m.label.clone())
            .collect()
    }

    /// The labels whose models may only report.
    fn monitor_only(&self) -> BTreeSet<LabelId> {
        self.models
            .values()
            .filter(|m| m.monitor_only)
            .map(|m| m.label.clone())
            .collect()
    }

    fn fault(&mut self, rejection: &Rejection, source: StreamSource) -> RuntimeOutput {
        let events: Vec<DetectionEvent> = self
            .depends_on(source)
            .iter()
            .filter_map(|label| {
                self.hub
                    .clear_label(label, ClearReason::Rejected(rejection.to_string()))
            })
            .collect();
        self.release(events)
    }

    pub fn observe_orientation(
        &mut self,
        sample: &WatchOrientationSample,
        received_ns: u64,
    ) -> RuntimeOutput {
        if self.mode == RuntimeMode::Off || self.models.is_empty() {
            return RuntimeOutput::default();
        }
        match self.pipeline.observe_orientation(sample, received_ns) {
            Ok(()) => self.tick(received_ns),
            Err(rejection) => self.fault(&rejection, StreamSource::WatchOrientation),
        }
    }

    pub fn observe_ppg(&mut self, batch: &WatchPpgBatchSample, received_ns: u64) -> RuntimeOutput {
        if self.mode == RuntimeMode::Off || self.models.is_empty() {
            return RuntimeOutput::default();
        }
        match self.pipeline.observe_ppg(batch, received_ns) {
            Ok(()) => self.tick(received_ns),
            Err(rejection) => self.fault(&rejection, StreamSource::WatchPpg),
        }
    }

    /// Scores whatever is due. Call it after each sample and on a timer, so a stream that stops is noticed.
    pub fn tick(&mut self, now_ns: u64) -> RuntimeOutput {
        if self.mode == RuntimeMode::Off || self.models.is_empty() {
            return RuntimeOutput::default();
        }
        let refs: Vec<&LoadedModel> = self.models.values().collect();
        let (scores, rejections) = self.pipeline.evaluate(&refs, now_ns);
        let mut events: Vec<DetectionEvent> = rejections
            .iter()
            .filter_map(|r| {
                self.hub
                    .clear_label(&r.label, ClearReason::Rejected(r.reason.to_string()))
            })
            .collect();
        // A model can score several pulse samples in one round: they go through the detectors in time order, the scores of
        // one sample together, so labels that cannot coexist are judged on the same moment.
        let mut order: Vec<&LabelScore> = scores.iter().collect();
        order.sort_by_key(|s| s.timestamp_ns);
        let mut conflicts = Vec::new();
        for moment in order.chunk_by(|a, b| a.timestamp_ns == b.timestamp_ns) {
            let batch: Vec<(LabelId, f64, u64)> = moment
                .iter()
                .map(|s| (s.label.clone(), s.confidence, s.timestamp_ns))
                .collect();
            let (changes, clashes) = self.hub.process(&batch);
            events.extend(changes);
            conflicts.extend(clashes);
        }
        for score in &scores {
            let Some(check) = &score.input_check else {
                continue;
            };
            // Unlike its training windows: one input far outside its range, or at least half of them well outside.
            let unfamiliar =
                check.far >= 1 || (check.judged > 0 && check.outside * 2 >= check.judged);
            let tracker = self.familiarity.entry(score.label.clone()).or_default();
            if tracker.version.as_ref() != Some(&score.model_version) {
                *tracker = Familiarity {
                    version: Some(score.model_version.clone()),
                    ..Familiarity::default()
                };
            }
            tracker.see(now_ns, unfamiliar, &check.worst);
        }
        let input_warnings = self.warnings_changed(now_ns, true);
        RuntimeOutput {
            actionable: allow(self.mode, &self.monitor_only(), &events),
            scores,
            rejections,
            events,
            conflicts,
            input_warnings,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::{expected, loaded};
    use crate::pipeline::tests::batch;
    use pinch_inference::ppg_onset::PpgSample;

    const BASE_NS: u64 = 10_000_000_000;

    fn runtime(mode: RuntimeMode) -> LabelRuntime {
        let mut rt = LabelRuntime::default();
        rt.set_models(vec![loaded()]);
        rt.set_mode(mode);
        rt
    }

    fn pinch() -> LabelId {
        LabelId::new("pinch").unwrap()
    }

    /// The fixture's trace (pinches and fists for 15 s, then quiet), its timestamps moved `shift_ns` later.
    fn trace(shift_ns: u64) -> Vec<PpgSample> {
        expected()
            .0
            .into_iter()
            .map(|s| PpgSample { ts_ns: s.ts_ns + shift_ns, ..s })
            .collect()
    }

    /// Drives the runtime through the real path, one pulse sample at a time, each received 5 ms after it was taken.
    fn drive(rt: &mut LabelRuntime, trace: &[PpgSample], from: usize, to: usize) -> Vec<RuntimeOutput> {
        let origin = expected().0[0].ts_ns;
        (from..to)
            .map(|i| rt.observe_ppg(&batch(trace, i, i + 1), trace[i].ts_ns - origin + BASE_NS + 5_000_000))
            .collect()
    }

    /// Drives until the label is active, returning the index of the sample after which it was.
    fn until_active(rt: &mut LabelRuntime, trace: &[PpgSample]) -> usize {
        (0..trace.len())
            .find(|&i| {
                drive(rt, trace, i, i + 1);
                rt.is_active(&pinch())
            })
            .expect("the trace's second pinch is detected")
    }

    fn events(outputs: &[RuntimeOutput]) -> Vec<&DetectionEvent> {
        outputs.iter().flat_map(|o| o.events.iter()).collect()
    }

    fn rises(outputs: &[RuntimeOutput], actionable: bool) -> usize {
        outputs
            .iter()
            .flat_map(|o| if actionable { o.actionable.iter() } else { o.events.iter() })
            .filter(|e| matches!(e, DetectionEvent::Rising { .. }))
            .count()
    }

    #[test]
    fn live_a_motion_model_detects_the_pinches_on_their_peak_and_ignores_the_fists() {
        use crate::model::tests::{expected_motion, loaded_motion};
        use crate::pipeline::tests::motion_sample;
        let mut rt = LabelRuntime::default();
        let model = loaded_motion();
        assert_eq!(model.thresholds.trigger, model_lab_core::Trigger::Peak);
        rt.set_models(vec![model]);
        rt.set_mode(RuntimeMode::Live);
        let (pulse, motion, _) = expected_motion();
        let origin = pulse[0].ts_ns;
        // Pulse samples arrive 5 ms after they are taken, motion 60 ms after, each stream on its own.
        let mut arrivals: Vec<(u64, bool, usize)> = (0..pulse.len())
            .map(|i| (pulse[i].ts_ns - origin + 5_000_000, true, i))
            .collect();
        arrivals
            .extend((0..motion.len()).map(|j| (motion[j].ts_ns - origin + 60_000_000, false, j)));
        arrivals.sort();
        let mut rose = Vec::new();
        for (at, is_pulse, i) in arrivals {
            let out = if is_pulse {
                let mut b = batch(&pulse, i, i + 1);
                b.timestamp_ns = pulse[i].ts_ns;
                rt.observe_ppg(&b, BASE_NS + at)
            } else {
                rt.observe_orientation(&motion_sample(&motion[i], i as u64), BASE_NS + at)
            };
            assert!(out.rejections.is_empty(), "{:?}", out.rejections);
            rose.extend(out.actionable.iter().filter_map(|e| match e {
                DetectionEvent::Rising { timestamp_ns, .. } => {
                    Some((timestamp_ns - origin) / 1_000_000)
                }
                _ => None,
            }));
        }
        // Gestures start every 3 s from 3 s, a pinch then a fist, until 12 s: the pinch at 9 s is the one after the warm-up.
        // A detection comes about 0.7-1.4 s after a pinch's start, and none after a fist's.
        assert!(!rose.is_empty());
        for ms in &rose {
            let since = ms.saturating_sub(3_000) % 6_000;
            assert!(
                (680..=1_400).contains(&since),
                "a detection {ms} ms in is not just after a pinch"
            );
        }
    }

    #[test]
    fn live_a_pinch_start_rises_and_falls_and_is_actionable() {
        let mut rt = runtime(RuntimeMode::Live);
        let t = trace(0);
        let out = drive(&mut rt, &t, 0, 300); // to 12 s: the second pinch, at 9 s, is detected near 9.9 s
        assert_eq!(rises(&out, false), 1);
        assert_eq!(rises(&out, true), 1);
        assert!(events(&out).iter().any(|e| matches!(
            e,
            DetectionEvent::Falling { reason: ClearReason::ScoreBelowRelease, .. }
        )));
    }

    #[test]
    fn monitor_reports_everything_but_only_lets_a_release_through() {
        let mut rt = runtime(RuntimeMode::Monitor);
        let out = drive(&mut rt, &trace(0), 0, 300);
        assert_eq!(rises(&out, false), 1, "it is reported");
        assert_eq!(rises(&out, true), 0, "but nothing may start anything");
        assert!(out.iter().any(|o| o.actionable.iter().any(|e| matches!(e, DetectionEvent::Falling { .. }))));
    }

    #[test]
    fn a_monitor_only_model_never_starts_anything_even_in_live() {
        let mut model = loaded();
        model.monitor_only = true;
        let mut rt = LabelRuntime::default();
        rt.set_models(vec![model]);
        rt.set_mode(RuntimeMode::Live);
        let out = drive(&mut rt, &trace(0), 0, 300);
        assert_eq!((rises(&out, false), rises(&out, true)), (1, 0));
    }

    #[test]
    fn off_does_nothing() {
        let mut rt = runtime(RuntimeMode::Off);
        assert!(drive(&mut rt, &trace(0), 0, 300).iter().all(|o| *o == RuntimeOutput::default()));
    }

    #[test]
    fn a_mode_change_ends_a_detection_in_progress() {
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &trace(0));
        let out = rt.set_mode(RuntimeMode::Monitor);
        assert!(matches!(
            out.actionable.as_slice(),
            [DetectionEvent::Falling { reason: ClearReason::Runtime(_), .. }]
        ));
        assert!(!rt.is_active(&pinch()));
        assert_eq!(rt.set_mode(RuntimeMode::Monitor), RuntimeOutput::default(), "no change, no event");
    }

    #[test]
    fn replacing_or_removing_a_model_releases_its_detection_before_anything_else() {
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &trace(0));
        let mut replacement = loaded();
        replacement.version_id = ModelVersionId::new("pinch-v2").unwrap();
        let out = rt.set_models(vec![replacement]);
        assert!(matches!(
            out.actionable.as_slice(),
            [DetectionEvent::Falling { reason: ClearReason::ModelChanged, .. }]
        ));
        assert!(!rt.is_active(&pinch()), "the new model starts with a clean state");
        assert!(rt.set_models(vec![]).events.is_empty(), "nothing was held");
        assert!(rt.loaded_labels().is_empty());
    }

    /// Switching to another model and back must leave no trace: the model scores the same live data exactly as it would
    /// have had it never been switched away from.
    #[test]
    fn switching_to_another_model_and_back_scores_exactly_as_if_it_had_never_been_switched() {
        let t = trace(0);
        let scores = |out: Vec<RuntimeOutput>| -> Vec<(u64, f64)> {
            out.into_iter().flat_map(|o| o.scores).map(|s| (s.timestamp_ns, s.confidence)).collect()
        };
        let other = || {
            let mut model = loaded();
            model.version_id = ModelVersionId::new("pinch-v2").unwrap();
            model
        };
        let mut straight = runtime(RuntimeMode::Monitor);
        drive(&mut straight, &t, 0, 300);
        straight.set_models(vec![loaded()]);
        let want = scores(drive(&mut straight, &t, 300, 500));

        let mut switched = runtime(RuntimeMode::Monitor);
        drive(&mut switched, &t, 0, 200);
        switched.set_models(vec![other()]);
        drive(&mut switched, &t, 200, 300);
        switched.set_models(vec![loaded()]);
        let got = scores(drive(&mut switched, &t, 300, 500));
        assert!(!got.is_empty());
        assert_eq!(got, want);
    }

    #[test]
    fn a_warning_goes_up_when_most_decisions_are_unlike_the_training_ones_and_comes_down_when_they_are_back() {
        let mut f = Familiarity::default();
        let s = 1_000_000_000;
        for i in 0..10 {
            f.see(i * s / 4, true, &[]);
        }
        assert!(f.raised, "most of the last 3 s were unfamiliar");
        for i in 10..30 {
            f.see(i * s / 4, false, &[]);
        }
        assert!(!f.raised, "they are back");
    }

    #[test]
    fn a_model_whose_range_every_decision_fits_is_never_warned_about_and_changing_the_model_clears_a_warning() {
        let ranged = |low: f64, high: f64| {
            let mut model = loaded();
            let n = model.input.features.len();
            model.training_range = Some(crate::bundle::TrainingRange { low: vec![low; n], high: vec![high; n] });
            model
        };
        let mut rt = LabelRuntime::default();
        rt.set_models(vec![ranged(-1e12, 1e12)]);
        rt.set_mode(RuntimeMode::Monitor);
        assert!(drive(&mut rt, &trace(0), 0, 300).iter().all(|o| o.input_warnings.is_none()));

        // A range nothing fits: every input is far outside it, and the warning goes up.
        let mut rt = LabelRuntime::default();
        rt.set_models(vec![ranged(1e9, 1e9 + 1.0)]);
        rt.set_mode(RuntimeMode::Monitor);
        let out = drive(&mut rt, &trace(0), 0, 300);
        let up = out.iter().find_map(|o| o.input_warnings.clone()).expect("a warning went up");
        assert_eq!(up[0].label, pinch());
        let mut replacement = ranged(1e9, 1e9 + 1.0);
        replacement.version_id = ModelVersionId::new("pinch-v2").unwrap();
        assert_eq!(rt.set_models(vec![replacement]).input_warnings, Some(Vec::new()), "a clean slate");
    }

    #[test]
    fn keeping_the_same_model_does_not_disturb_a_running_detection() {
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &trace(0));
        assert!(rt.set_models(vec![loaded()]).events.is_empty());
        assert!(rt.is_active(&pinch()));
    }

    #[test]
    fn a_bad_sample_a_stalled_stream_or_a_lost_watch_each_release_the_detection() {
        let t = trace(0);
        let released = |out: &RuntimeOutput| {
            matches!(out.actionable.as_slice(), [DetectionEvent::Falling { .. }])
        };
        // An out-of-order batch.
        let mut rt = runtime(RuntimeMode::Live);
        let at = until_active(&mut rt, &t);
        let out = rt.observe_ppg(&batch(&t, 10, 11), BASE_NS + 60_000_000_000);
        assert!(released(&out) && !rt.is_active(&pinch()));
        // A stream that stops: the timer tick notices.
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &t);
        let out = rt.tick(t[at].ts_ns - t[0].ts_ns + BASE_NS + 2_000_000_000);
        assert!(released(&out));
        assert_eq!(out.rejections.len(), 1);
        // The watch disconnecting, and the runtime itself failing.
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &t);
        assert!(released(&rt.watch_lost()));
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &t);
        assert!(matches!(
            rt.fail("backend crashed").actionable.as_slice(),
            [DetectionEvent::Falling { reason: ClearReason::Runtime(_), .. }]
        ));
        assert!(rt.tick(1_000_000_000_000).scores.is_empty(), "nothing is scored from stale data");
        // A bad motion sample releases nothing: no model reads motion.
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &t);
        let motion = WatchOrientationSample {
            device_id: "watch-1".into(),
            sequence: 1,
            timestamp_ns: 1,
            quaternion: [f64::NAN, 0.0, 0.0, 0.0],
            accelerometer: None,
            gyroscope: None,
        };
        assert!(rt.observe_orientation(&motion, BASE_NS).actionable.is_empty());
        assert!(rt.is_active(&pinch()));
    }

    #[test]
    fn after_a_fault_the_label_can_be_detected_again_from_fresh_data() {
        let mut rt = runtime(RuntimeMode::Live);
        until_active(&mut rt, &trace(0));
        rt.watch_lost();
        let again = drive(&mut rt, &trace(100_000_000_000), 0, 300);
        assert_eq!(rises(&again, true), 1);
    }

    #[test]
    fn two_exclusive_labels_cannot_both_be_acted_on() {
        let mut rt = LabelRuntime::default();
        let first = loaded();
        let mut second = loaded();
        second.label = LabelId::new("pinch_twin").unwrap();
        second.version_id = ModelVersionId::new("twin-v1").unwrap();
        rt.set_models(vec![first, second]);
        rt.set_exclusivity(vec![ExclusivityGroup {
            labels: [pinch(), LabelId::new("pinch_twin").unwrap()].into(),
        }]);
        rt.set_mode(RuntimeMode::Live);
        let out = drive(&mut rt, &trace(0), 0, 300);
        assert!(out.iter().any(|o| !o.conflicts.is_empty()), "the clash is reported");
        assert_eq!(rises(&out, true), 0, "and neither starts");
    }
}
