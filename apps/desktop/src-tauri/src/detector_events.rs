//! A model's detections counted as `docs/research/gesture-detector-evaluation-metrics.md` counts them, and as the trainer
//! does (`label_train.detections`, `label_train.cohort`), for the desktop's own replays: the Threshold card, the Mistakes
//! list, model comparison and the final test.
//!
//! Each detection is exactly one of: a **catch** (paired with a start of the gesture it rises 680 to 1,280 ms after,
//! `sealed_test::assign`), a **repeat** (another detection while a caught gesture is under way), **late** (one while a gesture
//! is under way that was not caught in its window: the gesture counts as missed), or a **false activation** (one with no
//! gesture under way). A gesture is under way from its start, through the holds of the same gesture that follow it without a
//! gap (`pinch_in`, then `pinch_hold` and `pinch_out`), and at least to the end of its match window. False activations are
//! counted per hour of time with no gesture under way; stretches left out on the Labelling page, and labels the model's
//! training excluded, are neither.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::dataset_files::{self, Hold};
use crate::sealed_test;

/// The release gate's budget, the trainer's `FALSE_ACTIVATIONS_BUDGET_PER_HOUR`.
pub const FALSE_ACTIVATIONS_BUDGET_PER_HOUR: f64 = 30.0;
/// The camera-timed recordings decide only when they hold at least this many gestures and this long with none under way
/// (the trainer's `MIN_COHORT_GESTURES`, `MIN_NEGATIVE_SECONDS`).
const MIN_COHORT_GESTURES: usize = 20;
const MIN_NEGATIVE_SECONDS: f64 = 60.0;

/// What one detection was.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    /// It caught the start with this index.
    Catch(usize),
    Repeat,
    Late,
    False,
}

/// One recording's (or several recordings') detections, counted.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventTotals {
    pub recordings: usize,
    pub starts: usize,
    pub caught: usize,
    pub repeats: usize,
    pub late: usize,
    pub false_activations: usize,
    /// Time with no gesture under way, and nothing left out.
    pub negative_seconds: f64,
    /// None when there was no such time.
    pub false_activations_per_hour: Option<f64>,
}

impl EventTotals {
    pub fn sum<'a>(parts: impl IntoIterator<Item = &'a EventTotals>) -> EventTotals {
        let mut total = EventTotals::default();
        for part in parts {
            total.recordings += part.recordings;
            total.starts += part.starts;
            total.caught += part.caught;
            total.repeats += part.repeats;
            total.late += part.late;
            total.false_activations += part.false_activations;
            total.negative_seconds += part.negative_seconds;
        }
        total.false_activations_per_hour =
            per_hour(total.false_activations, total.negative_seconds);
        total
    }
}

fn per_hour(count: usize, seconds: f64) -> Option<f64> {
    (seconds > 0.0).then(|| count as f64 / (seconds / 3600.0))
}

/// The detections that count, what each was, and the totals.
#[derive(Debug, Clone, PartialEq)]
pub struct Counted {
    /// Each detection that counts (not judging a stretch left out, nor rising inside an excluded label), with what it was.
    pub detections: Vec<(f64, Kind)>,
    /// Whether each start was caught.
    pub caught: Vec<bool>,
    /// Each gesture under way: from, to, and the index of its start.
    pub under_way: Vec<(f64, f64, usize)>,
    pub totals: EventTotals,
}

impl Counted {
    /// The delay from each caught start to the detection that caught it.
    pub fn latencies(&self, starts: &[f64]) -> Vec<f64> {
        self.detections
            .iter()
            .filter_map(|(at, kind)| match kind {
                Kind::Catch(i) => Some(at - starts[*i]),
                _ => None,
            })
            .collect()
    }
}

/// The holds training uses (at least [`dataset_files::MIN_HOLD_MS`]).
fn kept(holds: &[Hold]) -> impl Iterator<Item = &Hold> {
    holds
        .iter()
        .filter(|hold| hold.end_ms - hold.start_ms >= dataset_files::MIN_HOLD_MS)
}

fn stem(label: &str) -> &str {
    label.split('_').next().unwrap_or(label)
}

