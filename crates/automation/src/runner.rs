use std::collections::BTreeSet;

use serde::Serialize;

use crate::device::Output;
use crate::pitch::PitchDirection;
use crate::recipe::{Axis, Hold, ModelHold, Recipe, Stage};
use crate::roll::RollDirection;
use crate::swipe::SwipeDirection;
use crate::tap::TapKind;

/// Everything a recipe can look at, sampled together.
#[derive(Debug, Clone, Copy, Default)]
pub struct Signals<'a> {
    /// The head location currently being dwelled on, if any.
    pub head_location: Option<&'a str>,
    pub pinch_held: bool,
    pub stem_button_held: bool,
    /// A shake was recognised a moment ago and is still counted as happening.
    pub shake: bool,
    /// A swipe was recognised a moment ago in this direction and still counts as happening.
    pub swipe: Option<SwipeDirection>,
    /// A tap was recognised a moment ago and still counts as happening.
    pub tap: Option<TapKind>,
    /// A quick wrist twist was recognised a moment ago in this direction and still counts as happening.
    pub roll: Option<RollDirection>,
    /// A quick tilt of the hand was recognised a moment ago in this direction and still counts as happening.
    pub pitch: Option<PitchDirection>,
    /// The watch's orientation as a quaternion `[w, i, j, k]`; `None` while it has no valid orientation.
    pub orientation: Option<[f64; 4]>,
    /// Model labels detected right now and cleared to act.
    pub models_held: Option<&'a BTreeSet<String>>,
    /// Model labels first detected a moment ago, which still count as happening.
    pub models_pulsed: Option<&'a BTreeSet<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerPhase {
    /// Nothing of the chain holds.
    Idle,
    /// Every head-location stage holds but a later one (a pinch, say) does not yet: the host shows the knob
    /// so the user can see the gesture is recognised, but the device does not move.
    Armed,
    /// Every stage holds and the device is following the wrist.
    Driving,
}

/// Runs one recipe. Feed it [`Signals`] as they change; it returns what the device wants the action to do.
#[derive(Debug)]
pub struct RecipeRunner {
    recipe: Recipe,
    phase: RunnerPhase,
    /// Set by [`Self::cancel`]: stay idle until the chain has been broken once, so an interaction the user
    /// cancelled (Escape) does not restart while they are still holding the same gesture.
    latched: bool,
    /// A trigger recipe's chain completed since [`Self::take_fired`] last looked.
    fired: bool,
    /// The orientation when the chain completed; rotation is measured from here.
    start: [f64; 4],
    /// The previous wrist angle, so each step is measured the short way round.
    last_angle: f64,
    /// Total rotation since the chain completed, unwrapped so an endless knob can turn past 180 degrees.
    rotation: f64,
    last_position: f64,
}

/// Shortest signed angle from `from` to `to`, in degrees, so crossing +/-180 does not jump.
fn shortest_delta(from: f64, to: f64) -> f64 {
    (to - from + 540.0).rem_euclid(360.0) - 180.0
}

impl RecipeRunner {
    pub fn new(recipe: Recipe) -> Self {
        Self {
            recipe,
            phase: RunnerPhase::Idle,
            latched: false,
            fired: false,
            start: [1.0, 0.0, 0.0, 0.0],
            last_angle: 0.0,
            rotation: 0.0,
            last_position: 0.0,
        }
    }

    pub fn recipe(&self) -> &Recipe {
        &self.recipe
    }

    pub fn phase(&self) -> RunnerPhase {
        self.phase
    }

    /// Whether a trigger recipe (one with no wrist rotation) completed its chain since the last call.
    pub fn take_fired(&mut self) -> bool {
        std::mem::take(&mut self.fired)
    }

    /// Ends the interaction and keeps it ended until the user lets go of the chain and starts it again.
    pub fn cancel(&mut self) {
        self.phase = RunnerPhase::Idle;
        self.latched = true;
    }

    /// Ends any interaction (the recipe was disabled or is blocked by a conflict, or the link dropped).
    pub fn reset(&mut self) {
        self.phase = RunnerPhase::Idle;
    }

