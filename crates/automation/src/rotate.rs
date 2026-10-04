//! Spots a quick twist of the wrist about the forearm: turning a key, or flicking the hand over.
//!
//! This is the one-shot cousin of the continuous *roll* that drives a dial. It is recognised from the watch's
//! orientation alone: a twist of at least a set angle within a short window, mostly about the forearm and not a
//! general swing of the arm. A slow turn (the dial gesture) takes too long to qualify, and the turn back that often
//! follows a flick is ignored for a moment so one flick fires once.
//!
//! Which way is "clockwise" is as the wearer would see it looking along their forearm from the elbow towards the
//! hand, the way you turn a screwdriver. The watch's 3 o'clock axis points towards the hand on a left wrist with the
//! crown on the right, and the other way if either the wrist or the crown side is the other, so both are settings.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::swipe::{CrownSide, Wrist};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RotateDirection {
    Clockwise,
    CounterClockwise,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RotateConfig {
    /// How far the wrist must turn, in degrees.
    pub min_angle_degrees: f64,
    /// ...within this long, in nanoseconds.
    pub window_ns: u64,
    /// How much of the movement must be about the forearm: the off-axis swing may be at most this fraction of the
    /// twist.
    pub max_off_axis_ratio: f64,
    /// After a flick, ignore further turning for this long (the turn back, mostly), in nanoseconds.
    pub lockout_ns: u64,
    pub wrist: Wrist,
    pub crown: CrownSide,
}

impl Default for RotateConfig {
    fn default() -> Self {
        Self {
            min_angle_degrees: 60.0,
            window_ns: 600_000_000,
            max_off_axis_ratio: 0.5,
            lockout_ns: 800_000_000,
            wrist: Wrist::Left,
            crown: CrownSide::Right,
        }
    }
}

/// One step's rotation: its part about the forearm (x) and the rest, in degrees.
fn step(previous: [f64; 4], current: [f64; 4]) -> (f64, f64) {
    // relative = conjugate(previous) * current
    let [pw, pi, pj, pk] = previous;
    let [cw, ci, cj, ck] = current;
    let w = pw * cw + pi * ci + pj * cj + pk * ck;
    let i = pw * ci - pi * cw - pj * ck + pk * cj;
    let j = pw * cj + pi * ck - pj * cw - pk * ci;
    let k = pw * ck - pi * cj + pj * ci - pk * cw;
    let wrap = |degrees: f64| (degrees + 540.0).rem_euclid(360.0) - 180.0;
    let twist = wrap(2.0 * i.atan2(w).to_degrees());
    let total = wrap(2.0 * (j * j + k * k + i * i).sqrt().atan2(w.abs()).to_degrees()).abs();
    let off_axis = (total * total - twist * twist).max(0.0).sqrt();
    (twist, off_axis)
}

#[derive(Debug)]
pub struct RotateDetector {
    config: RotateConfig,
    previous: Option<(u64, [f64; 4])>,
    /// `(time, cumulative twist, cumulative off-axis movement)` over the recent window.
    history: VecDeque<(u64, f64, f64)>,
    twist: f64,
    off_axis: f64,
    locked_until_ns: u64,
}

impl Default for RotateDetector {
    fn default() -> Self {
        Self::new(RotateConfig::default())
    }
}

