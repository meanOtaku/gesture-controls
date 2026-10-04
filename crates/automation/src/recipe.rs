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
}

impl Action {
    /// Two recipes conflict when they drive the same resource.
    pub fn resource(self) -> &'static str {
        match self {
            Action::Volume => "volume",
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
    /// The PPG pinch gesture, after the gesture policy has allowed it.
    Pinch,
    /// The watch STEM button held down.
    StemButton,
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
    /// The wrist rotating about an axis, measured from where the hold began. Always the last stage; it
    /// supplies the continuous value. Movement inside `dead_zone_degrees` of the start is ignored, and
    /// `invert` flips the direction for a watch worn the other way round.
    Drive {
        axis: Axis,
        dead_zone_degrees: f64,
        invert: bool,
    },
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
    if recipe.stages.len() > MAX_STAGES {
        return Err(RecipeError::TooManyStages);
    }
    if !matches!(last, Stage::Drive { .. }) {
        return Err(RecipeError::MustEndWithDrive);
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
