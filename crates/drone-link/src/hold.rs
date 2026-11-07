//! Works out how to push the sticks to bring the picture back to where it started.
//!
//! The picture sliding sideways steers aileron, and the picture growing or shrinking steers elevator. Sliding up and
//! down is left alone, because a tilt and a climb look the same and the drone holds its own height. Corrections are
//! small on purpose: this is a nudge against drift, and there is no attitude data to catch a mistake with. Which way
//! each correction should go has not been tested in flight, so both can be reversed.

use crate::frame::{NEUTRAL, Sticks};
use crate::vision::{Flow, MIN_CONFIDENCE};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoldConfig {
    /// Stick steps per pixel of sideways drift.
    pub drift_gain: f32,
    /// Stick steps per pixel of sideways movement in one frame, which damps the correction.
    pub damping_gain: f32,
    /// Stick steps per unit of added-up zoom.
    pub zoom_gain: f32,
    /// The most a correction can move a stick.
    pub max_correction: u8,
    pub reverse_aileron: bool,
    pub reverse_elevator: bool,
}

impl Default for HoldConfig {
    fn default() -> Self {
        Self {
            drift_gain: 0.5,
            damping_gain: 1.5,
            zoom_gain: 40.0,
            max_correction: 12,
            reverse_aileron: false,
            reverse_elevator: false,
        }
    }
}

/// A push away from centre, in stick steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Correction {
    pub aileron: i8,
    pub elevator: i8,
}

impl Correction {
    /// Adds this to `sticks`, no further from centre than `limit`.
    pub fn apply(self, sticks: Sticks, limit: u8) -> Sticks {
        let push = |value: u8, by: i8| {
            let low = i32::from(NEUTRAL) - i32::from(limit);
            let high = i32::from(NEUTRAL) + i32::from(limit);
            (i32::from(value) + i32::from(by)).clamp(low, high) as u8
        };
        Sticks {
            aileron: push(sticks.aileron, self.aileron),
            elevator: push(sticks.elevator, self.elevator),
            ..sticks
        }
    }
}

impl HoldConfig {
    /// The correction for this drift and latest movement, or `None` when the measure cannot be trusted.
    pub fn correct(&self, drift_x: f32, zoom_total: f32, flow: Flow) -> Option<Correction> {
        if flow.confidence < MIN_CONFIDENCE {
            return None;
        }
        let limit = f32::from(self.max_correction);
        let steps = |value: f32, reverse: bool| {
            let signed = if reverse { -value } else { value };
            signed.clamp(-limit, limit).round() as i8
        };
        // The picture sliding right means the drone slid left, so it needs pushing right.
        let aileron = self.drift_gain * drift_x + self.damping_gain * flow.dx;
        // The picture growing means the drone came forward, so it needs pulling back.
        let elevator = -self.zoom_gain * zoom_total;
        Some(Correction {
            aileron: steps(aileron, self.reverse_aileron),
            elevator: steps(elevator, self.reverse_elevator),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow(dx: f32, confidence: f32) -> Flow {
        Flow {
            dx,
            dy: 0.0,
            zoom: 0.0,
            confidence,
        }
    }

    #[test]
    fn no_drift_means_no_correction() {
        let correction = HoldConfig::default().correct(0.0, 0.0, flow(0.0, 0.5));
        assert_eq!(correction, Some(Correction::default()));
    }

    #[test]
    fn sideways_drift_pushes_aileron_the_opposite_way_to_the_drone() {
        let config = HoldConfig::default();
        assert_eq!(
            config.correct(10.0, 0.0, flow(0.0, 0.5)).unwrap().aileron,
            5
        );
        assert_eq!(
            config.correct(-10.0, 0.0, flow(0.0, 0.5)).unwrap().aileron,
            -5
        );
    }

    #[test]
    fn movement_adds_damping() {
        let config = HoldConfig::default();
        assert_eq!(config.correct(0.0, 0.0, flow(2.0, 0.5)).unwrap().aileron, 3);
        // Already coming back: the drift says push, the movement says ease off.
        assert_eq!(
            config.correct(10.0, 0.0, flow(-2.0, 0.5)).unwrap().aileron,
            2
        );
    }

    #[test]
    fn growing_picture_pulls_elevator_back() {
        let config = HoldConfig::default();
        assert_eq!(
            config.correct(0.0, 0.1, flow(0.0, 0.5)).unwrap().elevator,
            -4
        );
    }

    #[test]
    fn corrections_stay_small_however_large_the_drift() {
        let config = HoldConfig::default();
        let correction = config.correct(5000.0, -50.0, flow(90.0, 0.5)).unwrap();
        assert_eq!(correction.aileron, 12);
        assert_eq!(correction.elevator, 12);
    }

    #[test]
    fn an_untrusted_measure_gives_no_correction() {
        assert_eq!(
            HoldConfig::default().correct(50.0, 0.0, flow(5.0, 0.2)),
            None
        );
    }

    #[test]
    fn each_axis_can_be_reversed() {
        let config = HoldConfig {
            reverse_aileron: true,
            reverse_elevator: true,
            ..HoldConfig::default()
        };
        let correction = config.correct(10.0, 0.1, flow(0.0, 0.5)).unwrap();
        assert_eq!(correction.aileron, -5);
        assert_eq!(correction.elevator, 4);
    }

    #[test]
    fn a_correction_adds_to_the_sticks_within_the_limit() {
        let pushed = Correction {
            aileron: 12,
            elevator: -12,
        }
        .apply(
            Sticks {
                aileron: 0x80 + 30,
                ..Sticks::CENTRED
            },
            38,
        );
        assert_eq!(pushed.aileron, 0x80 + 38);
        assert_eq!(pushed.elevator, 0x80 - 12);
        assert_eq!(pushed.throttle, 0x80);
    }
}