impl RotateDetector {
    pub fn new(config: RotateConfig) -> Self {
        Self {
            config,
            previous: None,
            history: VecDeque::new(),
            twist: 0.0,
            off_axis: 0.0,
            locked_until_ns: 0,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    /// Feeds one orientation `[w, x, y, z]`. Returns the direction once, when a flick is recognised.
    pub fn observe(&mut self, at_ns: u64, orientation: [f64; 4]) -> Option<RotateDirection> {
        let norm = orientation.iter().map(|c| c * c).sum::<f64>().sqrt();
        if !orientation.iter().all(|c| c.is_finite()) || norm < 1e-9 {
            return None;
        }
        let unit = orientation.map(|c| c / norm);
        let Some((previous_ns, previous)) = self.previous else {
            self.previous = Some((at_ns, unit));
            self.history.push_back((at_ns, 0.0, 0.0));
            return None;
        };
        if at_ns <= previous_ns {
            return None;
        }
        let (twist, off_axis) = step(previous, unit);
        self.previous = Some((at_ns, unit));
        self.twist += twist;
        self.off_axis += off_axis;
        self.history.push_back((at_ns, self.twist, self.off_axis));
        while self
            .history
            .front()
            .is_some_and(|(then, ..)| at_ns.saturating_sub(*then) > self.config.window_ns)
        {
            self.history.pop_front();
        }
        if at_ns < self.locked_until_ns {
            // Turning while locked out (the hand coming back) must not be counted once the lockout ends.
            self.history.clear();
            self.history.push_back((at_ns, self.twist, self.off_axis));
            return None;
        }
        // The biggest net turn from any moment in the window to now.
        let (start_twist, start_off_axis) =
            self.history
                .iter()
                .map(|&(_, t, o)| (t, o))
                .max_by(|a, b| {
                    (self.twist - a.0)
                        .abs()
                        .total_cmp(&(self.twist - b.0).abs())
                })?;
        let net = self.twist - start_twist;
        let off = self.off_axis - start_off_axis;
        if net.abs() >= self.config.min_angle_degrees
            && off <= self.config.max_off_axis_ratio * net.abs()
        {
            self.history.clear();
            self.history.push_back((at_ns, self.twist, self.off_axis));
            self.locked_until_ns = at_ns + self.config.lockout_ns;
            // Positive twist about the watch's 3 o'clock axis is clockwise as the wearer looks along their forearm
            // when that axis points towards the hand, which is so for a left wrist with the crown on the right, and
            // for a right wrist with the crown on the left.
            let axis_toward_hand =
                (self.config.wrist == Wrist::Left) == (self.config.crown == CrownSide::Right);
            let clockwise = (net > 0.0) == axis_toward_hand;
            return Some(if clockwise {
                RotateDirection::Clockwise
            } else {
                RotateDirection::CounterClockwise
            });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    fn about_x(degrees: f64) -> [f64; 4] {
        let half = degrees.to_radians() / 2.0;
        [half.cos(), half.sin(), 0.0, 0.0]
    }

    fn about_y(degrees: f64) -> [f64; 4] {
        let half = degrees.to_radians() / 2.0;
        [half.cos(), 0.0, half.sin(), 0.0]
    }

    /// 50 Hz stream where `angle_at(ms)` gives the roll in degrees; returns what was recognised and when.
    fn run(
        config: RotateConfig,
        total_ms: u64,
        pose: impl Fn(u64) -> [f64; 4],
    ) -> Vec<(u64, RotateDirection)> {
        let mut detector = RotateDetector::new(config);
        let mut found = Vec::new();
        for ms in (0..=total_ms).step_by(20) {
            if let Some(direction) = detector.observe(ms * MS, pose(ms)) {
                found.push((ms, direction));
            }
        }
        found
    }

    /// A flick: rolls `degrees` over 300 ms starting at 1 s, holds, then (optionally) rolls back from 1.5 s.
    fn flick(degrees: f64, back: bool) -> impl Fn(u64) -> [f64; 4] {
        move |ms| {
            let angle = match ms {
                0..1000 => 0.0,
                1000..1300 => degrees * (ms - 1000) as f64 / 300.0,
                1300..1500 => degrees,
                1500..2000 if !back => degrees,
                1500..1800 if back => degrees * (1.0 - (ms - 1500) as f64 / 300.0),
                _ => {
                    if back {
                        0.0
                    } else {
                        degrees
                    }
                }
            };
            about_x(angle)
        }
    }

    #[test]
    fn a_quick_twist_one_way_is_a_clockwise_or_counter_clockwise_flick() {
        let config = RotateConfig::default();
        let cw = run(config, 4000, flick(90.0, false));
        assert_eq!(cw.len(), 1, "{cw:?}");
        assert_eq!(cw[0].1, RotateDirection::Clockwise);
        let ccw = run(config, 4000, flick(-90.0, false));
        assert_eq!(
            ccw.iter().map(|(_, d)| *d).collect::<Vec<_>>(),
            vec![RotateDirection::CounterClockwise]
        );
        // The same physical twist reads the other way round on the other wrist, or with the crown on the other
        // side, and the same again if both are the other way.
        let other_wrist = RotateConfig {
            wrist: Wrist::Right,
            ..config
        };
        let other_crown = RotateConfig {
            crown: CrownSide::Left,
            ..config
        };
        let both = RotateConfig {
            wrist: Wrist::Right,
            crown: CrownSide::Left,
            ..config
        };
        let first = |c| run(c, 4000, flick(90.0, false))[0].1;
        assert_eq!(first(other_wrist), RotateDirection::CounterClockwise);
        assert_eq!(first(other_crown), RotateDirection::CounterClockwise);
        assert_eq!(first(both), RotateDirection::Clockwise);
    }

    #[test]
    fn the_turn_back_after_a_flick_does_not_count_as_a_second_flick() {
        let found = run(RotateConfig::default(), 4000, flick(90.0, true));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].1, RotateDirection::Clockwise);
    }

    #[test]
    fn a_small_or_slow_turn_is_not_a_flick() {
        let config = RotateConfig::default();
        assert!(
            run(config, 4000, flick(40.0, false)).is_empty(),
            "too small"
        );
        // 90 degrees spread over 3 seconds is the dial gesture, not a flick.
        let slow = |ms: u64| about_x(90.0 * (ms.min(3000) as f64) / 3000.0);
        assert!(run(config, 4000, slow).is_empty());
    }

    #[test]
    fn swinging_the_arm_is_not_a_twist_of_the_wrist() {
        // The same 90 degrees, but about the y axis: the arm swinging, not the forearm turning.
        let swing = |ms: u64| about_y(90.0 * ((ms.clamp(1000, 1300) - 1000) as f64) / 300.0);
        assert!(run(RotateConfig::default(), 4000, swing).is_empty());
    }

    #[test]
    fn a_second_flick_later_is_recognised_and_a_smaller_angle_setting_catches_gentle_ones() {
        let two = |ms: u64| {
            about_x(match ms {
                0..1000 => 0.0,
                1000..1300 => 90.0 * (ms - 1000) as f64 / 300.0,
                1300..3000 => 90.0,
                3000..3300 => 90.0 + 90.0 * (ms - 3000) as f64 / 300.0,
                _ => 180.0,
            })
        };
        assert_eq!(run(RotateConfig::default(), 5000, two).len(), 2);
        let gentle = RotateConfig {
            min_angle_degrees: 30.0,
            ..RotateConfig::default()
        };
        assert_eq!(run(gentle, 4000, flick(40.0, false)).len(), 1);
    }

    #[test]
    fn garbage_and_out_of_order_samples_are_ignored() {
        let mut detector = RotateDetector::default();
        assert_eq!(detector.observe(0, [f64::NAN, 0.0, 0.0, 0.0]), None);
        assert_eq!(detector.observe(1, [0.0; 4]), None);
        assert_eq!(detector.observe(2 * MS, about_x(0.0)), None);
        assert_eq!(detector.observe(MS, about_x(170.0)), None);
    }
}
