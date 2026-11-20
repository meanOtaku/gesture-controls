//! Pointer mode: the hand moves the mouse pointer and a pinch clicks.
//!
//! **Movement.** The pointer follows where the forearm points, in the world frame: turning it left or right (its
//! heading) moves the pointer across, raising or lowering it (its elevation) moves it up and down. Using the forearm's
//! direction rather than the watch's own axes means rolling the wrist does not move the pointer, and the same gesture
//! works however the hand is turned. Slow movement is scaled down for precision and fast movement up for reach, and
//! movement slower than hand tremor is ignored.
//!
//! **Mouse or trackpad.** As a mouse, the hand always moves the pointer. As a trackpad, it moves the pointer only while
//! it "touches": with the palm facing down (the watch face up). Turning the palm to the side lifts it, so the arm can
//! move back or rest without moving the pointer, and turning it down again carries on from where the pointer is. The
//! pose comes straight from the watch's orientation, with no model and no delay, and turning it does not move the
//! pointer, since rolling the wrist never does.
//!
//! **Watch or head.** The pointer can follow the head instead: the headphones' yaw (turning the head left or right)
//! moves it across and their pitch (nodding up or down) moves it up and down, with the same smoothing and speed
//! scaling. The watch still switches pointer mode on and clicks. As there is no palm to turn, the head always moves the
//! pointer, whatever the mode; the switch that turned pointer mode on turns it off again.
//!
//! **Clicks.** A model detects a pinch about 0.4 s after it starts, and the pinch itself nudges the wrist. So when a
//! press starts, the pointer is frozen and put back where it was a moment before, and the click lands where the user
//! was pointing. A release soon after is a click. A hold detected first presses the button down (and the hand drags),
//! until the release, until the hold has been gone a while, or until pointer mode ends. The button is never left down:
//! every way out of pointer mode lets it go.

use std::collections::{BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

/// What pointer mode asks of the mouse.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PointerEvent {
    /// Move the pointer by this many pixels (fractions carry over); positive is right and down.
    Move { dx: f64, dy: f64 },
    /// Move the pointer by these fractions of the width and height of the screen it is on; positive is right and down.
    /// A head pointer with a range moves this way, so turning through the range crosses the whole screen.
    MoveScreen { dx: f64, dy: f64 },
    /// Press and release the left button where the pointer is.
    Click,
    /// Press the left button and keep it down.
    Press,
    /// Let the left button go.
    Release,
}

/// How the hand moves the pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PointerMode {
    /// The hand always moves the pointer.
    #[default]
    Mouse,
    /// The hand moves the pointer only with the palm facing down; turned to the side, it is lifted.
    Trackpad,
}

/// What moves the pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PointerSource {
    /// Where the forearm points, from the watch.
    #[default]
    Watch,
    /// Where the head faces, from the headphones.
    Head,
}

/// Where the head faces, from one headphone sample: its yaw and pitch in degrees and when it was received.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HeadAim {
    /// Turning the head left raises it.
    pub yaw_deg: f64,
    /// Looking up raises it.
    pub pitch_deg: f64,
    pub timestamp_ns: u64,
}

/// How far the head turns to take the pointer from one edge of the screen to the other, in degrees: left to right
/// (`across_degrees`) and top to bottom (`up_degrees`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadRange {
    pub across_degrees: f64,
    pub up_degrees: f64,
}

/// The smallest and largest head range either way, in degrees.
pub const MIN_HEAD_RANGE_DEGREES: f64 = 5.0;
pub const MAX_HEAD_RANGE_DEGREES: f64 = 180.0;

impl HeadRange {
    pub fn is_valid(&self) -> bool {
        [self.across_degrees, self.up_degrees]
            .iter()
            .all(|degrees| {
                degrees.is_finite()
                    && (MIN_HEAD_RANGE_DEGREES..=MAX_HEAD_RANGE_DEGREES).contains(degrees)
            })
    }
}

/// As a trackpad, the hand touches when the watch face tilts at most this far from facing straight up...
pub const TOUCH_TILT_DEGREES: f64 = 45.0;
/// ...and lifts when it tilts further than this. The gap between them keeps a hand near the edge from flickering.
pub const LIFT_TILT_DEGREES: f64 = 60.0;

/// How far the watch face tilts from facing straight up, in degrees: 0 with the palm down, 90 with it to the side.
fn face_tilt_degrees(q: [f64; 4]) -> f64 {
    let [_, i, j, _] = q;
    // The watch's z axis (out of its face) in the world frame, its upward part: the last entry of the rotation matrix.
    (1.0 - 2.0 * (i * i + j * j))
        .clamp(-1.0, 1.0)
        .acos()
        .to_degrees()
}

/// The settings of one pointer step.
#[derive(Debug, Clone, PartialEq)]
pub struct PointerConfig {
    pub pixels_per_degree: f64,
    pub press_label: String,
    pub hold_label: String,
    pub release_label: String,
    pub lookback_ns: u64,
    pub mode: PointerMode,
    pub source: PointerSource,
    /// Flip the direction across (left and right) or up and down, for a head tracker that reports the other way round.
    pub reverse_across: bool,
    pub reverse_up: bool,
    /// Following the head, how far it turns to cross the screen. With a range the pointer moves in proportion to the
    /// head, with no speed scaling; without one it moves `pixels_per_degree` like the hand.
    pub head_range: Option<HeadRange>,
}

