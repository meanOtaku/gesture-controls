//! Spots a swipe of the hand in a stream of acceleration and orientation samples: one quick push in a direction,
//! like flicking through pages in the air.
//!
//! *Left* and *right* are along the watch case's 9-3 axis. That is along the forearm, which stays pointing along the
//! arm however the elbow is bent, and when the watch is read normally its 3 o'clock side is the wearer's right. A
//! watch worn the other way round (the crown on the left as it is read) has it the other way, so which side the
//! crown is on is a setting. *Up* and *down* are along gravity, found by turning the acceleration into the world
//! frame with the watch's orientation.
//!
//! A swipe is one strong lobe of acceleration. A shake, a run of lobes back and forth, must not read as swipes, so a
//! lobe is held for a moment: if a similarly strong lobe the other way follows, it was a shake and nothing is
//! reported. A weaker lobe the other way is just the hand stopping, and is ignored.

use serde::{Deserialize, Serialize};

const NS_PER_SECOND: f64 = 1e9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SwipeDirection {
    Left,
    Right,
    Up,
    Down,
}

/// Which wrist the watch is worn on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Wrist {
    #[default]
    Left,
    Right,
}

/// Which side of the watch face the crown is on, as the wearer reads the face. Most people wear it with the crown on
/// the right; the watch can be set up (and worn) the other way round. The watch's own 3 o'clock axis points to the
/// wearer's right when the crown is on the right, and to their left otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CrownSide {
    #[default]
    Right,
    Left,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SwipeConfig {
    /// How far above the baseline a push must reach, in m/s².
    pub peak_threshold: f64,
    /// How much stronger the main direction must be than any other, as a ratio.
    pub dominance: f64,
    /// How long to wait for a counter-stroke before calling it a swipe, in nanoseconds.
    pub confirm_ns: u64,
    /// After a swipe or a shake, ignore further movement for this long, in nanoseconds.
    pub lockout_ns: u64,
    pub crown: CrownSide,
}

impl Default for SwipeConfig {
    fn default() -> Self {
        Self {
            peak_threshold: 8.0,
            dominance: 1.5,
            confirm_ns: 250_000_000,
            lockout_ns: 700_000_000,
            crown: CrownSide::Right,
        }
    }
}

/// The strongest sample of one push.
#[derive(Debug, Clone, Copy)]
struct Lobe {
    /// Along the forearm, positive towards the hand.
    along: f64,
    /// Along world up.
    vertical: f64,
    strength: f64,
    finished_ns: u64,
}

fn norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// Turns `v` from the watch's frame into the world frame with the orientation `q = [w, x, y, z]`.
fn roll(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [w, x, y, z] = q;
    // v' = v + 2w(u x v) + 2 u x (u x v), with u = (x, y, z) for a unit quaternion.
    let t = [
        2.0 * (y * v[2] - z * v[1]),
        2.0 * (z * v[0] - x * v[2]),
        2.0 * (x * v[1] - y * v[0]),
    ];
    [
        v[0] + w * t[0] + (y * t[2] - z * t[1]),
        v[1] + w * t[1] + (z * t[0] - x * t[2]),
        v[2] + w * t[2] + (x * t[1] - y * t[0]),
    ]
}

#[derive(Debug)]
pub struct SwipeDetector {
    config: SwipeConfig,
    baseline: Option<[f64; 3]>,
    last_ns: u64,
    /// The strongest sample of the push in progress, while the signal is above the threshold.
    excursion: Option<Lobe>,
    /// A finished push waiting to see whether a counter-stroke makes it a shake.
    pending: Option<Lobe>,
    locked_until_ns: u64,
}

impl Default for SwipeDetector {
    fn default() -> Self {
        Self::new(SwipeConfig::default())
    }
}

