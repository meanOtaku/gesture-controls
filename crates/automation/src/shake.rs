//! Spots a shake in a stream of acceleration samples: a quick back-and-forth of the wrist.
//!
//! The signal is the acceleration with its slow-moving part (gravity, a held pose) taken out. A shake shows up as a
//! run of strong peaks that keep pointing in opposite directions, close together in time. One strong jolt, a steady
//! swing or a run of same-direction knocks (walking, typing) is not a shake.

use std::collections::VecDeque;

const NS_PER_SECOND: f64 = 1e9;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShakeConfig {
    /// How far above the baseline an acceleration must be to count as a peak, in m/s².
    pub peak_threshold: f64,
    /// Direction changes needed. Three reversals is four alternating strokes.
    pub reversals: usize,
    /// All the reversals must fall within this long, in nanoseconds.
    pub window_ns: u64,
    /// Peaks closer than this are one stroke, in nanoseconds.
    pub min_peak_gap_ns: u64,
    /// A pause longer than this between peaks starts the count again, in nanoseconds.
    pub max_peak_gap_ns: u64,
    /// After a shake, ignore further shaking for this long, in nanoseconds.
    pub lockout_ns: u64,
}

impl Default for ShakeConfig {
    fn default() -> Self {
        Self {
            peak_threshold: 6.0,
            reversals: 3,
            window_ns: 1_200_000_000,
            min_peak_gap_ns: 60_000_000,
            max_peak_gap_ns: 450_000_000,
            lockout_ns: 1_000_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Peak {
    direction: [f64; 3],
    at_ns: u64,
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

#[derive(Debug)]
pub struct ShakeDetector {
    config: ShakeConfig,
    /// The slow part of the signal: gravity and anything held steady.
    baseline: Option<[f64; 3]>,
    last_ns: u64,
    /// The strongest sample of the excursion in progress, if the signal is currently above the threshold.
    excursion: Option<(Peak, f64)>,
    last_peak: Option<Peak>,
    reversals: VecDeque<u64>,
    locked_until_ns: u64,
}

impl Default for ShakeDetector {
    fn default() -> Self {
        Self::new(ShakeConfig::default())
    }
}

impl ShakeDetector {
    pub fn new(config: ShakeConfig) -> Self {
        Self {
            config,
            baseline: None,
            last_ns: 0,
            excursion: None,
            last_peak: None,
            reversals: VecDeque::new(),
            locked_until_ns: 0,
        }
    }

    /// Forgets everything, when the watch went away or the stream was interrupted.
    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    /// Feeds one acceleration sample (m/s², any consistent frame). Returns true once, as a shake is recognised.
    pub fn observe(&mut self, at_ns: u64, acceleration: [f64; 3]) -> bool {
        if !acceleration.iter().all(|c| c.is_finite())
            || (self.baseline.is_some() && at_ns <= self.last_ns)
        {
            return false;
        }
        let Some(baseline) = self.baseline else {
            self.baseline = Some(acceleration);
            self.last_ns = at_ns;
            return false;
        };
        // A time constant of 0.3 s follows slow changes (turning the wrist to read the screen) but not a shake.
        let dt = (at_ns - self.last_ns) as f64 / NS_PER_SECOND;
        self.last_ns = at_ns;
        let alpha = 1.0 - (-dt / 0.3).exp();
        let mut updated = baseline;
        let mut moving = [0.0; 3];
        for axis in 0..3 {
            moving[axis] = acceleration[axis] - baseline[axis];
            updated[axis] += alpha * moving[axis];
        }
        self.baseline = Some(updated);

        let strength = norm(moving);
        let threshold = self.config.peak_threshold;
        match self.excursion {
            Some((peak, best)) => {
                if strength >= threshold {
                    if strength > best {
                        self.excursion = Some((
                            Peak {
                                direction: moving,
                                at_ns,
                            },
                            strength,
                        ));
                    }
                } else if strength < threshold * 0.6 {
                    self.excursion = None;
                    return self.finish_peak(peak);
                }
            }
            None if strength >= threshold => {
                self.excursion = Some((
                    Peak {
                        direction: moving,
                        at_ns,
                    },
                    strength,
                ));
            }
            None => {}
        }
        false
    }

    fn finish_peak(&mut self, peak: Peak) -> bool {
        if peak.at_ns < self.locked_until_ns {
            return false;
        }
        let Some(previous) = self.last_peak else {
            self.last_peak = Some(peak);
            return false;
        };
        let gap = peak.at_ns.saturating_sub(previous.at_ns);
        if gap < self.config.min_peak_gap_ns {
            return false; // the same stroke seen twice
        }
        if gap > self.config.max_peak_gap_ns || dot(previous.direction, peak.direction) >= 0.0 {
            // A pause, or another knock the same way: not a back-and-forth, so start counting afresh.
            self.reversals.clear();
        } else {
            self.reversals.push_back(peak.at_ns);
        }
        self.last_peak = Some(peak);
        while self
            .reversals
            .front()
            .is_some_and(|first| peak.at_ns.saturating_sub(*first) > self.config.window_ns)
        {
            self.reversals.pop_front();
        }
        if self.reversals.len() >= self.config.reversals {
            self.reversals.clear();
            self.last_peak = None;
            self.locked_until_ns = peak.at_ns + self.config.lockout_ns;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    /// Feeds a 50 Hz stream of gravity plus the given strokes. Each stroke is `(start_ms, direction, strength)` and
    /// lasts 60 ms. Returns the times, in ms, at which a shake was reported.
    fn run(strokes: &[(u64, f64, f64)], total_ms: u64) -> Vec<u64> {
        let mut detector = ShakeDetector::default();
        let mut detected = Vec::new();
        for ms in (0..=total_ms).step_by(20) {
            let mut a = [0.0, 0.0, 9.81];
            for &(start, direction, strength) in strokes {
                if ms >= start && ms < start + 60 {
                    a[0] += direction * strength;
                }
            }
            if detector.observe(ms * MS, a) {
                detected.push(ms);
            }
        }
        detected
    }

    fn alternating(count: usize, gap_ms: u64, strength: f64) -> Vec<(u64, f64, f64)> {
        (0..count)
            .map(|i| {
                (
                    1000 + i as u64 * gap_ms,
                    if i % 2 == 0 { 1.0 } else { -1.0 },
                    strength,
                )
            })
            .collect()
    }

    #[test]
    fn four_strong_alternating_strokes_are_a_shake() {
        let detected = run(&alternating(4, 160, 14.0), 3000);
        assert_eq!(detected.len(), 1, "{detected:?}");
    }

    #[test]
    fn a_single_jolt_is_not_a_shake() {
        assert!(run(&[(1000, 1.0, 20.0)], 3000).is_empty());
    }

    #[test]
    fn too_few_strokes_are_not_a_shake() {
        assert!(run(&alternating(3, 160, 14.0), 3000).is_empty());
    }

    #[test]
    fn knocks_all_the_same_way_are_not_a_shake() {
        let same: Vec<_> = (0..8).map(|i| (1000 + i * 160, 1.0, 14.0)).collect();
        assert!(run(&same, 4000).is_empty());
    }

    #[test]
    fn weak_movement_is_not_a_shake() {
        assert!(run(&alternating(8, 160, 3.0), 4000).is_empty());
    }

    #[test]
    fn slow_swings_are_not_a_shake() {
        // Strokes a second apart: each is a separate gesture, never a run.
        assert!(run(&alternating(6, 1000, 14.0), 9000).is_empty());
    }

    #[test]
    fn one_shake_is_reported_once_then_the_detector_waits_before_listening_again() {
        // A long burst of 12 strokes still reports a single shake, not several.
        let detected = run(&alternating(12, 160, 14.0), 4000);
        assert_eq!(detected.len(), 1, "{detected:?}");
        // After the lockout a second burst is a second shake.
        let mut both = alternating(4, 160, 14.0);
        both.extend(
            alternating(4, 160, 14.0)
                .into_iter()
                .map(|(t, d, s)| (t + 3000, d, s)),
        );
        assert_eq!(run(&both, 6000).len(), 2);
    }

    #[test]
    fn a_held_pose_and_gravity_do_not_register_and_garbage_is_ignored() {
        let mut detector = ShakeDetector::default();
        for ms in (0..3000).step_by(20) {
            assert!(!detector.observe(ms * MS, [0.0, 9.81, 0.0]));
        }
        assert!(!detector.observe(4000 * MS, [f64::NAN, 0.0, 0.0]));
        // An out-of-order sample is dropped rather than corrupting the baseline.
        assert!(!detector.observe(100 * MS, [50.0, 0.0, 0.0]));
    }
}
