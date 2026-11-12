use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::device::Device;

pub const MAX_STAGES: usize = 6;
pub const MAX_RECIPE_NAME_CHARS: usize = 40;

/// What a recipe controls. Each action names the one resource it drives, which is how conflicts are found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Volume,
    Brightness,
    Scroll,
    /// Play or pause the current media. A trigger: it fires once, it is not turned.
    PlayPause,
    NextTrack,
    PreviousTrack,
    /// Toggle the system mute.
    Mute,
    /// Press the recipe's keyboard shortcut ([`Recipe::keys`]) once. A trigger.
    Shortcut,
}

impl Action {
    /// A trigger fires once when its chain completes, instead of following the wrist. Its recipe has no wrist
    /// rotation stage and its device is unused.
    pub fn is_trigger(self) -> bool {
        matches!(
            self,
            Action::PlayPause
                | Action::NextTrack
                | Action::PreviousTrack
                | Action::Mute
                | Action::Shortcut
        )
    }

    /// Two recipes conflict when they drive the same resource.
    pub fn resource(self) -> &'static str {
        match self {
            Action::Volume => "volume",
            Action::Brightness => "brightness",
            Action::Scroll => "scroll",
            Action::PlayPause => "playPause",
            Action::NextTrack => "nextTrack",
            Action::PreviousTrack => "previousTrack",
            Action::Mute => "mute",
            Action::Shortcut => "shortcut",
        }
    }
}

/// A wrist rotation axis of the watch body: roll is about the forearm (the case's 9-3 direction), the other
/// two are the case's 12-6 and its face normal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    Roll,
    Pitch,
    Yaw,
}

/// A gesture that must be held for the chain to continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Hold {
    /// The watch STEM button held down.
    StemButton,
    /// A quick shake of the wrist, in any direction. It is a moment, not something held, so it counts as "holding"
    /// for a short while after it is recognised: it presses a button, or switches a dial on and off.
    Shake,
    /// A shake in and out along the forearm, like a pump.
    ShakeAlong,
    /// A shake up and down against gravity, like a salt shaker, however the hand is turned.
    ShakeVertical,
    /// A shake side to side, level with the ground, like wiping.
    ShakeSideways,
    /// A quick twist of the wrist back and forth, like rattling a door knob.
    Wiggle,
    /// The fist brought down on the other palm, or a clap: the moving arm stopping dead.
    Hammer,
    /// A quick swipe of the hand, read from the watch's acceleration. A moment, like a shake.
    SwipeLeft,
    SwipeRight,
    SwipeUp,
    SwipeDown,
    /// One knock of a finger on the watch.
    Tap,
    /// Two quick knocks.
    DoubleTap,
    /// A quick twist of the wrist, one way or the other: the one-shot cousin of the roll that turns a dial.
    #[serde(alias = "rotateClockwise")]
    RollClockwise,
    #[serde(alias = "rotateCounterClockwise")]
    RollCounterClockwise,
    /// A quick tilt of the hand up or down at the wrist, like a nod of the hand.
    PitchUp,
    PitchDown,
}

impl Hold {
    /// A shake or swipe is over in a moment: it counts as "holding" for a short while after it is recognised. In a
    /// button recipe it presses the button; in a dial recipe it switches the dial on, and off again the next time.
    pub fn is_momentary(self) -> bool {
        !matches!(self, Hold::StemButton)
    }
}

/// How a recipe uses a model's detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelHold {
    /// The label counts while it stays detected, like a pinch. Can keep a dial turning.
    Held,
    /// The label counts for a short moment after it is first detected, like a shake: it presses a button, or
    /// switches a dial on and off.
    OneShot,
}

pub const MAX_LABEL_CHARS: usize = 48;

pub const MAX_GESTURE_ID_CHARS: usize = 64;

