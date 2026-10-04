//! Spots a tap on the watch: a knock of a finger on the screen or case, felt as one brief sharp jolt.
//!
//! The watch reports acceleration at about 50 samples a second, so a tap is only a sample or two. What separates it
//! from everything else is its *shape*: very short, mostly along the screen's normal (a finger pressing the glass),
//! and arriving while the arm is otherwise still. A longer push is a swipe or part of a shake, a jolt sideways is
//! the arm bumping something, and a jolt in the middle of other movement is just that movement.
//!
//! A single tap is only reported once it is clear no second tap is coming, so it arrives a little late (about
//! 0.4 s). That is the price of being able to tell a tap from a double tap.

const NS_PER_SECOND: f64 = 1e9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TapKind {
    Single,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TapConfig {
    /// How far above the baseline the jolt must reach, in m/s².
    pub peak_threshold: f64,
    /// How much stronger the jolt must be along the screen's normal than across it, as a ratio.
    pub dominance: f64,
    /// The jolt may last this long at most, in nanoseconds. Anything longer is a push, not a tap.
    pub max_duration_ns: u64,
    /// The arm must have been quiet for this long before the jolt, in nanoseconds.
    pub quiet_ns: u64,
    /// Two taps closer than this are one (the same knock seen twice), in nanoseconds.
    pub min_gap_ns: u64,
    /// A second tap this soon makes a double tap; if none comes, the first is a single tap, in nanoseconds.
    pub double_window_ns: u64,
}

impl Default for TapConfig {
    fn default() -> Self {
        Self {
            peak_threshold: 12.0,
            dominance: 1.5,
            max_duration_ns: 60_000_000,
            quiet_ns: 150_000_000,
            min_gap_ns: 100_000_000,
            double_window_ns: 400_000_000,
        }
    }
}

/// The jolt in progress: the first sample above the threshold, and the strongest.
#[derive(Debug, Clone, Copy)]
struct Jolt {
    started_ns: u64,
    quiet_before_ns: u64,
    along_normal: f64,
    across: f64,
    strength: f64,
}

#[derive(Debug)]
pub struct TapDetector {
    config: TapConfig,
    baseline: Option<[f64; 3]>,
    last_ns: u64,
    /// The last time anything stirred (a sample above 40% of the threshold), outside the current jolt.
    last_stir_ns: Option<u64>,
    jolt: Option<Jolt>,
    /// A first tap waiting to see whether a second follows.
    first_tap_ns: Option<u64>,
}

impl Default for TapDetector {
    fn default() -> Self {
        Self::new(TapConfig::default())
    }
}

impl TapDetector {
    pub fn new(config: TapConfig) -> Self {
        Self {
            config,
            baseline: None,
            last_ns: 0,
            last_stir_ns: None,
            jolt: None,
            first_tap_ns: None,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    /// Feeds one acceleration sample in m/s² in the watch's frame (z out of the screen). Returns the kind of tap
    /// once, when it is certain.
    pub fn observe(&mut self, at_ns: u64, acceleration: [f64; 3]) -> Option<TapKind> {
        if !acceleration.iter().all(|c| c.is_finite())
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

        // A lone tap that nothing followed within the window is now certain.
        if let Some(first) = self.first_tap_ns
            && at_ns.saturating_sub(first) >= self.config.double_window_ns
        {
            self.first_tap_ns = None;
            return Some(TapKind::Single);
        }

        let strength =
            (moving[0] * moving[0] + moving[1] * moving[1] + moving[2] * moving[2]).sqrt();
        let threshold = self.config.peak_threshold;
        match self.jolt {
            Some(mut jolt) => {
                if strength >= threshold * 0.5 {
                    // Still going. A long one is not a tap: it stays above the limit until it ends.
                    if strength > jolt.strength {
                        jolt.strength = strength;
                        jolt.along_normal = moving[2].abs();
                        jolt.across = (moving[0] * moving[0] + moving[1] * moving[1]).sqrt();
                    }
                    self.jolt = Some(jolt);
                    if at_ns.saturating_sub(jolt.started_ns) > self.config.max_duration_ns {
                        self.jolt = None;
                        self.last_stir_ns = Some(at_ns);
                    }
                } else {
                    self.jolt = None;
                    self.last_stir_ns = Some(at_ns);
                    return self.finish(jolt);
                }
            }
            None => {
                if strength >= threshold {
                    self.jolt = Some(Jolt {
                        started_ns: at_ns,
                        quiet_before_ns: self
                            .last_stir_ns
                            .map_or(u64::MAX, |stirred| at_ns.saturating_sub(stirred)),
                        along_normal: moving[2].abs(),
                        across: (moving[0] * moving[0] + moving[1] * moving[1]).sqrt(),
                        strength,
                    });
                } else if strength >= threshold * 0.4 {
                    self.last_stir_ns = Some(at_ns);
                }
            }
        }
        None
    }

    fn finish(&mut self, jolt: Jolt) -> Option<TapKind> {
        let sharp = jolt.along_normal >= self.config.dominance * jolt.across;
        let still_before = jolt.quiet_before_ns >= self.config.quiet_ns;
        if !sharp || !still_before {
            return None;
        }
        match self.first_tap_ns {
            Some(first) => {
                let gap = jolt.started_ns.saturating_sub(first);
                if gap < self.config.min_gap_ns {
                    return None; // the same knock seen twice
                }
                self.first_tap_ns = None;
                Some(TapKind::Double)
            }
            None => {
                self.first_tap_ns = Some(jolt.started_ns);
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    /// A 50 Hz stream of gravity plus jolts `(start_ms, vector, ms_long)`. Returns `(time_ms, kind)` for each tap.
    fn run(jolts: &[(u64, [f64; 3], u64)], total_ms: u64) -> Vec<(u64, TapKind)> {
        let mut detector = TapDetector::default();
        let mut found = Vec::new();
        for ms in (0..=total_ms).step_by(20) {
            let mut a = [0.0, 0.0, 9.81];
            for &(start, jolt, length) in jolts {
                if ms >= start && ms < start + length {
                    for axis in 0..3 {
                        a[axis] += jolt[axis];
                    }
                }
            }
            if let Some(kind) = detector.observe(ms * MS, a) {
                found.push((ms, kind));
            }
        }
        found
    }

    const KNOCK: [f64; 3] = [1.0, 1.0, 20.0];

    #[test]
    fn one_knock_on_the_screen_is_a_single_tap_reported_after_the_double_tap_window() {
        let found = run(&[(1000, KNOCK, 20)], 3000);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].1, TapKind::Single);
        assert!(
            found[0].0 >= 1400,
            "reported at {} ms, before a second tap could still come",
            found[0].0
        );
    }

    #[test]
    fn two_knocks_close_together_are_a_double_tap_reported_at_once() {
        let found = run(&[(1000, KNOCK, 20), (1250, KNOCK, 20)], 3000);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].1, TapKind::Double);
        assert!(found[0].0 < 1500);
    }

    #[test]
    fn two_knocks_far_apart_are_two_single_taps() {
        let found = run(&[(1000, KNOCK, 20), (2000, KNOCK, 20)], 4000);
        assert_eq!(
            found.iter().map(|(_, k)| *k).collect::<Vec<_>>(),
            vec![TapKind::Single, TapKind::Single]
        );
    }

    #[test]
    fn a_long_push_a_sideways_jolt_and_a_weak_one_are_not_taps() {
        assert!(
            run(&[(1000, [0.0, 0.0, 20.0], 140)], 3000).is_empty(),
            "a long push is a swipe"
        );
        assert!(
            run(&[(1000, [20.0, 0.0, 2.0], 20)], 3000).is_empty(),
            "along the screen, not into it"
        );
        assert!(
            run(&[(1000, [0.0, 0.0, 6.0], 20)], 3000).is_empty(),
            "too weak"
        );
    }

    #[test]
    fn a_jolt_in_the_middle_of_other_movement_is_not_a_tap() {
        // A swirl of movement ends 60 ms before the jolt: the arm was not still.
        let stirring = (900, [5.0, 5.0, 3.0], 80);
        assert!(run(&[stirring, (1040, KNOCK, 20)], 3000).is_empty());
    }

    #[test]
    fn a_shake_is_not_a_run_of_taps() {
        let strokes: Vec<_> = (0..6)
            .map(|i| {
                (
                    1000 + i * 160,
                    [if i % 2 == 0 { 14.0 } else { -14.0 }, 0.0, 0.0],
                    60,
                )
            })
            .collect();
        assert!(run(&strokes, 4000).is_empty());
    }

    #[test]
    fn garbage_and_out_of_order_samples_are_ignored() {
        let mut detector = TapDetector::default();
        assert_eq!(detector.observe(0, [f64::NAN, 0.0, 0.0]), None);
        assert_eq!(detector.observe(2 * MS, [0.0, 0.0, 9.81]), None);
        assert_eq!(detector.observe(MS, [0.0, 0.0, 50.0]), None);
    }
}
