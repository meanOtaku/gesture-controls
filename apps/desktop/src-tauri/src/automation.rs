//! Runs the gesture recipes: collects the live signals (head location, pinch, STEM button, watch
//! orientation), steps every recipe, and applies the result to the volume overlay.
//!
//! The decisions live in [`Engine`], which knows nothing about Tauri and is unit-tested; the runtime around
//! it only feeds it signals and carries out the [`Effects`] it returns.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use automation::{
    Action, Axis, Conflict, CrownSide, Device, DeviceKind, HeuristicGestures, Hold, ModelHold,
    PitchConfig, PitchDetector, PitchDirection, Recipe, RecipeRunner, RollConfig, RollDetector,
    RollDirection, RunnerPhase, ShakeConfig, ShakeDetector, Signals, Stage, SwipeConfig,
    SwipeDetector, SwipeDirection, TapConfig, TapDetector, TapKind, Wrist, blocked_recipes,
    find_conflicts, validate_recipe,
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
pub const ROLL_DETECTED_EVENT: &str = "automation-roll";
/// Sent with `up` or `down` each time a quick tilt of the hand is recognised.
pub const PITCH_DETECTED_EVENT: &str = "automation-pitch";
/// How long a recognised shake keeps counting as "happening", so a recipe that combines it with another step (look
/// at a location, say) has a moment in which both hold.
/// Also how long a swipe keeps counting.
const SHAKE_HOLD_NS: u64 = 600_000_000;
/// A model label's first detection counts as happening for this long, like the wrist gestures' moment.
pub(crate) const MODEL_PULSE_NS: u64 = 600_000_000;
const RECIPES_FILE_NAME: &str = "recipes.json";
pub const MAX_RECIPES: usize = 24;
/// The camera is taken to have stopped when the app window has not reported for this long.
const CAMERA_STALE: Duration = Duration::from_millis(900);
const CAMERA_WATCHDOG_TICK: Duration = Duration::from_millis(250);
/// The most gestures a camera report may name, so a bad report cannot be large.
const MAX_CAMERA_REPORT: usize = 200;

/// Nanoseconds since the app first asked: this app's own clock for camera timing.
fn process_clock_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

