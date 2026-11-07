//! Decides what may be sent to the drone, whatever its callers ask for.
//!
//! The drone never confirms anything, so this cannot know whether it is flying. It holds to rules that are safe
//! either way: only an armed pilot can start or steer it, sticks are limited, and a caller that goes quiet is treated
//! as lost. Time is passed in, so all of it can be tested without waiting.

use std::time::{Duration, Instant};

use thiserror::Error;

use crate::frame::{Button, Control, NEUTRAL, Sticks};
use crate::frame::{FLAG_HEADLESS, FLAG_RETURN};
use crate::hold::Correction;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PilotConfig {
    /// How far aileron, elevator and rudder may leave centre. The app's default speed reaches about 38.
    pub stick_limit: u8,
    /// How far throttle may leave centre. It climbs and descends, so it is held back while we learn the drone.
    pub throttle_limit: u8,
    /// Sticks older than this are centred.
    pub stale_after: Duration,
    /// With no sticks for this long the pilot presses Down and disarms.
    pub land_after: Duration,
    /// How long Up and Down are held, as the app does.
    pub press_hold: Duration,
    /// How long Stop is held, as the app does.
    pub stop_hold: Duration,
    /// Return is sent for at most this long, as the drone has no way to know it is home and may keep going.
    pub return_limit: Duration,
    /// A hold correction older than this is dropped, so a stalled picture cannot leave a push in place.
    pub correction_stale_after: Duration,
}

