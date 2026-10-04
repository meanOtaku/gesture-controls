//! Runs the gesture recipes: collects the live signals (head location, pinch, STEM button, watch
//! orientation), steps every recipe, and applies the result to the volume overlay.
//!
//! The decisions live in [`Engine`], which knows nothing about Tauri and is unit-tested; the runtime around
//! it only feeds it signals and carries out the [`Effects`] it returns.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use automation::{
    Action, Axis, Conflict, CrownSide, Device, DeviceKind, Hold, PitchConfig, PitchDetector,
    PitchDirection, Recipe, RecipeRunner, RotateConfig, RotateDetector, RotateDirection,
    RunnerPhase, ShakeConfig, ShakeDetector, Signals, Stage, SwipeConfig, SwipeDetector,
    SwipeDirection, TapConfig, TapDetector, TapKind, Wrist, blocked_recipes, find_conflicts,
    validate_recipe,
};
use interaction_engine::quaternion_angular_distance;
use serde::Serialize;
use spatial_protocol::WatchOrientationSample;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::actuators::Actuators;
use crate::overlay::{OverlayRuntime, VolumeRuntime};
use crate::settings::{AppSettings, SettingsRuntime};

pub const AUTOMATION_STATE_EVENT: &str = "automation-state";
/// Sent each time a shake is recognised, so Settings can show the user what their sensitivity is catching.
pub const SHAKE_DETECTED_EVENT: &str = "automation-shake";
/// Sent with the direction each time a swipe is recognised.
pub const SWIPE_DETECTED_EVENT: &str = "automation-swipe";
/// Sent with `single` or `double` each time a tap is recognised.
pub const TAP_DETECTED_EVENT: &str = "automation-tap";
/// Sent with `clockwise` or `counterClockwise` each time a quick wrist twist is recognised.
pub const ROTATE_DETECTED_EVENT: &str = "automation-rotate";
/// Sent with `up` or `down` each time a quick tilt of the hand is recognised.
pub const PITCH_DETECTED_EVENT: &str = "automation-pitch";
/// How long a recognised shake keeps counting as "happening", so a recipe that combines it with another step (look
/// at a location, say) has a moment in which both hold.
/// Also how long a swipe keeps counting.
const SHAKE_HOLD_NS: u64 = 600_000_000;
const RECIPES_FILE_NAME: &str = "recipes.json";
pub const MAX_RECIPES: usize = 24;

/// What the UI shows: every recipe, which of them are held off by a conflict, and the conflicts themselves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationState {
    pub recipes: Vec<Recipe>,
    pub blocked: Vec<String>,
    pub conflicts: Vec<Conflict>,
}

/// How the volume overlay should look for the current recipes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayWanted {
    Hidden,
    /// Looking at a recipe's location: show the knob but do not move it.
    Armed,
    /// A recipe's whole chain holds: the knob follows the wrist.
    Driving,
}

#[derive(Debug, Default, PartialEq)]
pub struct Effects {
    /// Set only when the overlay needs to change.
    pub overlay: Option<OverlayWanted>,
    /// Changes to apply, each an action and a fraction of its full range.
    pub deltas: Vec<(Action, f64)>,
    /// A shake was recognised on this sample (whether or not any recipe uses it), for the Settings tuning aid.
    pub shook: bool,
    /// A swipe was recognised on this sample, for the Settings tuning aid.
    pub swiped: Option<SwipeDirection>,
    /// A quick tilt of the hand was recognised on this sample, for the Settings tuning aid.
    pub pitched: Option<PitchDirection>,
    /// A quick wrist twist was recognised on this sample, for the Settings tuning aid.
    pub rotated: Option<RotateDirection>,
    /// A tap was recognised on this sample, for the Settings tuning aid.
    pub tapped: Option<TapKind>,
    /// Trigger recipes that fired: each a one-off press.
    pub fired: Vec<Action>,
    /// Actions whose interaction just ended, so anything still carried for them is dropped.
    pub ended: Vec<Action>,
}

/// Wrist limits that apply to every recipe and so live in Settings: how fast a twist may be before it is
/// treated as a glitch, and how fast the volume may move. A recipe's own feel (dead zone, sensitivity,
/// device) is part of the recipe.
#[derive(Debug, Clone, Copy)]
pub struct Tuning {
    pub max_angular_velocity_degrees_per_second: f64,
    pub max_volume_points_per_second: f64,
    pub shake_peak_threshold: f64,
    pub shake_strokes: u32,
    pub swipe_peak_threshold: f64,
    pub tap_peak_threshold: f64,
    pub rotate_angle_degrees: f64,
    pub pitch_angle_degrees: f64,
    pub wrist: Wrist,
    pub crown: CrownSide,
}

impl Tuning {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            max_angular_velocity_degrees_per_second: settings
                .wrist_max_angular_velocity_degrees_per_second,
            max_volume_points_per_second: settings.wrist_max_volume_points_per_second,
            shake_peak_threshold: settings.shake_peak_threshold,
            shake_strokes: settings.shake_strokes,
            swipe_peak_threshold: settings.swipe_peak_threshold,
            tap_peak_threshold: settings.tap_peak_threshold,
            rotate_angle_degrees: settings.rotate_angle_degrees,
            pitch_angle_degrees: settings.pitch_angle_degrees,
            wrist: settings.watch_wrist,
            crown: settings.crown_side,
        }
    }

    pub fn pitch_config(&self) -> PitchConfig {
        PitchConfig {
            min_angle_degrees: self.pitch_angle_degrees,
            wrist: self.wrist,
            crown: self.crown,
            ..PitchConfig::default()
        }
    }

    pub fn rotate_config(&self) -> RotateConfig {
        RotateConfig {
            min_angle_degrees: self.rotate_angle_degrees,
            wrist: self.wrist,
            crown: self.crown,
            ..RotateConfig::default()
        }
    }

    pub fn tap_config(&self) -> TapConfig {
        TapConfig {
            peak_threshold: self.tap_peak_threshold,
            ..TapConfig::default()
        }
    }

    pub fn swipe_config(&self) -> SwipeConfig {
        SwipeConfig {
            peak_threshold: self.swipe_peak_threshold,
            crown: self.crown,
            ..SwipeConfig::default()
        }
    }

    /// The shake detector's settings: `strokes` quick strokes are `strokes - 1` changes of direction, and a longer
    /// run needs a longer window to fit in.
    pub fn shake_config(&self) -> ShakeConfig {
        let reversals = self.shake_strokes.saturating_sub(1).max(1) as usize;
        ShakeConfig {
            peak_threshold: self.shake_peak_threshold,
            reversals,
            window_ns: (reversals as u64 * 400_000_000).max(1_200_000_000),
            ..ShakeConfig::default()
        }
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            max_angular_velocity_degrees_per_second: 360.0,
            max_volume_points_per_second: 30.0,
            shake_peak_threshold: 6.0,
            shake_strokes: 4,
            swipe_peak_threshold: 8.0,
            tap_peak_threshold: 12.0,
            rotate_angle_degrees: 60.0,
            pitch_angle_degrees: 40.0,
            wrist: Wrist::Left,
            crown: CrownSide::Right,
        }
    }
}

