//! Spots a wiggle of the wrist: a quick twist back and forth about the forearm, like rattling a door knob.
//!
//! The signal is how fast the watch is turning about the forearm, worked out from its orientation. A wiggle is a run of
//! fast turns that keep changing direction, close together in time: the same shape a shake has in acceleration, so the
//! shake detector does the counting. One twist (a roll flick, or turning a dial) is not a wiggle, and a shake that
//! moves the arm without twisting it is not one either.

use crate::flick;
use crate::recipe::Axis;
use crate::shake::{ShakeConfig, ShakeDetector};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WiggleConfig {
    /// How fast the wrist must be turning at the top of each twist, in degrees a second.
    pub peak_rate: f64,
    /// Direction changes needed. Three reversals is four alternating twists.
    pub reversals: usize,
    /// All the reversals must fall within this long, in nanoseconds.
    pub window_ns: u64,
    /// After a wiggle, ignore further twisting for this long, in nanoseconds.
    pub lockout_ns: u64,
}

impl Default for WiggleConfig {
    fn default() -> Self {
        Self {
            peak_rate: 250.0,
            reversals: 3,
            window_ns: 1_200_000_000,
            lockout_ns: 1_000_000_000,
        }
    }
}

impl WiggleConfig {
    fn counting(&self) -> ShakeConfig {
        ShakeConfig {
            peak_threshold: self.peak_rate,
            reversals: self.reversals,
            window_ns: self.window_ns,
            lockout_ns: self.lockout_ns,
            ..ShakeConfig::default()
        }
    }
}

#[derive(Debug)]
pub struct WiggleDetector {
    config: WiggleConfig,
    counting: ShakeDetector,
    previous: Option<(u64, [f64; 4])>,
}

impl Default for WiggleDetector {
    fn default() -> Self {
        Self::new(WiggleConfig::default())
    }
}

impl WiggleDetector {
    pub fn new(config: WiggleConfig) -> Self {
        Self {
            config,
            counting: ShakeDetector::new(config.counting()),
            previous: None,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    /// Feeds one orientation `[w, x, y, z]`. Returns true once, as a wiggle is recognised.
    pub fn observe(&mut self, at_ns: u64, orientation: [f64; 4]) -> bool {
        let size = orientation.iter().map(|c| c * c).sum::<f64>().sqrt();
        if !orientation.iter().all(|c| c.is_finite()) || size < 1e-9 {
            return false;
        }
        let unit = orientation.map(|c| c / size);
        let Some((previous_ns, previous)) = self.previous else {
            self.previous = Some((at_ns, unit));
            return false;
        };
        if at_ns <= previous_ns {
            return false;
        }
        self.previous = Some((at_ns, unit));
        let (twist, _) = flick::step(previous, unit, Axis::Roll);
        let rate = twist / ((at_ns - previous_ns) as f64 / 1e9);
        self.counting.observe(at_ns, [rate, 0.0, 0.0])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    /// The orientation after rolling `degrees` about the forearm and `yaw` about the face normal.
    fn turned(degrees: f64, yaw: f64) -> [f64; 4] {
        let (r, y) = (degrees.to_radians() / 2.0, yaw.to_radians() / 2.0);
        // roll about x, then yaw about z
        [
            r.cos() * y.cos(),
            r.sin() * y.cos(),
            r.sin() * y.sin(),
            r.cos() * y.sin(),
        ]
    }

    /// A 100 Hz stream whose roll angle is `angle(ms)` degrees. Returns when wiggles were reported, in ms.
    fn run(angle: impl Fn(f64) -> f64, total_ms: u64) -> Vec<u64> {
        let mut detector = WiggleDetector::default();
        (0..=total_ms)
            .step_by(10)
            .filter(|&ms| detector.observe(ms * MS, turned(angle(ms as f64), 0.0)))
            .collect()
    }

    /// A sine of `amplitude` degrees at `hz` between `from` and `to` ms, flat otherwise.
    fn sine(amplitude: f64, hz: f64, from: f64, to: f64) -> impl Fn(f64) -> f64 {
        move |ms| {
            if ms < from || ms > to {
                0.0
            } else {
                amplitude * (std::f64::consts::TAU * hz * (ms - from) / 1000.0).sin()
            }
        }
    }

    #[test]
    fn a_quick_twist_back_and_forth_is_one_wiggle() {
        // 25 degrees each way, three and a half times a second: about 550 degrees a second at its fastest.
        let found = run(sine(25.0, 3.5, 1000.0, 2000.0), 4000);
        assert_eq!(found.len(), 1, "{found:?}");
    }

    #[test]
    fn a_single_twist_and_a_slow_turn_are_not_wiggles() {
        // One flick out and back.
        assert!(run(sine(40.0, 3.0, 1000.0, 1333.0), 3000).is_empty());
        // Turning a dial slowly back and forth: far, but never fast.
        assert!(run(sine(60.0, 0.4, 500.0, 6000.0), 7000).is_empty());
    }

    #[test]
    fn a_small_tremble_is_not_a_wiggle() {
        assert!(run(sine(4.0, 4.0, 1000.0, 3000.0), 4000).is_empty());
    }

    #[test]
    fn turning_about_another_axis_is_not_a_wiggle_and_garbage_is_ignored() {
        let mut detector = WiggleDetector::default();
        let yaw = sine(25.0, 3.5, 1000.0, 2000.0);
        let found = (0..=4000u64)
            .step_by(10)
            .filter(|&ms| detector.observe(ms * MS, turned(0.0, yaw(ms as f64))))
            .count();
        assert_eq!(found, 0);
        assert!(!detector.observe(5000 * MS, [f64::NAN, 0.0, 0.0, 0.0]));
        assert!(!detector.observe(5010 * MS, [0.0; 4]));
        assert!(!detector.observe(100 * MS, turned(90.0, 0.0)));
    }

    #[test]
    fn a_long_wiggle_is_reported_once() {
        let found = run(sine(25.0, 3.5, 1000.0, 3000.0), 3500);
        assert!(found.len() <= 2 && !found.is_empty(), "{found:?}");
        assert!(found.len() == 1 || found[1] - found[0] >= 1000, "{found:?}");
    }
}