    fn stage_holds(stage: &Stage, signals: &Signals<'_>) -> bool {
        match stage {
            Stage::HeadAt { location } => signals.head_location == Some(location.as_str()),
            Stage::Hold { hold: Hold::Pinch } => signals.pinch_held,
            Stage::Hold {
                hold: Hold::StemButton,
            } => signals.stem_button_held,
            Stage::Hold { hold: Hold::Shake } => signals.shake,
            Stage::Hold {
                hold: Hold::SwipeLeft,
            } => signals.swipe == Some(SwipeDirection::Left),
            Stage::Hold {
                hold: Hold::SwipeRight,
            } => signals.swipe == Some(SwipeDirection::Right),
            Stage::Hold {
                hold: Hold::SwipeUp,
            } => signals.swipe == Some(SwipeDirection::Up),
            Stage::Hold {
                hold: Hold::SwipeDown,
            } => signals.swipe == Some(SwipeDirection::Down),
            Stage::Hold { hold: Hold::Tap } => signals.tap == Some(TapKind::Single),
            Stage::Hold {
                hold: Hold::DoubleTap,
            } => signals.tap == Some(TapKind::Double),
            Stage::Hold {
                hold: Hold::RollClockwise,
            } => signals.roll == Some(RollDirection::Clockwise),
            Stage::Hold {
                hold: Hold::RollCounterClockwise,
            } => signals.roll == Some(RollDirection::CounterClockwise),
            Stage::Hold {
                hold: Hold::PitchUp,
            } => signals.pitch == Some(PitchDirection::Up),
            Stage::Hold {
                hold: Hold::PitchDown,
            } => signals.pitch == Some(PitchDirection::Down),
            Stage::Model { label, hold } => match hold {
                ModelHold::Held => signals.models_held,
                ModelHold::OneShot => signals.models_pulsed,
            }
            .is_some_and(|labels| labels.contains(label)),
            Stage::Drive { .. } => true,
        }
    }

    /// A unit quaternion, or `None` for anything that is not a usable orientation.
    fn unit(q: [f64; 4]) -> Option<[f64; 4]> {
        let norm = q.iter().map(|c| c * c).sum::<f64>().sqrt();
        (q.iter().all(|c| c.is_finite()) && norm > 1e-9).then(|| q.map(|c| c / norm))
    }

    /// Rotation about `axis` of the body, in degrees in (-180, 180], from `start` to `current`.
    fn twist(start: [f64; 4], current: [f64; 4], axis: Axis) -> f64 {
        // relative = conjugate(start) * current
        let [sw, si, sj, sk] = start;
        let [cw, ci, cj, ck] = current;
        let w = sw * cw + si * ci + sj * cj + sk * ck;
        let i = sw * ci - si * cw - sj * ck + sk * cj;
        let j = sw * cj + si * ck - sj * cw - sk * ci;
        let k = sw * ck - si * cj + sj * ci - sk * cw;
        let component = match axis {
            Axis::Roll => i,
            Axis::Pitch => j,
            Axis::Yaw => k,
        };
        let degrees = (2.0 * component.atan2(w)).to_degrees();
        (degrees + 540.0).rem_euclid(360.0) - 180.0
    }

    /// Returns the output for this reading, if the device moved.
    pub fn update(&mut self, signals: &Signals<'_>) -> Option<Output> {
        let drive = match self.recipe.stages.last() {
            Some(&Stage::Drive {
                axis,
                dead_zone_degrees,
                invert,
            }) => Some((axis, dead_zone_degrees, invert)),
            _ => None,
        };
        let chain_holds = self.recipe.enabled
            && !self.recipe.stages.is_empty()
            && self
                .recipe
                .stages
                .iter()
                .all(|stage| Self::stage_holds(stage, signals));
        let orientation = signals.orientation.and_then(Self::unit);

        let mut gates = self
            .recipe
            .stages
            .iter()
            .filter(|stage| matches!(stage, Stage::HeadAt { .. }))
            .peekable();
        let has_gates = gates.peek().is_some();
        let gates_hold = self.recipe.enabled
            && has_gates
            && gates.all(|stage| Self::stage_holds(stage, signals));
        if self.latched {
            if !chain_holds && !gates_hold {
                self.latched = false;
            }
            self.phase = RunnerPhase::Idle;
            return None;
        }
        let Some((axis, dead_zone_degrees, invert)) = drive else {
            // A trigger recipe has no wrist rotation: it fires once as its chain completes, and is "driving"
            // for as long as the chain keeps holding so it cannot fire again until it has been let go.
            if chain_holds {
                if self.phase != RunnerPhase::Driving {
                    self.phase = RunnerPhase::Driving;
                    self.fired = true;
                }
            } else {
                self.phase = if gates_hold {
                    RunnerPhase::Armed
                } else {
                    RunnerPhase::Idle
                };
            }
            return None;
        };
        let (true, Some(orientation)) = (chain_holds, orientation) else {
            self.phase = if gates_hold {
                RunnerPhase::Armed
            } else {
                RunnerPhase::Idle
            };
            return None;
        };
        if self.phase != RunnerPhase::Driving {
            self.phase = RunnerPhase::Driving;
            self.start = orientation;
            self.last_angle = 0.0;
            self.rotation = 0.0;
            self.last_position = 0.0;
            return None;
        }
        // Follow the shortest step each time so the +/-180 seam never causes a jump.
        let angle = Self::twist(self.start, orientation, axis);
        self.rotation += shortest_delta(self.last_angle, angle);
        self.last_angle = angle;
        let signed = if invert {
            -self.rotation
        } else {
            self.rotation
        };
        let outside_dead_zone = signed.signum() * (signed.abs() - dead_zone_degrees).max(0.0);
        let position = self.recipe.device.position(outside_dead_zone);
        let delta = position - self.last_position;
        self.last_position = position;
        (delta != 0.0).then_some(Output {
            delta_fraction: delta,
        })
    }
}
