//! Whether the hand was still: a gesture may only *start* while it is (rule B0 of the double-pinch research).
//!
//! A pinch is a small, short jolt. While the arm moves or the wrist turns it is buried in larger motion, and the pulse
//! sensor's level shifts with the strap pressure the movement changes. So a start is only allowed when the watch was
//! steady for the second before it. Steady means all three of, over that window:
//!
//! * **acceleration spread**: the linear acceleration's spread about its own mean (each axis's standard deviation, as one
//!   magnitude) is at most [`MAX_ACCEL_SPREAD`];
//! * **turning**: the gyroscope's RMS is at most [`MAX_TURNING`];
//! * **tilt change**: world up moved at most [`MAX_TILT_DEG`] in the watch's axes between the window's first and last
//!   samples.
//!
//! None of these depends on how the arm is posed. The limits are the research's starting values: on the recorded pinches,
//! requiring them shut out most arm movement, wrist turning and typing while keeping the pinches made from a still hand.
//!
//! The window is measured back from the gesture's estimated start, on the watch's clock: a model decides some time after a
//! gesture begins (its decision delay, from its bundle), so the start is put that long before the decision, and the window
//! runs from [`WINDOW_FROM_NS`] to [`WINDOW_TO_NS`] before it. It so ends before the gesture's own movement whatever the
//! model's delay. Too few motion samples in it, or no decision time on the watch's clock, is **not** steady: the gate
//! fails closed.

use std::collections::VecDeque;

use spatial_protocol::WatchOrientationSample;

/// Largest acceleration spread over the window that still counts as still, in m/s².
pub const MAX_ACCEL_SPREAD: f64 = 0.4;
/// Largest gyroscope RMS over the window that still counts as still, in rad/s.
pub const MAX_TURNING: f64 = 0.5;
/// Largest change in tilt across the window that still counts as still, in degrees.
pub const MAX_TILT_DEG: f64 = 10.0;
/// The window starts this long before the gesture's estimated start...
pub const WINDOW_FROM_NS: u64 = 1_500_000_000;
/// ...and ends this long before it.
pub const WINDOW_TO_NS: u64 = 500_000_000;
/// The decision delay of a model whose bundle does not give one: the trainer's positive moment, 880 ms after a gesture's
/// labelled start (`ppg_onset.ONSET_DELAY_MS`).
pub const DEFAULT_DECISION_DELAY_MS: u32 = 880;
/// Fewer motion samples than this in the window and nothing can be said (25 Hz over the second).
const MIN_SAMPLES: usize = 25;
/// How much motion is kept: the window, and some slack for decisions made a little late.
const KEEP_NS: u64 = 4_000_000_000;

/// The three measures over a window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Measures {
    /// m/s².
    pub accel_spread: f64,
    /// rad/s.
    pub turning: f64,
    /// Degrees.
    pub tilt_change_deg: f64,
}

impl Measures {
    pub fn is_steady(&self) -> bool {
        self.accel_spread <= MAX_ACCEL_SPREAD
            && self.turning <= MAX_TURNING
            && self.tilt_change_deg <= MAX_TILT_DEG
    }
}

/// What the gate says about a moment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    Steady(Measures),
    Moving(Measures),
    /// Not enough motion to tell (none in the window, or no time on the watch's clock): treated as not steady.
    Unknown,
}

impl Verdict {
    pub fn is_steady(&self) -> bool {
        matches!(self, Self::Steady(_))
    }

