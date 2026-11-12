//! Spots a hammer blow: the fist brought down on the other palm (or two hands clapped), felt as the moving arm stopping
//! dead.
//!
//! What separates it from everything else is its *shape*: the arm is already moving, then one very strong, very short
//! jolt as it stops, then stillness, because the hand is resting on what it hit. A tap on the watch is a weaker jolt on
//! a still arm. A shake is a run of jolts: each has another just before it or just after it. A swipe or reaching for
//! something stops gently, so its jolt is too weak or too long.
//!
//! It is reported once the stillness after the blow has lasted, so it arrives about a quarter of a second late.

const NS_PER_SECOND: f64 = 1e9;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HammerConfig {
    /// How far above the baseline the jolt of the stop must reach, in m/s².
    pub peak_threshold: f64,
    /// The jolt may last this long at most, in nanoseconds. A longer one is a push, not a blow.
    pub max_duration_ns: u64,
    /// The arm must have been moving at least this hard, in m/s²...
    pub lead_threshold: f64,
    /// ...at some moment within this long before the jolt, in nanoseconds.
    pub lead_ns: u64,
    /// After the jolt the arm must stay quiet (under half the threshold) for this long, in nanoseconds.
    pub settle_ns: u64,
    /// After a blow, ignore further movement for this long, in nanoseconds.
    pub lockout_ns: u64,
}

impl Default for HammerConfig {
    fn default() -> Self {
        Self {
            peak_threshold: 25.0,
            max_duration_ns: 80_000_000,
            lead_threshold: 3.0,
            lead_ns: 400_000_000,
            settle_ns: 250_000_000,
            lockout_ns: 600_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Phase {
    /// Waiting for a jolt.
    Watching,
    /// In a jolt that began at `started_ns`, after a lead-in or not.
    Jolt { started_ns: u64, led: bool },
    /// The jolt ended at `ended_ns`; waiting to see the arm stay quiet.
    Settling { ended_ns: u64 },
}

#[derive(Debug)]
pub struct HammerDetector {
    config: HammerConfig,
    baseline: Option<[f64; 3]>,
    last_ns: u64,
    /// The last time the arm was moving at least as hard as a lead-in, outside a jolt.
    last_lead_ns: Option<u64>,
    /// The last time anything half as strong as a blow happened: a blow has none in its lead-in.
    last_strong_ns: Option<u64>,
    phase: Phase,
    locked_until_ns: u64,
}

impl Default for HammerDetector {
    fn default() -> Self {
        Self::new(HammerConfig::default())
    }
}

impl HammerDetector {
    pub fn new(config: HammerConfig) -> Self {
        Self {
            config,
            baseline: None,
            last_ns: 0,
            last_lead_ns: None,
            last_strong_ns: None,
            phase: Phase::Watching,
            locked_until_ns: 0,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    /// Feeds one acceleration sample (m/s², any consistent frame). Returns true once, when a blow is certain.
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
        let strength =
            (moving[0] * moving[0] + moving[1] * moving[1] + moving[2] * moving[2]).sqrt();
        let threshold = self.config.peak_threshold;
        let within_lead = |then: Option<u64>| {
            then.is_some_and(|then| at_ns.saturating_sub(then) <= self.config.lead_ns)
        };
        let after_a_jolt = within_lead(self.last_strong_ns);
        if strength >= threshold * 0.5 {
            self.last_strong_ns = Some(at_ns);
        }

        match self.phase {
            Phase::Watching => {
                if strength >= threshold {
                    // Moving, but gently: another jolt just before it makes it a stroke of a shake.
                    let led = within_lead(self.last_lead_ns) && !after_a_jolt;
                    self.phase = Phase::Jolt {
                        started_ns: at_ns,
                        led,
                    };
                } else if strength >= self.config.lead_threshold {
                    self.last_lead_ns = Some(at_ns);
                }
            }
            Phase::Jolt { started_ns, led } => {
                if strength < threshold * 0.5 {
                    self.phase = if led && at_ns >= self.locked_until_ns {
                        Phase::Settling { ended_ns: at_ns }
                    } else {
                        Phase::Watching
                    };
                } else if at_ns.saturating_sub(started_ns) > self.config.max_duration_ns {
                    // A long push. What follows it is movement, not the lead-in to a blow of its own.
                    self.phase = Phase::Watching;
                    self.last_lead_ns = None;
                }
            }
            Phase::Settling { ended_ns } => {
                if strength >= threshold * 0.5 {
                    // Something strong followed: a shake, or the arm carrying on. Not a blow.
                    self.phase = Phase::Watching;
                    self.last_lead_ns = None;
                    self.locked_until_ns = at_ns + self.config.settle_ns;
                } else if at_ns.saturating_sub(ended_ns) >= self.config.settle_ns {
                    self.phase = Phase::Watching;
                    self.last_lead_ns = None;
                    self.locked_until_ns = at_ns + self.config.lockout_ns;
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    /// A 100 Hz stream of pushes `(start_ms, ms_long, strength)` along one axis. Returns when blows were reported, in ms.
    fn run(pushes: &[(u64, u64, f64)], total_ms: u64) -> Vec<u64> {
        let mut detector = HammerDetector::default();
        (0..=total_ms)
            .step_by(10)
            .filter(|&ms| {
                let a: f64 = pushes
                    .iter()
                    .filter(|&&(start, long, _)| ms >= start && ms < start + long)
                    .map(|&(_, _, strength)| strength)
                    .sum();
                detector.observe(ms * MS, [0.0, a, 0.0])
            })
            .collect()
    }

    /// The arm swinging down for 200 ms, then stopping dead at `at` ms.
    fn blow(at: u64) -> Vec<(u64, u64, f64)> {
        vec![(at - 200, 200, 6.0), (at, 30, -40.0)]
    }

    #[test]
    fn a_swing_that_stops_dead_is_a_blow_reported_after_the_stillness() {
        let found = run(&blow(1000), 3000);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!((1250..=1400).contains(&found[0]), "{found:?}");
    }

    #[test]
    fn a_jolt_on_a_still_arm_is_a_tap_not_a_blow() {
        assert!(run(&[(1000, 30, 40.0)], 3000).is_empty());
    }

    #[test]
    fn a_gentle_stop_a_long_push_and_a_weak_jolt_are_not_blows() {
        assert!(
            run(&[(800, 200, 6.0), (1000, 30, -12.0)], 3000).is_empty(),
            "too weak"
        );
        assert!(
            run(&[(800, 200, 6.0), (1000, 200, -40.0)], 3000).is_empty(),
            "too long"
        );
    }

    #[test]
    fn a_shake_is_not_a_run_of_blows() {
        let strokes: Vec<_> = (0..8)
            .map(|i| (1000 + i * 160, 60, if i % 2 == 0 { 30.0 } else { -30.0 }))
            .collect();
        assert!(run(&strokes, 4000).is_empty());
    }

    #[test]
    fn two_blows_are_two_and_garbage_is_ignored() {
        let mut both = blow(1000);
        both.extend(blow(2500));
        assert_eq!(run(&both, 4000).len(), 2);
        let mut detector = HammerDetector::default();
        assert!(!detector.observe(0, [f64::NAN, 0.0, 0.0]));
        assert!(!detector.observe(2 * MS, [0.0; 3]));
        assert!(!detector.observe(MS, [0.0, 90.0, 0.0]));
    }
}
