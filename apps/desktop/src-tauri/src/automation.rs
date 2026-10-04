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
    Action, Axis, Conflict, Device, DeviceKind, Hold, Recipe, RecipeRunner, RunnerPhase, Signals,
    Stage, blocked_recipes, find_conflicts, validate_recipe,
};
use interaction_engine::quaternion_angular_distance;
use serde::Serialize;
use spatial_protocol::WatchOrientationSample;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::overlay::{OverlayRuntime, VolumeRuntime};
use crate::settings::{AppSettings, SettingsRuntime};

pub const AUTOMATION_STATE_EVENT: &str = "automation-state";
const RECIPES_FILE_NAME: &str = "recipes.json";

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
    /// Volume changes to apply, as fractions of the full range.
    pub volume_deltas: Vec<f64>,
}

/// The wrist feel that Settings still controls until recipes carry their own (the Recipes page replaces this).
#[derive(Debug, Clone, Copy)]
pub struct Tuning {
    pub dead_zone_degrees: f64,
    pub volume_points_per_degree: f64,
    pub max_angular_velocity_degrees_per_second: f64,
    pub max_volume_points_per_second: f64,
}

impl Tuning {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            dead_zone_degrees: settings.wrist_dead_zone_degrees,
            volume_points_per_degree: settings.wrist_volume_points_per_degree,
            max_angular_velocity_degrees_per_second: settings
                .wrist_max_angular_velocity_degrees_per_second,
            max_volume_points_per_second: settings.wrist_max_volume_points_per_second,
        }
    }

    /// The recipe as it runs: a rotation knob takes its sensitivity and dead zone from Settings.
    fn applied_to(&self, recipe: &Recipe) -> Recipe {
        let mut recipe = recipe.clone();
        if let Device::RotationKnob {
            fraction_per_degree,
        } = &mut recipe.device
        {
            *fraction_per_degree = self.volume_points_per_degree / 100.0;
            if let Some(Stage::Drive {
                dead_zone_degrees, ..
            }) = recipe.stages.last_mut()
            {
                *dead_zone_degrees = self.dead_zone_degrees;
            }
        }
        recipe
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            dead_zone_degrees: 3.0,
            volume_points_per_degree: 1.0 / 3.0,
            max_angular_velocity_degrees_per_second: 360.0,
            max_volume_points_per_second: 30.0,
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
    tuning: Tuning,
    head: Option<String>,
    pinch: bool,
    stem: bool,
    orientation: Option<Orientation>,
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
            tuning,
            head: None,
            pinch: false,
            stem: false,
            orientation: None,
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
            .map(|recipe| RecipeRunner::new(self.tuning.applied_to(recipe)))
            .collect();
    }

    pub fn set_recipes(&mut self, recipes: Vec<Recipe>) -> Effects {
        self.recipes = recipes;
        self.rebuild();
        self.step()
    }

    pub fn set_tuning(&mut self, tuning: Tuning) -> Effects {
        self.tuning = tuning;
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

    pub fn observe_orientation(&mut self, quaternion: [f64; 4], timestamp_ns: u64) -> Effects {
        if self
            .orientation
            .as_ref()
            .is_some_and(|previous| timestamp_ns <= previous.timestamp_ns)
        {
            return Effects::default();
        }
        let driving = self.overlay == OverlayWanted::Driving;
        if driving && self.is_velocity_outlier(quaternion, timestamp_ns) {
            // A glitch freezes the knob rather than jumping it; the last good orientation stays current.
            return Effects::default();
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
        self.step()
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
            orientation: self.orientation.as_ref().map(|o| o.quaternion),
        };
        let mut wanted = OverlayWanted::Hidden;
        let mut effects = Effects::default();
        for (recipe, runner) in self.recipes.iter().zip(&mut self.runners) {
            if self.blocked.contains(&recipe.id) {
                runner.reset();
                continue;
            }
            if let Some(output) = runner.update(&signals) {
                effects.volume_deltas.push(output.delta_fraction);
            }
            wanted = match (wanted, runner.phase()) {
                (_, RunnerPhase::Driving) | (OverlayWanted::Driving, _) => OverlayWanted::Driving,
                (_, RunnerPhase::Armed) | (OverlayWanted::Armed, _) => OverlayWanted::Armed,
                _ => OverlayWanted::Hidden,
            };
        }
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
}

impl Default for AutomationRuntime {
    fn default() -> Self {
        Self {
            operations: Mutex::new(()),
            engine: Mutex::new(Engine::new(default_recipes(), Tuning::default())),
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
            engine.observe_orientation(sample.quaternion, sample.timestamp_ns)
        });
    }

    /// Applies new wrist tuning from Settings; ends any interaction in progress.
    pub fn apply_settings(&self, app: &AppHandle, settings: &AppSettings) {
        let tuning = Tuning::from_settings(settings);
        self.with_engine(app, |engine| engine.set_tuning(tuning));
    }

    pub fn set_recipe_enabled(
        &self,
        app: &AppHandle,
        id: &str,
        enabled: bool,
    ) -> Result<AutomationState, String> {
        let recipes = {
            let engine = self
                .engine
                .lock()
                .map_err(|_| "recipe engine lock was poisoned")?;
            let mut recipes = engine.recipes().to_vec();
            let recipe = recipes
                .iter_mut()
                .find(|recipe| recipe.id == id)
                .ok_or("there is no such recipe")?;
            recipe.enabled = enabled;
            recipes
        };
        save_recipes(app, &recipes);
        self.with_engine(app, |engine| engine.set_recipes(recipes));
        // The state event is how the UI hears about the change, even when the overlay is unaffected.
        let state = self.state()?;
        let _ = app.emit(AUTOMATION_STATE_EVENT, &state);
        Ok(state)
    }
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
    for delta in &effects.volume_deltas {
        if let Err(error) = overlay.apply_recipe_delta(app, *delta, max_points_per_second) {
            warn!(%error, "failed to apply a recipe's volume change");
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
        engine.observe_orientation(about_x(0.0), ts(1));
        assert_eq!(
            engine.set_head(Some("topRight".into())).overlay,
            Some(OverlayWanted::Armed)
        );
        // Rolling without the button does nothing.
        assert!(
            engine
                .observe_orientation(about_x(30.0), ts(2))
                .volume_deltas
                .is_empty()
        );

        assert_eq!(engine.set_stem(true).overlay, Some(OverlayWanted::Driving));
        engine.observe_orientation(about_x(30.0), ts(3));
        let moved = engine.observe_orientation(about_x(60.0), ts(4));
        assert_eq!(moved.volume_deltas.len(), 1);
        // 30 degrees less the 3 degree dead zone, at one third of a point per degree.
        assert!(
            (moved.volume_deltas[0] - 0.09).abs() < 1e-6,
            "{:?}",
            moved.volume_deltas
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
        engine.observe_orientation(about_x(0.0), ts(1));
        engine.set_head(Some("topRight".into()));
        let effects = engine.set_stem(true);
        assert_eq!(effects, Effects::default());
    }

    #[test]
    fn the_pinch_recipe_runs_when_it_alone_is_enabled() {
        let mut engine = Engine::new(only("lookPinchVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1));
        engine.set_head(Some("topRight".into()));
        assert_eq!(engine.set_pinch(true).overlay, Some(OverlayWanted::Driving));
        // A forced release ends it and it stays ended while the head is still on the corner.
        assert_eq!(engine.cancel().overlay, Some(OverlayWanted::Hidden));
        assert_eq!(engine.set_pinch(true), Effects::default());
    }

    #[test]
    fn losing_the_watch_ends_the_interaction() {
        let mut engine = Engine::new(only("lookStemVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1));
        engine.set_head(Some("topRight".into()));
        engine.set_stem(true);
        assert_eq!(engine.watch_lost().overlay, Some(OverlayWanted::Armed));
    }

    #[test]
    fn an_impossibly_fast_sample_while_driving_is_ignored() {
        let mut engine = Engine::new(only("lookStemVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1));
        engine.set_head(Some("topRight".into()));
        engine.set_stem(true);
        engine.observe_orientation(about_x(0.0), ts(2));
        // 120 degrees in 200 ms is 600 deg/s, over the 360 deg/s limit.
        let glitch = engine.observe_orientation(about_x(120.0), ts(3));
        assert!(glitch.volume_deltas.is_empty());
        // A real, moderate movement from the last good sample still counts.
        let real = engine.observe_orientation(about_x(5.0), ts(4));
        assert_eq!(real.volume_deltas.len(), 1);
    }

    #[test]
    fn out_of_order_samples_are_dropped() {
        let mut engine = Engine::new(only("lookStemVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(5));
        engine.set_head(Some("topRight".into()));
        engine.set_stem(true);
        assert_eq!(
            engine.observe_orientation(about_x(40.0), ts(4)),
            Effects::default()
        );
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
