//! Pointer mode: the hand moves the mouse pointer and a pinch clicks.
//!
//! **Movement.** The pointer follows where the forearm points, in the world frame: turning it left or right (its
//! heading) moves the pointer across, raising or lowering it (its elevation) moves it up and down. Using the forearm's
//! direction rather than the watch's own axes means rolling the wrist does not move the pointer, and the same gesture
//! works however the hand is turned. Slow movement is scaled down for precision and fast movement up for reach, and
//! movement slower than hand tremor is ignored.
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
    /// Press and release the left button where the pointer is.
    Click,
    /// Press the left button and keep it down.
    Press,
    /// Let the left button go.
    Release,
}

/// The settings of one pointer step.
#[derive(Debug, Clone, PartialEq)]
pub struct PointerConfig {
    pub pixels_per_degree: f64,
    pub press_label: String,
    pub hold_label: String,
    pub release_label: String,
    pub lookback_ns: u64,
}

/// Movement slower than this is tremor or sensor noise, and moves nothing.
const MIN_SPEED_DEGREES_PER_SECOND: f64 = 1.0;
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
            events: Vec::new(),
        }
    }

    pub fn is_pressed(&self) -> bool {
        self.pressed
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
        self.movement(pointing(orientation, hand_sign), now_ns);
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

    /// Puts the pointer back where it was `lookback` before now.
    fn rewind(&mut self, now_ns: Option<u64>) {
        let Some(now) = now_ns else {
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
            self.events.push(PointerEvent::Move { dx: -dx, dy: -dy });
        }
    }

    fn movement(&mut self, now: Pointing, now_ns: Option<u64>) {
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
        let gain =
            (0.5 + speed / (2.0 * REFERENCE_SPEED_DEGREES_PER_SECOND)).clamp(MIN_GAIN, MAX_GAIN);
        let scale = self.config.pixels_per_degree * gain;
        // Heading grows anticlockwise seen from above, so pointing further right lowers it; screen y grows downwards.
        let (dx, dy) = (-across * scale, -up * scale);
        self.events.push(PointerEvent::Move { dx, dy });
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

    #[test]
    fn pointing_right_and_up_moves_the_pointer_right_and_up() {
        let mut tracker = PointerTracker::new(config());
        let none = PointerInputs::default();
        tracker.update(pointed(0.0, 0.0), 1.0, Some(0), none);
        // 6 degrees to the right (heading down) and 3 up, in 100 ms: about 67 degrees a second, a gain of about 1.06.
        tracker.update(pointed(-6.0, 3.0), 1.0, Some(100 * MS), none);
        let (dx, dy) = moved(&tracker.take_events());
        assert!(dx > 60.0 && dx < 66.0, "{dx}");
        assert!(dy < -30.0 && dy > -33.0, "{dy}");
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
        let none = PointerInputs::default();
        let mut drift = PointerTracker::new(config());
        drift.update(pointed(0.0, 0.0), 1.0, Some(0), none);
        drift.update(pointed(-0.05, 0.0), 1.0, Some(100 * MS), none); // 0.5 degrees a second
        assert!(drift.take_events().is_empty());

        let distance = |millis: u64| {
            let mut tracker = PointerTracker::new(config());
            tracker.update(pointed(0.0, 0.0), 1.0, Some(0), none);
            tracker.update(pointed(-5.0, 0.0), 1.0, Some(millis * MS), none);
            moved(&tracker.take_events()).0
        };
        assert!(distance(500) < distance(50));
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