impl SwipeDetector {
    pub fn new(config: SwipeConfig) -> Self {
        Self {
            config,
            baseline: None,
            last_ns: 0,
            excursion: None,
            pending: None,
            locked_until_ns: 0,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    fn classify(&self, lobe: Lobe) -> Option<SwipeDirection> {
        let along = lobe.along.abs();
        let vertical = lobe.vertical.abs();
        let main = along.max(vertical);
        // What is left of the push once its main direction is taken out: a clean swipe has little of it.
        let residual = (lobe.strength * lobe.strength - main * main)
            .max(0.0)
            .sqrt();
        if main < self.config.peak_threshold * 0.8 || main < self.config.dominance * residual {
            return None;
        }
        Some(if along >= vertical {
            // Positive along the watch's 3 o'clock axis is the wearer's right with the crown on the right.
            match (lobe.along > 0.0, self.config.crown) {
                (true, CrownSide::Right) | (false, CrownSide::Left) => SwipeDirection::Right,
                _ => SwipeDirection::Left,
            }
        } else if lobe.vertical > 0.0 {
            SwipeDirection::Up
        } else {
            SwipeDirection::Down
        })
    }

    /// Feeds one sample: acceleration in m/s² in the watch's frame, and the orientation `[w, x, y, z]`. Returns the
    /// direction once, when a swipe is recognised.
    pub fn observe(
        &mut self,
        at_ns: u64,
        acceleration: [f64; 3],
        orientation: [f64; 4],
    ) -> Option<SwipeDirection> {
        let q_norm = orientation.iter().map(|c| c * c).sum::<f64>().sqrt();
        if !acceleration.iter().all(|c| c.is_finite())
            || !orientation.iter().all(|c| c.is_finite())
            || q_norm < 1e-9
            || (self.baseline.is_some() && at_ns <= self.last_ns)
        {
            return None;
        }
        let Some(baseline) = self.baseline else {
            self.baseline = Some(acceleration);
            self.last_ns = at_ns;
            return None;
        };
        let dt = (at_ns - self.last_ns) as f64 / NS_PER_SECOND;
        self.last_ns = at_ns;
        let alpha = 1.0 - (-dt / 0.3).exp();
        let mut moving = [0.0; 3];
        let mut updated = baseline;
        for axis in 0..3 {
            moving[axis] = acceleration[axis] - baseline[axis];
            updated[axis] += alpha * moving[axis];
        }
        self.baseline = Some(updated);

        // A push that nothing opposed within the wait is a swipe.
        if let Some(pending) = self.pending
            && at_ns.saturating_sub(pending.finished_ns) >= self.config.confirm_ns
        {
            self.pending = None;
            self.locked_until_ns = at_ns + self.config.lockout_ns;
            return self.classify(pending);
        }

        let unit = orientation.map(|c| c / q_norm);
        let strength = norm(moving);
        let threshold = self.config.peak_threshold;
        let here = |finished_ns| Lobe {
            along: moving[0],
            vertical: roll(unit, moving)[2],
            strength,
            finished_ns,
        };
        match self.excursion {
            Some(best) => {
                if strength >= threshold {
                    if strength > best.strength {
                        self.excursion = Some(here(at_ns));
                    }
                } else if strength < threshold * 0.6 {
                    self.excursion = None;
                    self.finish(Lobe {
                        finished_ns: at_ns,
                        ..best
                    });
                }
            }
            None if strength >= threshold => self.excursion = Some(here(at_ns)),
            None => {}
        }
        None
    }

    fn finish(&mut self, lobe: Lobe) {
        if lobe.finished_ns < self.locked_until_ns {
            return;
        }
        match self.pending {
            Some(first) => {
                // A second push while the first waits. A similarly strong one back the other way is a shake.
                let opposite = first.along * lobe.along + first.vertical * lobe.vertical < 0.0;
                if opposite && lobe.strength >= 0.7 * first.strength {
                    self.pending = None;
                    self.locked_until_ns = lobe.finished_ns + self.config.lockout_ns;
                }
                // Otherwise it is the hand stopping, which is expected, and changes nothing.
            }
            None => {
                if self.classify(lobe).is_some() {
                    self.pending = Some(lobe);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;
    const IDENTITY: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

    /// A 50 Hz stream of gravity (on the watch's z axis) plus pushes `(start_ms, vector, ms_long)`.
    fn run(
        config: SwipeConfig,
        orientation: [f64; 4],
        pushes: &[(u64, [f64; 3], u64)],
        total_ms: u64,
    ) -> Vec<SwipeDirection> {
        let mut detector = SwipeDetector::new(config);
        let mut found = Vec::new();
        for ms in (0..=total_ms).step_by(20) {
            let mut a = [0.0, 0.0, 9.81];
            for &(start, push, length) in pushes {
                if ms >= start && ms < start + length {
                    for axis in 0..3 {
                        a[axis] += push[axis];
                    }
                }
            }
            found.extend(detector.observe(ms * MS, a, orientation));
        }
        found
    }

    fn swipe(push: [f64; 3]) -> Vec<(u64, [f64; 3], u64)> {
        // A strong push, then the hand stopping: weaker, the other way, 120 ms later.
        let stop = push.map(|c| -c * 0.4);
        vec![(1000, push, 60), (1120, stop, 60)]
    }

    #[test]
    fn a_push_along_the_forearm_is_a_left_or_right_swipe_depending_on_the_crown_side() {
        let toward_the_crown = [14.0, 0.0, 0.0];
        let left = SwipeConfig::default();
        let right = SwipeConfig {
            crown: CrownSide::Left,
            ..left
        };
        assert_eq!(
            run(left, IDENTITY, &swipe(toward_the_crown), 3000),
            vec![SwipeDirection::Right]
        );
        assert_eq!(
            run(right, IDENTITY, &swipe(toward_the_crown), 3000),
            vec![SwipeDirection::Left]
        );
        let away_from_the_crown = [-14.0, 0.0, 0.0];
        assert_eq!(
            run(left, IDENTITY, &swipe(away_from_the_crown), 3000),
            vec![SwipeDirection::Left]
        );
    }

    #[test]
    fn up_and_down_follow_gravity_whatever_way_the_watch_is_turned() {
        // Watch flat: its z axis is world up.
        assert_eq!(
            run(
                SwipeConfig::default(),
                IDENTITY,
                &swipe([0.0, 0.0, 14.0]),
                3000
            ),
            vec![SwipeDirection::Up]
        );
        assert_eq!(
            run(
                SwipeConfig::default(),
                IDENTITY,
                &swipe([0.0, 0.0, -14.0]),
                3000
            ),
            vec![SwipeDirection::Down]
        );
        // Watch turned 90 degrees about its x axis (screen facing the wearer): its y axis is now world up, so a
        // push along y is an upward swipe.
        let half = std::f64::consts::FRAC_PI_4;
        let turned = [half.cos(), half.sin(), 0.0, 0.0];
        assert_eq!(
            run(
                SwipeConfig::default(),
                turned,
                &swipe([0.0, 14.0, 0.0]),
                3000
            ),
            vec![SwipeDirection::Up]
        );
    }

    #[test]
    fn a_shake_is_not_a_run_of_swipes() {
        let strokes: Vec<_> = (0..6)
            .map(|i| {
                (
                    1000 + i * 160,
                    [if i % 2 == 0 { 14.0 } else { -14.0 }, 0.0, 0.0],
                    60,
                )
            })
            .collect();
        assert!(run(SwipeConfig::default(), IDENTITY, &strokes, 4000).is_empty());
    }

    #[test]
    fn weak_slow_or_ambiguous_movement_is_not_a_swipe() {
        let config = SwipeConfig::default();
        assert!(
            run(config, IDENTITY, &swipe([4.0, 0.0, 0.0]), 3000).is_empty(),
            "too weak"
        );
        // Mostly across the wrist, which is neither of the directions we read.
        assert!(
            run(config, IDENTITY, &swipe([3.0, 14.0, 0.0]), 3000).is_empty(),
            "sideways of the arm"
        );
        // Equal along and vertical: no clear direction.
        assert!(
            run(config, IDENTITY, &swipe([10.0, 0.0, 10.0]), 3000).is_empty(),
            "diagonal"
        );
    }

    #[test]
    fn one_swipe_is_reported_once_and_a_later_one_again() {
        let mut pushes = swipe([14.0, 0.0, 0.0]);
        pushes.extend(
            swipe([14.0, 0.0, 0.0])
                .into_iter()
                .map(|(t, v, l)| (t + 3000, v, l)),
        );
        assert_eq!(
            run(SwipeConfig::default(), IDENTITY, &pushes, 6000).len(),
            2
        );
    }

    #[test]
    fn garbage_samples_are_ignored() {
        let mut detector = SwipeDetector::default();
        assert_eq!(detector.observe(0, [f64::NAN, 0.0, 0.0], IDENTITY), None);
        assert_eq!(detector.observe(1, [0.0, 0.0, 9.81], [0.0; 4]), None);
        assert_eq!(detector.observe(2 * MS, [0.0, 0.0, 9.81], IDENTITY), None);
        assert_eq!(detector.observe(MS, [50.0, 0.0, 0.0], IDENTITY), None);
    }

    #[test]
    fn rotating_into_the_world_frame_matches_a_hand_calculation() {
        // 90 degrees about x takes the watch's y axis to world z and its z axis to world -y.
        let half = std::f64::consts::FRAC_PI_4;
        let r = roll([half.cos(), half.sin(), 0.0, 0.0], [0.0, 1.0, 0.0]);
        assert!(
            (r[0]).abs() < 1e-9 && (r[1]).abs() < 1e-9 && (r[2] - 1.0).abs() < 1e-9,
            "{r:?}"
        );
        let r = roll(IDENTITY, [1.0, 2.0, 3.0]);
        assert_eq!(r, [1.0, 2.0, 3.0]);
    }
}