impl Default for PilotConfig {
    fn default() -> Self {
        Self {
            stick_limit: 38,
            throttle_limit: 64,
            stale_after: Duration::from_millis(200),
            land_after: Duration::from_secs(1),
            press_hold: Duration::from_millis(1100),
            stop_hold: Duration::from_millis(500),
            return_limit: Duration::from_secs(10),
            correction_stale_after: Duration::from_millis(300),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PilotError {
    #[error("the drone is not armed")]
    NotArmed,
    #[error("calibrating needs the drone on the ground, so land first")]
    Armed,
    #[error("already taken off: land first")]
    AlreadyFlying,
    #[error("another button is still being held")]
    Busy,
    #[error("the drone has not taken off")]
    NotFlying,
}

#[derive(Debug, Clone, Copy)]
struct Press {
    button: Button,
    until: Instant,
}

#[derive(Debug)]
pub struct Pilot {
    config: PilotConfig,
    armed: bool,
    failsafe: bool,
    sticks: Sticks,
    sticks_at: Instant,
    press: Option<Press>,
    hold_enabled: bool,
    correction: Option<(Correction, Instant)>,
    /// Up has been pressed since the last landing. The drone never says it is flying, so this is the nearest guess.
    took_off: bool,
    took_off_at: Option<Instant>,
    headless: bool,
    /// Return is being sent until then.
    returning_until: Option<Instant>,
}

impl Pilot {
    pub fn new(config: PilotConfig, now: Instant) -> Self {
        Self {
            config,
            armed: false,
            failsafe: false,
            sticks: Sticks::CENTRED,
            sticks_at: now,
            press: None,
            hold_enabled: false,
            correction: None,
            took_off: false,
            took_off_at: None,
            headless: false,
            returning_until: None,
        }
    }

    /// Turns headless mode on or off. It is sent only while armed, and lasts until turned off or Stop.
    pub fn set_headless(&mut self, enabled: bool) {
        self.headless = enabled;
    }

    pub fn is_headless(&self) -> bool {
        self.headless
    }

    /// Starts the one-key return, which also ends hold, as the two would fight. Only while flying, and only for
    /// `return_limit`; Down, Stop, landing by the failsafe and `cancel_return` all end it sooner.
    pub fn start_return(&mut self, now: Instant) -> Result<(), PilotError> {
        self.release_if_due(now);
        if !self.armed {
            return Err(PilotError::NotArmed);
        }
        if !self.took_off {
            return Err(PilotError::NotFlying);
        }
        if self.holding(Button::Down) || self.holding(Button::Stop) {
            return Err(PilotError::Busy);
        }
        self.hold_enabled = false;
        self.correction = None;
        self.returning_until = Some(now + self.config.return_limit);
        Ok(())
    }

    pub fn cancel_return(&mut self) {
        self.returning_until = None;
    }

    pub fn is_returning(&self, now: Instant) -> bool {
        self.returning_until.is_some_and(|until| now < until) && self.armed
    }

    /// How long since Up was pressed, while the drone is taken to be flying.
    pub fn airborne_for(&self, now: Instant) -> Option<Duration> {
        self.took_off_at
            .filter(|_| self.took_off && self.armed)
            .map(|at| now.saturating_duration_since(at))
    }

    /// True from Up until Down, Stop or disarming.
    pub fn has_taken_off(&self) -> bool {
        self.took_off
    }

    pub fn is_holding(&self) -> bool {
        self.hold_enabled
    }

    /// Lets camera corrections reach the sticks. Ignored unless armed, and off again at every disarm.
    pub fn set_hold(&mut self, enabled: bool) {
        self.hold_enabled = enabled && self.armed;
        self.correction = None;
        if self.hold_enabled {
            self.returning_until = None;
        }
    }

    /// The newest correction from the camera, or `None` when the picture cannot be trusted.
    pub fn set_correction(&mut self, correction: Option<Correction>, now: Instant) {
        self.correction = correction.map(|correction| (correction, now));
    }

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// True once input went quiet and the pilot landed by itself, until the next arm.
    pub fn failsafe_tripped(&self) -> bool {
        self.failsafe
    }

    /// True while a button is being held down.
    pub fn is_busy(&self) -> bool {
        self.press.is_some()
    }

    /// Allows the drone to be started and steered. From here on the caller must keep sending sticks.
    pub fn arm(&mut self, now: Instant) {
        self.armed = true;
        self.took_off = false;
        self.failsafe = false;
        self.sticks = Sticks::CENTRED;
        self.sticks_at = now;
    }

    /// Ends the session by pressing Down. Does nothing when already disarmed.
    pub fn disarm(&mut self, now: Instant) {
        self.hold_enabled = false;
        self.took_off = false;
        self.returning_until = None;
        if self.armed {
            self.armed = false;
            self.hold(Button::Down, now);
        }
    }

    /// Presses Stop, whatever else is going on.
    pub fn stop(&mut self, now: Instant) {
        self.armed = false;
        self.hold_enabled = false;
        self.took_off = false;
        self.headless = false;
        self.returning_until = None;
        self.hold(Button::Stop, now);
    }

    pub fn press(&mut self, button: Button, now: Instant) -> Result<(), PilotError> {
        self.release_if_due(now);
        match button {
            Button::Stop => {
                self.stop(now);
                return Ok(());
            }
            Button::Down => {
                if self.holding(Button::Stop) {
                    return Err(PilotError::Busy);
                }
                self.took_off = false;
                self.returning_until = None;
            }
            Button::Up => {
                if !self.armed {
                    return Err(PilotError::NotArmed);
                }
                // What Up does in the air is unknown, so it is never sent twice in one flight.
                if self.took_off {
                    return Err(PilotError::AlreadyFlying);
                }
                if self.press.is_some() {
                    return Err(PilotError::Busy);
                }
                self.took_off = true;
                self.took_off_at = Some(now);
            }
            // The drone never says whether it is flying, and armed is the nearest thing to knowing.
            Button::GyroCheck => {
                if self.armed {
                    return Err(PilotError::Armed);
                }
                if self.press.is_some() {
                    return Err(PilotError::Busy);
                }
            }
        }
        self.hold(button, now);
        Ok(())
    }

    /// New stick positions. Ignored unless armed.
    pub fn set_sticks(&mut self, sticks: Sticks, now: Instant) {
        if self.armed {
            self.sticks = sticks;
            self.sticks_at = now;
        }
    }

    /// What to send right now.
    pub fn tick(&mut self, now: Instant) -> Control {
        self.release_if_due(now);
        let quiet = now.saturating_duration_since(self.sticks_at);
        if self.armed && quiet >= self.config.land_after {
            self.failsafe = true;
            self.disarm(now);
        }
        let steering = self.armed
            && quiet < self.config.stale_after
            && !self.holding(Button::Down)
            && !self.holding(Button::Stop);
        let sticks = if steering {
            self.corrected(self.limited(self.sticks), now)
        } else {
            Sticks::CENTRED
        };
        let mut control = match self.press {
            Some(press) => Control::pressing(sticks, press.button),
            None => Control {
                sticks,
                ..Control::IDLE
            },
        };
        if self.armed && self.headless {
            control.flags |= FLAG_HEADLESS;
        }
        if self.is_returning(now) {
            control.flags |= FLAG_RETURN;
        } else {
            self.returning_until = None;
        }
        control
    }

    fn corrected(&self, sticks: Sticks, now: Instant) -> Sticks {
        let fresh = self.correction.filter(|(_, at)| {
            now.saturating_duration_since(*at) < self.config.correction_stale_after
        });
        match fresh {
            Some((correction, _)) if self.hold_enabled => {
                correction.apply(sticks, self.config.stick_limit)
            }
            _ => sticks,
        }
    }

    fn hold(&mut self, button: Button, now: Instant) {
        let hold = match button {
            Button::Stop => self.config.stop_hold,
            _ => self.config.press_hold,
        };
        self.press = Some(Press {
            button,
            until: now + hold,
        });
    }

    fn holding(&self, button: Button) -> bool {
        self.press.is_some_and(|press| press.button == button)
    }

    fn release_if_due(&mut self, now: Instant) {
        if self.press.is_some_and(|press| now >= press.until) {
            self.press = None;
        }
    }

    fn limited(&self, sticks: Sticks) -> Sticks {
        let limit =
            |value: u8, by: u8| value.clamp(NEUTRAL.saturating_sub(by), NEUTRAL.saturating_add(by));
        Sticks {
            aileron: limit(sticks.aileron, self.config.stick_limit),
            elevator: limit(sticks.elevator, self.config.stick_limit),
            throttle: limit(sticks.throttle, self.config.throttle_limit),
            rudder: limit(sticks.rudder, self.config.stick_limit),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UP: u8 = 0x41;
    const DOWN: u8 = 0x42;
    const STOP: u8 = 0x44;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    fn pilot() -> (Pilot, Instant) {
        let start = Instant::now();
        (Pilot::new(PilotConfig::default(), start), start)
    }

    fn pushed(value: u8) -> Sticks {
        Sticks {
            aileron: value,
            elevator: value,
            throttle: value,
            rudder: value,
        }
    }

    const HEADLESS: u8 = 0x50;
    const RETURNING: u8 = 0x60;

    #[test]
    fn headless_is_sent_in_every_frame_while_armed_and_on() {
        let (mut pilot, start) = pilot();
        pilot.set_headless(true);
        assert_eq!(pilot.tick(start).flags, 0x40, "not armed yet");
        pilot.arm(start);
        assert_eq!(pilot.tick(start).flags, HEADLESS);
        pilot.press(Button::Up, start).unwrap();
        assert_eq!(pilot.tick(start + ms(10)).flags, UP | 0x10);
        pilot.set_headless(false);
        assert_eq!(pilot.tick(start + ms(20)).flags, UP);
    }

    #[test]
    fn stop_turns_headless_off() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_headless(true);
        pilot.stop(start);
        pilot.arm(start + ms(600));
        assert_eq!(pilot.tick(start + ms(600)).flags, 0x40);
    }

    #[test]
    fn return_needs_a_takeoff_and_ends_by_itself() {
        let (mut pilot, start) = pilot();
        assert_eq!(pilot.start_return(start), Err(PilotError::NotArmed));
        pilot.arm(start);
        assert_eq!(pilot.start_return(start), Err(PilotError::NotFlying));
        pilot.press(Button::Up, start).unwrap();
        pilot.start_return(start + ms(1200)).unwrap();
        pilot.set_sticks(Sticks::CENTRED, start + ms(1200));
        assert_eq!(pilot.tick(start + ms(1300)).flags, RETURNING);
        assert!(pilot.is_returning(start + ms(1300)));
        let limit = PilotConfig::default().return_limit;
        for at in (1300..(1200 + limit.as_millis() as u64)).step_by(100) {
            pilot.set_sticks(Sticks::CENTRED, start + ms(at));
        }
        let after = start + ms(1200) + limit;
        pilot.set_sticks(Sticks::CENTRED, after);
        assert_eq!(pilot.tick(after).flags, 0x40);
        assert!(!pilot.is_returning(after));
    }

    #[test]
    fn landing_stop_and_hold_each_end_return() {
        for end in 0..4 {
            let (mut pilot, start) = pilot();
            pilot.arm(start);
            pilot.press(Button::Up, start).unwrap();
            let now = start + ms(1200);
            pilot.set_sticks(Sticks::CENTRED, now);
            pilot.start_return(now).unwrap();
            match end {
                0 => pilot.press(Button::Down, now).unwrap(),
                1 => pilot.stop(now),
                2 => pilot.set_hold(true),
                _ => pilot.cancel_return(),
            }
            assert!(!pilot.is_returning(now), "case {end}");
            assert_eq!(pilot.tick(now).flags & 0x20, 0, "case {end}");
        }
    }

    #[test]
    fn return_turns_hold_off_and_is_refused_during_a_landing() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Up, start).unwrap();
        pilot.set_hold(true);
        let now = start + ms(1200);
        pilot.start_return(now).unwrap();
        assert!(!pilot.is_holding());
        pilot.press(Button::Down, now).unwrap();
        pilot.arm(now);
        pilot.press(Button::Up, now + ms(1200)).unwrap();
        pilot.press(Button::Down, now + ms(2400)).unwrap();
        assert!(pilot.start_return(now + ms(2500)).is_err());
    }

    #[test]
    fn nothing_moves_before_arming() {
        let (mut pilot, start) = pilot();
        pilot.set_sticks(pushed(0xFF), start);
        assert_eq!(pilot.press(Button::Up, start), Err(PilotError::NotArmed));
        assert_eq!(pilot.tick(start + ms(10)), Control::IDLE);
    }

    #[test]
    fn up_is_held_then_released() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Up, start).unwrap();
        pilot.set_sticks(Sticks::CENTRED, start + ms(1000));
        assert_eq!(pilot.tick(start + ms(1000)).flags, UP);
        pilot.set_sticks(Sticks::CENTRED, start + ms(1100));
        assert_eq!(pilot.tick(start + ms(1100)), Control::IDLE);
    }