/// (start, end) of each gesture of `target` as a whole: its hold, extended through the holds that follow it without a gap of
/// [`dataset_files::HOLD_MERGE_GAP_MS`] and are labels of the same gesture (the same name before the first "_"). The
/// trainer's `gesture_episodes`.
pub fn gesture_episodes(holds: &[Hold], target: &str) -> Vec<(f64, f64)> {
    let held: Vec<&Hold> = kept(holds).collect();
    let mut episodes = Vec::new();
    for (i, hold) in held.iter().enumerate() {
        if hold.label != target {
            continue;
        }
        let mut end = hold.end_ms;
        for next in &held[i + 1..] {
            if next.label == target
                || stem(&next.label) != stem(target)
                || next.start_ms - end >= dataset_files::HOLD_MERGE_GAP_MS
            {
                break;
            }
            end = next.end_ms;
        }
        episodes.push((hold.start_ms, end));
    }
    episodes
}

fn merged_length(mut spans: Vec<(f64, f64)>, from: f64, to: f64) -> f64 {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
        .iter()
        .map(|(start, end)| (end.min(to) - start.max(from)).max(0.0))
        .sum()
}

/// One recording's detections (rise times, ms after its first sample) counted against `starts` (`sealed_test::starts_of`
/// for `target`). `holds` are all its holds, `excluded` the labels the model's training left out, and `span` the stretch
/// the model judged (its first and last score).
pub fn count(
    detections: &[f64],
    starts: &[f64],
    holds: &[Hold],
    target: &str,
    excluded: &[String],
    span: (f64, f64),
) -> Counted {
    let ignored: Vec<(f64, f64)> = holds
        .iter()
        .filter(|hold| excluded.contains(&hold.label))
        .map(|hold| (hold.start_ms, hold.end_ms))
        .collect();
    let rises: Vec<f64> = sealed_test::outside_left_out(detections, holds)
        .into_iter()
        .filter(|rise| {
            !ignored
                .iter()
                .any(|(start, end)| (*start..=*end).contains(rise))
        })
        .collect();
    let assigned = sealed_test::assign(&rises, starts);
    let caught: Vec<bool> = (0..starts.len())
        .map(|i| assigned.contains(&Some(i)))
        .collect();
    let under_way: Vec<(f64, f64, usize)> = gesture_episodes(holds, target)
        .into_iter()
        .filter_map(|(start, end)| {
            let i = starts.iter().position(|s| *s == start)?;
            Some((start, end.max(start + sealed_test::CATCH_TO_MS), i))
        })
        .collect();
    let mut totals = EventTotals {
        recordings: 1,
        starts: starts.len(),
        ..EventTotals::default()
    };
    let kinds: Vec<(f64, Kind)> = rises
        .iter()
        .zip(&assigned)
        .map(|(&rise, start)| {
            let kind = match start {
                Some(i) => Kind::Catch(*i),
                None => {
                    let during: Vec<bool> = under_way
                        .iter()
                        .filter(|(from, to, _)| (*from..=*to).contains(&rise))
                        .map(|(_, _, i)| caught[*i])
                        .collect();
                    if during.is_empty() {
                        Kind::False
                    } else if during.contains(&true) {
                        Kind::Repeat
                    } else {
                        Kind::Late
                    }
                }
            };
            match kind {
                Kind::Catch(_) => totals.caught += 1,
                Kind::Repeat => totals.repeats += 1,
                Kind::Late => totals.late += 1,
                Kind::False => totals.false_activations += 1,
            }
            (rise, kind)
        })
        .collect();
    let left_out = holds
        .iter()
        .filter(|hold| hold.label == dataset_files::LEFT_OUT_LABEL)
        .map(|hold| (hold.start_ms, hold.end_ms));
    let busy: Vec<(f64, f64)> = under_way
        .iter()
        .map(|(from, to, _)| (*from, *to))
        .chain(ignored)
        .chain(left_out)
        .collect();
    let (from, to) = span;
    totals.negative_seconds =
        ((to - from).max(0.0) - merged_length(busy, from, to)).max(0.0) / 1000.0;
    totals.false_activations_per_hour = per_hour(totals.false_activations, totals.negative_seconds);
    Counted {
        detections: kinds,
        caught,
        under_way,
        totals,
    }
}

/// "camera" for a recording whose labels the camera marked, "estimated" for one placed from the watch's motion, and
/// "unknown" otherwise (`DatasetSummary::labels_from`, worked out by `model_lab::describe`).
pub fn label_timing(labels_from: Option<&str>) -> &'static str {
    match labels_from {
        Some("camera") => "camera",
        Some("motion") => "estimated",
        _ => "unknown",
    }
}