/// Movement slower than this, after smoothing, is tremor or sensor noise, and moves nothing. The watch's orientation
/// wanders by a few hundredths of a degree from one sample to the next, which at 100 samples a second is 3-6 degrees a
/// second: a lower floor turned that into the pointer shaking in place.
const MIN_SPEED_DEGREES_PER_SECOND: f64 = 4.0;
/// The smoothing of where the forearm points (a One Euro filter): this cutoff, in hertz, when it is still, raised by
/// [`SMOOTHING_SPEED_GAIN`] per degree a second of movement, so slow aiming is steady and fast movement keeps up.
const SMOOTHING_MIN_CUTOFF_HZ: f64 = 1.0;
const SMOOTHING_SPEED_GAIN: f64 = 0.05;
/// How quickly the filter's own estimate of the speed follows, in hertz.
const SMOOTHING_SPEED_CUTOFF_HZ: f64 = 1.0;
/// At this speed a degree moves the pointer the configured number of pixels. Slower moves less, faster more.
const REFERENCE_SPEED_DEGREES_PER_SECOND: f64 = 60.0;
const MIN_GAIN: f64 = 0.5;
const MAX_GAIN: f64 = 2.0;
/// Moves are remembered this long, for putting the pointer back when a press starts.
const HISTORY_NS: u64 = 1_500_000_000;
/// Pinches right after pointer mode comes on are ignored: the gesture that switched it on (a snap) can look like one.
pub const SETTLE_NS: u64 = 400_000_000;
/// A press with neither a hold nor a release this long after it is forgotten, and the pointer moves again.
pub const PENDING_NS: u64 = 2_000_000_000;
/// The button comes up when the hold has not been detected for this long, in case the release was missed.
pub const HOLD_LOST_NS: u64 = 1_500_000_000;

/// The labels the model runtime reports for one update.
#[derive(Debug, Clone, Copy, Default)]
pub struct PointerInputs<'a> {
    /// Labels that started this update.
    pub edges: Option<&'a BTreeSet<String>>,
    /// Labels detected right now.
    pub held: Option<&'a BTreeSet<String>>,
}

impl PointerInputs<'_> {
    fn edge(&self, label: &str) -> bool {
        self.edges.is_some_and(|edges| edges.contains(label))
    }

    fn held(&self, label: &str) -> bool {
        self.held.is_some_and(|held| held.contains(label))
    }
}

/// Where the forearm points, in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Pointing {
    heading: f64,
    elevation: f64,
}

/// Where the forearm points for an orientation `[w, i, j, k]`. `hand_sign` is 1 when the watch's 3 o'clock points at
/// the hand and -1 when it points at the elbow.
fn pointing(q: [f64; 4], hand_sign: f64) -> Pointing {
    let [w, i, j, k] = q;
    // The watch's x axis (3 o'clock, along the forearm) in the world frame: the first column of the rotation matrix.
    let x = (1.0 - 2.0 * (j * j + k * k)) * hand_sign;
    let y = 2.0 * (i * j + w * k) * hand_sign;
    let z = 2.0 * (i * k - w * j) * hand_sign;
    Pointing {
        heading: y.atan2(x).to_degrees(),
        elevation: z.clamp(-1.0, 1.0).asin().to_degrees(),
    }
}

fn shortest_delta(from: f64, to: f64) -> f64 {
    (to - from + 540.0).rem_euclid(360.0) - 180.0
}

/// A One Euro filter (Casiez et al., 2012) on one angle: low-pass, with a cutoff that rises with speed.
#[derive(Debug, Default, Clone, Copy)]
struct OneEuro {
    /// The smoothed value and the smoothed speed (per second).
    state: Option<(f64, f64)>,
}

impl OneEuro {
    fn alpha(cutoff_hz: f64, seconds: f64) -> f64 {
        let r = 2.0 * std::f64::consts::PI * cutoff_hz * seconds;
        r / (r + 1.0)
    }

    fn filter(&mut self, value: f64, seconds: f64) -> f64 {
        let Some((smoothed, speed)) = self.state else {
            self.state = Some((value, 0.0));
            return value;
        };
        if seconds <= 0.0 {
            // The same moment again (a step for a model update, not a new sample): nothing new to smooth.
            return smoothed;
        }
        let raw_speed = (value - smoothed) / seconds;
        let speed = speed + Self::alpha(SMOOTHING_SPEED_CUTOFF_HZ, seconds) * (raw_speed - speed);
        let cutoff = SMOOTHING_MIN_CUTOFF_HZ + SMOOTHING_SPEED_GAIN * speed.abs();
        let smoothed = smoothed + Self::alpha(cutoff, seconds) * (value - smoothed);
        self.state = Some((smoothed, speed));
        smoothed
    }
}