/// A Gesture library id: letters, digits, hyphens and underscores.
pub fn is_valid_gesture_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_GESTURE_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The same shape a model label has everywhere: a lowercase slug.
pub fn is_valid_label(label: &str) -> bool {
    let mut chars = label.chars();
    label.len() <= MAX_LABEL_CHARS
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Stage {
    /// The head dwells on a calibrated location (by id).
    HeadAt { location: String },
    /// A gesture held down.
    Hold { hold: Hold },
    /// A trained model's label, detected by the label runtime.
    Model { label: String, hold: ModelHold },
    /// A fresh start grabs until a separate end event. Both labels must remain healthy.
    ModelPair {
        start_label: String,
        end_label: String,
    },
    /// A gesture from the Gesture library (by id), seen by the camera. Only works while the app is open and its
    /// camera is on; see `report_camera_gestures` in the desktop.
    Camera { gesture: String, hold: ModelHold },
    /// The wrist rotating about an axis, measured from where the hold began. Always the last stage; it
    /// supplies the continuous value. Movement inside `dead_zone_degrees` of the start is ignored, and
    /// `invert` flips the direction for a watch worn the other way round.
    Drive {
        axis: Axis,
        dead_zone_degrees: f64,
        invert: bool,
    },
}

impl Stage {
    /// A step that is over in a moment: a shake, swipe, tap or flick, or a model label or camera gesture used once.
    pub fn is_momentary(&self) -> bool {
        match self {
            Stage::Hold { hold } => hold.is_momentary(),
            Stage::Model { hold, .. } | Stage::Camera { hold, .. } => *hold == ModelHold::OneShot,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub stages: Vec<Stage>,
    pub device: Device,
    pub action: Action,
    /// The keyboard shortcut a [`Action::Shortcut`] recipe presses, such as `cmd+shift+4`. The host checks it can be
    /// pressed; here it only has to be there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<String>,
}

pub const MAX_KEYS_CHARS: usize = 40;

impl Recipe {
    /// The one thing this recipe drives. Two enabled recipes with the same resource conflict. Each keyboard shortcut is
    /// a resource of its own, so two recipes may press different shortcuts but not the same one.
    pub fn resource(&self) -> String {
        match (self.action, &self.keys) {
            (Action::Shortcut, Some(keys)) => format!("shortcut {}", keys.trim().to_lowercase()),
            (action, _) => action.resource().to_string(),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RecipeError {
    #[error("give the recipe a name of 1 to {MAX_RECIPE_NAME_CHARS} characters")]
    InvalidName,
    #[error("a recipe needs at least one stage")]
    NoStages,
    #[error("a recipe can have at most {MAX_STAGES} stages")]
    TooManyStages,
    #[error("the last stage must be the wrist rotation that drives the device")]
    MustEndWithDrive,
    #[error("only the last stage can be a wrist rotation")]
    DriveNotLast,
    #[error("a head location is used twice")]
    RepeatedStage,
    #[error("an action that fires once cannot have a wrist rotation: remove it")]
    TriggerHasDrive,
    #[error("a model step needs a label made of lowercase letters, digits and underscores")]
    InvalidLabel,
    #[error(
        "use one paired model step with two different labels and a continuous action, and no shake, swipe, tap, flick or one-shot step beside it"
    )]
    InvalidModelPair,
    #[error("a camera gesture step needs a Gesture library gesture")]
    InvalidCameraGesture,
    #[error("a keyboard shortcut recipe needs its shortcut, such as cmd+shift+4")]
    MissingKeys,
    #[error("the dead zone must be from 0 to under 90 degrees")]
    InvalidDeadZone,
    #[error("the device settings are out of range")]
    InvalidDevice,
}

/// Checks a recipe is well formed. It does not check that locations exist; the host knows those.
pub fn validate_recipe(recipe: &Recipe) -> Result<(), RecipeError> {
    let name = recipe.name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_RECIPE_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(RecipeError::InvalidName);
    }
    let (last, rest) = recipe.stages.split_last().ok_or(RecipeError::NoStages)?;
    let pairs: Vec<_> = recipe
        .stages
        .iter()
        .filter_map(|s| match s {
            Stage::ModelPair {
                start_label,
                end_label,
            } => Some((start_label, end_label)),
            _ => None,
        })
        .collect();
    if pairs.len() > 1
        || pairs
            .iter()
            .any(|(a, b)| a == b || !is_valid_label(a) || !is_valid_label(b))
        || (!pairs.is_empty() && recipe.action.is_trigger())
    {
        return Err(RecipeError::InvalidModelPair);
    }

    if recipe
        .stages
        .iter()
        .any(|stage| matches!(stage, Stage::Model { label, .. } if !is_valid_label(label)))
    {
        return Err(RecipeError::InvalidLabel);
    }
    if recipe.stages.iter().any(
        |stage| matches!(stage, Stage::Camera { gesture, .. } if !is_valid_gesture_id(gesture)),
    ) {
        return Err(RecipeError::InvalidCameraGesture);
    }
    if recipe.stages.len() > MAX_STAGES {
        return Err(RecipeError::TooManyStages);
    }
    if recipe.action == Action::Shortcut
        && !recipe.keys.as_deref().is_some_and(|keys| {
            let keys = keys.trim();
            !keys.is_empty()
                && keys.chars().count() <= MAX_KEYS_CHARS
                && !keys.chars().any(char::is_control)
        })
    {
        return Err(RecipeError::MissingKeys);
    }
    if recipe.action.is_trigger() {
        if recipe
            .stages
            .iter()
            .any(|stage| matches!(stage, Stage::Drive { .. }))
        {
            return Err(RecipeError::TriggerHasDrive);
        }
        for (index, stage) in recipe.stages.iter().enumerate() {
            if recipe.stages[..index].contains(stage) {
                return Err(RecipeError::RepeatedStage);
            }
        }
        // The device is unused, but it is stored, so it must still be well formed.
        return recipe
            .device
            .validate()
            .map_err(|_| RecipeError::InvalidDevice);
    }
    if !matches!(last, Stage::Drive { .. }) {
        return Err(RecipeError::MustEndWithDrive);
    }
    // A momentary step switches the dial on and off. A grab/release pair already says when the dial is on, so the two
    // cannot be mixed.
    if !pairs.is_empty() && recipe.stages.iter().any(Stage::is_momentary) {
        return Err(RecipeError::InvalidModelPair);
    }
    if rest
        .iter()
        .any(|stage| matches!(stage, Stage::Drive { .. }))
    {
        return Err(RecipeError::DriveNotLast);
    }
    for (index, stage) in rest.iter().enumerate() {
        if rest[..index].contains(stage) {
            return Err(RecipeError::RepeatedStage);
        }
    }
    if let Stage::Drive {
        dead_zone_degrees, ..
    } = last
        && !(dead_zone_degrees.is_finite() && (0.0..90.0).contains(dead_zone_degrees))
    {
        return Err(RecipeError::InvalidDeadZone);
    }
    recipe
        .device
        .validate()
        .map_err(|_| RecipeError::InvalidDevice)
}
