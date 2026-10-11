//! Ties the pipeline, the loaded models and the detection hub together, and applies the safety rules.
//!
//! * **Off** does nothing at all. **Monitor** scores and reports but never lets a *start* through. **Live** forwards
//!   detections from the models that are loaded, and only validated, approved, active ones can be.
//! * A falling edge always gets through in every mode: releasing is the safe direction, so it is never withheld.
//! * A model replaced, removed or rolled back is released *before* the new one is used.
//! * A stale or bad stream, a failed window, a model error, a mode change or a lost runtime clears the affected
//!   labels and reports a falling edge for each, so anything depending on them lets go.

use std::collections::{BTreeMap, VecDeque};

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
/// recent windows have at least half of their inputs well outside the training range, lowered when most are back.
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

fn allow(mode: RuntimeMode, events: &[DetectionEvent]) -> Vec<DetectionEvent> {
    events
        .iter()
        .filter(|e| mode == RuntimeMode::Live || matches!(e, DetectionEvent::Falling { .. }))
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

    fn depends_on(&self, source: StreamSource) -> Vec<LabelId> {
        // The orientation stream carries acceleration and gyroscope too, so a fault in it affects all three.
        let from_orientation = |s: &StreamSource| {
            matches!(
                s,
                StreamSource::WatchOrientation
                    | StreamSource::WatchAcceleration
                    | StreamSource::WatchGyroscope
            )
        };
        self.models
            .values()
            .filter(|m| {
                m.input.sources.iter().any(|s| {
                    if source == StreamSource::WatchPpg {
                        *s == source
                    } else {
                        from_orientation(s)
                    }
                })
            })
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
        let batch: Vec<(LabelId, f64, u64)> = scores
            .iter()
            .map(|s| (s.label.clone(), s.confidence, s.timestamp_ns))
            .collect();
        let (changes, conflicts) = self.hub.process(&batch);
        events.extend(changes);
        for score in &scores {
            let Some(check) = &score.input_check else {
                continue;
            };
            let unfamiliar = check.judged > 0 && check.outside * 2 >= check.judged;
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
            actionable: allow(self.mode, &events),
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
    use crate::model::tests::loaded;
    use crate::pipeline::tests::{feed, orientation};

    fn runtime(mode: RuntimeMode) -> LabelRuntime {
        let mut rt = LabelRuntime::default();
        rt.set_models(vec![loaded()]);
        rt.set_mode(mode);
        rt
    }

    fn shake_label() -> LabelId {
        LabelId::new("shake_fixture").unwrap()
    }

    /// Drives the runtime through the real path: samples in, detections out.
    fn drive(rt: &mut LabelRuntime, from_n: u64, count: u64, amplitude: f64) -> Vec<RuntimeOutput> {
        (from_n..from_n + count)
            .map(|n| rt.observe_orientation(&orientation(n, amplitude), n * 20_000_000))
            .collect()
    }

    fn events(outputs: &[RuntimeOutput]) -> Vec<&DetectionEvent> {
        outputs.iter().flat_map(|o| o.events.iter()).collect()
    }

    #[test]
    fn live_shaking_rises_stays_active_and_falls_when_it_stops_and_everything_is_actionable() {
        let mut rt = runtime(RuntimeMode::Live);
        let shaking = drive(&mut rt, 0, 80, 5.0);
        let rising: Vec<_> = events(&shaking)
            .into_iter()
            .filter(|e| matches!(e, DetectionEvent::Rising { .. }))
            .collect();
        assert_eq!(rising.len(), 1, "one rising edge");
        assert!(rt.is_active(&shake_label()));
        assert!(shaking.iter().any(|o| {
            o.actionable
                .iter()
                .any(|e| matches!(e, DetectionEvent::Rising { .. }))
        }));
        let still = drive(&mut rt, 80, 120, 0.0);
        assert!(events(&still).iter().any(|e| matches!(
            e,
            DetectionEvent::Falling {
                reason: ClearReason::ScoreBelowRelease,
                ..
            }
        )));
        assert!(!rt.is_active(&shake_label()));
    }

    #[test]
    fn monitor_reports_everything_but_only_lets_a_release_through() {
        let mut rt = runtime(RuntimeMode::Monitor);
        let shaking = drive(&mut rt, 0, 80, 5.0);
        assert!(
            events(&shaking)
                .iter()
                .any(|e| matches!(e, DetectionEvent::Rising { .. })),
            "it is reported"
        );
        assert!(
            shaking.iter().all(|o| o.actionable.is_empty()),
            "but nothing may start anything"
        );
        let still = drive(&mut rt, 80, 120, 0.0);
        assert!(
            still.iter().any(|o| o
                .actionable
                .iter()
                .any(|e| matches!(e, DetectionEvent::Falling { .. }))),
            "a release always gets through"
        );
    }

    #[test]
    fn off_does_nothing() {
        let mut rt = runtime(RuntimeMode::Off);
        let out = drive(&mut rt, 0, 80, 5.0);
        assert!(out.iter().all(|o| *o == RuntimeOutput::default()));
        assert!(!rt.is_active(&shake_label()));
    }

    #[test]
    fn a_mode_change_ends_a_detection_in_progress() {
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        assert!(rt.is_active(&shake_label()));
        let out = rt.set_mode(RuntimeMode::Monitor);
        assert!(matches!(
            out.actionable.as_slice(),
            [DetectionEvent::Falling {
                reason: ClearReason::Runtime(_),
                ..
            }]
        ));
        assert!(!rt.is_active(&shake_label()));
        assert_eq!(
            rt.set_mode(RuntimeMode::Monitor),
            RuntimeOutput::default(),
            "no change, no event"
        );
    }

    #[test]
    fn replacing_or_removing_a_model_releases_its_detection_before_anything_else() {
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        let mut replacement = loaded();
        replacement.version_id = model_lab_core::ModelVersionId::new("shake-v2").unwrap();
        let out = rt.set_models(vec![replacement]);
        assert!(matches!(
            out.actionable.as_slice(),
            [DetectionEvent::Falling {
                reason: ClearReason::ModelChanged,
                ..
            }]
        ));
        assert!(
            !rt.is_active(&shake_label()),
            "the new model starts with a clean state"
        );

        drive(&mut rt, 200, 80, 5.0);
        assert!(rt.is_active(&shake_label()));
        let out = rt.set_models(vec![]);
        assert!(matches!(
            out.actionable.as_slice(),
            [DetectionEvent::Falling {
                reason: ClearReason::ModelChanged,
                ..
            }]
        ));
        assert!(rt.loaded_labels().is_empty());
    }

    /// Switching to another model and back must leave no trace: the model scores the same live data exactly as it would have
    /// had it never been switched away from, and starts with a clean detection each time.
    #[test]
    fn switching_to_another_model_and_back_scores_exactly_as_if_it_had_never_been_switched() {
        let amplitude = |n: u64| if (n / 40).is_multiple_of(2) { 5.0 } else { 0.0 }; // shake for 0.8 s, then be still, and so on
        let drive_pattern = |rt: &mut LabelRuntime, from: u64, to: u64| -> Vec<(u64, f64)> {
            (from..to)
                .flat_map(|n| {
                    rt.observe_orientation(&orientation(n, amplitude(n)), n * 20_000_000)
                        .scores
                        .into_iter()
                        .map(move |s| (n, s.confidence))
                })
                .collect()
        };
        let other = || {
            let mut model = loaded();
            model.version_id = model_lab_core::ModelVersionId::new("shake-v2").unwrap();
            model
        };

        // Re-adopting the same model at the same moment only restarts the scoring schedule, which a switch does too, so the
        // two runs score at the same instants.
        let mut straight = runtime(RuntimeMode::Monitor);
        let mut never_switched = drive_pattern(&mut straight, 0, 200);
        straight.set_models(vec![loaded()]);
        never_switched.extend(drive_pattern(&mut straight, 200, 400));

        let mut switched = runtime(RuntimeMode::Monitor);
        drive_pattern(&mut switched, 0, 100);
        switched.set_models(vec![other()]);
        drive_pattern(&mut switched, 100, 200);
        switched.set_models(vec![loaded()]); // back to the first model
        let after = drive_pattern(&mut switched, 200, 400);

        let expected: Vec<&(u64, f64)> = never_switched.iter().filter(|(n, _)| *n >= 200).collect();
        assert!(!after.is_empty());
        assert_eq!(after.len(), expected.len(), "the same windows are scored");
        for (got, want) in after.iter().zip(expected) {
            assert_eq!(got.0, want.0);
            assert!(
                (got.1 - want.1).abs() < 1e-12,
                "sample {}: {} vs {}",
                got.0,
                got.1,
                want.1
            );
        }
    }

    /// The fixture model with a training range that only quiet windows fit: every input usually between 0 and 0.5.
    fn with_a_quiet_training_range() -> LoadedModel {
        let mut model = loaded();
        let n = model.input.features.len();
        model.training_range = Some(crate::bundle::TrainingRange {
            low: vec![0.0; n],
            high: vec![0.5; n],
        });
        model
    }

    #[test]
    fn a_warning_goes_up_when_most_windows_are_unlike_the_training_ones_and_comes_down_when_they_are_back()
     {
        let mut rt = LabelRuntime::default();
        rt.set_models(vec![with_a_quiet_training_range()]);
        rt.set_mode(RuntimeMode::Monitor);
        let warnings = |outputs: &[RuntimeOutput]| -> Vec<Vec<InputWarning>> {
            outputs
                .iter()
                .filter_map(|o| o.input_warnings.clone())
                .collect()
        };

        // Quiet windows are what it trained on: nothing is said.
        let quiet = drive(&mut rt, 0, 150, 0.0);
        assert!(warnings(&quiet).is_empty());

        // Vigorous shaking is far outside that range, in every input.
        let shaking = drive(&mut rt, 150, 250, 5.0);
        let raised = warnings(&shaking);
        let first = raised.first().expect("a warning went up");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].label, shake_label());
        assert!(first[0].unfamiliar_share >= 0.7);
        assert!(!first[0].worst.is_empty() && first[0].worst[0].value > first[0].worst[0].high);
        // Once up it is refreshed now and then, not on every window.
        assert!(
            raised.len() < shaking.len() / 4,
            "{} of {}",
            raised.len(),
            shaking.len()
        );

        // Back to quiet: it comes down, and says so.
        let calm = drive(&mut rt, 250, 450, 0.0);
        assert!(
            warnings(&calm).last().is_some_and(Vec::is_empty),
            "{:?}",
            warnings(&calm).last()
        );
    }

    #[test]
    fn a_model_with_no_recorded_range_is_never_warned_about_and_changing_the_model_clears_a_warning()
     {
        let mut rt = runtime(RuntimeMode::Monitor); // the fixture records no range
        assert!(
            drive(&mut rt, 0, 200, 5.0)
                .iter()
                .all(|o| o.input_warnings.is_none())
        );

        let mut rt = LabelRuntime::default();
        rt.set_models(vec![with_a_quiet_training_range()]);
        rt.set_mode(RuntimeMode::Monitor);
        drive(&mut rt, 0, 150, 5.0);
        let mut replacement = with_a_quiet_training_range();
        replacement.version_id = model_lab_core::ModelVersionId::new("shake-v2").unwrap();
        let out = rt.set_models(vec![replacement]);
        assert_eq!(
            out.input_warnings,
            Some(Vec::new()),
            "the new model starts with a clean slate"
        );
        let out = rt.set_mode(RuntimeMode::Off);
        assert!(out.input_warnings.is_none(), "nothing was standing");
    }

    #[test]
    fn keeping_the_same_model_does_not_disturb_a_running_detection() {
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        assert!(rt.set_models(vec![loaded()]).events.is_empty());
        assert!(rt.is_active(&shake_label()));
    }

    #[test]
    fn a_bad_sample_a_stalled_stream_or_a_lost_watch_each_release_the_detection() {
        // An out-of-order sample.
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        let out = rt.observe_orientation(&orientation(10, 5.0), 90 * 20_000_000);
        assert!(matches!(
            out.actionable.as_slice(),
            [DetectionEvent::Falling {
                reason: ClearReason::Rejected(_),
                ..
            }]
        ));
        assert!(!rt.is_active(&shake_label()));

        // A stream that stops: the timer tick notices.
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        let out = rt.tick(79 * 20_000_000 + 2_000_000_000);
        assert!(matches!(
            out.actionable.as_slice(),
            [DetectionEvent::Falling {
                reason: ClearReason::Rejected(_),
                ..
            }]
        ));
        assert_eq!(out.rejections.len(), 1);

        // The watch disconnecting, and the runtime itself failing.
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        assert!(matches!(
            rt.watch_lost().actionable.as_slice(),
            [DetectionEvent::Falling { .. }]
        ));
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        assert!(matches!(
            rt.fail("backend crashed").actionable.as_slice(),
            [DetectionEvent::Falling {
                reason: ClearReason::Runtime(_),
                ..
            }]
        ));
        // After a loss the buffers are empty, so nothing is scored from stale data.
        assert!(rt.tick(1_000_000_000_000).scores.is_empty());
    }

    #[test]
    fn after_a_fault_the_label_can_be_detected_again_from_fresh_data() {
        let mut rt = runtime(RuntimeMode::Live);
        drive(&mut rt, 0, 80, 5.0);
        rt.watch_lost();
        let again = drive(&mut rt, 1000, 90, 5.0);
        assert!(
            events(&again)
                .iter()
                .any(|e| matches!(e, DetectionEvent::Rising { .. }))
        );
    }

    #[test]
    fn two_exclusive_labels_cannot_both_be_acted_on() {
        // Two models for two labels reading the same data would both fire; declare them exclusive and neither does.
        let mut rt = LabelRuntime::default();
        let first = loaded();
        let mut second = loaded();
        second.label = LabelId::new("shake_twin").unwrap();
        second.version_id = model_lab_core::ModelVersionId::new("twin-v1").unwrap();
        rt.set_models(vec![first, second]);
        rt.set_exclusivity(vec![ExclusivityGroup {
            labels: [shake_label(), LabelId::new("shake_twin").unwrap()].into(),
        }]);
        rt.set_mode(RuntimeMode::Live);
        let out = drive(&mut rt, 0, 90, 5.0);
        assert!(
            out.iter().any(|o| !o.conflicts.is_empty()),
            "the clash is reported"
        );
        assert!(
            out.iter().all(|o| o
                .actionable
                .iter()
                .all(|e| !matches!(e, DetectionEvent::Rising { .. }))),
            "and neither starts"
        );
        let _ = feed;
    }
}