/// Where the forearm points, smoothed. The heading is unwrapped first, so the filter never sees the jump at +-180.
#[derive(Debug, Default)]
struct Smoothing {
    raw_heading: Option<f64>,
    unwrapped_heading: f64,
    heading: OneEuro,
    elevation: OneEuro,
}

impl Smoothing {
    fn smooth(&mut self, raw: Pointing, seconds: f64) -> Pointing {
        self.unwrapped_heading = match self.raw_heading {
            Some(previous) => self.unwrapped_heading + shortest_delta(previous, raw.heading),
            None => raw.heading,
        };
        self.raw_heading = Some(raw.heading);
        Pointing {
            heading: self.heading.filter(self.unwrapped_heading, seconds),
            elevation: self.elevation.filter(raw.elevation, seconds),
        }
    }
}

/// Pointer mode while it is on. Make a new one each time it comes on; [`Self::end`] when it goes off.
#[derive(Debug)]
pub struct PointerTracker {
    config: PointerConfig,
    on_since_ns: Option<u64>,
    last: Option<(Pointing, Option<u64>)>,
    /// A press started at this time and is waiting to become a click or a held button.
    pending_ns: Option<u64>,
    pressed: bool,
    hold_seen_ns: Option<u64>,
    history: VecDeque<(u64, f64, f64)>,
    smoothing: Smoothing,
    /// As a trackpad, whether the hand is touching (palm down) now.
    touching: bool,
    events: Vec<PointerEvent>,
}

impl PointerTracker {
    pub fn new(config: PointerConfig) -> Self {
        Self {
            config,
            on_since_ns: None,
            last: None,
            pending_ns: None,
            pressed: false,
            hold_seen_ns: None,
            history: VecDeque::new(),
            smoothing: Smoothing::default(),
            touching: false,
            events: Vec::new(),
        }
    }

    pub fn is_pressed(&self) -> bool {
        self.pressed
    }

    /// As a trackpad, whether the hand is touching (moving the pointer) now. Always true as a mouse.
    pub fn is_touching(&self) -> bool {
        self.config.mode == PointerMode::Mouse || self.touching
    }

    /// What the mouse should do, since the last call.
    pub fn take_events(&mut self) -> Vec<PointerEvent> {
        std::mem::take(&mut self.events)
    }

    /// Pointer mode is ending: let the button go if it is down. The events are still there to take.
    pub fn end(&mut self) {
        if self.pressed {
            self.events.push(PointerEvent::Release);
        }
        self.pressed = false;
        self.pending_ns = None;
        self.hold_seen_ns = None;
        self.last = None;
        self.smoothing = Smoothing::default();
        self.touching = false;
        self.history.clear();
    }

    /// One update with pointer mode on. Returns whether anything happened (the pointer moved or a button changed),
    /// so a mode switched on by a momentary step can tell it is in use.
    pub fn update(
        &mut self,
        orientation: [f64; 4],
        hand_sign: f64,
        now_ns: Option<u64>,
        inputs: PointerInputs<'_>,
    ) -> bool {
        let before = self.events.len();
        if self.on_since_ns.is_none() {
            self.on_since_ns = now_ns;
        }
        let settled = match (self.on_since_ns, now_ns) {
            (Some(on), Some(now)) => now.saturating_sub(on) >= SETTLE_NS,
            _ => true,
        };
        if settled {
            self.clicks(now_ns, inputs);
        }
        if self.config.mode == PointerMode::Trackpad {
            let tilt = face_tilt_degrees(orientation);
            let touching = tilt
                <= if self.touching {
                    LIFT_TILT_DEGREES
                } else {
                    TOUCH_TILT_DEGREES
                };
            if touching != self.touching {
                // Each touch starts afresh from where the hand is: nothing it did while lifted carries over.
                self.touching = touching;
                self.last = None;
                self.smoothing = Smoothing::default();
            }
            if !touching {
                return self.events.len() != before;
            }
        }
        self.movement(pointing(orientation, hand_sign), now_ns);
        self.events.len() != before
    }

    /// One update with pointer mode on and the pointer following the head. `now_ns` is the watch's clock, which the
    /// clicks go by; the head's own timestamps pace its movement. The same head sample given again moves nothing.
    pub fn update_head(
        &mut self,
        aim: HeadAim,
        now_ns: Option<u64>,
        inputs: PointerInputs<'_>,
    ) -> bool {
        let before = self.events.len();
        if self.on_since_ns.is_none() {
            self.on_since_ns = now_ns;
        }
        let settled = match (self.on_since_ns, now_ns) {
            (Some(on), Some(now)) => now.saturating_sub(on) >= SETTLE_NS,
            _ => true,
        };
        if settled {
            self.clicks(now_ns, inputs);
        }
        let facing = Pointing {
            heading: aim.yaw_deg,
            elevation: aim.pitch_deg.clamp(-89.0, 89.0),
        };
        self.movement(facing, Some(aim.timestamp_ns));
        self.events.len() != before
    }

