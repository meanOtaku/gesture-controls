//! Holds the drone where it is, using nothing but the picture.
//!
//! Which way a stick moves the picture, and how far, depends on the drone and on how far away the scene is, so neither
//! is assumed. When hold starts, the autopilot gives each axis one small push and watches what the picture does. That
//! measures the direction and strength for this flight, and a PID loop scaled by the result then keeps the picture
//! where it was. If an axis does not respond clearly, or the picture is lost, hold gives up and centres the sticks.
//!
//! The drone's own IMU does the fast work: it keeps the drone level and at height many times a second, and the app
//! cannot read it. So this is a slow, gentle outer loop that only leans against drift, and a measurement saved from one
//! flight can start hold straight after the next takeoff, without the test pushes.
//!
//! The picture sliding sideways steers aileron, and the picture growing or shrinking steers elevator. Sliding up and
//! down is left alone, because a tilt and a climb look the same, and the drone holds its own height. Everything here
//! is pure: time is passed in, so a simulated flight can run it in tests.

use std::time::{Duration, Instant};

use crate::frame::{NEUTRAL, Sticks};
use crate::vision::{Flow, MIN_CONFIDENCE};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoldConfig {
    /// The most a correction can move a stick, in steps.
    pub max_correction: u8,
    /// The stick steps of a calibration push, and the scale for the gains below.
    pub push: i8,
    /// Gains, relative to one calibration push: an error as large as the push's response asks for `proportional` pushes.
    pub proportional: f32,
    /// As `proportional`, per second of rate of change, which damps the correction.
    pub derivative: f32,
    /// As `proportional`, per second of error held, which cancels a steady lean.
    pub integral: f32,
    /// The most the integral can ask for, in pushes.
    pub integral_limit: f32,
    /// Waiting before and after a push.
    pub settle: Duration,
    /// How long a push lasts, and then the same again the other way to stop.
    pub push_time: Duration,
    /// The least sideways picture movement, in pixels, that counts as a response.
    pub min_slide_response: f32,
    /// The least added-up zoom that counts as a response.
    pub min_zoom_response: f32,
    /// With no trusted picture for this long, hold gives up.
    pub picture_lost_after: Duration,
    /// Test pushes need a trusted picture at least this long before they start.
    pub steady_before_pushing: Duration,
    /// While pushing, a gap longer than this between trusted frames abandons calibration at once.
    pub probe_gap: Duration,
}

impl Default for HoldConfig {
    fn default() -> Self {
        Self {
            max_correction: 12,
            push: 12,
            proportional: 0.5,
            derivative: 0.4,
            integral: 0.08,
            integral_limit: 0.4,
            settle: Duration::from_millis(500),
            push_time: Duration::from_millis(600),
            min_slide_response: 0.8,
            min_zoom_response: 0.004,
            picture_lost_after: Duration::from_secs(1),
            steady_before_pushing: Duration::from_secs(2),
            probe_gap: Duration::from_millis(250),
        }
    }
}

/// Used only to show what hold might do before it has measured anything.
const ASSUMED_SLIDE_RESPONSE: f32 = -24.0;
const ASSUMED_ZOOM_RESPONSE: f32 = 0.3;
/// How much of each new rate reading to take, which steadies the derivative.
const RATE_SMOOTHING: f32 = 0.4;
const MAX_FRAME_GAP: f32 = 0.5;
/// Drift this many times larger than a push's response drowns it out.
const MAX_DRIFT_TO_RESPONSE: f32 = 8.0;

/// What the test pushes measured: how far one push moves the picture sideways, in pixels, and how much it zooms it.
/// The sign says which way the sticks work, which belongs to the drone. The size also depends on how far away the scene
/// is, so a saved one is only roughly right in another place, which the gentle gains allow for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Calibration {
    pub slide: f32,
    pub zoom: f32,
}