    /// Why a start was withheld, in words for the detections list; `None` when it was steady.
    pub fn refusal(&self) -> Option<String> {
        match self {
            Self::Steady(_) => None,
            Self::Moving(m) => {
                let mut why = Vec::new();
                if m.accel_spread > MAX_ACCEL_SPREAD {
                    why.push(format!("moving ({:.2} m/s², at most {MAX_ACCEL_SPREAD})", m.accel_spread));
                }
                if m.turning > MAX_TURNING {
                    why.push(format!("turning ({:.2} rad/s, at most {MAX_TURNING})", m.turning));
                }
                if m.tilt_change_deg > MAX_TILT_DEG {
                    why.push(format!("tilting ({:.0}°, at most {MAX_TILT_DEG:.0}°)", m.tilt_change_deg));
                }
                Some(format!("the hand was not still before the gesture: {}", why.join(", ")))
            }
            Self::Unknown => Some("no motion data to tell whether the hand was still".into()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Motion {
    ts_ns: u64,
    accel: [f64; 3],
    gyro: [f64; 3],
    /// World up in the watch's axes, from the rotation vector.
    up: [f64; 3],
}

/// The recent motion, on the watch's clock.
#[derive(Debug, Default)]
pub struct Steadiness {
    motion: VecDeque<Motion>,
}

/// World up in the watch's axes, from a `[w, x, y, z]` rotation-vector quaternion (watch to world), or `None` if the
/// quaternion is not usable.
fn up_of(q: &[f64; 4]) -> Option<[f64; 3]> {
    let norm = q.iter().map(|c| c * c).sum::<f64>().sqrt();
    if !norm.is_finite() || norm < 0.5 {
        return None;
    }
    let [w, x, y, z] = q.map(|c| c / norm);
    Some([2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y)])
}

impl Steadiness {
    /// Keeps a motion sample that has an accelerometer, a gyroscope and a usable rotation vector, all finite. Samples must
    /// come in time order (the pipeline refuses any that do not, and the caller resets on a fault).
    pub fn observe(&mut self, sample: &WatchOrientationSample) {
        let (Some(accel), Some(gyro)) = (sample.accelerometer, sample.gyroscope) else {
            return;
        };
        if !accel.iter().chain(&gyro).all(|c| c.is_finite()) {
            return;
        }
        let Some(up) = up_of(&sample.quaternion) else {
            return;
        };
        if self.motion.back().is_some_and(|m| sample.timestamp_ns <= m.ts_ns) {
            return;
        }
        self.motion.push_back(Motion { ts_ns: sample.timestamp_ns, accel, gyro, up });
        let oldest = sample.timestamp_ns.saturating_sub(KEEP_NS);
        while self.motion.front().is_some_and(|m| m.ts_ns < oldest) {
            self.motion.pop_front();
        }
    }

    pub fn reset(&mut self) {
        self.motion.clear();
    }

    /// The measures over the motion from `from_ns` to `to_ns` (watch clock), or `None` with too few samples.
    pub fn measure(&self, from_ns: u64, to_ns: u64) -> Option<Measures> {
        let inside: Vec<&Motion> = self.motion.iter().filter(|m| m.ts_ns >= from_ns && m.ts_ns <= to_ns).collect();
        if inside.len() < MIN_SAMPLES {
            return None;
        }
        let n = inside.len() as f64;
        let mut spread = 0.0;
        for axis in 0..3 {
            let mean = inside.iter().map(|m| m.accel[axis]).sum::<f64>() / n;
            spread += inside.iter().map(|m| (m.accel[axis] - mean).powi(2)).sum::<f64>() / n;
        }
        let turning = (inside.iter().map(|m| m.gyro.iter().map(|g| g * g).sum::<f64>()).sum::<f64>() / n).sqrt();
        let (a, b) = (inside[0].up, inside[inside.len() - 1].up);
        let dot = a.iter().zip(&b).map(|(p, q)| p * q).sum::<f64>();
        let norms = a.iter().map(|c| c * c).sum::<f64>().sqrt() * b.iter().map(|c| c * c).sum::<f64>().sqrt();
        let tilt = (dot / norms).clamp(-1.0, 1.0).acos().to_degrees();
        Some(Measures { accel_spread: spread.sqrt(), turning, tilt_change_deg: tilt })
    }

    /// Whether a gesture decided at `decision_watch_ns`, by a model that decides `decision_delay_ms` after a gesture
    /// starts, may start: the window before the gesture's estimated start was steady.
    pub fn before(&self, decision_watch_ns: Option<u64>, decision_delay_ms: u32) -> Verdict {
        let Some(at) = decision_watch_ns else {
            return Verdict::Unknown;
        };
        let start = at.saturating_sub(u64::from(decision_delay_ms) * 1_000_000);
        self.verdict(start.saturating_sub(WINDOW_FROM_NS), start.saturating_sub(WINDOW_TO_NS))
    }

    /// The hand's state right now: the second of motion up to the newest sample (for display).
    pub fn now(&self) -> Verdict {
        let Some(newest) = self.motion.back() else {
            return Verdict::Unknown;
        };
        self.verdict(newest.ts_ns.saturating_sub(WINDOW_FROM_NS - WINDOW_TO_NS), newest.ts_ns)
    }

    fn verdict(&self, from_ns: u64, to_ns: u64) -> Verdict {
        match self.measure(from_ns, to_ns) {
            Some(m) if m.is_steady() => Verdict::Steady(m),
            Some(m) => Verdict::Moving(m),
            None => Verdict::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEVEL: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

    fn sample(i: u64, accel: [f64; 3], gyro: [f64; 3], quaternion: [f64; 4]) -> WatchOrientationSample {
        WatchOrientationSample {
            device_id: "w".into(),
            sequence: i,
            timestamp_ns: 10_000_000_000 + i * 10_000_000, // 100 Hz
            quaternion,
            accelerometer: Some(accel),
            gyroscope: Some(gyro),
        }
    }

    /// Two seconds at 100 Hz, from `make(i)`.
    fn feed(make: impl Fn(u64) -> WatchOrientationSample) -> Steadiness {
        let mut s = Steadiness::default();
        for i in 0..200 {
            s.observe(&make(i));
        }
        s
    }

    const END: u64 = 10_000_000_000 + 199 * 10_000_000;

    #[test]
    fn a_still_hand_with_small_tremor_is_steady() {
        let s = feed(|i| {
            let wobble = if i % 2 == 0 { 0.1 } else { -0.1 };
            sample(i, [wobble, 0.0, 0.05], [0.05, -0.05, 0.0], LEVEL)
        });
        let v = s.before(Some(END), 0);
        assert!(v.is_steady(), "{v:?}");
        assert_eq!(v.refusal(), None);
        assert!(s.now().is_steady());
    }

    #[test]
    fn a_moving_arm_a_turning_wrist_and_a_tilting_watch_are_each_not_steady() {
        // Arm swinging: acceleration swings by ±1.5 m/s².
        let moving = feed(|i| sample(i, [1.5 * ((i as f64) / 8.0).sin(), 0.0, 0.0], [0.0; 3], LEVEL));
        // Wrist turning at 1 rad/s.
        let turning = feed(|i| sample(i, [0.0; 3], [0.0, 0.0, 1.0], LEVEL));
        // The watch slowly tilting about x by 30° over the two seconds: little motion, but the pose changes.
        let tilting = feed(|i| {
            let half = (30f64.to_radians() * i as f64 / 200.0) / 2.0;
            sample(i, [0.0; 3], [0.0; 3], [half.cos(), half.sin(), 0.0, 0.0])
        });
        for (name, s, word) in [("moving", moving, "moving"), ("turning", turning, "turning"), ("tilting", tilting, "tilting")] {
            let v = s.before(Some(END), 0);
            assert!(matches!(v, Verdict::Moving(_)), "{name}: {v:?}");
            assert!(v.refusal().unwrap().contains(word), "{name}: {:?}", v.refusal());
        }
    }

    #[test]
    fn only_the_window_before_the_decision_counts_so_the_gesture_s_own_jolt_does_not() {
        // Still, then a sharp jolt in the last 0.3 s (the gesture itself): the window ends 0.5 s before the decision.
        let s = feed(|i| {
            let jolt = if i >= 170 { 3.0 } else { 0.0 };
            sample(i, [jolt, 0.0, 0.0], [jolt, 0.0, 0.0], LEVEL)
        });
        assert!(s.before(Some(END), 0).is_steady());
        assert!(!s.now().is_steady(), "the jolt is in the last second, so the hand is moving right now");
    }

    #[test]
    fn too_little_motion_or_no_watch_time_fails_closed() {
        let empty = Steadiness::default();
        assert_eq!(empty.before(Some(END), 0), Verdict::Unknown);
        assert_eq!(empty.now(), Verdict::Unknown);
        let s = feed(|i| sample(i, [0.0; 3], [0.0; 3], LEVEL));
        assert_eq!(s.before(None, 0), Verdict::Unknown);
        assert!(Verdict::Unknown.refusal().unwrap().contains("no motion data"));
        // A decision far later than the motion: nothing in its window.
        assert_eq!(s.before(Some(END + 10_000_000_000), 0), Verdict::Unknown);
    }

    #[test]
    fn samples_without_both_sensors_a_usable_quaternion_or_in_order_are_not_kept() {
        let mut s = Steadiness::default();
        let mut no_gyro = sample(0, [0.0; 3], [0.0; 3], LEVEL);
        no_gyro.gyroscope = None;
        s.observe(&no_gyro);
        s.observe(&sample(1, [f64::NAN, 0.0, 0.0], [0.0; 3], LEVEL));
        s.observe(&sample(2, [0.0; 3], [0.0; 3], [0.0; 4]));
        s.observe(&sample(5, [0.0; 3], [0.0; 3], LEVEL));
        s.observe(&sample(4, [0.0; 3], [0.0; 3], LEVEL)); // older than the last kept
        assert_eq!(s.motion.len(), 1);
    }

    #[test]
    fn the_window_sits_before_the_gesture_s_estimated_start_whatever_the_model_s_delay() {
        // Still, then the gesture's movement for the last 0.9 s: a model that decides 0.9 s after a gesture starts.
        let s = feed(|i| {
            let moving = if i >= 110 { 3.0 } else { 0.0 };
            sample(i, [moving, 0.0, 0.0], [moving, 0.0, 0.0], LEVEL)
        });
        assert!(s.before(Some(END), 900).is_steady(), "the second before the gesture was still");
        assert!(!s.before(Some(END), 0).is_steady(), "judged as a model with no delay, the gesture itself is in the window");
    }
}