    fn clicks(&mut self, now_ns: Option<u64>, inputs: PointerInputs<'_>) {
        let config = &self.config;
        let released = inputs.edge(&config.release_label);
        let hold = inputs.held(&config.hold_label);
        if released {
            if self.pressed {
                self.events.push(PointerEvent::Release);
                self.pressed = false;
            } else if self.pending_ns.is_some() {
                self.events.push(PointerEvent::Click);
            }
            self.pending_ns = None;
            self.hold_seen_ns = None;
            return;
        }
        if inputs.edge(&config.press_label) && !self.pressed && self.pending_ns.is_none() {
            self.rewind(now_ns);
            // With no clock the press cannot time out, but it still waits for its hold or release.
            self.pending_ns = Some(now_ns.unwrap_or(0));
        }
        if let Some(pending) = self.pending_ns {
            if hold {
                self.events.push(PointerEvent::Press);
                self.pressed = true;
                self.pending_ns = None;
                self.hold_seen_ns = now_ns;
            } else if now_ns.is_some_and(|now| now.saturating_sub(pending) > PENDING_NS) {
                self.pending_ns = None;
            }
        } else if self.pressed {
            if hold {
                self.hold_seen_ns = now_ns;
            } else if let (Some(now), Some(seen)) = (now_ns, self.hold_seen_ns)
                && now.saturating_sub(seen) > HOLD_LOST_NS
            {
                self.events.push(PointerEvent::Release);
                self.pressed = false;
                self.hold_seen_ns = None;
            }
        }
    }

    /// The head range, when the head moves the pointer and has one: moves are then fractions of the screen.
    fn screen_range(&self) -> Option<HeadRange> {
        self.config
            .head_range
            .filter(|_| self.config.source == PointerSource::Head)
    }

    fn move_event(&self, dx: f64, dy: f64) -> PointerEvent {
        if self.screen_range().is_some() {
            PointerEvent::MoveScreen { dx, dy }
        } else {
            PointerEvent::Move { dx, dy }
        }
    }

    /// Puts the pointer back where it was `lookback` before now.
    fn rewind(&mut self, now_ns: Option<u64>) {
        // On the clock the moves were stamped with: the head's own, when it moves the pointer.
        let latest = self.last.and_then(|(_, at)| at);
        let Some(now) = (match self.config.source {
            PointerSource::Watch => now_ns.or(latest),
            PointerSource::Head => latest,
        }) else {
            return;
        };
        let since = now.saturating_sub(self.config.lookback_ns);
        let (dx, dy) = self
            .history
            .iter()
            .filter(|(at, _, _)| *at >= since)
            .fold((0.0, 0.0), |(x, y), (_, dx, dy)| (x + dx, y + dy));
        self.history.clear();
        if dx != 0.0 || dy != 0.0 {
            self.events.push(self.move_event(-dx, -dy));
        }
    }