    #[test]
    fn a_second_press_waits_for_the_first() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Up, start).unwrap();
        assert_eq!(
            pilot.press(Button::Up, start),
            Err(PilotError::AlreadyFlying)
        );
    }

    #[test]
    fn down_and_stop_interrupt_up() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Up, start).unwrap();
        pilot.press(Button::Down, start + ms(100)).unwrap();
        assert_eq!(pilot.tick(start + ms(100)).flags, DOWN);
        pilot.press(Button::Stop, start + ms(200)).unwrap();
        assert_eq!(pilot.tick(start + ms(200)).flags, STOP);
        assert!(!pilot.is_armed());
    }

    #[test]
    fn stop_cannot_be_cut_short_by_down() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Stop, start).unwrap();
        assert_eq!(pilot.press(Button::Down, start), Err(PilotError::Busy));
        assert_eq!(pilot.tick(start + ms(100)).flags, STOP);
        assert_eq!(pilot.tick(start + ms(500)), Control::IDLE);
    }

    #[test]
    fn stop_and_down_work_when_disarmed() {
        let (mut pilot, start) = pilot();
        pilot.press(Button::Down, start).unwrap();
        assert_eq!(pilot.tick(start).flags, DOWN);
        pilot.press(Button::Stop, start).unwrap();
        assert_eq!(pilot.tick(start).flags, STOP);
    }

    #[test]
    fn sticks_are_limited() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_sticks(pushed(0xFF), start);
        let high = pilot.tick(start).sticks;
        assert_eq!(high.aileron, 0x80 + 38);
        assert_eq!(high.elevator, 0x80 + 38);
        assert_eq!(high.rudder, 0x80 + 38);
        assert_eq!(high.throttle, 0x80 + 64);
        pilot.set_sticks(pushed(0x00), start);
        let low = pilot.tick(start).sticks;
        assert_eq!(low.aileron, 0x80 - 38);
        assert_eq!(low.throttle, 0x80 - 64);
    }

    #[test]
    fn quiet_input_centres_the_sticks_but_stays_armed() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_sticks(pushed(0xFF), start);
        assert_ne!(pilot.tick(start + ms(199)).sticks, Sticks::CENTRED);
        assert_eq!(pilot.tick(start + ms(200)).sticks, Sticks::CENTRED);
        assert!(pilot.is_armed());
    }

    #[test]
    fn longer_quiet_lands_and_disarms() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_sticks(pushed(0xFF), start);
        assert_eq!(pilot.tick(start + ms(1000)).flags, DOWN);
        assert!(!pilot.is_armed());
        assert!(pilot.failsafe_tripped());
        assert_eq!(pilot.tick(start + ms(2100)), Control::IDLE);
    }

    #[test]
    fn sticks_cannot_steer_a_landing() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Down, start).unwrap();
        pilot.set_sticks(pushed(0xFF), start);
        assert_eq!(pilot.tick(start).sticks, Sticks::CENTRED);
    }

    #[test]
    fn arming_again_clears_the_failsafe_and_old_sticks() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_sticks(pushed(0xFF), start);
        pilot.tick(start + ms(1000));
        let later = start + ms(3000);
        pilot.arm(later);
        assert!(!pilot.failsafe_tripped());
        assert_eq!(pilot.tick(later), Control::IDLE);
    }

    #[test]
    fn take_off_is_refused_once_flying_until_landed() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Up, start).unwrap();
        assert!(pilot.has_taken_off());
        let later = start + ms(2000);
        pilot.set_sticks(Sticks::CENTRED, later);
        assert_eq!(
            pilot.press(Button::Up, later),
            Err(PilotError::AlreadyFlying)
        );
        pilot.press(Button::Down, later).unwrap();
        assert!(!pilot.has_taken_off());
        let landed = later + ms(1200);
        pilot.set_sticks(Sticks::CENTRED, landed);
        pilot.press(Button::Up, landed).unwrap();
    }

    #[test]
    fn time_in_the_air_counts_from_take_off_until_landing() {
        let (mut pilot, start) = pilot();
        assert_eq!(pilot.airborne_for(start), None);
        pilot.arm(start);
        pilot.press(Button::Up, start).unwrap();
        assert_eq!(pilot.airborne_for(start + ms(3000)), Some(ms(3000)));
        pilot.disarm(start + ms(4000));
        assert_eq!(pilot.airborne_for(start + ms(4000)), None);
    }

    #[test]
    fn stop_and_rearming_also_count_as_landed() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.press(Button::Up, start).unwrap();
        pilot.stop(start + ms(100));
        assert!(!pilot.has_taken_off());
        pilot.arm(start + ms(700));
        assert!(!pilot.has_taken_off());
    }

    #[test]
    fn gyro_calibration_runs_only_on_the_ground() {
        let (mut pilot, start) = pilot();
        pilot.press(Button::GyroCheck, start).unwrap();
        assert_eq!(pilot.tick(start).flags, 0xC0);
        assert_eq!(pilot.tick(start).sticks, Sticks::CENTRED);
        assert_eq!(pilot.tick(start + ms(1100)), Control::IDLE);
        pilot.arm(start + ms(1100));
        assert_eq!(
            pilot.press(Button::GyroCheck, start + ms(1100)),
            Err(PilotError::Armed)
        );
    }

    #[test]
    fn gyro_calibration_cannot_interrupt_a_landing() {
        let (mut pilot, start) = pilot();
        pilot.press(Button::Down, start).unwrap();
        assert_eq!(pilot.press(Button::GyroCheck, start), Err(PilotError::Busy));
    }

    fn push() -> Correction {
        Correction {
            aileron: 10,
            elevator: -5,
        }
    }

    fn pushed_sticks() -> Sticks {
        Sticks {
            aileron: 0x80 + 10,
            elevator: 0x80 - 5,
            ..Sticks::CENTRED
        }
    }

    #[test]
    fn corrections_do_nothing_until_hold_is_on() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_correction(Some(push()), start);
        assert_eq!(pilot.tick(start), Control::IDLE);
        pilot.set_hold(true);
        pilot.set_correction(Some(push()), start);
        assert_eq!(pilot.tick(start).sticks, pushed_sticks());
    }

    #[test]
    fn hold_cannot_start_unarmed() {
        let (mut pilot, start) = pilot();
        pilot.set_hold(true);
        assert!(!pilot.is_holding());
        pilot.set_correction(Some(push()), start);
        assert_eq!(pilot.tick(start), Control::IDLE);
    }

    #[test]
    fn a_stale_or_untrusted_correction_is_dropped() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_hold(true);
        pilot.set_correction(Some(push()), start);
        pilot.set_sticks(Sticks::CENTRED, start + ms(300));
        assert_eq!(pilot.tick(start + ms(300)), Control::IDLE);
        pilot.set_correction(Some(push()), start + ms(300));
        pilot.set_correction(None, start + ms(310));
        assert_eq!(pilot.tick(start + ms(310)), Control::IDLE);
    }

    #[test]
    fn hold_does_not_keep_the_link_alive() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_hold(true);
        pilot.set_correction(Some(push()), start + ms(999));
        assert_eq!(pilot.tick(start + ms(1000)).flags, DOWN);
        assert!(!pilot.is_holding());
    }

    #[test]
    fn landing_and_stop_turn_hold_off_and_cannot_be_steered() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.set_hold(true);
        pilot.set_correction(Some(push()), start);
        pilot.press(Button::Down, start).unwrap();
        assert_eq!(pilot.tick(start).sticks, Sticks::CENTRED);
        pilot.stop(start);
        assert!(!pilot.is_holding());
    }

    #[test]
    fn disarm_presses_down_only_once() {
        let (mut pilot, start) = pilot();
        pilot.arm(start);
        pilot.disarm(start);
        assert_eq!(pilot.tick(start).flags, DOWN);
        pilot.disarm(start + ms(2000));
        assert_eq!(pilot.tick(start + ms(2000)), Control::IDLE);
    }
}
