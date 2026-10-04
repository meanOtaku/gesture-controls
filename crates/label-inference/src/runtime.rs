//! Ties the pipeline, the loaded models and the detection hub together, and applies the safety rules.
//!
//! * **Off** does nothing at all. **Monitor** scores and reports but never lets a *start* through. **Live** forwards
//!   detections from the models that are loaded, and only validated, approved, active ones can be.
//! * A falling edge always gets through in every mode: releasing is the safe direction, so it is never withheld.
//! * A model replaced, removed or rolled back is released *before* the new one is used.
//! * A stale or bad stream, a failed window, a model error, a mode change or a lost runtime clears the affected
//!   labels and reports a falling edge for each, so anything depending on them lets go.

use std::collections::BTreeMap;

use model_lab_core::{InferenceMode, LabelId, StreamSource};
use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::detection::{ClearReason, Conflict, DetectionEvent, DetectionHub, ExclusivityGroup};
use crate::model::LoadedModel;
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

#[derive(Debug, Default, PartialEq)]
pub struct RuntimeOutput {
    pub scores: Vec<LabelScore>,
    pub rejections: Vec<WindowRejection>,
    /// Every detection change, for display and diagnostics.
    pub events: Vec<DetectionEvent>,
    pub conflicts: Vec<Conflict>,
    /// What may be acted on: in Live everything, otherwise only falling edges (releasing is always safe).
    pub actionable: Vec<DetectionEvent>,
}

pub struct LabelRuntime {
    models: BTreeMap<LabelId, LoadedModel>,
    pipeline: LabelPipeline,
    hub: DetectionHub,
    mode: RuntimeMode,
}

impl Default for LabelRuntime {
    fn default() -> Self {
        Self {
            models: BTreeMap::new(),
            pipeline: LabelPipeline::default(),
            hub: DetectionHub::default(),
            mode: RuntimeMode::Off,
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
            ..RuntimeOutput::default()
        }
    }

    /// Changes the mode. Any change ends every detection, so a mode downgrade can never leave something held.
    pub fn set_mode(&mut self, mode: RuntimeMode) -> RuntimeOutput {
        if mode == self.mode {
            return RuntimeOutput::default();
        }
        self.mode = mode;
        self.pipeline.reset();
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
        self.models = next;
        let refs: Vec<&LoadedModel> = self.models.values().collect();
        self.pipeline.configure(&refs);
        self.release(events)
    }

    /// The runtime itself failed (a crash, a lost backend): end everything and drop buffered telemetry.
    pub fn fail(&mut self, detail: &str) -> RuntimeOutput {
        self.pipeline.reset();
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
        RuntimeOutput {
            actionable: allow(self.mode, &events),
            scores,
            rejections,
            events,
            conflicts,
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
