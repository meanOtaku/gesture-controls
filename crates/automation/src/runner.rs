use serde::Serialize;

use crate::device::Output;
use crate::recipe::{Axis, Hold, Recipe, Stage};

/// Everything a recipe can look at, sampled together.
#[derive(Debug, Clone, Copy, Default)]
pub struct Signals<'a> {
    /// The head location currently being dwelled on, if any.
    pub head_location: Option<&'a str>,
    pub pinch_held: bool,
    pub stem_button_held: bool,
    /// Wrist rotation in degrees about each axis; `None` while the watch has no valid orientation.
    pub roll: Option<f64>,
    pub pitch: Option<f64>,
    pub yaw: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerPhase {
    /// Waiting for the earlier stages to all hold.
    Idle,
    /// Every stage holds and the device is following the wrist.
    Driving,
}

/// Runs one recipe. Feed it [`Signals`] as they change; it returns what the device wants the action to do.
#[derive(Debug)]
pub struct RecipeRunner {
    recipe: Recipe,
    phase: RunnerPhase,
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
            Stage::Drive { .. } => true,
        }
    }

    fn angle(axis: Axis, signals: &Signals<'_>) -> Option<f64> {
        match axis {
            Axis::Roll => signals.roll,
            Axis::Pitch => signals.pitch,
            Axis::Yaw => signals.yaw,
        }
        .filter(|angle| angle.is_finite())
    }

    /// Returns the output for this reading, if the device moved.
    pub fn update(&mut self, signals: &Signals<'_>) -> Option<Output> {
        let Some(Stage::Drive { axis }) = self.recipe.stages.last() else {
            return None;
        };
        let axis = *axis;
        let chain_holds = self.recipe.enabled
            && self
                .recipe
                .stages
                .iter()
                .all(|stage| Self::stage_holds(stage, signals));
        let angle = Self::angle(axis, signals);

        let (true, Some(angle)) = (chain_holds, angle) else {
            self.phase = RunnerPhase::Idle;
            return None;
        };
        if self.phase == RunnerPhase::Idle {
            self.phase = RunnerPhase::Driving;
            self.last_angle = angle;
            self.rotation = 0.0;
            self.last_position = 0.0;
            return None;
        }
        // Follow the shortest step each time so the +/-180 seam never causes a jump.
        self.rotation += shortest_delta(self.last_angle, angle);
        self.last_angle = angle;
        let position = self.recipe.device.position(self.rotation);
        let delta = position - self.last_position;
        self.last_position = position;
        (delta != 0.0).then_some(Output {
            delta_fraction: delta,
        })
    }
}