impl Calibration {
    /// Whether this could have come from a real measurement, so a damaged saved file is never used.
    pub fn is_plausible(&self, config: &HoldConfig) -> bool {
        self.slide.is_finite()
            && self.zoom.is_finite()
            && self.slide.abs() >= config.min_slide_response
            && self.zoom.abs() >= config.min_zoom_response
            && self.slide.abs() < 500.0
            && self.zoom.abs() < 5.0
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldAxis {
    Sideways,
    ForwardBack,
}

/// Why hold stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldFault {
    /// A push made no clear change in the picture: the scene is too plain, or the drone is not flying.
    NoResponse(HoldAxis),
    /// The picture was moving too much to measure a push.
    Unsteady(HoldAxis),
    /// No trusted picture for too long.
    PictureLost,
    /// Hold was not started, because the picture had not been steady for long enough.
    PictureNotSteady,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldPhase {
    Off,
    Calibrating,
    Holding,
    Failed(HoldFault),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Stage {
    Settling { first: f32 },
    Pushing,
    Braking,
    Recovering,
}

/// Pushes one axis both ways and measures what the picture does.
///
/// A drifting drone is already moving, which swamps a single push and can even show the wrong direction. Taking the
/// difference between a push each way cancels any steady drift, and a mismatch shows the measurement cannot be trusted.
#[derive(Debug, Clone, Copy)]
struct Probe {
    axis: HoldAxis,
    stage: Stage,
    since: Instant,
    direction: i8,
    start: f32,
    first_pass: Option<f32>,
}

impl Probe {
    fn new(axis: HoldAxis, value: f32, now: Instant) -> Self {
        Self {
            axis,
            stage: Stage::Settling { first: value },
            since: now,
            direction: 1,
            start: value,
            first_pass: None,
        }
    }

    fn min_response(&self, config: &HoldConfig) -> f32 {
        match self.axis {
            HoldAxis::Sideways => config.min_slide_response,
            HoldAxis::ForwardBack => config.min_zoom_response,
        }
    }

    /// The push to send now, or the finished measurement.
    fn step(
        &mut self,
        value: f32,
        now: Instant,
        config: &HoldConfig,
    ) -> Result<i8, Result<f32, HoldFault>> {
        let elapsed = now.saturating_duration_since(self.since);
        let push = self.direction * config.push;
        match self.stage {
            Stage::Settling { .. } if elapsed < config.settle => Ok(0),
            Stage::Settling { .. } => {
                self.start = value;
                self.stage = Stage::Pushing;
                self.since = now;
                Ok(push)
            }
            Stage::Pushing if elapsed >= config.push_time => {
                self.stage = Stage::Braking;
                self.since = now;
                Ok(-push)
            }
            Stage::Pushing => Ok(push),
            Stage::Braking if elapsed >= config.push_time => {
                self.stage = Stage::Recovering;
                self.since = now;
                Ok(0)
            }
            Stage::Braking => Ok(-push),
            Stage::Recovering if elapsed >= config.settle => self.next_pass(value, now, config),
            Stage::Recovering => Ok(0),
        }
    }

    fn next_pass(
        &mut self,
        value: f32,
        now: Instant,
        config: &HoldConfig,
    ) -> Result<i8, Result<f32, HoldFault>> {
        let moved = value - self.start;
        let Some(first) = self.first_pass else {
            self.first_pass = Some(moved);
            self.direction = -1;
            self.stage = Stage::Settling { first: value };
            self.since = now;
            return Ok(0);
        };
        // Half the difference is the push. Half the sum is whatever was happening anyway.
        let response = (first - moved) / 2.0;
        let drift = (first + moved) / 2.0;
        Err(if response.abs() < self.min_response(config) {
            Err(HoldFault::NoResponse(self.axis))
        } else if drift.abs() > response.abs() * MAX_DRIFT_TO_RESPONSE {
            Err(HoldFault::Unsteady(self.axis))
        } else {
            Ok(response)
        })
    }
}

/// One axis's PID loop, working in calibration pushes.
#[derive(Debug, Clone, Copy)]
struct Loop {
    response: f32,
    target: f32,
    integral: f32,
    rate: f32,
}

impl Loop {
    fn new(response: f32, target: f32) -> Self {
        Self {
            response,
            target,
            integral: 0.0,
            rate: 0.0,
        }
    }

    /// `change` is how much the value moved this frame.
    fn update(&mut self, value: f32, change: f32, dt: f32, config: &HoldConfig) -> f32 {
        let scale = self.response.abs().max(f32::EPSILON);
        let error = (value - self.target) / scale;
        self.rate += RATE_SMOOTHING * (change / scale / dt - self.rate);
        let limit = config.integral_limit;
        let wanted = self.integral + config.integral * error * dt;
        self.integral = wanted.clamp(-limit, limit);
        let pushes = config.proportional * error + config.derivative * self.rate + self.integral;
        -self.response.signum() * pushes * f32::from(config.push)
    }
}

/// Whatever the autopilot is doing now.
#[derive(Debug, Clone, Copy)]
enum Mode {
    Off,
    Probing { probe: Probe, slide: Option<f32> },
    Holding { slide: Loop, zoom: Loop },
    Failed(HoldFault),
}

#[derive(Debug)]
pub struct Autopilot {
    config: HoldConfig,
    mode: Mode,
    slide: f32,
    zoom: f32,
    vertical: f32,
    last_frame: Option<Instant>,
    last_trusted: Option<Instant>,
    /// Since when the picture has been trusted without a break.
    steady_since: Option<Instant>,
    /// The latest measurement, from the test pushes or from a saved one.
    calibration: Option<Calibration>,
    /// What this frame's correction was, whether or not it is on.
    preview: Option<Correction>,
}

impl Default for Autopilot {
    fn default() -> Self {
        Self::new(HoldConfig::default())
    }
}

impl Autopilot {
    pub fn new(config: HoldConfig) -> Self {
        Self {
            config,
            mode: Mode::Off,
            slide: 0.0,
            zoom: 0.0,
            vertical: 0.0,
            last_frame: None,
            last_trusted: None,
            steady_since: None,
            calibration: None,
            preview: None,
        }
    }

    pub fn phase(&self) -> HoldPhase {
        match self.mode {
            Mode::Off => HoldPhase::Off,
            Mode::Probing { .. } => HoldPhase::Calibrating,
            Mode::Holding { .. } => HoldPhase::Holding,
            Mode::Failed(fault) => HoldPhase::Failed(fault),
        }
    }

    /// Picture movement added up since the last reset: sideways and vertical pixels.
    pub fn drift(&self) -> (f32, f32) {
        (self.slide, self.vertical)
    }

    pub fn zoom_total(&self) -> f32 {
        self.zoom
    }

    /// What hold is sending, or would send if it were on. `None` when the picture cannot be trusted.
    pub fn preview(&self) -> Option<Correction> {
        self.preview
    }

    /// Makes the current view the centre. Ignored while calibrating or holding, which have their own.
    pub fn reset(&mut self) {
        if !matches!(self.mode, Mode::Probing { .. } | Mode::Holding { .. }) {
            self.slide = 0.0;
            self.zoom = 0.0;
            self.vertical = 0.0;
            self.preview = None;
        }
    }

    /// Starts measuring, then holding the current view. Refused unless the picture has been steady for a while,
    /// because the test pushes move the drone, and on a poor picture they measure nothing and are wasted.
    pub fn start(&mut self, now: Instant) -> Result<(), HoldFault> {
        if !self.is_steady(now) {
            return Err(HoldFault::PictureNotSteady);
        }
        self.slide = 0.0;
        self.zoom = 0.0;
        self.vertical = 0.0;
        self.last_trusted = Some(now);
        self.mode = Mode::Probing {
            probe: Probe::new(HoldAxis::Sideways, 0.0, now),
            slide: None,
        };
        Ok(())
    }

    /// Holds the current view straight away with a saved measurement, so no test pushes are needed.
    pub fn start_calibrated(
        &mut self,
        now: Instant,
        calibration: Calibration,
    ) -> Result<(), HoldFault> {
        if !calibration.is_plausible(&self.config) {
            return Err(HoldFault::NoResponse(HoldAxis::Sideways));
        }
        if !self.is_steady(now) {
            return Err(HoldFault::PictureNotSteady);
        }
        self.slide = 0.0;
        self.zoom = 0.0;
        self.vertical = 0.0;
        self.calibration = Some(calibration);
        self.mode = Mode::Holding {
            slide: Loop::new(calibration.slide, 0.0),
            zoom: Loop::new(calibration.zoom, 0.0),
        };
        Ok(())
    }

    /// The measurement in use, once the test pushes have finished or a saved one was given.
    pub fn calibration(&self) -> Option<Calibration> {
        self.calibration
    }

    fn is_steady(&self, now: Instant) -> bool {
        self.steady_since.is_some_and(|since| {
            now.saturating_duration_since(since) >= self.config.steady_before_pushing
        }) && self
            .last_trusted
            .is_some_and(|at| now.saturating_duration_since(at) < self.config.probe_gap)
    }

    pub fn stop(&mut self) {
        self.mode = Mode::Off;
    }

    /// Gives up if the picture has stopped. Called on a timer, because no frames also means no `on_frame`.
    pub fn check_picture(&mut self, now: Instant) {
        let allowed = match self.mode {
            Mode::Probing { .. } => self.config.probe_gap,
            Mode::Holding { .. } => self.config.picture_lost_after,
            Mode::Off | Mode::Failed(_) => return,
        };
        if self
            .last_trusted
            .is_some_and(|at| now.saturating_duration_since(at) >= allowed)
        {
            self.fail(HoldFault::PictureLost);
        }
    }

    fn fail(&mut self, fault: HoldFault) -> Option<Correction> {
        self.mode = Mode::Failed(fault);
        self.preview = None;
        None
    }

    /// Takes in the movement between the last two frames, and returns the correction to send, if any.
    pub fn on_frame(&mut self, flow: Option<Flow>, now: Instant) -> Option<Correction> {
        let dt = self
            .last_frame
            .map_or(0.066, |at| now.saturating_duration_since(at).as_secs_f32())
            .clamp(0.001, MAX_FRAME_GAP);
        self.last_frame = Some(now);
        let trusted = flow.filter(|flow| flow.confidence >= MIN_CONFIDENCE);
        let Some(flow) = trusted else {
            self.steady_since = None;
            // A push measured on a broken picture would be wrong, so calibration gives up at once.
            if matches!(self.mode, Mode::Probing { .. }) {
                return self.fail(HoldFault::PictureLost);
            }
            let last = self.last_trusted.unwrap_or(now);
            let lost = now.saturating_duration_since(last) >= self.config.picture_lost_after;
            if lost && matches!(self.mode, Mode::Holding { .. }) {
                return self.fail(HoldFault::PictureLost);
            }
            self.preview = None;
            return None;
        };
        let gap = self
            .last_trusted
            .map(|at| now.saturating_duration_since(at));
        let broken = gap.is_none_or(|gap| gap > self.config.probe_gap);
        if broken && matches!(self.mode, Mode::Probing { .. }) {
            return self.fail(HoldFault::PictureLost);
        }
        if broken || self.steady_since.is_none() {
            self.steady_since = Some(now);
        }
        self.last_trusted = Some(now);
        self.slide += flow.dx;
        self.zoom += flow.zoom;
        self.vertical += flow.dy;

        let config = self.config;
        let limit = f32::from(config.max_correction);
        let steps = |value: f32| value.clamp(-limit, limit).round() as i8;
        let correction = match self.mode {
            Mode::Off | Mode::Failed(_) => {
                let mut slide = Loop::new(ASSUMED_SLIDE_RESPONSE, 0.0);
                let mut zoom = Loop::new(ASSUMED_ZOOM_RESPONSE, 0.0);
                Some(Correction {
                    aileron: steps(slide.update(self.slide, flow.dx, dt, &config)),
                    elevator: steps(zoom.update(self.zoom, flow.zoom, dt, &config)),
                })
            }
            Mode::Probing { .. } => self.probe(now),
            Mode::Holding {
                mut slide,
                mut zoom,
            } => {
                let correction = Correction {
                    aileron: steps(slide.update(self.slide, flow.dx, dt, &config)),
                    elevator: steps(zoom.update(self.zoom, flow.zoom, dt, &config)),
                };
                self.mode = Mode::Holding { slide, zoom };
                Some(correction)
            }
        };
        self.preview = correction;
        correction
    }

    fn probe(&mut self, now: Instant) -> Option<Correction> {
        let Mode::Probing {
            mut probe,
            slide: measured,
        } = self.mode
        else {
            return None;
        };
        let value = match probe.axis {
            HoldAxis::Sideways => self.slide,
            HoldAxis::ForwardBack => self.zoom,
        };
        match probe.step(value, now, &self.config) {
            Ok(push) => {
                self.mode = Mode::Probing {
                    probe,
                    slide: measured,
                };
                Some(match probe.axis {
                    HoldAxis::Sideways => Correction {
                        aileron: push,
                        elevator: 0,
                    },
                    HoldAxis::ForwardBack => Correction {
                        aileron: 0,
                        elevator: push,
                    },
                })
            }
            Err(Err(fault)) => self.fail(fault),
            Err(Ok(response)) => {
                match (probe.axis, measured) {
                    (HoldAxis::Sideways, _) => {
                        self.mode = Mode::Probing {
                            probe: Probe::new(HoldAxis::ForwardBack, self.zoom, now),
                            slide: Some(response),
                        };
                    }
                    (HoldAxis::ForwardBack, Some(slide)) => {
                        self.calibration = Some(Calibration {
                            slide,
                            zoom: response,
                        });
                        self.mode = Mode::Holding {
                            slide: Loop::new(slide, self.slide),
                            zoom: Loop::new(response, self.zoom),
                        };
                    }
                    (HoldAxis::ForwardBack, None) => {
                        return self.fail(HoldFault::NoResponse(HoldAxis::Sideways));
                    }
                }
                Some(Correction::default())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: Duration = Duration::from_millis(66);

    fn flow(dx: f32, confidence: f32) -> Flow {
        Flow {
            dx,
            dy: 0.0,
            zoom: 0.0,
            confidence,
        }
    }

    #[test]
    fn a_still_picture_previews_no_correction() {
        let mut pilot = Autopilot::default();
        let start = Instant::now();
        assert_eq!(
            pilot.on_frame(Some(flow(0.0, 0.5)), start),
            Some(Correction::default())
        );
        assert_eq!(pilot.phase(), HoldPhase::Off);
    }

    #[test]
    fn the_preview_opposes_a_slide_on_the_assumed_direction() {
        let mut pilot = Autopilot::default();
        let start = Instant::now();
        let correction = pilot.on_frame(Some(flow(10.0, 0.5)), start).unwrap();
        assert!(correction.aileron > 0, "{correction:?}");
    }

    #[test]
    fn an_untrusted_picture_gives_nothing_to_send() {
        let mut pilot = Autopilot::default();
        assert_eq!(pilot.on_frame(Some(flow(5.0, 0.2)), Instant::now()), None);
        assert_eq!(pilot.on_frame(None, Instant::now()), None);
        assert_eq!(pilot.drift().0, 0.0);
    }

    #[test]
    fn corrections_stay_small_however_large_the_drift() {
        let mut pilot = Autopilot::default();
        let correction = pilot
            .on_frame(Some(flow(5000.0, 0.5)), Instant::now())
            .unwrap();
        assert_eq!(correction.aileron, 12);
    }

    /// A trusted picture for long enough to start, returning when it ended.
    fn steady(pilot: &mut Autopilot, start: Instant) -> Instant {
        let mut now = start;
        for _ in 0..35 {
            pilot.on_frame(Some(flow(0.0, 0.5)), now);
            now += FRAME;
        }
        now
    }

    #[test]
    fn hold_will_not_start_on_a_picture_that_has_not_been_steady() {
        let mut pilot = Autopilot::default();
        let start = Instant::now();
        assert_eq!(pilot.start(start), Err(HoldFault::PictureNotSteady));
        let mut now = start;
        for _ in 0..10 {
            pilot.on_frame(Some(flow(0.0, 0.5)), now);
            now += FRAME;
        }
        assert_eq!(pilot.start(now), Err(HoldFault::PictureNotSteady));
        pilot.on_frame(Some(flow(0.0, 0.1)), now);
        let now = steady(&mut pilot, now + FRAME);
        assert_eq!(pilot.start(now), Ok(()));
        assert_eq!(pilot.phase(), HoldPhase::Calibrating);
    }

    #[test]
    fn hold_will_not_start_once_the_picture_has_stopped() {
        let mut pilot = Autopilot::default();
        let now = steady(&mut pilot, Instant::now());
        assert_eq!(
            pilot.start(now + Duration::from_millis(500)),
            Err(HoldFault::PictureNotSteady)
        );
    }

    #[test]
    fn one_untrusted_frame_during_calibration_ends_it_at_once() {
        let mut pilot = Autopilot::default();
        let now = steady(&mut pilot, Instant::now());
        pilot.start(now).unwrap();
        pilot.on_frame(Some(flow(0.0, 0.5)), now + FRAME);
        assert_eq!(pilot.on_frame(Some(flow(0.0, 0.1)), now + FRAME * 2), None);
        assert_eq!(pilot.phase(), HoldPhase::Failed(HoldFault::PictureLost));
    }

    #[test]
    fn a_gap_in_frames_during_calibration_ends_it() {
        let mut pilot = Autopilot::default();
        let now = steady(&mut pilot, Instant::now());
        pilot.start(now).unwrap();
        pilot.check_picture(now + Duration::from_millis(300));
        assert_eq!(pilot.phase(), HoldPhase::Failed(HoldFault::PictureLost));
    }

    #[test]
    fn a_saved_measurement_holds_at_once_without_test_pushes() {
        let mut pilot = Autopilot::default();
        let now = steady(&mut pilot, Instant::now());
        let saved = Calibration {
            slide: -20.0,
            zoom: 0.05,
        };
        pilot.start_calibrated(now, saved).unwrap();
        assert_eq!(pilot.phase(), HoldPhase::Holding);
        assert_eq!(pilot.calibration(), Some(saved));
        let correction = pilot.on_frame(Some(flow(4.0, 0.5)), now + FRAME).unwrap();
        assert!(correction.aileron > 0, "{correction:?}");
    }

    #[test]
    fn a_saved_measurement_still_needs_a_steady_picture_and_must_be_plausible() {
        let mut pilot = Autopilot::default();
        let start = Instant::now();
        let saved = Calibration {
            slide: -20.0,
            zoom: 0.05,
        };
        assert_eq!(
            pilot.start_calibrated(start, saved),
            Err(HoldFault::PictureNotSteady)
        );
        let now = steady(&mut pilot, start);
        for broken in [
            Calibration {
                slide: f32::NAN,
                zoom: 0.05,
            },
            Calibration {
                slide: 0.0,
                zoom: 0.05,
            },
            Calibration {
                slide: -20.0,
                zoom: 99.0,
            },
        ] {
            assert!(pilot.start_calibrated(now, broken).is_err(), "{broken:?}");
        }
        assert_eq!(pilot.phase(), HoldPhase::Off);
    }

    #[test]
    fn a_drone_that_does_not_respond_fails_calibration_and_stops_pushing() {
        let mut pilot = Autopilot::default();
        let start = steady(&mut pilot, Instant::now());
        pilot.start(start).unwrap();
        let mut last = None;
        for frame in 0..160 {
            last = pilot.on_frame(Some(flow(0.0, 0.5)), start + FRAME * frame);
        }
        assert_eq!(
            pilot.phase(),
            HoldPhase::Failed(HoldFault::NoResponse(HoldAxis::Sideways))
        );
        assert_ne!(
            last,
            Some(Correction {
                aileron: 12,
                elevator: 0
            })
        );
    }

    #[test]
    fn losing_the_picture_ends_calibration() {
        let mut pilot = Autopilot::default();
        let start = steady(&mut pilot, Instant::now());
        pilot.start(start).unwrap();
        assert_eq!(pilot.on_frame(None, start + Duration::from_secs(2)), None);
        assert_eq!(pilot.phase(), HoldPhase::Failed(HoldFault::PictureLost));
    }

    #[test]
    fn a_frozen_picture_ends_hold_even_though_no_frames_arrive() {
        let mut pilot = Autopilot::default();
        let start = steady(&mut pilot, Instant::now());
        pilot.start(start).unwrap();
        pilot.check_picture(start + Duration::from_millis(200));
        assert_eq!(pilot.phase(), HoldPhase::Calibrating);
        pilot.check_picture(start + Duration::from_millis(300));
        assert_eq!(pilot.phase(), HoldPhase::Failed(HoldFault::PictureLost));
    }

    #[test]
    fn stopping_ends_hold_and_centre_can_be_set_again() {
        let mut pilot = Autopilot::default();
        let start = Instant::now();
        pilot.on_frame(Some(flow(3.0, 0.5)), start);
        pilot.reset();
        assert_eq!(pilot.drift().0, 0.0);
        let now = steady(&mut pilot, start + FRAME);
        pilot.start(now).unwrap();
        pilot.stop();
        assert_eq!(pilot.phase(), HoldPhase::Off);
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