/// The recipes a fresh install starts with. They reproduce what the hard-wired gestures did: look at the top
/// right so the knob appears, hold the STEM button (or pinch), and roll the wrist. Only one volume recipe is
/// enabled, because two on the same resource conflict and are both held off.
pub fn default_recipes() -> Vec<Recipe> {
    let look = || Stage::HeadAt {
        location: "topRight".into(),
    };
    let roll = || Stage::Drive {
        axis: Axis::Roll,
        dead_zone_degrees: 3.0,
        invert: false,
    };
    let knob = Device::default_for(DeviceKind::RotationKnob);
    let recipe = |id: &str, name: &str, enabled: bool, stages: Vec<Stage>| Recipe {
        id: id.into(),
        name: name.into(),
        enabled,
        stages,
        device: knob,
        action: Action::Volume,
    };
    vec![
        recipe(
            "lookStemVolume",
            "Look top right, hold STEM, roll",
            true,
            vec![
                look(),
                Stage::Hold {
                    hold: Hold::StemButton,
                },
                roll(),
            ],
        ),
        recipe(
            "lookPinchVolume",
            "Look top right, pinch, roll",
            false,
            vec![look(), Stage::Hold { hold: Hold::Pinch }, roll()],
        ),
        recipe(
            "lookVolume",
            "Look top right, roll",
            false,
            vec![look(), roll()],
        ),
    ]
}

struct Orientation {
    quaternion: [f64; 4],
    timestamp_ns: u64,
}

pub struct Engine {
    recipes: Vec<Recipe>,
    runners: Vec<RecipeRunner>,
    /// Each runner's phase after the previous step, to notice when one stops driving.
    previous_phases: Vec<RunnerPhase>,
    /// Whether any recipe is turning its device right now.
    driving: bool,
    tuning: Tuning,
    head: Option<String>,
    pinch: bool,
    stem: bool,
    orientation: Option<Orientation>,
    shake: ShakeDetector,
    /// A recognised shake counts as happening until this watch-clock time, so a recipe's chain can see it.
    shake_until_ns: u64,
    swipe: SwipeDetector,
    swipe_direction: Option<SwipeDirection>,
    swipe_until_ns: u64,
    tap: TapDetector,
    tap_kind: Option<TapKind>,
    tap_until_ns: u64,
    rotate: RotateDetector,
    rotate_direction: Option<RotateDirection>,
    rotate_until_ns: u64,
    pitch: PitchDetector,
    pitch_direction: Option<PitchDirection>,
    pitch_until_ns: u64,
    /// The last orientation accepted while driving, for the angular-velocity outlier check.
    last_accepted: Option<Orientation>,
    blocked: BTreeSet<String>,
    overlay: OverlayWanted,
}

impl Engine {
    pub fn new(recipes: Vec<Recipe>, tuning: Tuning) -> Self {
        let mut engine = Self {
            recipes: Vec::new(),
            runners: Vec::new(),
            previous_phases: Vec::new(),
            driving: false,
            tuning,
            head: None,
            pinch: false,
            stem: false,
            orientation: None,
            shake: ShakeDetector::new(tuning.shake_config()),
            shake_until_ns: 0,
            swipe: SwipeDetector::new(tuning.swipe_config()),
            swipe_direction: None,
            swipe_until_ns: 0,
            tap: TapDetector::new(tuning.tap_config()),
            tap_kind: None,
            tap_until_ns: 0,
            rotate: RotateDetector::new(tuning.rotate_config()),
            rotate_direction: None,
            rotate_until_ns: 0,
            pitch: PitchDetector::new(tuning.pitch_config()),
            pitch_direction: None,
            pitch_until_ns: 0,
            last_accepted: None,
            blocked: BTreeSet::new(),
            overlay: OverlayWanted::Hidden,
        };
        engine.set_recipes(recipes);
        engine
    }

    fn rebuild(&mut self) {
        self.blocked = blocked_recipes(&self.recipes);
        self.runners = self
            .recipes
            .iter()
            .map(|recipe| RecipeRunner::new(recipe.clone()))
            .collect();
        self.previous_phases = vec![RunnerPhase::Idle; self.recipes.len()];
    }

    pub fn set_recipes(&mut self, recipes: Vec<Recipe>) -> Effects {
        self.recipes = recipes;
        self.rebuild();
        self.step()
    }

    pub fn set_tuning(&mut self, tuning: Tuning) -> Effects {
        self.tuning = tuning;
        self.shake = ShakeDetector::new(tuning.shake_config());
        self.shake_until_ns = 0;
        self.swipe = SwipeDetector::new(tuning.swipe_config());
        self.swipe_until_ns = 0;
        self.tap = TapDetector::new(tuning.tap_config());
        self.tap_until_ns = 0;
        self.rotate = RotateDetector::new(tuning.rotate_config());
        self.rotate_until_ns = 0;
        self.pitch = PitchDetector::new(tuning.pitch_config());
        self.pitch_until_ns = 0;
        self.rebuild();
        self.step()
    }

    pub fn recipes(&self) -> &[Recipe] {
        &self.recipes
    }

    pub fn state(&self) -> AutomationState {
        AutomationState {
            recipes: self.recipes.clone(),
            blocked: self.blocked.iter().cloned().collect(),
            conflicts: find_conflicts(&self.recipes),
        }
    }

    pub fn set_head(&mut self, location: Option<String>) -> Effects {
        self.head = location;
        self.step()
    }

    pub fn set_pinch(&mut self, held: bool) -> Effects {
        self.pinch = held;
        self.step()
    }

    pub fn set_stem(&mut self, held: bool) -> Effects {
        self.stem = held;
        self.step()
    }

    /// The watch went away: nothing it contributed can still hold.
    pub fn watch_lost(&mut self) -> Effects {
        self.pinch = false;
        self.stem = false;
        self.orientation = None;
        self.last_accepted = None;
        self.shake.reset();
        self.shake_until_ns = 0;
        self.swipe.reset();
        self.swipe_until_ns = 0;
        self.tap.reset();
        self.tap_until_ns = 0;
        self.rotate.reset();
        self.rotate_until_ns = 0;
        self.pitch.reset();
        self.pitch_until_ns = 0;
        self.step()
    }

    /// Escape or a forced release: end whatever is running until the user lets go and starts again.
    pub fn cancel(&mut self) -> Effects {
        for runner in &mut self.runners {
            runner.cancel();
        }
        self.pinch = false;
        self.step()
    }