/// How a recording's `target` gestures were timed: "noGesture" when it has none (everyday noise: nothing to time, so it is
/// trusted like a camera-timed one), otherwise [`label_timing`].
pub fn timing_of(dataset: &crate::model_lab::DatasetSummary, target: &str) -> &'static str {
    if dataset
        .effective_labels()
        .iter()
        .any(|label| label == target)
    {
        label_timing(dataset.labels_from.as_deref())
    } else {
        "noGesture"
    }
}

/// Kinds of recording judged together when the camera-timed ones are enough to judge by.
const TRUSTED: [&str; 2] = ["camera", "noGesture"];

/// The totals to judge a replay by, with which recordings they cover.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Judged {
    #[serde(flatten)]
    pub totals: EventTotals,
    /// "camera": only the camera-timed recordings, as the set also held others and they were enough to judge by. "all":
    /// every one.
    pub cohort: &'static str,
    /// The totals for each kind of label timing present ("camera", "estimated", "unknown", "noGesture").
    pub by_label_timing: BTreeMap<&'static str, EventTotals>,
}

/// Judged as the trainer's `cohort` judges: on the camera-timed recordings (with any of no gesture, which have no timing to
/// doubt) when recordings timed otherwise are present too and the camera-timed ones hold at least 20 gestures, and those
/// 60 s with none under way; otherwise on all of them.
pub fn judge(per_recording: &[(&'static str, EventTotals)]) -> Judged {
    let mut by_label_timing: BTreeMap<&'static str, EventTotals> = BTreeMap::new();
    for timing in ["camera", "estimated", "unknown", "noGesture"] {
        let part: Vec<&EventTotals> = per_recording
            .iter()
            .filter(|(t, _)| *t == timing)
            .map(|(_, totals)| totals)
            .collect();
        if !part.is_empty() {
            by_label_timing.insert(timing, EventTotals::sum(part));
        }
    }
    let trusted = EventTotals::sum(
        per_recording
            .iter()
            .filter(|(t, _)| TRUSTED.contains(t))
            .map(|(_, totals)| totals),
    );
    let mixed = by_label_timing
        .keys()
        .filter(|t| **t != "noGesture")
        .count()
        > 1;
    let enough = by_label_timing
        .get("camera")
        .is_some_and(|camera| camera.starts >= MIN_COHORT_GESTURES)
        && trusted.negative_seconds >= MIN_NEGATIVE_SECONDS;
    if mixed && enough {
        Judged {
            totals: trusted,
            cohort: "camera",
            by_label_timing,
        }
    } else {
        Judged {
            totals: EventTotals::sum(per_recording.iter().map(|(_, totals)| totals)),
            cohort: "all",
            by_label_timing,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hold(label: &str, start_ms: f64, end_ms: f64) -> Hold {
        Hold {
            label: label.into(),
            start_ms,
            end_ms,
        }
    }

    /// Mirrors `test_label_train.py::test_a_firing_during_a_pinch_is_a_repeat_or_late_and_only_one_with_no_gesture_under_way_is_false`.
    #[test]
    fn a_firing_during_a_pinch_is_a_repeat_or_late_and_only_one_with_no_gesture_under_way_is_false()
    {
        // Rows every 10 ms, so each hold ends on the last row before the next label.
        let holds = vec![
            hold("pinch_in", 2000.0, 2290.0),
            hold("pinch_hold", 2300.0, 3990.0),
            hold("pinch_out", 4000.0, 4290.0),
            hold("pinch_in", 10_000.0, 10_290.0),
            hold("pinch_hold", 10_300.0, 11_990.0),
            hold("pinch_out", 12_000.0, 12_290.0),
            hold("fist", 15_000.0, 15_990.0),
        ];
        let starts = [2000.0, 10_000.0];
        // Caught 0.9 s after the first pinch, again during its hold, late in the second, during a fist, and with nothing held.
        let counted = count(
            &[2900.0, 3500.0, 11_500.0, 15_500.0, 18_000.0],
            &starts,
            &holds,
            "pinch_in",
            &[],
            (0.0, 19_990.0),
        );
        let t = &counted.totals;
        assert_eq!(
            (t.starts, t.caught, t.repeats, t.late, t.false_activations),
            (2, 1, 1, 1, 2)
        );
        assert_eq!(
            counted
                .detections
                .iter()
                .map(|(_, kind)| *kind)
                .collect::<Vec<_>>(),
            [
                Kind::Catch(0),
                Kind::Repeat,
                Kind::Late,
                Kind::False,
                Kind::False
            ]
        );
        // Time without the gesture leaves out both pinches, from their start through pinch out.
        assert!((t.negative_seconds - (19_990.0 - 2_290.0 - 2_290.0) / 1000.0).abs() < 1e-9);
        assert_eq!(
            gesture_episodes(&holds, "pinch_in"),
            [(2000.0, 4290.0), (10_000.0, 12_290.0)]
        );
        assert_eq!(counted.latencies(&starts), [900.0]);
    }

    #[test]
    fn a_short_gesture_is_under_way_to_the_end_of_its_match_window_and_left_out_or_excluded_time_is_not_counted()
     {
        // A pinch of 300 ms is still under way 1,280 ms after it began; a detection 1.25 s after it is a repeat.
        let holds = vec![
            hold("pinch", 1000.0, 1300.0),
            hold(dataset_files::LEFT_OUT_LABEL, 5000.0, 7000.0),
            hold("walking", 8000.0, 9000.0),
        ];
        let counted = count(
            &[1900.0, 2250.0, 6500.0, 8500.0, 9500.0],
            &[1000.0],
            &holds,
            "pinch",
            &["walking".into()],
            (0.0, 10_000.0),
        );
        let t = &counted.totals;
        // 6.5 s judges 5.62 s, left out; 8.5 s rises during walking, excluded; 9.5 s is false.
        assert_eq!(
            (t.caught, t.repeats, t.late, t.false_activations),
            (1, 1, 0, 1)
        );
        assert!((t.negative_seconds - (10_000.0 - 1280.0 - 2000.0 - 1000.0) / 1000.0).abs() < 1e-9);
        assert!((t.false_activations_per_hour.unwrap() - 3600.0 / 5.72).abs() < 1e-6);
    }

    #[test]
    fn results_are_judged_on_the_camera_timed_recordings_when_there_are_enough_of_them() {
        let part =
            |starts: usize, caught: usize, false_activations: usize, seconds: f64| EventTotals {
                recordings: 1,
                starts,
                caught,
                false_activations,
                negative_seconds: seconds,
                false_activations_per_hour: per_hour(false_activations, seconds),
                ..EventTotals::default()
            };
        let judged = judge(&[
            ("camera", part(25, 10, 3, 600.0)),
            ("estimated", part(30, 28, 0, 600.0)),
        ]);
        assert_eq!(
            (judged.cohort, judged.totals.starts, judged.totals.caught),
            ("camera", 25, 10)
        );
        assert_eq!(judged.totals.false_activations_per_hour, Some(18.0));
        assert_eq!(judged.by_label_timing["estimated"].caught, 28);
        // Too few camera-timed gestures to judge by: all of them, still split by timing.
        let few = judge(&[
            ("camera", part(5, 2, 0, 600.0)),
            ("estimated", part(30, 28, 0, 600.0)),
        ]);
        assert_eq!(
            (few.cohort, few.totals.starts, few.by_label_timing.len()),
            ("all", 35, 2)
        );
        // Only camera-timed recordings: all of them.
        assert_eq!(judge(&[("camera", part(25, 10, 3, 600.0))]).cohort, "all");
        // Everyday noise counts with the camera-timed recordings.
        let noisy = judge(&[
            ("camera", part(25, 10, 3, 600.0)),
            ("estimated", part(30, 28, 0, 600.0)),
            ("noGesture", part(0, 0, 6, 1800.0)),
        ]);
        assert_eq!(
            (
                noisy.cohort,
                noisy.totals.starts,
                noisy.totals.false_activations
            ),
            ("camera", 25, 9)
        );
        assert_eq!(noisy.totals.false_activations_per_hour, Some(13.5));
        assert_eq!(
            judge(&[
                ("camera", part(25, 10, 3, 600.0)),
                ("noGesture", part(0, 0, 6, 1800.0))
            ])
            .cohort,
            "all"
        );
        assert_eq!(label_timing(Some("motion")), "estimated");
        assert_eq!(label_timing(Some("recorder")), "unknown");
    }
}
