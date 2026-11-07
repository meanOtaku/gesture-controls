//! Flies the autopilot in a simulated room, with the delays, noise and lean a real drone has.
//!
//! The physics are estimates, not measurements of the real drone. What these tests prove is that the control loop is
//! stable across a wide range of drones and scenes, and that it fails safely. They do not prove how well it will hold.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use drone_link::Correction;
use drone_link::hold::{Autopilot, Calibration, HoldAxis, HoldFault, HoldPhase};
use drone_link::vision::Flow;

const STEP: f32 = 0.01;
const FRAME_EVERY: f32 = 0.066;
const FOCAL_PIXELS: f32 = 114.0;

/// One horizontal axis of the drone.
#[derive(Debug, Default, Clone, Copy)]
struct Axis {
    position: f32,
    speed: f32,
    tilt: f32,
}

#[derive(Debug, Clone, Copy)]
struct Room {
    /// Metres to the scene in front.
    depth: f32,
    /// Radians of tilt per stick step.
    tilt_per_step: f32,
    /// Seconds the drone takes to tilt.
    tilt_lag: f32,
    /// How quickly air slows it, per second.
    drag: f32,
    /// A steady lean, in radians, which is what makes a toy drone drift.
    lean: f32,
    /// Picture movement noise per frame, in pixels.
    noise: f32,
    /// Seconds from the camera to a measurement.
    video_delay: f32,
    /// Which way a positive stick moves the drone.
    stick_sign: f32,
    /// The share of each second a slow gust pushes.
    gust: f32,
}

impl Default for Room {
    fn default() -> Self {
        Self {
            depth: 2.0,
            tilt_per_step: 0.0035,
            tilt_lag: 0.15,
            drag: 1.0,
            lean: 0.012,
            noise: 0.15,
            video_delay: 0.15,
            stick_sign: 1.0,
            gust: 0.1,
        }
    }
}

/// Repeatable noise, so a failing test fails the same way each time.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

struct Flight {
    room: Room,
    sideways: Axis,
    forward: Axis,
    time: f32,
    noise: Noise,
    frames: VecDeque<(f32, f32, f32)>,
    previous: Option<(f32, f32)>,
    next_frame: f32,
    start: Instant,
    pilot: Autopilot,
    correction: Correction,
    peak: f32,
    used_sticks: bool,
}

impl Flight {
    fn new(room: Room) -> Self {
        Self {
            room,
            sideways: Axis::default(),
            forward: Axis::default(),
            time: 0.0,
            noise: Noise(0x1234_5678),
            frames: VecDeque::new(),
            previous: None,
            next_frame: 0.0,
            start: Instant::now(),
            pilot: Autopilot::default(),
            correction: Correction::default(),
            peak: 0.0,
            used_sticks: false,
        }
    }

    fn now(&self) -> Instant {
        self.start + Duration::from_secs_f32(self.time)
    }

    fn fly(axis: &mut Axis, room: &Room, steps: f32, push: f32) {
        let wanted = steps * room.stick_sign * room.tilt_per_step + room.lean;
        axis.tilt += (wanted - axis.tilt) * STEP / room.tilt_lag;
        axis.speed += (9.8 * axis.tilt - room.drag * axis.speed + push) * STEP;
        axis.position += axis.speed * STEP;
    }

