//! Turns wrist tilt into stick positions while the watch button is held.
//!
//! Like the volume knob, this measures from where the wrist was when the hold began, so the hand can start in any
//! comfortable pose. Letting go centres the sticks. Only aileron and elevator move: height and heading are left to
//! the drone, which keeps a first flight simple. Which way each tilt moves the drone has not been tested yet.

use crate::frame::{NEUTRAL, Sticks};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SteeringConfig {
    /// Tilt smaller than this does nothing, so a resting hand does not steer.
    pub dead_zone_degrees: f64,
    /// Tilt at which the sticks reach `max_swing`.
    pub full_tilt_degrees: f64,
    /// How far a full tilt moves a stick from centre.
    pub max_swing: u8,
}

impl Default for SteeringConfig {
    fn default() -> Self {
        Self {
            dead_zone_degrees: 8.0,
            full_tilt_degrees: 35.0,
            max_swing: 38,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Steering {
    config: SteeringConfig,
    held: bool,
    reference: Option<[f64; 4]>,
}

impl Steering {
    pub fn new(config: SteeringConfig) -> Self {
        Self {
            config,
            held: false,
            reference: None,
        }
    }

    pub fn is_held(&self) -> bool {
        self.held
    }

    /// The hold starts from the next orientation seen, so a pose from before the press is never used.
    pub fn set_held(&mut self, held: bool) {
        self.held = held;
        self.reference = None;
    }

    /// The sticks for this orientation, a `[w, x, y, z]` quaternion. An unusable one ends the hold.
    pub fn observe(&mut self, orientation: [f64; 4]) -> Sticks {
        if !self.held {
            return Sticks::CENTRED;
        }
        let Some(orientation) = unit(orientation) else {
            self.set_held(false);
            return Sticks::CENTRED;
        };
        let reference = *self.reference.get_or_insert(orientation);
        let (roll, pitch) = tilt(reference, orientation);
        Sticks {
            aileron: self.stick(roll),
            elevator: self.stick(pitch),
            ..Sticks::CENTRED
        }
    }

    fn stick(&self, degrees: f64) -> u8 {
        let SteeringConfig {
            dead_zone_degrees,
            full_tilt_degrees,
            max_swing,
        } = self.config;
        let beyond = (degrees.abs() - dead_zone_degrees).max(0.0);
        let span = (full_tilt_degrees - dead_zone_degrees).max(f64::EPSILON);
        let swing = (beyond / span).min(1.0) * f64::from(max_swing);
        (f64::from(NEUTRAL) + swing.copysign(degrees))
            .round()
            .clamp(0.0, 255.0) as u8
    }
}

fn unit(q: [f64; 4]) -> Option<[f64; 4]> {
    let norm = q.iter().map(|c| c * c).sum::<f64>().sqrt();
    (q.iter().all(|c| c.is_finite()) && norm > 1e-9).then(|| q.map(|c| c / norm))
}

/// Rotation from `start` to `current` about the watch body's x and y axes, in degrees.
fn tilt(start: [f64; 4], current: [f64; 4]) -> (f64, f64) {
    let [sw, si, sj, sk] = start;
    let [cw, ci, cj, ck] = current;
    let w = sw * cw + si * ci + sj * cj + sk * ck;
    let i = sw * ci - si * cw - sj * ck + sk * cj;
    let j = sw * cj + si * ck - sj * cw - sk * ci;
    let degrees = |part: f64| {
        let angle = (2.0 * part.atan2(w)).to_degrees();
        (angle + 540.0).rem_euclid(360.0) - 180.0
    };
    (degrees(i), degrees(j))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEVEL: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

    fn about_x(degrees: f64) -> [f64; 4] {
        let half = degrees.to_radians() / 2.0;
        [half.cos(), half.sin(), 0.0, 0.0]
    }

    fn about_y(degrees: f64) -> [f64; 4] {
        let half = degrees.to_radians() / 2.0;
        [half.cos(), 0.0, half.sin(), 0.0]
    }

    fn held() -> Steering {
        let mut steering = Steering::default();
        steering.set_held(true);
        steering.observe(LEVEL);
        steering
    }

    #[test]
    fn nothing_moves_unless_held() {
        let mut steering = Steering::default();
        assert_eq!(steering.observe(about_x(60.0)), Sticks::CENTRED);
    }

    #[test]
    fn the_pose_at_the_start_of_the_hold_is_centre() {
        let mut steering = Steering::default();
        steering.set_held(true);
        assert_eq!(steering.observe(about_x(70.0)), Sticks::CENTRED);
        assert_eq!(steering.observe(about_x(70.0)), Sticks::CENTRED);
        assert_eq!(steering.observe(about_x(105.0)).aileron, 0x80 + 38);
    }

    #[test]
    fn a_small_tilt_does_nothing() {
        let mut steering = held();
        assert_eq!(steering.observe(about_x(8.0)), Sticks::CENTRED);
        assert_eq!(steering.observe(about_y(-8.0)), Sticks::CENTRED);
    }

    #[test]
    fn roll_drives_aileron_and_pitch_drives_elevator_only() {
        let mut steering = held();
        let rolled = steering.observe(about_x(35.0));
        assert_eq!(rolled.aileron, 0x80 + 38);
        assert_eq!(rolled.elevator, 0x80);
        let pitched = steering.observe(about_y(-35.0));
        assert_eq!(pitched.elevator, 0x80 - 38);
        assert_eq!(pitched.aileron, 0x80);
        assert_eq!(pitched.throttle, 0x80);
        assert_eq!(pitched.rudder, 0x80);
    }

    #[test]
    fn tilt_scales_up_to_the_limit_and_stops_there() {
        let mut steering = held();
        let halfway = steering.observe(about_x(21.5)).aileron;
        assert_eq!(halfway, 0x80 + 19);
        assert_eq!(steering.observe(about_x(120.0)).aileron, 0x80 + 38);
    }

    #[test]
    fn letting_go_centres_and_the_next_hold_starts_again() {
        let mut steering = held();
        assert_ne!(steering.observe(about_x(30.0)), Sticks::CENTRED);
        steering.set_held(false);
        assert_eq!(steering.observe(about_x(30.0)), Sticks::CENTRED);
        steering.set_held(true);
        assert_eq!(steering.observe(about_x(30.0)), Sticks::CENTRED);
    }

    #[test]
    fn an_unusable_orientation_ends_the_hold() {
        let mut steering = held();
        assert_eq!(steering.observe([f64::NAN, 0.0, 0.0, 0.0]), Sticks::CENTRED);
        assert!(!steering.is_held());
        assert_eq!(steering.observe(about_x(30.0)), Sticks::CENTRED);
    }

    #[test]
    fn a_flipped_quaternion_is_the_same_pose() {
        let mut steering = held();
        let flipped = about_x(35.0).map(|c| -c);
        assert_eq!(steering.observe(flipped).aileron, 0x80 + 38);
    }
}