    pub fn observe_orientation(
        &mut self,
        quaternion: [f64; 4],
        timestamp_ns: u64,
        acceleration: Option<[f64; 3]>,
    ) -> Effects {
        if self
            .orientation
            .as_ref()
            .is_some_and(|previous| timestamp_ns <= previous.timestamp_ns)
        {
            return Effects::default();
        }
        // A shake is judged on every sample, even one the glitch filter below discards: a shake is exactly the sort
        // of fast movement that filter exists for.
        let shook =
            acceleration.is_some_and(|acceleration| self.shake.observe(timestamp_ns, acceleration));
        if shook {
            self.shake_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let swiped = acceleration
            .and_then(|acceleration| self.swipe.observe(timestamp_ns, acceleration, quaternion));
        if let Some(direction) = swiped {
            self.swipe_direction = Some(direction);
            self.swipe_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let tapped =
            acceleration.and_then(|acceleration| self.tap.observe(timestamp_ns, acceleration));
        if let Some(kind) = tapped {
            self.tap_kind = Some(kind);
            self.tap_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let rotated = self.rotate.observe(timestamp_ns, quaternion);
        if let Some(direction) = rotated {
            self.rotate_direction = Some(direction);
            self.rotate_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let pitched = self.pitch.observe(timestamp_ns, quaternion);
        if let Some(direction) = pitched {
            self.pitch_direction = Some(direction);
            self.pitch_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let driving = self.driving;
        if driving && self.is_velocity_outlier(quaternion, timestamp_ns) {
            // A glitch freezes the knob rather than jumping it; the last good orientation stays current.
            return Effects {
                shook,
                swiped,
                tapped,
                rotated,
                pitched,
                ..Effects::default()
            };
        }
        let sample = Orientation {
            quaternion,
            timestamp_ns,
        };
        self.last_accepted = driving.then_some(Orientation {
            quaternion,
            timestamp_ns,
        });
        self.orientation = Some(sample);
        let mut effects = self.step();
        effects.shook = shook;
        effects.swiped = swiped;
        effects.tapped = tapped;
        effects.rotated = rotated;
        effects.pitched = pitched;
        effects
    }

    fn is_velocity_outlier(&self, quaternion: [f64; 4], timestamp_ns: u64) -> bool {
        let Some(previous) = &self.last_accepted else {
            return false;
        };
        let Ok(distance) = quaternion_angular_distance(previous.quaternion, quaternion) else {
            return true;
        };
        let seconds = (timestamp_ns.saturating_sub(previous.timestamp_ns)) as f64 / 1e9;
        seconds > 0.0
            && distance.to_degrees() / seconds > self.tuning.max_angular_velocity_degrees_per_second
    }

    /// Steps every recipe that is not held off by a conflict and works out what the overlay needs.
    fn step(&mut self) -> Effects {
        let signals = Signals {
            head_location: self.head.as_deref(),
            pinch_held: self.pinch,
            stem_button_held: self.stem,
            pitch: self
                .orientation
                .as_ref()
                .filter(|latest| latest.timestamp_ns < self.pitch_until_ns)
                .and(self.pitch_direction),
            rotate: self
                .orientation
                .as_ref()
                .filter(|latest| latest.timestamp_ns < self.rotate_until_ns)
                .and(self.rotate_direction),
            tap: self
                .orientation
                .as_ref()
                .filter(|latest| latest.timestamp_ns < self.tap_until_ns)
                .and(self.tap_kind),
            swipe: self
                .orientation
                .as_ref()
                .filter(|latest| latest.timestamp_ns < self.swipe_until_ns)
                .and(self.swipe_direction),
            shake: self
                .orientation
                .as_ref()
                .is_some_and(|latest| latest.timestamp_ns < self.shake_until_ns),
            orientation: self.orientation.as_ref().map(|o| o.quaternion),
        };
        let mut wanted = OverlayWanted::Hidden;
        let mut effects = Effects::default();
        let mut driving = false;
        for (index, (recipe, runner)) in self.recipes.iter().zip(&mut self.runners).enumerate() {
            if self.blocked.contains(&recipe.id) {
                runner.reset();
            } else if let Some(output) = runner.update(&signals) {
                effects.deltas.push((recipe.action, output.delta_fraction));
            }
            if runner.take_fired() {
                effects.fired.push(recipe.action);
            }
            let phase = runner.phase();
            // A trigger is "driving" only while its chain is held; it moves nothing, so it must not engage the
            // glitch filter or have anything to wind down.
            let continuous = !recipe.action.is_trigger();
            driving |= continuous && phase == RunnerPhase::Driving;
            if continuous
                && self.previous_phases[index] == RunnerPhase::Driving
                && phase != RunnerPhase::Driving
                && !effects.ended.contains(&recipe.action)
            {
                effects.ended.push(recipe.action);
            }
            self.previous_phases[index] = phase;
            // The volume knob on screen is only for recipes that control volume.
            if recipe.action == Action::Volume {
                wanted = match (wanted, phase) {
                    (_, RunnerPhase::Driving) | (OverlayWanted::Driving, _) => {
                        OverlayWanted::Driving
                    }
                    (_, RunnerPhase::Armed) | (OverlayWanted::Armed, _) => OverlayWanted::Armed,
                    _ => OverlayWanted::Hidden,
                };
            }
        }
        self.driving = driving;
        if wanted != self.overlay {
            self.overlay = wanted;
            effects.overlay = Some(wanted);
        }
        effects
    }

    pub fn max_volume_points_per_second(&self) -> f64 {
        self.tuning.max_volume_points_per_second
    }
}

fn recipes_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(RECIPES_FILE_NAME))
        .map_err(|error| error.to_string())
}

/// Recipes from disk, keeping only well-formed ones; the defaults when there is no usable file.
fn load_recipes(app: &AppHandle) -> Vec<Recipe> {
    let loaded = recipes_path(app)
        .and_then(|path| fs::read_to_string(path).map_err(|error| error.to_string()))
        .and_then(|text| serde_json::from_str::<Vec<Recipe>>(&text).map_err(|e| e.to_string()));
    match loaded {
        Ok(recipes) => recipes
            .into_iter()
            .filter(|recipe| match validate_recipe(recipe) {
                Ok(()) => true,
                Err(error) => {
                    warn!(recipe = %recipe.id, %error, "dropped an invalid saved recipe");
                    false
                }
            })
            .collect(),
        Err(_) => default_recipes(),
    }
}

fn save_recipes(app: &AppHandle, recipes: &[Recipe]) {
    let result = recipes_path(app).and_then(|path| {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        let json = serde_json::to_string_pretty(recipes).map_err(|error| error.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|error| error.to_string())?;
        fs::rename(&tmp, &path).map_err(|error| error.to_string())
    });
    if let Err(error) = result {
        warn!(%error, "failed to save the recipes");
    }
}

pub struct AutomationRuntime {
    /// Serializes "step the engine, then apply what it asked for", so effects from the head, watch and
    /// inference threads reach the overlay in the order they were decided.
    operations: Mutex<()>,
    engine: Mutex<Engine>,
    actuators: Actuators,
}

impl Default for AutomationRuntime {
    fn default() -> Self {
        Self {
            operations: Mutex::new(()),
            engine: Mutex::new(Engine::new(default_recipes(), Tuning::default())),
            actuators: Actuators::default(),
        }
    }
}

impl AutomationRuntime {
    /// Loads the saved recipes and the wrist tuning from Settings. Called once at startup.
    pub fn load(&self, app: &AppHandle) {
        let tuning = app
            .state::<SettingsRuntime>()
            .get()
            .map(|settings| Tuning::from_settings(&settings))
            .unwrap_or_default();
        let recipes = load_recipes(app);
        self.with_engine(app, |engine| {
            engine.set_tuning(tuning);
            engine.set_recipes(recipes)
        });
    }

    fn with_engine(&self, app: &AppHandle, step: impl FnOnce(&mut Engine) -> Effects) {
        let Ok(_operation) = self.operations.lock() else {
            return;
        };
        let (effects, state, max_points) = {
            let Ok(mut engine) = self.engine.lock() else {
                return;
            };
            let effects = step(&mut engine);
            (
                effects,
                engine.state(),
                engine.max_volume_points_per_second(),
            )
        };
        apply_effects(app, &effects, max_points);
        if effects.shook {
            let _ = app.emit(SHAKE_DETECTED_EVENT, ());
        }
        if let Some(direction) = effects.pitched {
            let _ = app.emit(PITCH_DETECTED_EVENT, direction);
        }
        if let Some(direction) = effects.rotated {
            let _ = app.emit(ROTATE_DETECTED_EVENT, direction);
        }
        if let Some(kind) = effects.tapped {
            let _ = app.emit(TAP_DETECTED_EVENT, kind);
        }
        if let Some(direction) = effects.swiped {
            let _ = app.emit(SWIPE_DETECTED_EVENT, direction);
        }
        if effects.overlay.is_some() {
            let _ = app.emit(AUTOMATION_STATE_EVENT, &state);
        }
    }

    pub fn state(&self) -> Result<AutomationState, String> {
        Ok(self
            .engine
            .lock()
            .map_err(|_| "recipe engine lock was poisoned")?
            .state())
    }

    pub fn set_head(&self, app: &AppHandle, location: Option<String>) {
        self.with_engine(app, |engine| engine.set_head(location));
    }

    pub fn set_pinch(&self, app: &AppHandle, held: bool) {
        self.with_engine(app, |engine| engine.set_pinch(held));
    }

    pub fn set_stem(&self, app: &AppHandle, held: bool) {
        self.with_engine(app, |engine| engine.set_stem(held));
    }

    pub fn watch_lost(&self, app: &AppHandle) {
        self.with_engine(app, Engine::watch_lost);
    }

    pub fn cancel(&self, app: &AppHandle) {
        self.with_engine(app, Engine::cancel);
    }

    pub fn observe_orientation(&self, app: &AppHandle, sample: &WatchOrientationSample) {
        self.with_engine(app, |engine| {
            engine.observe_orientation(sample.quaternion, sample.timestamp_ns, sample.accelerometer)
        });
    }

    /// Applies new wrist tuning from Settings; ends any interaction in progress.
    pub fn apply_settings(&self, app: &AppHandle, settings: &AppSettings) {
        let tuning = Tuning::from_settings(settings);
        self.with_engine(app, |engine| engine.set_tuning(tuning));
    }

    fn current_recipes(&self) -> Result<Vec<Recipe>, String> {
        Ok(self
            .engine
            .lock()
            .map_err(|_| "recipe engine lock was poisoned")?
            .recipes()
            .to_vec())
    }

    /// Saves, applies and announces a new recipe list.
    fn commit_recipes(
        &self,
        app: &AppHandle,
        recipes: Vec<Recipe>,
    ) -> Result<AutomationState, String> {
        save_recipes(app, &recipes);
        self.with_engine(app, |engine| engine.set_recipes(recipes));
        // The state event is how the UI hears about the change, even when the overlay is unaffected.
        let state = self.state()?;
        let _ = app.emit(AUTOMATION_STATE_EVENT, &state);
        Ok(state)
    }

    pub fn set_recipe_enabled(
        &self,
        app: &AppHandle,
        id: &str,
        enabled: bool,
    ) -> Result<AutomationState, String> {
        let mut recipes = self.current_recipes()?;
        recipes
            .iter_mut()
            .find(|recipe| recipe.id == id)
            .ok_or("there is no such recipe")?
            .enabled = enabled;
        self.commit_recipes(app, recipes)
    }

    /// Adds a recipe (an empty id asks for a new one) or replaces the one with that id.
    pub fn save_recipe(
        &self,
        app: &AppHandle,
        mut recipe: Recipe,
        known_locations: &[String],
    ) -> Result<AutomationState, String> {
        validate_recipe(&recipe).map_err(|error| error.to_string())?;
        check_locations(&recipe, known_locations)?;
        let mut recipes = self.current_recipes()?;
        if recipe.id.is_empty() {
            recipe.id = new_recipe_id();
        }
        recipe.name = recipe.name.trim().to_string();
        if let Some(position) = recipes.iter().position(|existing| existing.id == recipe.id) {
            recipes[position] = recipe;
        } else if recipes.len() >= MAX_RECIPES {
            return Err(format!(
                "the most recipes allowed ({MAX_RECIPES}) has been reached"
            ));
        } else {
            recipes.push(recipe);
        }
        self.commit_recipes(app, recipes)
    }

    pub fn delete_recipe(&self, app: &AppHandle, id: &str) -> Result<AutomationState, String> {
        let mut recipes = self.current_recipes()?;
        let before = recipes.len();
        recipes.retain(|recipe| recipe.id != id);
        if recipes.len() == before {
            return Err("there is no such recipe".into());
        }
        self.commit_recipes(app, recipes)
    }
}

fn new_recipe_id() -> String {
    format!("recipe{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

/// Every head location a recipe names must exist, or it could never start.
pub fn check_locations(recipe: &Recipe, known: &[String]) -> Result<(), String> {
    for stage in &recipe.stages {
        if let Stage::HeadAt { location } = stage
            && !known.contains(location)
        {
            return Err(format!("the location '{location}' does not exist"));
        }
    }
    Ok(())
}

/// Carries out what the engine asked for. Errors are logged, not raised: a failed volume write must never
/// stop the signal loops that call in here.
fn apply_effects(app: &AppHandle, effects: &Effects, max_points_per_second: f64) {
    let overlay = app.state::<OverlayRuntime>();
    let volume = app.state::<VolumeRuntime>();
    if let Some(wanted) = effects.overlay {
        let result = match wanted {
            OverlayWanted::Hidden => overlay.release(app),
            OverlayWanted::Armed => overlay.show_armed(app, &volume),
            OverlayWanted::Driving => overlay.begin_recipe_interaction(app, &volume),
        };
        if let Err(error) = result {
            warn!(%error, ?wanted, "failed to update the volume overlay for a recipe");
        }
    }
    let actuators = &app.state::<AutomationRuntime>().actuators;
    for (action, delta) in &effects.deltas {
        match action {
            Action::Volume => {
                if let Err(error) = overlay.apply_recipe_delta(app, *delta, max_points_per_second) {
                    warn!(%error, "failed to apply a recipe's volume change");
                }
            }
            Action::Brightness | Action::Scroll => actuators.delta(app, *action, *delta),
            _ => {}
        }
    }
    for action in &effects.fired {
        actuators.press(app, *action);
    }
    for action in &effects.ended {
        if *action != Action::Volume {
            actuators.reset(app, *action);
        }
    }
}

#[tauri::command]
pub fn get_automation_state(
    runtime: State<'_, AutomationRuntime>,
) -> Result<AutomationState, String> {
    runtime.state()
}

#[tauri::command]
pub fn save_recipe(
    recipe: Recipe,
    runtime: State<'_, AutomationRuntime>,
    calibration: State<'_, crate::calibration::CalibrationRuntime>,
    app: AppHandle,
) -> Result<AutomationState, String> {
    let known: Vec<String> = calibration
        .state()?
        .targets
        .into_iter()
        .map(|target| target.id.as_str().to_string())
        .collect();
    runtime.save_recipe(&app, recipe, &known)
}

#[tauri::command]
pub fn delete_recipe(
    id: String,
    runtime: State<'_, AutomationRuntime>,
    app: AppHandle,
) -> Result<AutomationState, String> {
    runtime.delete_recipe(&app, &id)
}

#[tauri::command]
pub fn set_recipe_enabled(
    id: String,
    enabled: bool,
    runtime: State<'_, AutomationRuntime>,
    app: AppHandle,
) -> Result<AutomationState, String> {
    runtime.set_recipe_enabled(&app, &id, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn about_x(degrees: f64) -> [f64; 4] {
        let half = degrees.to_radians() / 2.0;
        [half.cos(), half.sin(), 0.0, 0.0]
    }

    fn only(id: &str) -> Vec<Recipe> {
        default_recipes()
            .into_iter()
            .map(|mut recipe| {
                recipe.enabled = recipe.id == id;
                recipe
            })
            .collect()
    }

    /// Nanoseconds for sample `n`, 200 ms apart, so a 30 degree move is 150 degrees per second.
    fn ts(n: u64) -> u64 {
        n * 200_000_000
    }

    #[test]
    fn looking_shows_the_knob_then_stem_and_roll_move_the_volume() {
        let mut engine = Engine::new(only("lookStemVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1), None);
        assert_eq!(
            engine.set_head(Some("topRight".into())).overlay,
            Some(OverlayWanted::Armed)
        );
        // Rolling without the button does nothing.
        assert!(
            engine
                .observe_orientation(about_x(30.0), ts(2), None)
                .deltas
                .is_empty()
        );

        assert_eq!(engine.set_stem(true).overlay, Some(OverlayWanted::Driving));
        engine.observe_orientation(about_x(30.0), ts(3), None);
        let moved = engine.observe_orientation(about_x(60.0), ts(4), None);
        assert_eq!(moved.deltas.len(), 1);
        // 30 degrees less the 3 degree dead zone, at one third of a point per degree.
        assert!(
            (moved.deltas[0].1 - 0.09).abs() < 1e-6,
            "{:?}",
            moved.deltas
        );

        assert_eq!(engine.set_stem(false).overlay, Some(OverlayWanted::Armed));
        assert_eq!(engine.set_head(None).overlay, Some(OverlayWanted::Hidden));
    }

    #[test]
    fn two_enabled_volume_recipes_conflict_and_neither_runs() {
        let mut recipes = default_recipes();
        recipes[1].enabled = true; // pinch alongside the STEM recipe
        let mut engine = Engine::new(recipes, Tuning::default());
        let state = engine.state();
        assert_eq!(state.conflicts.len(), 1);
        assert!(state.blocked.contains(&"lookStemVolume".to_string()));
        assert!(state.blocked.contains(&"lookPinchVolume".to_string()));
        // Even with the whole chain of one of them satisfied, the held-off recipes never touch the overlay.
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_head(Some("topRight".into()));
        let effects = engine.set_stem(true);
        assert_eq!(effects, Effects::default());
    }

    #[test]
    fn the_pinch_recipe_runs_when_it_alone_is_enabled() {
        let mut engine = Engine::new(only("lookPinchVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_head(Some("topRight".into()));
        assert_eq!(engine.set_pinch(true).overlay, Some(OverlayWanted::Driving));
        // A forced release ends it and it stays ended while the head is still on the corner.
        assert_eq!(engine.cancel().overlay, Some(OverlayWanted::Hidden));
        assert_eq!(engine.set_pinch(true), Effects::default());
    }

    #[test]
    fn losing_the_watch_ends_the_interaction() {
        let mut engine = Engine::new(only("lookStemVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_head(Some("topRight".into()));
        engine.set_stem(true);
        assert_eq!(engine.watch_lost().overlay, Some(OverlayWanted::Armed));
    }

    #[test]
    fn an_impossibly_fast_sample_while_driving_is_ignored() {
        let mut engine = Engine::new(only("lookStemVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_head(Some("topRight".into()));
        engine.set_stem(true);
        engine.observe_orientation(about_x(0.0), ts(2), None);
        // 120 degrees in 200 ms is 600 deg/s, over the 360 deg/s limit.
        let glitch = engine.observe_orientation(about_x(120.0), ts(3), None);
        assert!(glitch.deltas.is_empty());
        // A real, moderate movement from the last good sample still counts.
        let real = engine.observe_orientation(about_x(5.0), ts(4), None);
        assert_eq!(real.deltas.len(), 1);
    }

    #[test]
    fn out_of_order_samples_are_dropped() {
        let mut engine = Engine::new(only("lookStemVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(5), None);
        engine.set_head(Some("topRight".into()));
        engine.set_stem(true);
        assert_eq!(
            engine.observe_orientation(about_x(40.0), ts(4), None),
            Effects::default()
        );
    }

    #[test]
    fn a_recipe_must_name_locations_that_exist() {
        let recipe = &default_recipes()[0];
        assert!(check_locations(recipe, &["center".into(), "topRight".into()]).is_ok());
        let error = check_locations(recipe, &["center".into()]).unwrap_err();
        assert!(error.contains("topRight"), "{error}");
    }

    #[test]
    fn new_recipe_ids_are_valid_and_distinct() {
        let (a, b) = (new_recipe_id(), new_recipe_id());
        assert_ne!(a, b);
        assert!(a.starts_with("recipe") && a.len() == 14);
    }

    fn driving(action: Action) -> Recipe {
        Recipe {
            id: format!("{action:?}"),
            name: format!("{action:?}"),
            enabled: true,
            action,
            stages: vec![
                Stage::Hold {
                    hold: Hold::StemButton,
                },
                Stage::Drive {
                    axis: Axis::Roll,
                    dead_zone_degrees: 0.0,
                    invert: false,
                },
            ],
            device: Device::default_for(DeviceKind::RotationKnob),
        }
    }

    #[test]
    fn a_scroll_recipe_sends_scroll_changes_and_never_touches_the_volume_knob() {
        let mut engine = Engine::new(vec![driving(Action::Scroll)], Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1), None);
        let began = engine.set_stem(true);
        assert_eq!(
            began.overlay, None,
            "the volume knob is only for volume recipes"
        );
        engine.observe_orientation(about_x(0.0), ts(2), None);
        let moved = engine.observe_orientation(about_x(30.0), ts(3), None);
        assert_eq!(moved.deltas.len(), 1);
        assert_eq!(moved.deltas[0].0, Action::Scroll);
        assert!((moved.deltas[0].1 - 0.1).abs() < 1e-6);
        let ended = engine.set_stem(false);
        assert_eq!(ended.ended, vec![Action::Scroll]);
        assert_eq!(ended.overlay, None);
    }

    #[test]
    fn brightness_and_scroll_can_run_on_the_same_gesture_at_once() {
        let mut engine = Engine::new(
            vec![driving(Action::Brightness), driving(Action::Scroll)],
            Tuning::default(),
        );
        assert!(engine.state().conflicts.is_empty());
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_stem(true);
        engine.observe_orientation(about_x(0.0), ts(2), None);
        let moved = engine.observe_orientation(about_x(30.0), ts(3), None);
        let actions: Vec<Action> = moved.deltas.iter().map(|(a, _)| *a).collect();
        assert_eq!(actions, vec![Action::Brightness, Action::Scroll]);
    }

    #[test]
    fn two_recipes_scrolling_conflict_and_both_stay_still() {
        let mut second = driving(Action::Scroll);
        second.id = "other".into();
        let mut engine = Engine::new(vec![driving(Action::Scroll), second], Tuning::default());
        assert_eq!(engine.state().conflicts.len(), 1);
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_stem(true);
        engine.observe_orientation(about_x(0.0), ts(2), None);
        assert_eq!(
            engine.observe_orientation(about_x(30.0), ts(3), None),
            Effects::default()
        );
    }

    fn trigger_recipe(action: Action, hold: Hold) -> Recipe {
        Recipe {
            id: format!("{action:?}"),
            name: format!("{action:?}"),
            enabled: true,
            action,
            stages: vec![Stage::Hold { hold }],
            device: Device::default_for(DeviceKind::RotationKnob),
        }
    }

    #[test]
    fn a_media_trigger_fires_once_on_the_pinch_and_shows_no_volume_knob() {
        let mut engine = Engine::new(
            vec![trigger_recipe(Action::PlayPause, Hold::Pinch)],
            Tuning::default(),
        );
        let pinched = engine.set_pinch(true);
        assert_eq!(pinched.fired, vec![Action::PlayPause]);
        assert_eq!(pinched.overlay, None);
        // Holding on, or the watch streaming orientation, does not fire it again.
        assert!(
            engine
                .observe_orientation(about_x(0.0), ts(1), None)
                .fired
                .is_empty()
        );
        assert!(
            engine
                .observe_orientation(about_x(5.0), ts(2), None)
                .fired
                .is_empty()
        );
        assert!(engine.set_pinch(false).fired.is_empty());
        assert_eq!(engine.set_pinch(true).fired, vec![Action::PlayPause]);
    }

    #[test]
    fn a_held_trigger_does_not_trip_the_glitch_filter_that_guards_a_turning_device() {
        // The pinch is held (the trigger is "driving") while a STEM scroll recipe turns: a fast sample must still
        // be judged by the scroll recipe's own state, and a trigger alone must never freeze orientation.
        let mut engine = Engine::new(
            vec![trigger_recipe(Action::NextTrack, Hold::Pinch)],
            Tuning::default(),
        );
        engine.set_pinch(true);
        engine.observe_orientation(about_x(0.0), ts(1), None);
        let _ = engine.observe_orientation(about_x(120.0), ts(2), None);
        assert_eq!(engine.orientation.as_ref().unwrap().timestamp_ns, ts(2));
    }

    #[test]
    fn two_recipes_on_the_same_media_key_conflict_but_different_keys_do_not() {
        let mut other = trigger_recipe(Action::PlayPause, Hold::StemButton);
        other.id = "other".into();
        let engine = Engine::new(
            vec![trigger_recipe(Action::PlayPause, Hold::Pinch), other],
            Tuning::default(),
        );
        assert_eq!(engine.state().conflicts.len(), 1);
        assert_eq!(engine.state().conflicts[0].resource, "playPause");
        let engine = Engine::new(
            vec![
                trigger_recipe(Action::PlayPause, Hold::Pinch),
                trigger_recipe(Action::NextTrack, Hold::Pinch),
            ],
            Tuning::default(),
        );
        assert!(engine.state().conflicts.is_empty());
    }

    /// Feeds 50 Hz orientation samples carrying acceleration: `strokes` alternating 14 m/s² pushes, 160 ms apart,
    /// starting at 1 s. Returns how many times each action fired.
    fn shake_for(engine: &mut Engine, strokes: u64, offset_ms: u64) -> Vec<Action> {
        let mut fired = Vec::new();
        for ms in (0..=(1000 + strokes * 160 + 800)).step_by(20) {
            let mut a = [0.0, 0.0, 9.81];
            for i in 0..strokes {
                let start = 1000 + i * 160;
                if ms >= start && ms < start + 60 {
                    a[0] += if i % 2 == 0 { 14.0 } else { -14.0 };
                }
            }
            let t = (offset_ms + ms) * 1_000_000;
            fired.extend(engine.observe_orientation(about_x(0.0), t, Some(a)).fired);
        }
        fired
    }

    #[test]
    fn shaking_the_wrist_fires_a_shake_recipe_once() {
        let mut engine = Engine::new(
            vec![Recipe {
                id: "shakeNext".into(),
                name: "Shake for next".into(),
                enabled: true,
                action: Action::NextTrack,
                stages: vec![Stage::Hold { hold: Hold::Shake }],
                device: Device::default_for(DeviceKind::RotationKnob),
            }],
            Tuning::default(),
        );
        assert_eq!(shake_for(&mut engine, 4, 0), vec![Action::NextTrack]);
        // Sitting still, or a lone knock, does nothing.
        assert!(shake_for(&mut engine, 0, 10_000).is_empty());
        assert!(shake_for(&mut engine, 1, 20_000).is_empty());
        // And a second shake later fires again.
        assert_eq!(shake_for(&mut engine, 4, 30_000), vec![Action::NextTrack]);
    }

    #[test]
    fn a_shake_while_not_looking_does_nothing_for_a_look_and_shake_recipe() {
        let recipe = Recipe {
            id: "lookShake".into(),
            name: "Look and shake".into(),
            enabled: true,
            action: Action::PlayPause,
            stages: vec![
                Stage::HeadAt {
                    location: "topRight".into(),
                },
                Stage::Hold { hold: Hold::Shake },
            ],
            device: Device::default_for(DeviceKind::RotationKnob),
        };
        let mut engine = Engine::new(vec![recipe.clone()], Tuning::default());
        assert!(
            shake_for(&mut engine, 4, 0).is_empty(),
            "shaken without looking"
        );
        let mut engine = Engine::new(vec![recipe], Tuning::default());
        engine.set_head(Some("topRight".into()));
        assert_eq!(shake_for(&mut engine, 4, 0), vec![Action::PlayPause]);
    }

    #[test]
    fn a_less_sensitive_setting_ignores_a_shake_the_default_catches_and_more_strokes_are_asked_for()
    {
        let recipe = || Recipe {
            id: "shakeNext".into(),
            name: "Shake for next".into(),
            enabled: true,
            action: Action::NextTrack,
            stages: vec![Stage::Hold { hold: Hold::Shake }],
            device: Device::default_for(DeviceKind::RotationKnob),
        };
        // The simulated strokes are 14 m/s². A threshold above that sees nothing.
        let hard = Tuning {
            shake_peak_threshold: 20.0,
            ..Tuning::default()
        };
        let mut engine = Engine::new(vec![recipe()], hard);
        assert!(shake_for(&mut engine, 8, 0).is_empty());
        // Changing the setting takes effect without restarting.
        engine.set_tuning(Tuning::default());
        assert_eq!(shake_for(&mut engine, 4, 20_000), vec![Action::NextTrack]);
        // Asking for six strokes ignores a four-stroke shake and accepts a six-stroke one.
        let demanding = Tuning {
            shake_strokes: 6,
            ..Tuning::default()
        };
        let mut engine = Engine::new(vec![recipe()], demanding);
        assert!(shake_for(&mut engine, 4, 0).is_empty());
        assert_eq!(shake_for(&mut engine, 6, 30_000), vec![Action::NextTrack]);
    }

    #[test]
    fn a_recognised_shake_is_reported_even_when_no_recipe_uses_it() {
        let mut engine = Engine::new(Vec::new(), Tuning::default());
        let mut shook = 0;
        for ms in (0..=3000u64).step_by(20) {
            let mut a = [0.0, 0.0, 9.81];
            for i in 0..4u64 {
                let start = 1000 + i * 160;
                if ms >= start && ms < start + 60 {
                    a[0] += if i % 2 == 0 { 14.0 } else { -14.0 };
                }
            }
            if engine
                .observe_orientation(about_x(0.0), ms * 1_000_000, Some(a))
                .shook
            {
                shook += 1;
            }
        }
        assert_eq!(shook, 1);
    }

    /// Feeds 50 Hz samples with a swipe (a strong push, then a weaker stop) along the watch's x axis (towards the hand
    /// when positive), starting at 1 s, and returns what was recognised and what fired.
    fn swipe_for(
        engine: &mut Engine,
        push: f64,
        offset_ms: u64,
    ) -> (Vec<SwipeDirection>, Vec<Action>) {
        let (mut swipes, mut fired) = (Vec::new(), Vec::new());
        for ms in (0..=3000u64).step_by(20) {
            let mut a = [0.0, 0.0, 9.81];
            if (1000..1060).contains(&ms) {
                a[0] += push;
            }
            if (1120..1180).contains(&ms) {
                a[0] -= push * 0.4;
            }
            let effects =
                engine.observe_orientation(about_x(0.0), (offset_ms + ms) * 1_000_000, Some(a));
            swipes.extend(effects.swiped);
            fired.extend(effects.fired);
        }
        (swipes, fired)
    }

    fn swipe_recipe(hold: Hold, action: Action) -> Recipe {
        Recipe {
            id: format!("{hold:?}"),
            name: format!("{hold:?}"),
            enabled: true,
            action,
            stages: vec![Stage::Hold { hold }],
            device: Device::default_for(DeviceKind::RotationKnob),
        }
    }

    #[test]
    fn a_swipe_fires_only_the_recipe_for_its_direction() {
        let mut engine = Engine::new(
            vec![
                swipe_recipe(Hold::SwipeRight, Action::NextTrack),
                swipe_recipe(Hold::SwipeLeft, Action::PreviousTrack),
            ],
            Tuning::default(),
        );
        // Towards the hand on a left wrist is the wearer's right.
        let (swipes, fired) = swipe_for(&mut engine, 14.0, 0);
        assert_eq!(swipes, vec![SwipeDirection::Right]);
        assert_eq!(fired, vec![Action::NextTrack]);
        let (swipes, fired) = swipe_for(&mut engine, -14.0, 10_000);
        assert_eq!(swipes, vec![SwipeDirection::Left]);
        assert_eq!(fired, vec![Action::PreviousTrack]);
    }

    #[test]
    fn the_crown_setting_swaps_left_and_right_and_the_strength_setting_is_obeyed() {
        let on_right_wrist = Tuning {
            crown: CrownSide::Left,
            ..Tuning::default()
        };
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::SwipeLeft, Action::PreviousTrack)],
            on_right_wrist,
        );
        let (swipes, fired) = swipe_for(&mut engine, 14.0, 0);
        assert_eq!(
            (swipes, fired),
            (vec![SwipeDirection::Left], vec![Action::PreviousTrack])
        );

        let strict = Tuning {
            swipe_peak_threshold: 20.0,
            ..Tuning::default()
        };
        engine.set_tuning(strict);
        assert!(swipe_for(&mut engine, 14.0, 20_000).0.is_empty());
    }

    /// Feeds 50 Hz samples with knocks on the screen (20 ms jolts along z) at the given times, from a still start.
    fn tap_for(
        engine: &mut Engine,
        knocks_ms: &[u64],
        offset_ms: u64,
    ) -> (Vec<TapKind>, Vec<Action>) {
        let (mut taps, mut fired) = (Vec::new(), Vec::new());
        for ms in (0..=3000u64).step_by(20) {
            let mut a = [0.0, 0.0, 9.81];
            if knocks_ms.contains(&ms) {
                a[2] += 20.0;
            }
            let effects =
                engine.observe_orientation(about_x(0.0), (offset_ms + ms) * 1_000_000, Some(a));
            taps.extend(effects.tapped);
            fired.extend(effects.fired);
        }
        (taps, fired)
    }

    #[test]
    fn a_tap_and_a_double_tap_fire_their_own_recipes() {
        let mut engine = Engine::new(
            vec![
                swipe_recipe(Hold::Tap, Action::PlayPause),
                swipe_recipe(Hold::DoubleTap, Action::Mute),
            ],
            Tuning::default(),
        );
        let (taps, fired) = tap_for(&mut engine, &[1000], 0);
        assert_eq!(
            (taps, fired),
            (vec![TapKind::Single], vec![Action::PlayPause])
        );
        let (taps, fired) = tap_for(&mut engine, &[1000, 1240], 10_000);
        assert_eq!((taps, fired), (vec![TapKind::Double], vec![Action::Mute]));
    }

    #[test]
    fn the_tap_setting_is_obeyed() {
        let strict = Tuning {
            tap_peak_threshold: 30.0,
            ..Tuning::default()
        };
        let mut engine = Engine::new(vec![swipe_recipe(Hold::Tap, Action::PlayPause)], strict);
        assert!(tap_for(&mut engine, &[1000], 0).0.is_empty());
        engine.set_tuning(Tuning::default());
        assert_eq!(
            tap_for(&mut engine, &[1000], 10_000).0,
            vec![TapKind::Single]
        );
    }

    fn rolled(degrees: f64) -> [f64; 4] {
        about_x(degrees)
    }

    /// Feeds 50 Hz orientation: a quick roll of `degrees` over 300 ms starting at 1 s, then still.
    fn rotate_for(
        engine: &mut Engine,
        degrees: f64,
        offset_ms: u64,
    ) -> (Vec<RotateDirection>, Vec<Action>) {
        let (mut rotations, mut fired) = (Vec::new(), Vec::new());
        for ms in (0..=3000u64).step_by(20) {
            let angle = match ms {
                0..1000 => 0.0,
                1000..1300 => degrees * (ms - 1000) as f64 / 300.0,
                _ => degrees,
            };
            let effects =
                engine.observe_orientation(rolled(angle), (offset_ms + ms) * 1_000_000, None);
            rotations.extend(effects.rotated);
            fired.extend(effects.fired);
        }
        (rotations, fired)
    }

    #[test]
    fn a_quick_wrist_twist_fires_the_recipe_for_its_direction() {
        let mut engine = Engine::new(
            vec![
                swipe_recipe(Hold::RotateClockwise, Action::NextTrack),
                swipe_recipe(Hold::RotateCounterClockwise, Action::PreviousTrack),
            ],
            Tuning::default(),
        );
        assert_eq!(
            rotate_for(&mut engine, 90.0, 0),
            (vec![RotateDirection::Clockwise], vec![Action::NextTrack])
        );
        // The watch is now 90 degrees round, so a flick back is a 90 degree turn the other way.
        let mut engine = Engine::new(
            vec![swipe_recipe(
                Hold::RotateCounterClockwise,
                Action::PreviousTrack,
            )],
            Tuning::default(),
        );
        assert_eq!(
            rotate_for(&mut engine, -90.0, 0),
            (
                vec![RotateDirection::CounterClockwise],
                vec![Action::PreviousTrack]
            )
        );
    }

    #[test]
    fn the_wrist_and_crown_settings_decide_which_way_clockwise_is() {
        let direction = |wrist, crown| {
            let tuning = Tuning {
                wrist,
                crown,
                ..Tuning::default()
            };
            let mut engine = Engine::new(Vec::new(), tuning);
            let mut found = Vec::new();
            for ms in (0..=3000u64).step_by(20) {
                let angle = match ms {
                    0..1000 => 0.0,
                    1000..1300 => 90.0 * (ms - 1000) as f64 / 300.0,
                    _ => 90.0,
                };
                found.extend(
                    engine
                        .observe_orientation(rolled(angle), ms * 1_000_000, None)
                        .rotated,
                );
            }
            found
        };
        use CrownSide::{Left as CrownLeft, Right as CrownRight};
        assert_eq!(
            direction(Wrist::Left, CrownRight),
            vec![RotateDirection::Clockwise]
        );
        assert_eq!(
            direction(Wrist::Right, CrownRight),
            vec![RotateDirection::CounterClockwise]
        );
        assert_eq!(
            direction(Wrist::Left, CrownLeft),
            vec![RotateDirection::CounterClockwise]
        );
        assert_eq!(
            direction(Wrist::Right, CrownLeft),
            vec![RotateDirection::Clockwise]
        );
    }

    /// Feeds 50 Hz orientation: a quick tilt of `degrees` about the watch's 12-6 axis over 300 ms from 1 s.
    fn pitch_for(
        engine: &mut Engine,
        degrees: f64,
        offset_ms: u64,
    ) -> (Vec<PitchDirection>, Vec<Action>) {
        let (mut pitches, mut fired) = (Vec::new(), Vec::new());
        for ms in (0..=3000u64).step_by(20) {
            let angle = match ms {
                0..1000 => 0.0,
                1000..1300 => degrees * (ms - 1000) as f64 / 300.0,
                _ => degrees,
            };
            let half = angle.to_radians() / 2.0;
            let q = [half.cos(), 0.0, half.sin(), 0.0];
            let effects = engine.observe_orientation(q, (offset_ms + ms) * 1_000_000, None);
            pitches.extend(effects.pitched);
            fired.extend(effects.fired);
        }
        (pitches, fired)
    }

    #[test]
    fn a_quick_tilt_of_the_hand_fires_the_recipe_for_its_direction_and_the_angle_setting_is_obeyed()
    {
        // Default left wrist, crown right: a positive turn about the 12-6 axis lowers the hand.
        let mut engine = Engine::new(
            vec![
                swipe_recipe(Hold::PitchUp, Action::PlayPause),
                swipe_recipe(Hold::PitchDown, Action::Mute),
            ],
            Tuning::default(),
        );
        assert_eq!(
            pitch_for(&mut engine, 60.0, 0),
            (vec![PitchDirection::Down], vec![Action::Mute])
        );
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::PitchUp, Action::PlayPause)],
            Tuning::default(),
        );
        assert_eq!(
            pitch_for(&mut engine, -60.0, 0),
            (vec![PitchDirection::Up], vec![Action::PlayPause])
        );
        // A tilt smaller than the setting is ignored, until the setting is lowered.
        let strict = Tuning {
            pitch_angle_degrees: 90.0,
            ..Tuning::default()
        };
        let mut engine = Engine::new(vec![swipe_recipe(Hold::PitchUp, Action::PlayPause)], strict);
        assert!(pitch_for(&mut engine, -60.0, 0).0.is_empty());
        engine.set_tuning(Tuning::default());
        assert_eq!(pitch_for(&mut engine, -60.0, 10_000).0.len(), 1);
    }

    #[test]
    fn the_rotate_angle_setting_is_obeyed_and_a_rotate_does_not_disturb_a_dial() {
        let strict = Tuning {
            rotate_angle_degrees: 150.0,
            ..Tuning::default()
        };
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::RotateClockwise, Action::NextTrack)],
            strict,
        );
        assert!(rotate_for(&mut engine, 90.0, 0).0.is_empty());
        engine.set_tuning(Tuning::default());
        assert_eq!(rotate_for(&mut engine, 90.0, 10_000).0.len(), 1);
    }

    #[test]
    fn the_defaults_are_valid_and_start_without_a_conflict() {
        for recipe in default_recipes() {
            assert_eq!(validate_recipe(&recipe), Ok(()), "{}", recipe.id);
        }
        assert!(
            Engine::new(default_recipes(), Tuning::default())
                .state()
                .conflicts
                .is_empty()
        );
    }
}