    fn step(&mut self, confidence: f32) {
        let gust = (self.time * 0.7).sin() * self.room.gust * 9.8 * 0.02;
        let room = self.room;
        Self::fly(
            &mut self.sideways,
            &room,
            f32::from(self.correction.aileron),
            gust,
        );
        Self::fly(
            &mut self.forward,
            &room,
            f32::from(self.correction.elevator),
            gust * 0.5,
        );
        self.time += STEP;

        if self.time >= self.next_frame {
            self.next_frame += FRAME_EVERY;
            self.frames
                .push_back((self.time, self.sideways.position, self.forward.position));
        }
        while self
            .frames
            .front()
            .is_some_and(|frame| frame.0 + self.room.video_delay <= self.time)
        {
            let (_, sideways, forward) = self.frames.pop_front().unwrap();
            if let Some((was_sideways, was_forward)) = self.previous {
                let depth = self.room.depth;
                let flow = Flow {
                    dx: -FOCAL_PIXELS * (sideways - was_sideways) / depth
                        + self.noise.next() * self.room.noise,
                    dy: 0.0,
                    zoom: (forward - was_forward) / depth
                        + self.noise.next() * self.room.noise * 0.003,
                    confidence,
                };
                let now = self.now();
                if let Some(correction) = self.pilot.on_frame(Some(flow), now) {
                    // Off, the autopilot only previews: nothing reaches this drone.
                    if !matches!(self.pilot.phase(), HoldPhase::Off | HoldPhase::Failed(_)) {
                        self.correction = correction;
                        self.used_sticks = true;
                    }
                } else {
                    self.correction = Correction::default();
                }
                if matches!(self.pilot.phase(), HoldPhase::Failed(_)) {
                    self.correction = Correction::default();
                }
            }
            self.previous = Some((sideways, forward));
        }
    }

    fn run(&mut self, seconds: f32) {
        let end = self.time + seconds;
        while self.time < end {
            self.step(0.5);
        }
    }

    /// Flies with the picture steady long enough for hold to agree to start, then starts it.
    fn start_hold(&mut self) {
        self.run(3.0);
        let now = self.now();
        self.pilot.start(now).unwrap();
    }

    /// How far the drone is from where it was at `from`.
    fn distance(&self, from: (f32, f32)) -> f32 {
        (self.sideways.position - from.0).hypot(self.forward.position - from.1)
    }

    fn position(&self) -> (f32, f32) {
        (self.sideways.position, self.forward.position)
    }

    /// Holds for a settled while, and returns the furthest it strayed once calibrated.
    fn hold_for(&mut self, seconds: f32) -> f32 {
        self.start_hold();
        self.run(12.0);
        assert_eq!(self.pilot.phase(), HoldPhase::Holding, "{:?}", self.room);
        self.run(10.0);
        let centre = self.position();
        let end = self.time + seconds;
        self.peak = 0.0;
        while self.time < end {
            self.step(0.5);
            self.peak = self.peak.max(self.distance(centre));
        }
        self.peak
    }
}

#[test]
fn left_alone_the_drone_wanders_off() {
    let mut flight = Flight::new(Room::default());
    flight.run(20.0);
    assert!(flight.distance((0.0, 0.0)) > 3.0, "{:?}", flight.position());
    assert!(!flight.used_sticks);
}

#[test]
fn hold_stops_the_wandering() {
    let peak = Flight::new(Room::default()).hold_for(60.0);
    assert!(peak < 0.25, "strayed {peak} m");
}

#[test]
fn calibration_finds_the_direction_of_the_sticks_by_itself() {
    let backwards = Room {
        stick_sign: -1.0,
        ..Room::default()
    };
    let peak = Flight::new(backwards).hold_for(60.0);
    assert!(peak < 0.25, "strayed {peak} m");
}

#[test]
fn hold_works_from_a_near_wall_to_a_middling_one() {
    for depth in [1.0, 2.0, 4.0] {
        let peak = Flight::new(Room {
            depth,
            ..Room::default()
        })
        .hold_for(60.0);
        assert!(peak < 0.6, "strayed {peak} m at {depth} m");
    }
}

