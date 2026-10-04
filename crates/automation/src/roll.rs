//! Spots a quick twist of the wrist about the forearm: turning a key, or flicking the hand over.
//!
//! This is the one-shot cousin of the continuous *roll* that drives a dial: the same movement about the same axis,
//! but quick and done once instead of followed. It is recognised from the watch's orientation alone: a twist of at
//! least a set angle within a short window, mostly about the forearm and not a general swing of the arm. A slow turn
//! (the dial gesture) takes too long to qualify, and the turn back that often follows a flick is ignored for a moment
//! so one flick fires once.
//!
//! Which way is "clockwise" is as the wearer would see it looking along their forearm from the elbow towards the
//! hand, the way you turn a screwdriver. The watch's 3 o'clock axis points towards the hand on a left wrist with the
//! crown on the right, and the other way if either the wrist or the crown side is the other, so both are settings.

use serde::{Deserialize, Serialize};

use crate::flick::{FlickConfig, FlickDetector};
use crate::recipe::Axis;
use crate::swipe::{CrownSide, Wrist};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RollDirection {
    Clockwise,
    CounterClockwise,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RollConfig {
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

impl Default for RollConfig {
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

#[derive(Debug)]
pub struct RollDetector {
    config: RollConfig,
    flick: FlickDetector,
}

impl Default for RollDetector {
    fn default() -> Self {
        Self::new(RollConfig::default())
    }
}

impl RollDetector {
    pub fn new(config: RollConfig) -> Self {
        Self {
            config,
            flick: FlickDetector::new(FlickConfig {
                axis: Axis::Roll,
                min_angle_degrees: config.min_angle_degrees,
                window_ns: config.window_ns,
                max_off_axis_ratio: config.max_off_axis_ratio,
                lockout_ns: config.lockout_ns,
            }),
        }
    }

    pub fn reset(&mut self) {
        self.flick.reset();
    }

    /// Feeds one orientation `[w, x, y, z]`. Returns the direction once, when a flick is recognised.
    pub fn observe(&mut self, at_ns: u64, orientation: [f64; 4]) -> Option<RollDirection> {
        let net = self.flick.observe(at_ns, orientation)?;
        // Positive twist about the watch's 3 o'clock axis is clockwise as the wearer looks along their forearm
        // when that axis points towards the hand, which is so for a left wrist with the crown on the right, and
        // for a right wrist with the crown on the left.
        let axis_toward_hand =
            (self.config.wrist == Wrist::Left) == (self.config.crown == CrownSide::Right);
        Some(if (net > 0.0) == axis_toward_hand {
            RollDirection::Clockwise
        } else {
            RollDirection::CounterClockwise
        })
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
        config: RollConfig,
        total_ms: u64,
        pose: impl Fn(u64) -> [f64; 4],
    ) -> Vec<(u64, RollDirection)> {
        let mut detector = RollDetector::new(config);
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
        let config = RollConfig::default();
        let cw = run(config, 4000, flick(90.0, false));
        assert_eq!(cw.len(), 1, "{cw:?}");
        assert_eq!(cw[0].1, RollDirection::Clockwise);
        let ccw = run(config, 4000, flick(-90.0, false));
        assert_eq!(
            ccw.iter().map(|(_, d)| *d).collect::<Vec<_>>(),
            vec![RollDirection::CounterClockwise]
        );
        // The same physical twist reads the other way round on the other wrist, or with the crown on the other
        // side, and the same again if both are the other way.
        let other_wrist = RollConfig {
            wrist: Wrist::Right,
            ..config
        };
        let other_crown = RollConfig {
            crown: CrownSide::Left,
            ..config
        };
        let both = RollConfig {
            wrist: Wrist::Right,
            crown: CrownSide::Left,
            ..config
        };
        let first = |c| run(c, 4000, flick(90.0, false))[0].1;
        assert_eq!(first(other_wrist), RollDirection::CounterClockwise);
        assert_eq!(first(other_crown), RollDirection::CounterClockwise);
        assert_eq!(first(both), RollDirection::Clockwise);
    }

    #[test]
    fn the_turn_back_after_a_flick_does_not_count_as_a_second_flick() {
        let found = run(RollConfig::default(), 4000, flick(90.0, true));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].1, RollDirection::Clockwise);
    }

    #[test]
    fn a_small_or_slow_turn_is_not_a_flick() {
        let config = RollConfig::default();
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
        assert!(run(RollConfig::default(), 4000, swing).is_empty());
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
        assert_eq!(run(RollConfig::default(), 5000, two).len(), 2);
        let gentle = RollConfig {
            min_angle_degrees: 30.0,
            ..RollConfig::default()
        };
        assert_eq!(run(gentle, 4000, flick(40.0, false)).len(), 1);
    }

    #[test]
    fn garbage_and_out_of_order_samples_are_ignored() {
        let mut detector = RollDetector::default();
        assert_eq!(detector.observe(0, [f64::NAN, 0.0, 0.0, 0.0]), None);
        assert_eq!(detector.observe(1, [0.0; 4]), None);
        assert_eq!(detector.observe(2 * MS, about_x(0.0)), None);
        assert_eq!(detector.observe(MS, about_x(170.0)), None);
    }
}