    fn movement(&mut self, raw: Pointing, now_ns: Option<u64>) {
        let seconds = match (self.last.and_then(|(_, at)| at), now_ns) {
            (Some(then), Some(at)) if at > then => (at - then) as f64 / 1e9,
            // No clock: as if a sample of a 100 Hz stream.
            (_, None) => 0.01,
            _ => 0.0,
        };
        let now = self.smoothing.smooth(raw, seconds);
        let Some((last, last_ns)) = self.last.replace((now, now_ns)) else {
            return;
        };
        if self.pending_ns.is_some() {
            // Frozen while a press is deciding what it is.
            return;
        }
        let across = shortest_delta(last.heading, now.heading) * now.elevation.to_radians().cos();
        let up = now.elevation - last.elevation;
        let degrees = across.hypot(up);
        let speed = match (last_ns, now_ns) {
            (Some(then), Some(at)) if at > then => degrees / ((at - then) as f64 / 1e9),
            _ => REFERENCE_SPEED_DEGREES_PER_SECOND,
        };
        if degrees == 0.0 || speed < MIN_SPEED_DEGREES_PER_SECOND {
            return;
        }
        let (dx, dy) = match self.screen_range() {
            // In proportion to the head: the whole range is the whole screen.
            Some(range) => (-across / range.across_degrees, -up / range.up_degrees),
            None => {
                let gain = (0.5 + speed / (2.0 * REFERENCE_SPEED_DEGREES_PER_SECOND))
                    .clamp(MIN_GAIN, MAX_GAIN);
                let scale = self.config.pixels_per_degree * gain;
                // Heading grows anticlockwise seen from above, so pointing further right lowers it; screen y grows
                // downwards.
                (-across * scale, -up * scale)
            }
        };
        let dx = if self.config.reverse_across { -dx } else { dx };
        let dy = if self.config.reverse_up { -dy } else { dy };
        self.events.push(self.move_event(dx, dy));
        if let Some(at) = now_ns {
            self.history.push_back((at, dx, dy));
            while self
                .history
                .front()
                .is_some_and(|(then, _, _)| at.saturating_sub(*then) > HISTORY_NS)
            {
                self.history.pop_front();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    fn config() -> PointerConfig {
        PointerConfig {
            pixels_per_degree: 10.0,
            press_label: "pinch_in".into(),
            hold_label: "pinch_hold".into(),
            release_label: "pinch_out".into(),
            lookback_ns: 400 * MS,
            mode: PointerMode::Mouse,
            source: PointerSource::Watch,
            reverse_across: false,
            reverse_up: false,
            head_range: None,
        }
    }

    /// The forearm pointing level at `heading` degrees, raised by `elevation` degrees, as an orientation quaternion.
    /// Yaw about the world's vertical, then pitch about the watch's 12-6 axis (negative pitch about y raises +x).
    fn pointed(heading: f64, elevation: f64) -> [f64; 4] {
        let (h, e) = (heading.to_radians() / 2.0, -elevation.to_radians() / 2.0);
        let yaw = [h.cos(), 0.0, 0.0, h.sin()];
        let pitch = [e.cos(), 0.0, e.sin(), 0.0];
        multiply(yaw, pitch)
    }

    fn multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
        let [aw, ai, aj, ak] = a;
        let [bw, bi, bj, bk] = b;
        [
            aw * bw - ai * bi - aj * bj - ak * bk,
            aw * bi + ai * bw + aj * bk - ak * bj,
            aw * bj - ai * bk + aj * bw + ak * bi,
            aw * bk + ai * bj - aj * bi + ak * bw,
        ]
    }

    fn set(labels: &[&str]) -> BTreeSet<String> {
        labels.iter().map(|l| l.to_string()).collect()
    }

    fn moved(events: &[PointerEvent]) -> (f64, f64) {
        events.iter().fold((0.0, 0.0), |(x, y), event| match event {
            PointerEvent::Move { dx, dy } => (x + dx, y + dy),
            _ => (x, y),
        })
    }

    fn buttons(events: &[PointerEvent]) -> Vec<PointerEvent> {
        events
            .iter()
            .copied()
            .filter(|event| !matches!(event, PointerEvent::Move { .. }))
            .collect()
    }

    #[test]
    fn the_forearm_direction_is_read_from_the_orientation() {
        let p = pointing(pointed(30.0, 20.0), 1.0);
        assert!(
            (p.heading - 30.0).abs() < 1e-9 && (p.elevation - 20.0).abs() < 1e-9,
            "{p:?}"
        );
        // Worn with 3 o'clock at the elbow, the hand points the other way along the same line.
        let flipped = pointing(pointed(30.0, 20.0), -1.0);
        assert!((flipped.elevation + 20.0).abs() < 1e-9);
    }

    /// Sweeps from pointing at (0, 0) to `(heading, elevation)` over `millis` at 100 samples a second, then holds there
    /// for a second so the smoothing catches up; returns how far the pointer moved.
    fn sweep(heading: f64, elevation: f64, millis: u64) -> (f64, f64) {
        let mut tracker = PointerTracker::new(config());
        let none = PointerInputs::default();
        let steps = millis / 10;
        let mut events = Vec::new();
        for n in 0..=steps + 100 {
            let f = (n.min(steps) as f64) / steps as f64;
            tracker.update(
                pointed(heading * f, elevation * f),
                1.0,
                Some(n * 10 * MS),
                none,
            );
            events.extend(tracker.take_events());
        }
        moved(&events)
    }

    #[test]
    fn pointing_right_and_up_moves_the_pointer_right_and_up() {
        // 6 degrees to the right (heading down) and 3 up, in 100 ms.
        let (dx, dy) = sweep(-6.0, 3.0, 100);
        assert!(dx > 40.0 && dx < 80.0, "{dx}");
        assert!(dy < 0.0 && (dx / -dy - 2.0).abs() < 0.2, "{dx} {dy}");
    }

    #[test]
    fn rolling_the_wrist_does_not_move_the_pointer() {
        let mut tracker = PointerTracker::new(config());
        let none = PointerInputs::default();
        let level = pointed(10.0, 5.0);
        tracker.update(level, 1.0, Some(0), none);
        // A roll is a turn about the forearm itself, the watch's x axis.
        let roll = [(0.3f64).cos(), (0.3f64).sin(), 0.0, 0.0];
        tracker.update(multiply(level, roll), 1.0, Some(100 * MS), none);
        let (dx, dy) = moved(&tracker.take_events());
        assert!(dx.abs() < 1e-6 && dy.abs() < 1e-6, "{dx} {dy}");
    }

    #[test]
    fn slow_drift_is_ignored_and_slow_movement_moves_less_than_fast() {
        // Half a degree a second, for two seconds.
        assert_eq!(sweep(-1.0, 0.0, 2000), (0.0, 0.0));
        assert!(sweep(-5.0, 0.0, 500).0 < sweep(-5.0, 0.0, 50).0);
    }

    #[test]
    fn a_still_hand_with_sensor_noise_holds_the_pointer_still() {
        let mut tracker = PointerTracker::new(config());
        let none = PointerInputs::default();
        // The watch's orientation wanders by a few hundredths of a degree a sample around where the hand points.
        let mut travelled = 0.0;
        for n in 0..300u64 {
            let wobble = |k: u64| ((n * k % 7) as f64 - 3.0) * 0.02;
            tracker.update(pointed(wobble(3), wobble(5)), 1.0, Some(n * 10 * MS), none);
            for event in tracker.take_events() {
                if let PointerEvent::Move { dx, dy } = event {
                    travelled += dx.hypot(dy);
                }
            }
        }
        assert!(travelled < 3.0, "the pointer shook {travelled} px in 3 s");
    }

    /// Pointing at `(heading, elevation)` with the forearm rolled `roll` degrees: 0 is palm down, 90 palm to the side.
    fn posed(heading: f64, elevation: f64, roll: f64) -> [f64; 4] {
        let half = roll.to_radians() / 2.0;
        multiply(
            pointed(heading, elevation),
            [half.cos(), half.sin(), 0.0, 0.0],
        )
    }

    /// Sweeps a trackpad tracker `heading` degrees further right over 300 ms with the palm at `roll`, then holds a
    /// second; returns how far the pointer moved across.
    fn stroke(tracker: &mut PointerTracker, from_ms: u64, heading: f64, roll: f64) -> f64 {
        let mut dx = 0.0;
        for n in 0..=130u64 {
            let f = n.min(30) as f64 / 30.0;
            tracker.update(
                posed(-(heading * f), 0.0, roll),
                1.0,
                Some((from_ms + n * 10) * MS),
                PointerInputs::default(),
            );
            dx += moved(&tracker.take_events()).0;
        }
        dx
    }

    #[test]
    fn as_a_trackpad_the_palm_down_moves_the_pointer_and_to_the_side_lifts_it() {
        let mut trackpad = PointerTracker::new(PointerConfig {
            mode: PointerMode::Trackpad,
            ..config()
        });
        // Palm down: a stroke to the right moves the pointer right.
        assert!(stroke(&mut trackpad, 0, 10.0, 0.0) > 50.0);
        assert!(trackpad.is_touching());
        // Palm to the side: the arm goes back to the left, and the pointer stays.
        let mut lifted = 0.0;
        for n in 0..=100u64 {
            let roll = (n.min(20) as f64) * 4.5;
            let heading = -10.0 + 10.0 * (n.saturating_sub(20) as f64 / 80.0);
            trackpad.update(
                posed(heading, 0.0, roll),
                1.0,
                Some((2000 + n * 10) * MS),
                PointerInputs::default(),
            );
            lifted += moved(&trackpad.take_events()).0.abs();
        }
        assert!(!trackpad.is_touching());
        assert!(lifted < 1.0, "moved {lifted} px while lifted");
        // Palm down again, back where the arm started: the next stroke carries on, with no jump back.
        let mut again = PointerTracker::new(PointerConfig {
            mode: PointerMode::Trackpad,
            ..config()
        });
        let first = stroke(&mut again, 0, 10.0, 0.0);
        assert!((stroke(&mut trackpad, 4000, 10.0, 0.0) - first).abs() < first * 0.2);
    }

    #[test]
    fn as_a_trackpad_a_hand_near_the_edge_of_the_pose_does_not_flicker() {
        let mut trackpad = PointerTracker::new(PointerConfig {
            mode: PointerMode::Trackpad,
            ..config()
        });
        let none = PointerInputs::default();
        trackpad.update(posed(0.0, 0.0, 50.0), 1.0, Some(0), none);
        assert!(!trackpad.is_touching(), "50 degrees is not yet a touch");
        trackpad.update(posed(0.0, 0.0, 40.0), 1.0, Some(10 * MS), none);
        assert!(trackpad.is_touching());
        trackpad.update(posed(0.0, 0.0, 55.0), 1.0, Some(20 * MS), none);
        assert!(trackpad.is_touching(), "55 degrees is not yet a lift");
        trackpad.update(posed(0.0, 0.0, 65.0), 1.0, Some(30 * MS), none);
        assert!(!trackpad.is_touching());
        // As a mouse, the pose does not matter.
        let mut mouse = PointerTracker::new(config());
        assert!(mouse.is_touching());
        assert!(stroke(&mut mouse, 0, 10.0, 90.0) > 50.0);
    }

    fn head(config: PointerConfig) -> PointerTracker {
        PointerTracker::new(PointerConfig {
            source: PointerSource::Head,
            ..config
        })
    }

    /// Turns the head from facing (0, 0) to `(yaw, pitch)` over 100 ms, 50 samples a second on the headphones' clock
    /// (which starts far from the watch's), with the watch sending twice as often; returns how far the pointer moved.
    fn turn_head(tracker: &mut PointerTracker, yaw: f64, pitch: f64) -> (f64, f64) {
        let mut events = Vec::new();
        for n in 0..=200u64 {
            let sample = n / 2; // a new headphone sample every other watch reading
            let f = (sample.min(5) as f64) / 5.0;
            let aim = HeadAim {
                yaw_deg: yaw * f,
                pitch_deg: pitch * f,
                timestamp_ns: 7_000_000_000_000 + sample * 20 * MS,
            };
            tracker.update_head(aim, Some(n * 10 * MS), PointerInputs::default());
            events.extend(tracker.take_events());
        }
        moved(&events)
    }

    #[test]
    fn following_the_head_turning_it_right_and_looking_up_moves_the_pointer_right_and_up() {
        let (dx, dy) = turn_head(&mut head(config()), -6.0, 3.0);
        assert!(dx > 40.0 && dx < 80.0, "{dx}");
        assert!(dy < 0.0 && (dx / -dy - 2.0).abs() < 0.2, "{dx} {dy}");
        // The same headphone sample seen again (a watch reading in between) moves nothing more.
        let mut still = head(config());
        let aim = HeadAim {
            yaw_deg: 0.0,
            pitch_deg: 0.0,
            timestamp_ns: 5,
        };
        for n in 0..50 {
            still.update_head(aim, Some(n * 10 * MS), PointerInputs::default());
        }
        assert_eq!(moved(&still.take_events()), (0.0, 0.0));
    }

    #[test]
    fn with_a_head_range_turning_through_it_crosses_the_whole_screen_whatever_the_speed() {
        let ranged = || {
            head(PointerConfig {
                head_range: Some(HeadRange {
                    across_degrees: 40.0,
                    up_degrees: 20.0,
                }),
                ..config()
            })
        };
        let across = |tracker: &mut PointerTracker, yaw: f64, pitch: f64, samples: u64| {
            let mut events = Vec::new();
            for n in 0..=samples + 100 {
                let f = (n.min(samples) as f64) / samples as f64;
                let aim = HeadAim {
                    yaw_deg: yaw * f,
                    pitch_deg: pitch * f,
                    timestamp_ns: n * 10 * MS,
                };
                tracker.update_head(aim, Some(n * 10 * MS), PointerInputs::default());
                events.extend(tracker.take_events());
            }
            assert!(
                events
                    .iter()
                    .all(|e| matches!(e, PointerEvent::MoveScreen { .. })),
                "{events:?}"
            );
            events.iter().fold((0.0, 0.0), |(x, y), e| match e {
                PointerEvent::MoveScreen { dx, dy } => (x + dx, y + dy),
                _ => (x, y),
            })
        };
        // Half the range to the right, quickly or slowly: half the screen, near enough.
        let (fast, _) = across(&mut ranged(), -20.0, 0.0, 30);
        let (slow, _) = across(&mut ranged(), -20.0, 0.0, 200);
        assert!((fast - 0.5).abs() < 0.05, "{fast}");
        assert!((slow - 0.5).abs() < 0.05, "{slow}");
        // The whole range up: from the bottom to the top.
        let (_, up) = across(&mut ranged(), 0.0, 20.0, 100);
        assert!((up + 1.0).abs() < 0.1, "{up}");
        // Only a head pointer goes by the range.
        let mut hand = PointerTracker::new(PointerConfig {
            head_range: Some(HeadRange {
                across_degrees: 40.0,
                up_degrees: 20.0,
            }),
            ..config()
        });
        hand.update(pointed(0.0, 0.0), 1.0, Some(0), PointerInputs::default());
        hand.update(
            pointed(-1.0, 0.0),
            1.0,
            Some(10 * MS),
            PointerInputs::default(),
        );
        assert!(
            hand.take_events()
                .iter()
                .all(|e| matches!(e, PointerEvent::Move { .. }))
        );
        assert!(
            HeadRange {
                across_degrees: 40.0,
                up_degrees: 20.0
            }
            .is_valid()
        );
        assert!(
            !HeadRange {
                across_degrees: 2.0,
                up_degrees: 20.0
            }
            .is_valid()
        );
        assert!(
            !HeadRange {
                across_degrees: 40.0,
                up_degrees: f64::NAN
            }
            .is_valid()
        );
    }

    #[test]
    fn following_the_head_either_direction_can_be_reversed_and_the_palm_does_not_matter() {
        let (dx, dy) = turn_head(
            &mut head(PointerConfig {
                reverse_across: true,
                reverse_up: true,
                mode: PointerMode::Trackpad,
                ..config()
            }),
            -6.0,
            3.0,
        );
        assert!(dx < -40.0 && dy > 0.0, "{dx} {dy}");
    }

    #[test]
    fn following_the_head_a_pinch_still_puts_the_pointer_back_and_clicks() {
        let mut tracker = head(config());
        let mut at_ns = 9_000_000_000_000u64;
        let mut look = |tracker: &mut PointerTracker, from: u64, steps: u64, edges: &[&str]| {
            let edges = set(edges);
            for n in 0..steps {
                let watch = from + n * 10;
                at_ns += 10 * MS;
                let aim = HeadAim {
                    yaw_deg: -(watch as f64) * 0.05,
                    pitch_deg: 0.0,
                    timestamp_ns: at_ns,
                };
                let inputs = PointerInputs {
                    edges: (n == 0).then_some(&edges),
                    held: None,
                };
                tracker.update_head(aim, Some(watch * MS), inputs);
            }
            tracker.take_events()
        };
        look(&mut tracker, 0, 100, &[]);
        let press = look(&mut tracker, 1000, 20, &["pinch_in"]);
        assert_eq!(press.len(), 1, "{press:?}");
        let (back, _) = moved(&press);
        assert!(back < -175.0 && back > -190.0, "{back}");
        assert_eq!(
            buttons(&look(&mut tracker, 1200, 1, &["pinch_out"])),
            vec![PointerEvent::Click]
        );
    }

    /// Runs `steps` updates 10 ms apart from `start`, each pointing a little further right, with these labels.
    fn walk(
        tracker: &mut PointerTracker,
        start: u64,
        steps: u64,
        edges: &[&str],
        held: &[&str],
    ) -> Vec<PointerEvent> {
        let (edges, held) = (set(edges), set(held));
        for n in 0..steps {
            let at = start + n * 10;
            let inputs = PointerInputs {
                edges: (n == 0).then_some(&edges),
                held: Some(&held),
            };
            tracker.update(
                pointed(-(at as f64) * 0.05, 0.0),
                1.0,
                Some(at * MS),
                inputs,
            );
        }
        tracker.take_events()
    }

    #[test]
    fn a_quick_pinch_in_and_out_clicks_where_the_pointer_was_before_it() {
        let mut tracker = PointerTracker::new(config());
        walk(&mut tracker, 0, 100, &[], &[]); // a second of moving, well settled
        let press = walk(&mut tracker, 1000, 20, &["pinch_in"], &[]);
        // The first event puts the pointer back by the last 400 ms of movement (50 degrees a second for 0.4 s is 20
        // degrees, at a gain of about 0.92: some 183 px to the left), and then it stays still.
        assert_eq!(press.len(), 1, "{press:?}");
        let (back, _) = moved(&press);
        assert!(back < -175.0 && back > -190.0, "{back}");
        let release = walk(&mut tracker, 1200, 1, &["pinch_out"], &[]);
        assert_eq!(buttons(&release), vec![PointerEvent::Click]);
        // And the pointer moves again afterwards.
        assert!(moved(&walk(&mut tracker, 1210, 10, &[], &[])).0 > 0.0);
    }

    #[test]
    fn a_pinch_held_presses_the_button_drags_and_lets_go_on_the_release() {
        let mut tracker = PointerTracker::new(config());
        walk(&mut tracker, 0, 100, &[], &[]);
        walk(&mut tracker, 1000, 10, &["pinch_in"], &[]);
        let held = walk(&mut tracker, 1100, 30, &[], &["pinch_hold"]);
        assert_eq!(buttons(&held), vec![PointerEvent::Press]);
        assert!(tracker.is_pressed());
        // The hand drags while the button is down.
        assert!(moved(&walk(&mut tracker, 1400, 30, &[], &["pinch_hold"])).0 > 0.0);
        let release = walk(&mut tracker, 1700, 1, &["pinch_out"], &[]);
        assert_eq!(buttons(&release), vec![PointerEvent::Release]);
        assert!(!tracker.is_pressed());
    }

    #[test]
    fn a_missed_release_still_lets_the_button_go_once_the_hold_is_gone() {
        let mut tracker = PointerTracker::new(config());
        walk(&mut tracker, 0, 100, &[], &[]);
        walk(&mut tracker, 1000, 1, &["pinch_in"], &[]);
        walk(&mut tracker, 1010, 1, &[], &["pinch_hold"]);
        assert!(tracker.is_pressed());
        let later = walk(&mut tracker, 1020, 160, &[], &[]); // 1.6 s with no hold
        assert_eq!(buttons(&later), vec![PointerEvent::Release]);
    }

    #[test]
    fn a_press_with_nothing_after_it_is_forgotten_without_a_click() {
        let mut tracker = PointerTracker::new(config());
        walk(&mut tracker, 0, 100, &[], &[]);
        walk(&mut tracker, 1000, 1, &["pinch_in"], &[]);
        let later = walk(&mut tracker, 1010, 250, &[], &[]);
        assert!(buttons(&later).is_empty());
        assert!(
            moved(&later).0 > 0.0,
            "the pointer moves again once the press is forgotten"
        );
        assert!(buttons(&walk(&mut tracker, 3600, 1, &["pinch_out"], &[])).is_empty());
    }

    #[test]
    fn a_pinch_right_after_pointer_mode_comes_on_is_ignored() {
        let mut tracker = PointerTracker::new(config());
        walk(&mut tracker, 0, 1, &["pinch_in"], &[]);
        assert!(buttons(&walk(&mut tracker, 100, 1, &["pinch_out"], &[])).is_empty());
    }

    #[test]
    fn ending_pointer_mode_never_leaves_the_button_down() {
        let mut tracker = PointerTracker::new(config());
        walk(&mut tracker, 0, 100, &[], &[]);
        walk(&mut tracker, 1000, 1, &["pinch_in"], &[]);
        walk(&mut tracker, 1010, 1, &[], &["pinch_hold"]);
        tracker.take_events();
        tracker.end();
        assert_eq!(tracker.take_events(), vec![PointerEvent::Release]);
        tracker.end();
        assert!(tracker.take_events().is_empty());
    }
}
