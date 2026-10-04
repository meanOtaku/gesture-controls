//! Turns a label's stream of probabilities into detections: a rising edge, an active state and a falling edge.
//!
//! A score starts a detection when it reaches the activation threshold (held for the debounce time, and not within the
//! cooldown after the last detection ended). It keeps the detection active until the score falls *below the release
//! threshold*, which is at or under the activation threshold, so a score wobbling between the two does not flicker.
//!
//! Labels that cannot both be true (a swipe left and a swipe right) are declared as an [`ExclusivityGroup`], separately
//! from any model. When two of them would be active at once, **neither** is: both are held off and a [`Conflict`] is
//! reported once. There is no rule that the first or the stronger one wins.

use std::collections::{BTreeMap, BTreeSet};

use model_lab_core::{LabelId, Thresholds};

/// Why a detection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClearReason {
    /// The score fell below the release threshold: the ordinary end.
    ScoreBelowRelease,
    /// Another label that cannot coexist with it was also detected.
    Conflict,
    /// A window for its model was rejected (stale or out-of-order input, a quality gate, a model error).
    Rejected(String),
    /// Its model was replaced, rolled back, removed or deactivated.
    ModelChanged,
    /// The runtime was lost or switched mode.
    Runtime(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum DetectionEvent {
    Rising {
        label: LabelId,
        confidence: f64,
        timestamp_ns: u64,
    },
    /// Still detected. Sent with each new score while the detection lasts.
    Active {
        label: LabelId,
        confidence: f64,
        timestamp_ns: u64,
    },
    Falling {
        label: LabelId,
        timestamp_ns: u64,
        reason: ClearReason,
    },
}

impl DetectionEvent {
    pub fn label(&self) -> &LabelId {
        match self {
            Self::Rising { label, .. }
            | Self::Active { label, .. }
            | Self::Falling { label, .. } => label,
        }
    }
}

/// Labels of which at most one may be detected at a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExclusivityGroup {
    pub labels: BTreeSet<LabelId>,
}

/// Labels that were detected at the same time though they cannot coexist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub labels: BTreeSet<LabelId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Quiet,
    Rising,
    Active,
    Falling,
}

#[derive(Debug, Clone)]
pub struct TemporalDetector {
    thresholds: Thresholds,
    active: bool,
    /// When the score first reached the activation threshold in the current run, while debouncing.
    pending_since_ns: Option<u64>,
    last_fall_ns: Option<u64>,
}

const NS_PER_MS: u64 = 1_000_000;