/// The safety property: however the room or drone differs, hold either stays close or refuses. It never runs away.
#[test]
fn across_many_drones_and_rooms_hold_stays_close_or_refuses_cleanly() {
    let mut held = 0;
    let mut refused = Vec::new();
    for depth in [0.7, 1.0, 2.0, 4.0, 8.0] {
        for tilt_per_step in [0.002, 0.0035, 0.006] {
            for drag in [0.5, 1.0, 2.0] {
                for lean in [-0.02, 0.005, 0.02] {
                    for stick_sign in [1.0, -1.0] {
                        let room = Room {
                            depth,
                            tilt_per_step,
                            drag,
                            lean,
                            stick_sign,
                            ..Room::default()
                        };
                        let mut flight = Flight::new(room);
                        flight.start_hold();
                        flight.run(12.0);
                        if flight.pilot.phase() != HoldPhase::Holding {
                            assert!(
                                matches!(flight.pilot.phase(), HoldPhase::Failed(_)),
                                "{:?}",
                                flight.pilot.phase()
                            );
                            assert_eq!(flight.correction, Correction::default());
                            refused.push(room);
                            continue;
                        }
                        held += 1;
                        flight.run(10.0);
                        let centre = flight.position();
                        let mut peak: f32 = 0.0;
                        for _ in 0..6000 {
                            flight.step(0.5);
                            peak = peak.max(flight.distance(centre));
                        }
                        assert!(peak < 1.0, "strayed {peak} m with {room:?}");
                    }
                }
            }
        }
    }
    let total = held + refused.len();
    println!("held {held} of {total}, refused {}", refused.len());
    for depth in [0.7, 1.0, 2.0, 4.0, 8.0] {
        let count = refused.iter().filter(|room| room.depth == depth).count();
        println!("  refused at {depth} m: {count}");
    }
    assert!(held * 2 > total, "held only {held} of {total}");
}

#[test]
fn hold_copes_with_a_longer_video_delay() {
    for video_delay in [0.1, 0.2, 0.3] {
        let peak = Flight::new(Room {
            video_delay,
            ..Room::default()
        })
        .hold_for(60.0);
        assert!(peak < 0.6, "strayed {peak} m at {video_delay} s");
    }
}

#[test]
fn hold_copes_with_vibration_noise() {
    let peak = Flight::new(Room {
        noise: 0.5,
        ..Room::default()
    })
    .hold_for(60.0);
    assert!(peak < 0.6, "strayed {peak} m");
}

#[test]
fn a_picture_that_goes_blank_ends_hold_and_centres_the_sticks() {
    let mut flight = Flight::new(Room::default());
    flight.hold_for(5.0);
    let end = flight.time + 2.0;
    while flight.time < end {
        flight.step(0.1);
    }
    assert_eq!(
        flight.pilot.phase(),
        HoldPhase::Failed(HoldFault::PictureLost)
    );
    assert_eq!(flight.correction, Correction::default());
}

#[test]
fn a_drone_sitting_on_a_table_cannot_pass_calibration() {
    let table = Room {
        tilt_per_step: 0.0,
        lean: 0.0,
        gust: 0.0,
        noise: 0.05,
        ..Room::default()
    };
    let mut flight = Flight::new(table);
    flight.start_hold();
    flight.run(12.0);
    assert_eq!(
        flight.pilot.phase(),
        HoldPhase::Failed(HoldFault::NoResponse(HoldAxis::Sideways))
    );
    assert_eq!(flight.correction, Correction::default());
}

/// Measures in one room, then holds with that saved measurement straight after takeoff in another, with no test pushes.
#[test]
fn a_measurement_saved_in_one_room_holds_safely_in_another() {
    let mut results = Vec::new();
    for measured_at in [1.0, 2.0, 4.0] {
        let mut learning = Flight::new(Room {
            depth: measured_at,
            ..Room::default()
        });
        learning.hold_for(1.0);
        let saved: Calibration = learning.pilot.calibration().unwrap();
        for flown_at in [1.0, 2.0, 4.0] {
            let mut flight = Flight::new(Room {
                depth: flown_at,
                ..Room::default()
            });
            flight.run(3.0);
            let now = flight.now();
            flight.pilot.start_calibrated(now, saved).unwrap();
            flight.run(10.0);
            let centre = flight.position();
            let mut peak: f32 = 0.0;
            for _ in 0..6000 {
                flight.step(0.5);
                peak = peak.max(flight.distance(centre));
            }
            assert_eq!(flight.pilot.phase(), HoldPhase::Holding);
            assert!(
                peak < 1.0,
                "strayed {peak} m, measured at {measured_at} m, flown at {flown_at} m"
            );
            results.push((measured_at, flown_at, peak));
        }
    }
    for (measured_at, flown_at, peak) in results {
        println!("measured at {measured_at} m, flown at {flown_at} m: strayed {peak:.2} m");
    }
}