/// What the UI shows: every recipe, which of them are held off by a conflict, and the conflicts themselves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationState {
    pub recipes: Vec<Recipe>,
    pub blocked: Vec<String>,
    pub conflicts: Vec<Conflict>,
    /// Enabled recipes that name a model label which is not loaded, so they cannot start. Empty until the label
    /// runtime has said what it loaded.
    pub unavailable: Vec<UnavailableLabel>,
    /// The model labels the label runtime has loaded, which a recipe can name.
    pub loaded_labels: Vec<String>,
    /// Enabled recipes with a camera gesture step whose gesture the camera is not running right now: the camera is
    /// off, the app window is not reporting, or the gesture no longer exists.
    pub unavailable_cameras: Vec<UnavailableCamera>,
    /// Whether camera gestures may act. Off at every start, and off again whenever the camera stops, so a recipe
    /// never acts on the camera without it being switched on in this run.
    pub camera_armed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableCamera {
    pub recipe: String,
    pub gesture: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableLabel {
    pub recipe: String,
    pub label: String,
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
    pub rolled: Option<RollDirection>,
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
    pub roll_angle_degrees: f64,
    pub pitch_angle_degrees: f64,
    pub heuristics: HeuristicGestures,
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
            roll_angle_degrees: settings.roll_angle_degrees,
            pitch_angle_degrees: settings.pitch_angle_degrees,
            heuristics: settings.heuristic_gestures,
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

    pub fn roll_config(&self) -> RollConfig {
        RollConfig {
            min_angle_degrees: self.roll_angle_degrees,
            wrist: self.wrist,
            crown: self.crown,
            ..RollConfig::default()
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
            roll_angle_degrees: 60.0,
            pitch_angle_degrees: 40.0,
            heuristics: HeuristicGestures::default(),
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
            vec![
                look(),
                Stage::Model {
                    label: "pinch".into(),
                    hold: ModelHold::Held,
                },
                roll(),
            ],
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
    roll: RollDetector,
    roll_direction: Option<RollDirection>,
    roll_until_ns: u64,
    pitch: PitchDetector,
    pitch_direction: Option<PitchDirection>,
    pitch_until_ns: u64,
    /// The last orientation accepted while driving, for the angular-velocity outlier check.
    last_accepted: Option<Orientation>,
    blocked: BTreeSet<String>,
    overlay: OverlayWanted,
    /// Model labels detected now and cleared to act.
    models_held: BTreeSet<String>,
    /// Model labels first detected recently, mapped to when that stops counting (the label runtime's clock).
    model_pulses: BTreeMap<String, u64>,
    model_now_ns: u64,
    /// The labels the label runtime has loaded; `None` until it has said.
    models_loaded: Option<BTreeSet<String>>,
    /// Gesture library gestures the camera sees right now (and so are cleared to act).
    cameras_held: BTreeSet<String>,
    /// Camera gestures first seen recently, mapped to when that stops counting (the camera clock, see `set_cameras`).
    camera_pulses: BTreeMap<String, u64>,
    camera_now_ns: u64,
    /// The gestures the camera is running right now; empty while the camera is off or silent.
    cameras_known: BTreeSet<String>,
    /// Camera gestures act only while this is on; see [`AutomationState::camera_armed`].
    cameras_armed: bool,
    /// Recipes or the loaded labels changed since the host last looked, so what the UI shows about them may be stale.
    labels_dirty: bool,
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
            roll: RollDetector::new(tuning.roll_config()),
            roll_direction: None,
            roll_until_ns: 0,
            pitch: PitchDetector::new(tuning.pitch_config()),
            pitch_direction: None,
            pitch_until_ns: 0,
            last_accepted: None,
            blocked: BTreeSet::new(),
            overlay: OverlayWanted::Hidden,
            models_held: BTreeSet::new(),
            model_pulses: BTreeMap::new(),
            model_now_ns: 0,
            models_loaded: None,
            cameras_held: BTreeSet::new(),
            camera_pulses: BTreeMap::new(),
            camera_now_ns: 0,
            cameras_known: BTreeSet::new(),
            cameras_armed: false,
            labels_dirty: true,
        };
        engine.set_recipes(recipes);
        engine
    }

    /// Whether the labels part of [`Self::state`] may have changed since this was last called.
    pub fn take_labels_dirty(&mut self) -> bool {
        std::mem::take(&mut self.labels_dirty)
    }

    fn rebuild(&mut self) {
        self.labels_dirty = true;
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
        self.roll = RollDetector::new(tuning.roll_config());
        self.roll_until_ns = 0;
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
            unavailable: self.unavailable_labels(),
            loaded_labels: self.models_loaded.iter().flatten().cloned().collect(),
            unavailable_cameras: self.unavailable_cameras(),
            camera_armed: self.cameras_armed,
        }
    }

    fn unavailable_cameras(&self) -> Vec<UnavailableCamera> {
        self.recipes
            .iter()
            .filter(|recipe| recipe.enabled)
            .flat_map(|recipe| {
                recipe.stages.iter().filter_map(|stage| match stage {
                    Stage::Camera { gesture, .. } if !self.cameras_known.contains(gesture) => {
                        Some(UnavailableCamera {
                            recipe: recipe.id.clone(),
                            gesture: gesture.clone(),
                        })
                    }
                    _ => None,
                })
            })
            .collect()
    }

    /// The app window's camera report. `known` is every gesture the camera is running now (empty with the camera
    /// off), `held` those it sees right now, `risen` those it began to see a moment ago. Only a known gesture can be
    /// held or pulsed, so a gesture that was deleted or whose camera stopped cannot keep a recipe going.
    /// `now_ns` is this app's own clock; the camera and the watch share none.
    pub fn set_cameras(
        &mut self,
        known: BTreeSet<String>,
        held: BTreeSet<String>,
        risen: &[String],
        now_ns: u64,
    ) -> Effects {
        self.camera_now_ns = now_ns;
        for gesture in risen {
            if known.contains(gesture) {
                self.camera_pulses
                    .insert(gesture.clone(), now_ns + MODEL_PULSE_NS);
            }
        }
        self.camera_pulses
            .retain(|gesture, until| *until > now_ns && known.contains(gesture));
        self.cameras_held = held.into_iter().filter(|g| known.contains(g)).collect();
        if self.cameras_known != known {
            self.labels_dirty = true;
        }
        // With no camera running, arming is over: turning the camera back on must not start acting by itself.
        if known.is_empty() && self.cameras_armed {
            self.cameras_armed = false;
            self.camera_pulses.clear();
            self.labels_dirty = true;
        }
        self.cameras_known = known;
        self.step()
    }

    /// Switches camera gestures on or off. Arming needs a running camera, and starts from a clean slate: a gesture
    /// seen a moment before does not count, so only what happens after arming can act (a gesture already held does).
    pub fn set_cameras_armed(&mut self, armed: bool) -> Result<Effects, &'static str> {
        if armed && self.cameras_known.is_empty() {
            return Err(
                "turn the camera on first, with at least one gesture in the Gesture library",
            );
        }
        if self.cameras_armed != armed {
            self.cameras_armed = armed;
            self.camera_pulses.clear();
            self.labels_dirty = true;
        }
        Ok(self.step())
    }

    /// The camera went quiet (turned off, window closed or stalled): nothing it saw can still hold.
    pub fn camera_lost(&mut self) -> Effects {
        let now = self.camera_now_ns;
        self.set_cameras(BTreeSet::new(), BTreeSet::new(), &[], now)
    }

    fn unavailable_labels(&self) -> Vec<UnavailableLabel> {
        let Some(loaded) = &self.models_loaded else {
            return Vec::new();
        };
        self.recipes
            .iter()
            .filter(|recipe| recipe.enabled)
            .flat_map(|recipe| {
                recipe.stages.iter().filter_map(|stage| match stage {
                    Stage::Model { label, .. } if !loaded.contains(label) => {
                        Some(UnavailableLabel {
                            recipe: recipe.id.clone(),
                            label: label.clone(),
                        })
                    }
                    _ => None,
                })
            })
            .collect()
    }

    /// The label runtime's latest word. `held` is everything detected and cleared to act right now; `risen` the
    /// labels that started a moment ago; `dropped` those whose detection was cut short (a fault, a model change),
    /// whose pending one-shot must not fire. `now_ns` is the label runtime's clock, which also expires old pulses.
    pub fn set_models(
        &mut self,
        loaded: BTreeSet<String>,
        held: BTreeSet<String>,
        risen: &[String],
        dropped: &[String],
        now_ns: u64,
    ) -> Effects {
        self.model_now_ns = now_ns;
        for label in risen {
            self.model_pulses
                .insert(label.clone(), now_ns + MODEL_PULSE_NS);
        }
        // Dropped wins over risen in the same update: when unsure, fail closed.
        for label in dropped {
            self.model_pulses.remove(label);
        }
        self.model_pulses.retain(|_, until| *until > now_ns);
        self.models_held = held;
        if self.models_loaded.as_ref() != Some(&loaded) {
            self.labels_dirty = true;
        }
        self.models_loaded = Some(loaded);
        self.step()
    }

    pub fn set_head(&mut self, location: Option<String>) -> Effects {
        self.head = location;
        self.step()
    }

    pub fn set_stem(&mut self, held: bool) -> Effects {
        self.stem = held;
        self.step()
    }

    /// The watch went away: nothing it contributed can still hold.
    pub fn watch_lost(&mut self) -> Effects {
        self.models_held.clear();
        self.model_pulses.clear();
        self.stem = false;
        self.orientation = None;
        self.last_accepted = None;
        self.shake.reset();
        self.shake_until_ns = 0;
        self.swipe.reset();
        self.swipe_until_ns = 0;
        self.tap.reset();
        self.tap_until_ns = 0;
        self.roll.reset();
        self.roll_until_ns = 0;
        self.pitch.reset();
        self.pitch_until_ns = 0;
        self.step()
    }

    /// Escape or a forced release: end whatever is running until the user lets go and starts again.
    pub fn cancel(&mut self) -> Effects {
        for runner in &mut self.runners {
            runner.cancel();
        }
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
        // A gesture switched off in Settings is not fed at all, so it can never be recognised or reported.
        let on = self.tuning.heuristics;
        let shook = on.shake
            && acceleration
                .is_some_and(|acceleration| self.shake.observe(timestamp_ns, acceleration));
        if shook {
            self.shake_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let swiped = acceleration
            .filter(|_| on.swipe)
            .and_then(|acceleration| self.swipe.observe(timestamp_ns, acceleration, quaternion));
        if let Some(direction) = swiped {
            self.swipe_direction = Some(direction);
            self.swipe_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let tapped = acceleration
            .filter(|_| on.tap)
            .and_then(|acceleration| self.tap.observe(timestamp_ns, acceleration));
        if let Some(kind) = tapped {
            self.tap_kind = Some(kind);
            self.tap_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let rolled = on
            .roll
            .then(|| self.roll.observe(timestamp_ns, quaternion))
            .flatten();
        if let Some(direction) = rolled {
            self.roll_direction = Some(direction);
            self.roll_until_ns = timestamp_ns + SHAKE_HOLD_NS;
        }
        let pitched = on
            .pitch
            .then(|| self.pitch.observe(timestamp_ns, quaternion))
            .flatten();
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
                rolled,
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
        effects.rolled = rolled;
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
        let now = self.model_now_ns;
        let pulsed: BTreeSet<String> = self
            .model_pulses
            .iter()
            .filter(|(_, until)| **until > now)
            .map(|(label, _)| label.clone())
            .collect();
        let camera_pulsed: BTreeSet<String> = self
            .camera_pulses
            .iter()
            .filter(|(_, until)| **until > self.camera_now_ns)
            .map(|(gesture, _)| gesture.clone())
            .collect();
        let signals = Signals {
            models_held: Some(&self.models_held),
            models_pulsed: Some(&pulsed),
            cameras_held: self.cameras_armed.then_some(&self.cameras_held),
            cameras_pulsed: self.cameras_armed.then_some(&camera_pulsed),
            head_location: self.head.as_deref(),
            stem_button_held: self.stem,
            pitch: self
                .orientation
                .as_ref()
                .filter(|latest| latest.timestamp_ns < self.pitch_until_ns)
                .and(self.pitch_direction),
            roll: self
                .orientation
                .as_ref()
                .filter(|latest| latest.timestamp_ns < self.roll_until_ns)
                .and(self.roll_direction),
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
/// Recipes saved before the pinch step moved to a model have `{"kind":"hold","hold":"pinch"}`. That step now reads the
/// model for the label `pinch`, held, so it is rewritten to `{"kind":"model","label":"pinch","hold":"held"}`. Returns how
/// many steps were rewritten.
fn migrate_pinch_steps(recipes: &mut serde_json::Value) -> usize {
    let mut changed = 0;
    let Some(list) = recipes.as_array_mut() else {
        return 0;
    };
    for recipe in list {
        let Some(stages) = recipe
            .get_mut("stages")
            .and_then(|stages| stages.as_array_mut())
        else {
            continue;
        };
        for stage in stages {
            if stage.get("kind").and_then(|kind| kind.as_str()) == Some("hold")
                && stage.get("hold").and_then(|hold| hold.as_str()) == Some("pinch")
            {
                *stage = serde_json::json!({ "kind": "model", "label": "pinch", "hold": "held" });
                changed += 1;
            }
        }
    }
    changed
}

fn load_recipes(app: &AppHandle) -> Vec<Recipe> {
    let loaded = recipes_path(app)
        .and_then(|path| fs::read_to_string(path).map_err(|error| error.to_string()))
        .and_then(|text| {
            let mut value: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let changed = migrate_pinch_steps(&mut value);
            if changed > 0 {
                warn!(changed, "rewrote saved pinch steps to use the pinch model");
            }
            serde_json::from_value::<Vec<Recipe>>(value).map_err(|e| e.to_string())
        });
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

/// What the last state sent to the UI said about models and cameras: unavailable labels, loaded labels, unavailable
/// camera gestures, and whether camera gestures were armed.
type AnnouncedLabels = (
    Vec<UnavailableLabel>,
    Vec<String>,
    Vec<UnavailableCamera>,
    bool,
);

pub struct AutomationRuntime {
    /// Serializes "step the engine, then apply what it asked for", so effects from the head, watch and
    /// inference threads reach the overlay in the order they were decided.
    operations: Mutex<()>,
    engine: Mutex<Engine>,
    actuators: Actuators,
    /// The model-label part of the last state sent to the UI, so a change in what is loaded is announced.
    announced_labels: Mutex<AnnouncedLabels>,
    /// When the app window last reported its camera while it had gestures running; `None` while it has not.
    camera_last: Mutex<Option<Instant>>,
    camera_watchdog_started: AtomicBool,
}

impl Default for AutomationRuntime {
    fn default() -> Self {
        Self {
            operations: Mutex::new(()),
            engine: Mutex::new(Engine::new(default_recipes(), Tuning::default())),
            actuators: Actuators::default(),
            announced_labels: Mutex::new((Vec::new(), Vec::new(), Vec::new(), false)),
            camera_last: Mutex::new(None),
            camera_watchdog_started: AtomicBool::new(false),
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
            // The state is a copy of every recipe, so it is only built when something is going to be told about it.
            let dirty = engine.take_labels_dirty();
            let state = (effects.overlay.is_some() || dirty).then(|| engine.state());
            (effects, state, engine.max_volume_points_per_second())
        };
        apply_effects(app, &effects, max_points);
        if effects.shook {
            let _ = app.emit(SHAKE_DETECTED_EVENT, ());
        }
        if let Some(direction) = effects.pitched {
            let _ = app.emit(PITCH_DETECTED_EVENT, direction);
        }
        if let Some(direction) = effects.rolled {
            let _ = app.emit(ROLL_DETECTED_EVENT, direction);
        }
        if let Some(kind) = effects.tapped {
            let _ = app.emit(TAP_DETECTED_EVENT, kind);
        }
        if let Some(direction) = effects.swiped {
            let _ = app.emit(SWIPE_DETECTED_EVENT, direction);
        }
        let Some(state) = state else { return };
        let labels_changed = self.announced_labels.lock().is_ok_and(|mut announced| {
            let now = (
                state.unavailable.clone(),
                state.loaded_labels.clone(),
                state.unavailable_cameras.clone(),
                state.camera_armed,
            );
            let changed = *announced != now;
            *announced = now;
            changed
        });
        if effects.overlay.is_some() || labels_changed {
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

    pub fn set_stem(&self, app: &AppHandle, held: bool) {
        self.with_engine(app, |engine| engine.set_stem(held));
    }

    /// The label runtime's latest detections; see [`Engine::set_models`].
    pub fn set_models(
        &self,
        app: &AppHandle,
        loaded: BTreeSet<String>,
        held: BTreeSet<String>,
        risen: &[String],
        dropped: &[String],
        now_ns: u64,
    ) {
        self.with_engine(app, |engine| {
            engine.set_models(loaded, held, risen, dropped, now_ns)
        });
    }

    /// The app window's camera report; see [`Engine::set_cameras`]. While the camera has gestures running the window
    /// must keep reporting (a heartbeat); a silence longer than [`CAMERA_STALE`] releases every camera gesture, so a
    /// frozen or hidden window cannot leave one held.
    pub fn set_cameras(
        &self,
        app: &AppHandle,
        known: BTreeSet<String>,
        held: BTreeSet<String>,
        risen: &[String],
    ) {
        if let Ok(mut last) = self.camera_last.lock() {
            *last = (!known.is_empty()).then(Instant::now);
        }
        let now_ns = process_clock_ns();
        self.with_engine(app, |engine| engine.set_cameras(known, held, risen, now_ns));
        self.start_camera_watchdog(app);
    }

    /// Arms or disarms camera gestures; see [`Engine::set_cameras_armed`].
    pub fn set_cameras_armed(&self, app: &AppHandle, armed: bool) -> Result<(), String> {
        let mut result = Ok(());
        self.with_engine(app, |engine| match engine.set_cameras_armed(armed) {
            Ok(effects) => effects,
            Err(reason) => {
                result = Err(reason.to_string());
                Effects::default()
            }
        });
        result
    }

    fn start_camera_watchdog(&self, app: &AppHandle) {
        if self.camera_watchdog_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(CAMERA_WATCHDOG_TICK);
                let runtime = app.state::<AutomationRuntime>();
                let stale = runtime.camera_last.lock().is_ok_and(|mut last| {
                    let stale = last.is_some_and(|at| at.elapsed() > CAMERA_STALE);
                    if stale {
                        *last = None;
                    }
                    stale
                });
                if stale {
                    warn!("the camera stopped reporting; releasing its gestures");
                    runtime.with_engine(&app, Engine::camera_lost);
                }
            }
        });
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

/// Names of the recipes that use a Gesture library gesture, so it is not deleted from under them.
pub fn recipes_using_gesture(recipes: &[Recipe], gesture_id: &str) -> Vec<String> {
    recipes
        .iter()
        .filter(|recipe| {
            recipe.stages.iter().any(
                |stage| matches!(stage, Stage::Camera { gesture, .. } if gesture == gesture_id),
            )
        })
        .map(|recipe| recipe.name.clone())
        .collect()
}

/// The app window's camera report: which library gestures the camera is running, which it sees now, and which it
/// began to see. Ids that are not valid gesture ids are dropped.
#[tauri::command]
pub fn report_camera_gestures(
    known: Vec<String>,
    held: Vec<String>,
    risen: Vec<String>,
    runtime: State<'_, AutomationRuntime>,
    app: AppHandle,
) -> Result<(), String> {
    if known.len() > MAX_CAMERA_REPORT
        || held.len() > MAX_CAMERA_REPORT
        || risen.len() > MAX_CAMERA_REPORT
    {
        return Err("the camera report is too large".to_string());
    }
    let valid = |ids: Vec<String>| -> BTreeSet<String> {
        ids.into_iter()
            .filter(|id| automation::is_valid_gesture_id(id))
            .collect()
    };
    let risen: Vec<String> = valid(risen).into_iter().collect();
    runtime.set_cameras(&app, valid(known), valid(held), &risen);
    Ok(())
}

/// Switches camera gestures on or off for recipes. Refused when arming without a running camera.
#[tauri::command]
pub fn set_camera_armed(
    armed: bool,
    runtime: State<'_, AutomationRuntime>,
    app: AppHandle,
) -> Result<AutomationState, String> {
    runtime.set_cameras_armed(&app, armed)?;
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
    use automation::ModelHold;

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
        recipes[1].enabled = true; // the pinch model alongside the STEM recipe
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
    fn a_saved_pinch_step_becomes_a_step_that_reads_the_pinch_model() {
        let mut saved = serde_json::json!([
            { "id": "a", "name": "Old pinch", "enabled": true, "action": "volume",
              "stages": [
                { "kind": "headAt", "location": "topRight" },
                { "kind": "hold", "hold": "pinch" },
                { "kind": "drive", "axis": "roll", "deadZoneDegrees": 3.0, "invert": false }
              ],
              "device": { "kind": "rotationKnob", "fractionPerDegree": 0.003 } },
            { "id": "b", "name": "Stem", "enabled": false, "action": "playPause",
              "stages": [ { "kind": "hold", "hold": "stemButton" } ],
              "device": { "kind": "rotationKnob", "fractionPerDegree": 0.003 } }
        ]);
        assert_eq!(migrate_pinch_steps(&mut saved), 1);
        let recipes: Vec<Recipe> = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(
            recipes[0].stages[1],
            Stage::Model {
                label: "pinch".into(),
                hold: ModelHold::Held
            }
        );
        assert!(validate_recipe(&recipes[0]).is_ok());
        assert_eq!(
            recipes[1].stages[0],
            Stage::Hold {
                hold: Hold::StemButton
            }
        );
        // Nothing left to rewrite the second time.
        assert_eq!(migrate_pinch_steps(&mut saved), 0);
    }

    #[test]
    fn the_pinch_model_recipe_runs_when_it_alone_is_enabled() {
        let mut engine = Engine::new(only("lookPinchVolume"), Tuning::default());
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_head(Some("topRight".into()));
        let loaded = set(&["pinch"]);
        let held = |engine: &mut Engine, now| {
            engine.set_models(loaded.clone(), set(&["pinch"]), &[], &[], now)
        };
        assert_eq!(held(&mut engine, MS).overlay, Some(OverlayWanted::Driving));
        // A forced release ends it and it stays ended while the head is still on the corner.
        assert_eq!(engine.cancel().overlay, Some(OverlayWanted::Hidden));
        assert_eq!(held(&mut engine, 2 * MS), Effects::default());
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
    fn a_media_trigger_fires_once_on_the_button_and_shows_no_volume_knob() {
        let mut engine = Engine::new(
            vec![trigger_recipe(Action::PlayPause, Hold::StemButton)],
            Tuning::default(),
        );
        let pinched = engine.set_stem(true);
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
        assert!(engine.set_stem(false).fired.is_empty());
        assert_eq!(engine.set_stem(true).fired, vec![Action::PlayPause]);
    }

    #[test]
    fn a_held_trigger_does_not_trip_the_glitch_filter_that_guards_a_turning_device() {
        // The button is held (the trigger is "driving") while a STEM scroll recipe turns: a fast sample must still
        // be judged by the scroll recipe's own state, and a trigger alone must never freeze orientation.
        let mut engine = Engine::new(
            vec![trigger_recipe(Action::NextTrack, Hold::SwipeLeft)],
            Tuning::default(),
        );
        engine.set_stem(true);
        engine.observe_orientation(about_x(0.0), ts(1), None);
        let _ = engine.observe_orientation(about_x(120.0), ts(2), None);
        assert_eq!(engine.orientation.as_ref().unwrap().timestamp_ns, ts(2));
    }

    #[test]
    fn two_recipes_on_the_same_media_key_conflict_but_different_keys_do_not() {
        let mut other = trigger_recipe(Action::PlayPause, Hold::StemButton);
        other.id = "other".into();
        let engine = Engine::new(
            vec![trigger_recipe(Action::PlayPause, Hold::Shake), other],
            Tuning::default(),
        );
        assert_eq!(engine.state().conflicts.len(), 1);
        assert_eq!(engine.state().conflicts[0].resource, "playPause");
        let engine = Engine::new(
            vec![
                trigger_recipe(Action::PlayPause, Hold::StemButton),
                trigger_recipe(Action::NextTrack, Hold::SwipeLeft),
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

    fn roll_pose(degrees: f64) -> [f64; 4] {
        about_x(degrees)
    }

    /// Feeds 50 Hz orientation: a quick roll of `degrees` over 300 ms starting at 1 s, then still.
    fn roll_for(
        engine: &mut Engine,
        degrees: f64,
        offset_ms: u64,
    ) -> (Vec<RollDirection>, Vec<Action>) {
        let (mut rotations, mut fired) = (Vec::new(), Vec::new());
        for ms in (0..=3000u64).step_by(20) {
            let angle = match ms {
                0..1000 => 0.0,
                1000..1300 => degrees * (ms - 1000) as f64 / 300.0,
                _ => degrees,
            };
            let effects =
                engine.observe_orientation(roll_pose(angle), (offset_ms + ms) * 1_000_000, None);
            rotations.extend(effects.rolled);
            fired.extend(effects.fired);
        }
        (rotations, fired)
    }

    #[test]
    fn a_quick_wrist_twist_fires_the_recipe_for_its_direction() {
        let mut engine = Engine::new(
            vec![
                swipe_recipe(Hold::RollClockwise, Action::NextTrack),
                swipe_recipe(Hold::RollCounterClockwise, Action::PreviousTrack),
            ],
            Tuning::default(),
        );
        assert_eq!(
            roll_for(&mut engine, 90.0, 0),
            (vec![RollDirection::Clockwise], vec![Action::NextTrack])
        );
        // The watch is now 90 degrees round, so a flick back is a 90 degree turn the other way.
        let mut engine = Engine::new(
            vec![swipe_recipe(
                Hold::RollCounterClockwise,
                Action::PreviousTrack,
            )],
            Tuning::default(),
        );
        assert_eq!(
            roll_for(&mut engine, -90.0, 0),
            (
                vec![RollDirection::CounterClockwise],
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
                        .observe_orientation(roll_pose(angle), ms * 1_000_000, None)
                        .rolled,
                );
            }
            found
        };
        use CrownSide::{Left as CrownLeft, Right as CrownRight};
        assert_eq!(
            direction(Wrist::Left, CrownRight),
            vec![RollDirection::Clockwise]
        );
        assert_eq!(
            direction(Wrist::Right, CrownRight),
            vec![RollDirection::CounterClockwise]
        );
        assert_eq!(
            direction(Wrist::Left, CrownLeft),
            vec![RollDirection::CounterClockwise]
        );
        assert_eq!(
            direction(Wrist::Right, CrownLeft),
            vec![RollDirection::Clockwise]
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
    fn the_roll_angle_setting_is_obeyed_and_a_roll_does_not_disturb_a_dial() {
        let strict = Tuning {
            roll_angle_degrees: 150.0,
            ..Tuning::default()
        };
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::RollClockwise, Action::NextTrack)],
            strict,
        );
        assert!(roll_for(&mut engine, 90.0, 0).0.is_empty());
        engine.set_tuning(Tuning::default());
        assert_eq!(roll_for(&mut engine, 90.0, 10_000).0.len(), 1);
    }

    #[test]
    fn a_gesture_switched_off_is_never_recognised_or_reported_and_the_others_still_are() {
        let off = |f: fn(&mut HeuristicGestures)| {
            let mut heuristics = HeuristicGestures::default();
            f(&mut heuristics);
            Tuning {
                heuristics,
                ..Tuning::default()
            }
        };
        // Taps off: a knock that would be a tap does nothing, and neither does its recipe.
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::Tap, Action::PlayPause)],
            off(|h| h.tap = false),
        );
        assert_eq!(tap_for(&mut engine, &[1000], 0), (vec![], vec![]));
        // Back on (as the Settings switch does by rebuilding the tuning), the same knock is recognised.
        engine.set_tuning(Tuning::default());
        assert_eq!(
            tap_for(&mut engine, &[1000], 10_000).0,
            vec![TapKind::Single]
        );

        // Swipes off, taps still on.
        let mut engine = Engine::new(
            vec![
                swipe_recipe(Hold::SwipeRight, Action::NextTrack),
                swipe_recipe(Hold::Tap, Action::PlayPause),
            ],
            off(|h| h.swipe = false),
        );
        assert!(swipe_for(&mut engine, 14.0, 0).0.is_empty());
        assert_eq!(
            tap_for(&mut engine, &[1000], 10_000).0,
            vec![TapKind::Single]
        );

        // Roll and pitch off: a flick that would count is ignored.
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::RollClockwise, Action::NextTrack)],
            off(|h| h.roll = false),
        );
        assert!(roll_for(&mut engine, 90.0, 0).0.is_empty());
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::PitchUp, Action::PlayPause)],
            off(|h| h.pitch = false),
        );
        assert!(pitch_for(&mut engine, -60.0, 0).0.is_empty());
        // Shake off.
        let mut engine = Engine::new(
            vec![swipe_recipe(Hold::Shake, Action::NextTrack)],
            off(|h| h.shake = false),
        );
        assert!(shake_for(&mut engine, 4, 0).is_empty());
    }

    fn model_recipe(label: &str, hold: ModelHold, action: Action) -> Recipe {
        let mut recipe = swipe_recipe(Hold::Tap, action);
        recipe.id = format!("{label}{hold:?}");
        recipe.stages = vec![Stage::Model {
            label: label.into(),
            hold,
        }];
        recipe
    }

    fn set(labels: &[&str]) -> BTreeSet<String> {
        labels.iter().map(ToString::to_string).collect()
    }

    const MS: u64 = 1_000_000;

    #[test]
    fn a_one_shot_model_label_fires_once_when_it_rises_and_not_again_while_it_stays() {
        let mut engine = Engine::new(
            vec![model_recipe("snap", ModelHold::OneShot, Action::PlayPause)],
            Tuning::default(),
        );
        let loaded = set(&["snap"]);
        let rise = engine.set_models(
            loaded.clone(),
            set(&["snap"]),
            &["snap".to_string()],
            &[],
            100 * MS,
        );
        assert_eq!(rise.fired, vec![Action::PlayPause]);
        // Still detected on the next updates: the chain keeps holding, so it must not fire again.
        let again = engine.set_models(loaded.clone(), set(&["snap"]), &[], &[], 200 * MS);
        assert!(again.fired.is_empty());
        let later = engine.set_models(loaded, set(&["snap"]), &[], &[], 900 * MS);
        assert!(later.fired.is_empty());
    }

    #[test]
    fn a_one_shot_that_ended_abnormally_does_not_fire_and_one_that_ended_normally_still_counts() {
        let mut engine = Engine::new(
            vec![
                model_recipe("snap", ModelHold::OneShot, Action::PlayPause),
                model_recipe("flick", ModelHold::OneShot, Action::Mute),
            ],
            Tuning::default(),
        );
        let loaded = set(&["snap", "flick"]);
        // Rising and a fault in the same update: the recipe waiting on it must not fire.
        let faulted = engine.set_models(
            loaded.clone(),
            set(&[]),
            &["snap".to_string()],
            &["snap".to_string()],
            100 * MS,
        );
        assert!(faulted.fired.is_empty());
        // A normal release before the moment is over does not undo the gesture.
        let rose = engine.set_models(
            loaded.clone(),
            set(&["flick"]),
            &["flick".to_string()],
            &[],
            200 * MS,
        );
        assert_eq!(rose.fired, vec![Action::Mute]);
    }

    #[test]
    fn a_held_model_label_can_drive_a_dial_and_lets_go_when_it_falls() {
        let mut recipe = driving(Action::Brightness);
        recipe.stages[0] = Stage::Model {
            label: "fist".into(),
            hold: ModelHold::Held,
        };
        assert_eq!(validate_recipe(&recipe), Ok(()));
        let mut engine = Engine::new(vec![recipe], Tuning::default());
        let loaded = set(&["fist"]);
        engine.observe_orientation(about_x(0.0), ts(1), None);
        engine.set_models(
            loaded.clone(),
            set(&["fist"]),
            &["fist".to_string()],
            &[],
            MS,
        );
        engine.observe_orientation(about_x(0.0), ts(2), None);
        let moved = engine.observe_orientation(about_x(30.0), ts(3), None);
        assert_eq!(moved.deltas.len(), 1);
        let released = engine.set_models(loaded, set(&[]), &[], &[], 2 * MS);
        assert_eq!(released.ended, vec![Action::Brightness]);
        assert!(
            engine
                .observe_orientation(about_x(60.0), ts(4), None)
                .deltas
                .is_empty()
        );
    }

    #[test]
    fn a_recipe_naming_a_label_that_is_not_loaded_is_reported_and_never_runs() {
        let mut engine = Engine::new(
            vec![model_recipe("snap", ModelHold::OneShot, Action::PlayPause)],
            Tuning::default(),
        );
        // Until the label runtime has said what it loaded, nothing is reported.
        assert!(engine.state().unavailable.is_empty());
        engine.set_models(set(&["other"]), set(&[]), &[], &[], MS);
        let state = engine.state();
        assert_eq!(
            state.unavailable,
            vec![UnavailableLabel {
                recipe: "snapOneShot".into(),
                label: "snap".into()
            }]
        );
        // A label the runtime reports but that is not loaded cannot fire a recipe.
        let effects = engine.set_models(set(&["other"]), set(&["snap"]), &[], &[], 2 * MS);
        assert!(effects.fired.is_empty());
        engine.set_models(set(&["snap"]), set(&[]), &[], &[], 3 * MS);
        assert!(engine.state().unavailable.is_empty());
    }

    fn camera_recipe(gesture: &str, hold: ModelHold, action: Action) -> Recipe {
        let mut recipe = swipe_recipe(Hold::Tap, action);
        recipe.id = format!("{gesture}{hold:?}");
        recipe.stages = vec![Stage::Camera {
            gesture: gesture.into(),
            hold,
        }];
        recipe
    }

    #[test]
    fn a_one_shot_camera_gesture_fires_once_when_it_rises_and_not_again_while_it_stays() {
        let mut engine = Engine::new(
            vec![camera_recipe(
                "gesture-1",
                ModelHold::OneShot,
                Action::PlayPause,
            )],
            Tuning::default(),
        );
        let known = set(&["gesture-1"]);
        engine.set_cameras(known.clone(), set(&[]), &[], 50 * MS);
        engine.set_cameras_armed(true).unwrap();
        let rise = engine.set_cameras(
            known.clone(),
            set(&["gesture-1"]),
            &["gesture-1".to_string()],
            100 * MS,
        );
        assert_eq!(rise.fired, vec![Action::PlayPause]);
        assert!(
            engine
                .set_cameras(known.clone(), set(&["gesture-1"]), &[], 200 * MS)
                .fired
                .is_empty()
        );
        assert!(
            engine
                .set_cameras(known, set(&["gesture-1"]), &[], 900 * MS)
                .fired
                .is_empty()
        );
    }

    #[test]
    fn a_camera_gesture_the_camera_is_not_running_never_acts_and_is_reported_unavailable() {
        let mut engine = Engine::new(
            vec![camera_recipe(
                "gesture-1",
                ModelHold::OneShot,
                Action::PlayPause,
            )],
            Tuning::default(),
        );
        // Before any report, and with the camera off (nothing known), the recipe cannot start and says why.
        assert_eq!(
            engine.state().unavailable_cameras,
            vec![UnavailableCamera {
                recipe: "gesture-1OneShot".into(),
                gesture: "gesture-1".into()
            }]
        );
        // A held or risen gesture the camera does not know (deleted, or from before it was turned off) is ignored.
        let effects = engine.set_cameras(
            set(&["other"]),
            set(&["gesture-1"]),
            &["gesture-1".to_string()],
            MS,
        );
        assert!(effects.fired.is_empty());
        assert!(engine.cameras_held.is_empty() && engine.camera_pulses.is_empty());
        engine.set_cameras(set(&["gesture-1"]), set(&[]), &[], 2 * MS);
        assert!(engine.state().unavailable_cameras.is_empty());
        engine.set_recipes(
            vec![camera_recipe(
                "gesture-1",
                ModelHold::OneShot,
                Action::PlayPause,
            )]
            .into_iter()
            .map(|mut r| {
                r.enabled = false;
                r
            })
            .collect(),
        );
        assert!(engine.state().unavailable_cameras.is_empty());
    }

    #[test]
    fn a_held_camera_gesture_lets_go_when_the_camera_goes_quiet_and_a_pulse_expires() {
        let mut engine = Engine::new(
            vec![
                camera_recipe("gesture-1", ModelHold::Held, Action::PlayPause),
                camera_recipe("gesture-2", ModelHold::OneShot, Action::Mute),
            ],
            Tuning::default(),
        );
        let known = set(&["gesture-1", "gesture-2"]);
        engine.set_cameras(known.clone(), set(&[]), &[], MS);
        engine.set_cameras_armed(true).unwrap();
        engine.set_cameras(
            known.clone(),
            set(&["gesture-1"]),
            &["gesture-2".to_string()],
            10 * MS,
        );
        assert!(engine.cameras_held.contains("gesture-1"));
        assert!(engine.camera_pulses.contains_key("gesture-2"));
        // The pulse is over after its moment even while the gesture stays held.
        engine.set_cameras(
            known,
            set(&["gesture-1", "gesture-2"]),
            &[],
            10 * MS + MODEL_PULSE_NS + MS,
        );
        assert!(engine.camera_pulses.is_empty());
        engine.camera_lost();
        assert!(engine.cameras_held.is_empty() && engine.cameras_known.is_empty());
    }

    #[test]
    fn camera_gestures_do_nothing_until_armed_and_arming_needs_a_running_camera() {
        let mut engine = Engine::new(
            vec![
                camera_recipe("gesture-1", ModelHold::OneShot, Action::PlayPause),
                camera_recipe("gesture-1", ModelHold::Held, Action::Mute),
            ],
            Tuning::default(),
        );
        assert!(!engine.state().camera_armed);
        assert!(engine.set_cameras_armed(true).is_err(), "no camera running");
        assert!(!engine.state().camera_armed);
        let known = set(&["gesture-1"]);
        // Seen while disarmed: nothing fires, and the pulse does not wait around for arming.
        let seen = engine.set_cameras(
            known.clone(),
            set(&["gesture-1"]),
            &["gesture-1".to_string()],
            100 * MS,
        );
        assert!(seen.fired.is_empty());
        let armed = engine.set_cameras_armed(true).unwrap();
        assert!(
            !armed.fired.contains(&Action::PlayPause),
            "a pulse from before arming must not fire"
        );
        // Already held at arming: a held gesture counts (it is what the person is doing now).
        assert!(armed.fired.contains(&Action::Mute));
        assert!(engine.state().camera_armed);
        // Disarming releases at once.
        engine.set_cameras_armed(false).unwrap();
        assert!(!engine.state().camera_armed);
    }

    #[test]
    fn the_camera_stopping_disarms_so_turning_it_back_on_does_not_act_by_itself() {
        let mut engine = Engine::new(
            vec![camera_recipe(
                "gesture-1",
                ModelHold::OneShot,
                Action::PlayPause,
            )],
            Tuning::default(),
        );
        let known = set(&["gesture-1"]);
        engine.set_cameras(known.clone(), set(&[]), &[], MS);
        engine.set_cameras_armed(true).unwrap();
        engine.camera_lost();
        assert!(!engine.state().camera_armed);
        let back = engine.set_cameras(
            known,
            set(&["gesture-1"]),
            &["gesture-1".to_string()],
            5 * MS,
        );
        assert!(back.fired.is_empty());
    }

    #[test]
    fn recipes_using_a_gesture_are_found_by_name() {
        let recipes = vec![
            camera_recipe("gesture-1", ModelHold::Held, Action::PlayPause),
            camera_recipe("gesture-2", ModelHold::Held, Action::Mute),
            model_recipe("gesture-1", ModelHold::Held, Action::NextTrack),
        ];
        assert_eq!(recipes_using_gesture(&recipes, "gesture-1").len(), 1);
        assert!(recipes_using_gesture(&recipes, "gesture-9").is_empty());
    }

    #[test]
    fn losing_the_watch_drops_model_detections() {
        let mut engine = Engine::new(
            vec![model_recipe("fist", ModelHold::Held, Action::PlayPause)],
            Tuning::default(),
        );
        engine.set_models(set(&["fist"]), set(&["fist"]), &[], &[], MS);
        engine.watch_lost();
        assert!(engine.models_held.is_empty() && engine.model_pulses.is_empty());
    }

    #[test]
    fn two_recipes_on_the_same_action_with_different_model_labels_conflict() {
        let engine = Engine::new(
            vec![
                model_recipe("a", ModelHold::OneShot, Action::PlayPause),
                model_recipe("b", ModelHold::OneShot, Action::PlayPause),
            ],
            Tuning::default(),
        );
        assert_eq!(engine.state().conflicts.len(), 1);
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