impl TemporalDetector {
    pub fn new(thresholds: Thresholds) -> Self {
        Self {
            thresholds,
            active: false,
            pending_since_ns: None,
            last_fall_ns: None,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    fn step(&mut self, score: f64, timestamp_ns: u64) -> Step {
        if self.active {
            if score < self.thresholds.release {
                self.active = false;
                self.last_fall_ns = Some(timestamp_ns);
                return Step::Falling;
            }
            return Step::Active;
        }
        if score < self.thresholds.activation {
            self.pending_since_ns = None;
            return Step::Quiet;
        }
        let cooling = self.last_fall_ns.is_some_and(|fell| {
            timestamp_ns.saturating_sub(fell) < u64::from(self.thresholds.cooldown_ms) * NS_PER_MS
        });
        if cooling {
            self.pending_since_ns = None;
            return Step::Quiet;
        }
        let since = *self.pending_since_ns.get_or_insert(timestamp_ns);
        if timestamp_ns.saturating_sub(since) >= u64::from(self.thresholds.debounce_ms) * NS_PER_MS
        {
            self.active = true;
            self.pending_since_ns = None;
            return Step::Rising;
        }
        Step::Quiet
    }

    /// Ends any detection without a score and without starting a cooldown. Returns whether one was active.
    fn clear(&mut self) -> bool {
        self.pending_since_ns = None;
        std::mem::replace(&mut self.active, false)
    }
}

/// All labels' detectors, plus the exclusivity rules between them.
#[derive(Debug, Default)]
pub struct DetectionHub {
    detectors: BTreeMap<LabelId, TemporalDetector>,
    groups: Vec<ExclusivityGroup>,
    /// Conflicts already reported and still going, so each is reported once rather than every score.
    reported: BTreeSet<BTreeSet<LabelId>>,
    /// The last raw timestamp seen per label, used to stamp a forced end.
    last_timestamp_ns: BTreeMap<LabelId, u64>,
}

impl DetectionHub {
    pub fn set_exclusivity(&mut self, groups: Vec<ExclusivityGroup>) {
        self.groups = groups;
        self.reported.clear();
    }

    /// Starts tracking a label (or updates its thresholds, restarting its detector).
    pub fn track(&mut self, label: LabelId, thresholds: Thresholds) {
        self.detectors
            .insert(label, TemporalDetector::new(thresholds));
    }

    pub fn untrack(&mut self, label: &LabelId, reason: ClearReason) -> Option<DetectionEvent> {
        let event = self.clear_label(label, reason);
        self.detectors.remove(label);
        self.last_timestamp_ns.remove(label);
        event
    }

    pub fn is_active(&self, label: &LabelId) -> bool {
        self.detectors
            .get(label)
            .is_some_and(TemporalDetector::is_active)
    }

    /// Ends one label's detection, if it has one, and says so.
    pub fn clear_label(&mut self, label: &LabelId, reason: ClearReason) -> Option<DetectionEvent> {
        let was_active = self.detectors.get_mut(label)?.clear();
        was_active.then(|| DetectionEvent::Falling {
            label: label.clone(),
            timestamp_ns: self.last_timestamp_ns.get(label).copied().unwrap_or(0),
            reason,
        })
    }

    pub fn clear_all(&mut self, reason: &ClearReason) -> Vec<DetectionEvent> {
        self.reported.clear();
        let labels: Vec<LabelId> = self.detectors.keys().cloned().collect();
        labels
            .iter()
            .filter_map(|label| self.clear_label(label, reason.clone()))
            .collect()
    }

    /// Applies one round of scores (label, probability, raw timestamp) and returns what changed.
    pub fn process(
        &mut self,
        scores: &[(LabelId, f64, u64)],
    ) -> (Vec<DetectionEvent>, Vec<Conflict>) {
        let mut steps: BTreeMap<LabelId, (Step, f64, u64)> = BTreeMap::new();
        for (label, score, timestamp_ns) in scores {
            let Some(detector) = self.detectors.get_mut(label) else {
                continue;
            };
            self.last_timestamp_ns.insert(label.clone(), *timestamp_ns);
            steps.insert(
                label.clone(),
                (detector.step(*score, *timestamp_ns), *score, *timestamp_ns),
            );
        }

        // Which labels would be detected after this round.
        let mut conflicts = Vec::new();
        let mut present: BTreeSet<BTreeSet<LabelId>> = BTreeSet::new();
        for group in &self.groups {
            let on: BTreeSet<LabelId> = group
                .labels
                .iter()
                .filter(|label| {
                    self.detectors
                        .get(*label)
                        .is_some_and(TemporalDetector::is_active)
                })
                .cloned()
                .collect();
            if on.len() >= 2 {
                present.insert(on.clone());
                if !self.reported.contains(&on) {
                    conflicts.push(Conflict { labels: on.clone() });
                }
                for label in &on {
                    // Hold every conflicting label off; the event below says whether one had been detected.
                    if let Some(detector) = self.detectors.get_mut(label) {
                        detector.clear();
                    }
                    let last_ts = self.last_timestamp_ns.get(label).copied().unwrap_or(0);
                    let entry = steps
                        .entry(label.clone())
                        .or_insert((Step::Active, 0.0, last_ts));
                    *entry = (
                        match entry.0 {
                            // A label that only just rose never was detected: say nothing about it.
                            Step::Rising => Step::Quiet,
                            Step::Active | Step::Falling => Step::Falling,
                            Step::Quiet => Step::Quiet,
                        },
                        entry.1,
                        entry.2,
                    );
                }
            }
        }
        self.reported = present;

        let conflicted: BTreeSet<&LabelId> =
            self.reported.iter().flat_map(|set| set.iter()).collect();
        let events = steps
            .into_iter()
            .filter_map(|(label, (step, confidence, timestamp_ns))| match step {
                Step::Quiet => None,
                Step::Rising => Some(DetectionEvent::Rising {
                    label,
                    confidence,
                    timestamp_ns,
                }),
                Step::Active => Some(DetectionEvent::Active {
                    label,
                    confidence,
                    timestamp_ns,
                }),
                Step::Falling => Some(DetectionEvent::Falling {
                    reason: if conflicted.contains(&label) {
                        ClearReason::Conflict
                    } else {
                        ClearReason::ScoreBelowRelease
                    },
                    label,
                    timestamp_ns,
                }),
            })
            .collect();
        (events, conflicts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(id: &str) -> LabelId {
        LabelId::new(id).unwrap()
    }

    fn thresholds(activation: f64, release: f64, debounce_ms: u32, cooldown_ms: u32) -> Thresholds {
        Thresholds {
            activation,
            release,
            debounce_ms,
            cooldown_ms,
        }
    }

    const MS: u64 = 1_000_000;

    fn run(detector: &mut TemporalDetector, scores: &[(f64, u64)]) -> Vec<Step> {
        scores
            .iter()
            .map(|(s, ms)| detector.step(*s, ms * MS))
            .collect()
    }

    #[test]
    fn a_detection_rises_stays_active_and_falls_with_hysteresis_between_the_thresholds() {
        let mut d = TemporalDetector::new(thresholds(0.8, 0.5, 0, 0));
        let steps = run(
            &mut d,
            &[
                (0.2, 0),
                (0.85, 10),
                (0.7, 20),
                (0.55, 30),
                (0.4, 40),
                (0.7, 50),
            ],
        );
        // 0.7 and 0.55 are below activation but not below release, so it stays active; only 0.4 ends it. After that
        // 0.7 is below activation, so it does not rise again.
        assert_eq!(
            steps,
            [
                Step::Quiet,
                Step::Rising,
                Step::Active,
                Step::Active,
                Step::Falling,
                Step::Quiet
            ]
        );
    }

    #[test]
    fn a_brief_spike_is_ignored_until_it_has_lasted_the_debounce_time() {
        let mut d = TemporalDetector::new(thresholds(0.8, 0.5, 100, 0));
        assert_eq!(
            run(
                &mut d,
                &[(0.9, 0), (0.3, 30), (0.9, 60), (0.9, 120), (0.9, 170)]
            ),
            [
                Step::Quiet,
                Step::Quiet,
                Step::Quiet,
                Step::Quiet,
                Step::Rising
            ]
        );
    }

    #[test]
    fn after_a_detection_ends_it_cannot_restart_until_the_cooldown_has_passed() {
        let mut d = TemporalDetector::new(thresholds(0.8, 0.5, 0, 200));
        let steps = run(
            &mut d,
            &[(0.9, 0), (0.1, 50), (0.9, 100), (0.9, 249), (0.9, 251)],
        );
        assert_eq!(
            steps,
            [
                Step::Rising,
                Step::Falling,
                Step::Quiet,
                Step::Quiet,
                Step::Rising
            ]
        );
    }

    #[test]
    fn clearing_ends_a_detection_without_a_cooldown() {
        let mut d = TemporalDetector::new(thresholds(0.8, 0.5, 0, 500));
        d.step(0.9, 0);
        assert!(d.clear());
        assert!(!d.clear());
        assert_eq!(
            d.step(0.9, 10 * MS),
            Step::Rising,
            "a forced end must not leave the label dead for the cooldown"
        );
    }

    fn hub() -> DetectionHub {
        let mut hub = DetectionHub::default();
        for l in ["swipe_left", "swipe_right", "pinch_start"] {
            hub.track(label(l), thresholds(0.8, 0.5, 0, 0));
        }
        hub.set_exclusivity(vec![ExclusivityGroup {
            labels: [label("swipe_left"), label("swipe_right")].into(),
        }]);
        hub
    }

    fn scores(entries: &[(&str, f64)], ts: u64) -> Vec<(LabelId, f64, u64)> {
        entries.iter().map(|(l, s)| (label(l), *s, ts)).collect()
    }

    #[test]
    fn independent_labels_are_detected_at_the_same_time_without_affecting_each_other() {
        let mut hub = hub();
        let (events, conflicts) =
            hub.process(&scores(&[("swipe_left", 0.9), ("pinch_start", 0.9)], 10));
        assert!(conflicts.is_empty());
        assert_eq!(events.len(), 2);
        assert!(
            events
                .iter()
                .all(|e| matches!(e, DetectionEvent::Rising { .. }))
        );
        assert!(hub.is_active(&label("swipe_left")) && hub.is_active(&label("pinch_start")));
    }

    #[test]
    fn two_exclusive_labels_detected_together_are_both_held_off_and_reported_once() {
        let mut hub = hub();
        let (events, conflicts) =
            hub.process(&scores(&[("swipe_left", 0.9), ("swipe_right", 0.95)], 10));
        // Neither is detected, and nothing was ever announced for either, so there is nothing to release.
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(
            conflicts,
            vec![Conflict {
                labels: [label("swipe_left"), label("swipe_right")].into()
            }]
        );
        assert!(!hub.is_active(&label("swipe_left")) && !hub.is_active(&label("swipe_right")));
        // While the clash continues it is not reported again.
        let (events, conflicts) =
            hub.process(&scores(&[("swipe_left", 0.9), ("swipe_right", 0.95)], 20));
        assert!(events.is_empty() && conflicts.is_empty());
        // When only one is still high, that one is detected normally: no label wins by being first.
        let (events, conflicts) =
            hub.process(&scores(&[("swipe_left", 0.1), ("swipe_right", 0.95)], 30));
        assert!(conflicts.is_empty());
        assert!(
            matches!(events.as_slice(), [DetectionEvent::Rising { label: l, .. }] if l.as_str() == "swipe_right")
        );
    }

    #[test]
    fn a_label_already_detected_is_released_when_an_exclusive_one_arrives() {
        let mut hub = hub();
        hub.process(&scores(&[("swipe_left", 0.9)], 10));
        assert!(hub.is_active(&label("swipe_left")));
        let (events, conflicts) =
            hub.process(&scores(&[("swipe_left", 0.9), ("swipe_right", 0.9)], 20));
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            events.len(),
            1,
            "swipe_right never rose, so only swipe_left has something to release: {events:?}"
        );
        assert!(
            matches!(&events[0], DetectionEvent::Falling { label: l, reason: ClearReason::Conflict, .. } if l.as_str() == "swipe_left")
        );
        assert!(!hub.is_active(&label("swipe_left")));
    }

    #[test]
    fn clearing_a_label_or_everything_reports_a_falling_edge_for_each_active_one() {
        let mut hub = hub();
        hub.process(&scores(&[("swipe_left", 0.9), ("pinch_start", 0.9)], 77));
        let event = hub
            .clear_label(&label("swipe_left"), ClearReason::ModelChanged)
            .unwrap();
        assert_eq!(
            event,
            DetectionEvent::Falling {
                label: label("swipe_left"),
                timestamp_ns: 77,
                reason: ClearReason::ModelChanged
            }
        );
        assert!(
            hub.clear_label(&label("swipe_left"), ClearReason::ModelChanged)
                .is_none(),
            "nothing left to release"
        );
        let rest = hub.clear_all(&ClearReason::Runtime("lost".into()));
        assert_eq!(rest.len(), 1);
        assert!(!hub.is_active(&label("pinch_start")));
    }

    #[test]
    fn a_score_for_an_untracked_label_is_ignored() {
        let mut hub = hub();
        let (events, _) = hub.process(&scores(&[("fist", 0.99)], 1));
        assert!(events.is_empty());
    }

    #[test]
    fn untracking_a_label_releases_it() {
        let mut hub = hub();
        hub.process(&scores(&[("pinch_start", 0.9)], 5));
        let event = hub
            .untrack(&label("pinch_start"), ClearReason::ModelChanged)
            .unwrap();
        assert!(matches!(
            event,
            DetectionEvent::Falling {
                reason: ClearReason::ModelChanged,
                ..
            }
        ));
        assert!(!hub.is_active(&label("pinch_start")));
    }
}
