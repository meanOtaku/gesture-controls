//! Spots a quick tilt of the hand up or down at the wrist: a nod of the hand, like a "stop" sign or a wave.
//!
//! It is the same kind of one-shot movement as a roll, but about the watch's 12-6 axis, which runs across the wrist,
//! so it is read from the orientation alone and rejects slow tilts (the dial gesture) and swings of the whole arm.
//!
//! Which way is "up" is the hand rising, and which way the watch's axis turns for that depends on whether its 3
//! o'clock side points towards the hand or the elbow, which the wrist and crown settings decide.

use serde::{Deserialize, Serialize};

use crate::flick::{FlickConfig, FlickDetector};
use crate::recipe::Axis;
use crate::swipe::{CrownSide, Wrist};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PitchDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchConfig {
    /// How far the hand must tilt, in degrees. Smaller than a roll: the wrist bends less than it twists.
    pub min_angle_degrees: f64,
    pub window_ns: u64,
    pub max_off_axis_ratio: f64,
    pub lockout_ns: u64,
    pub wrist: Wrist,
    pub crown: CrownSide,
}

impl Default for PitchConfig {
    fn default() -> Self {
        Self {
            min_angle_degrees: 40.0,
            window_ns: 600_000_000,
            max_off_axis_ratio: 0.5,
            lockout_ns: 800_000_000,
            wrist: Wrist::Left,
            crown: CrownSide::Right,
        }
    }
}

#[derive(Debug)]
pub struct PitchDetector {
    config: PitchConfig,
    flick: FlickDetector,
}

impl Default for PitchDetector {
    fn default() -> Self {
        Self::new(PitchConfig::default())
    }
}

impl PitchDetector {
    pub fn new(config: PitchConfig) -> Self {
        Self {
            config,
            flick: FlickDetector::new(FlickConfig {
                axis: Axis::Pitch,
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

    /// Feeds one orientation `[w, x, y, z]`. Returns the direction once, when a tilt is recognised.
    pub fn observe(&mut self, at_ns: u64, orientation: [f64; 4]) -> Option<PitchDirection> {
        let net = self.flick.observe(at_ns, orientation)?;
        // A positive turn about the 12-6 axis lowers the 3 o'clock side. When that side points towards the hand the
        // hand goes down; when it points towards the elbow the hand goes up.
        let axis_toward_hand =
            (self.config.wrist == Wrist::Left) == (self.config.crown == CrownSide::Right);
        Some(if (net > 0.0) == axis_toward_hand {
            PitchDirection::Down
        } else {
            PitchDirection::Up
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    fn about(axis: Axis, degrees: f64) -> [f64; 4] {
        let half = degrees.to_radians() / 2.0;
        match axis {
            Axis::Roll => [half.cos(), half.sin(), 0.0, 0.0],
            Axis::Pitch => [half.cos(), 0.0, half.sin(), 0.0],
            Axis::Yaw => [half.cos(), 0.0, 0.0, half.sin()],
        }
    }

    /// 50 Hz stream: a turn of `degrees` about `axis` over 300 ms from 1 s, held; optionally back from 1.5 s.
    fn run(config: PitchConfig, axis: Axis, degrees: f64, back: bool) -> Vec<PitchDirection> {
        let mut detector = PitchDetector::new(config);
        let mut found = Vec::new();
        for ms in (0..=4000u64).step_by(20) {
            let angle = match ms {
                0..1000 => 0.0,
                1000..1300 => degrees * (ms - 1000) as f64 / 300.0,
                1300..1500 => degrees,
                1500..1800 if back => degrees * (1.0 - (ms - 1500) as f64 / 300.0),
                1500..2000 if !back => degrees,
                _ if back => 0.0,
                _ => degrees,
            };
            found.extend(detector.observe(ms * MS, about(axis, angle)));
        }
        found
    }

    #[test]
    fn a_quick_tilt_about_the_cross_wrist_axis_is_a_pitch_up_or_down() {
        let config = PitchConfig::default();
        // Default: left wrist, crown on the right, so the watch's 3 o'clock side is towards the hand.
        assert_eq!(
            run(config, Axis::Pitch, 60.0, false),
            vec![PitchDirection::Down]
        );
        assert_eq!(
            run(config, Axis::Pitch, -60.0, false),
            vec![PitchDirection::Up]
        );
    }

    #[test]
    fn the_wrist_and_crown_settings_flip_which_way_is_up() {
        let flip = |wrist, crown| {
            run(
                PitchConfig {
                    wrist,
                    crown,
                    ..PitchConfig::default()
                },
                Axis::Pitch,
                60.0,
                false,
            )
        };
        assert_eq!(
            flip(Wrist::Left, CrownSide::Right),
            vec![PitchDirection::Down]
        );
        assert_eq!(
            flip(Wrist::Right, CrownSide::Right),
            vec![PitchDirection::Up]
        );
        assert_eq!(flip(Wrist::Left, CrownSide::Left), vec![PitchDirection::Up]);
        assert_eq!(
            flip(Wrist::Right, CrownSide::Left),
            vec![PitchDirection::Down]
        );
    }

    #[test]
    fn the_tilt_back_is_ignored_and_a_twist_or_swing_the_other_way_is_not_a_pitch() {
        let config = PitchConfig::default();
        assert_eq!(run(config, Axis::Pitch, 60.0, true).len(), 1);
        assert!(
            run(config, Axis::Roll, 90.0, false).is_empty(),
            "a twist about the forearm is a roll"
        );
        assert!(
            run(config, Axis::Yaw, 90.0, false).is_empty(),
            "a swing of the arm"
        );
    }

    #[test]
    fn a_small_tilt_is_not_a_pitch_until_the_angle_setting_allows_it() {
        let config = PitchConfig::default();
        assert!(run(config, Axis::Pitch, 25.0, false).is_empty());
        let gentle = PitchConfig {
            min_angle_degrees: 20.0,
            ..config
        };
        assert_eq!(run(gentle, Axis::Pitch, 25.0, false).len(), 1);
    }
}
