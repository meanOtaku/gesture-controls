//! Gesture recipes: chains of gesture stages that drive a virtual device, which drives one action.
//!
//! A recipe such as "look at top right -> pinch to hold -> roll the wrist" is `[Gate, Hold, Drive]` feeding a
//! [`Device`] feeding an [`Action`]. Every stage before the drive must hold for the drive to do anything;
//! releasing any of them ends the interaction. Nothing here touches hardware, windows or the OS: it consumes
//! plain [`Signals`] and produces plain [`Output`]s, so the same engine can run in the foreground app today and
//! in a background host later.

mod conflicts;
mod device;
mod flick;
mod pitch;
mod recipe;
mod roll;
mod runner;
mod shake;
mod swipe;
mod tap;

pub use conflicts::{Conflict, blocked_recipes, find_conflicts};
pub use device::{Device, DeviceKind, Output};
pub use pitch::{PitchConfig, PitchDetector, PitchDirection};
pub use recipe::{Action, Axis, Hold, MAX_STAGES, Recipe, RecipeError, Stage, validate_recipe};
pub use roll::{RollConfig, RollDetector, RollDirection};
pub use runner::{RecipeRunner, RunnerPhase, Signals};
pub use shake::{ShakeConfig, ShakeDetector};
pub use swipe::{CrownSide, SwipeConfig, SwipeDetector, SwipeDirection, Wrist};
pub use tap::{TapConfig, TapDetector, TapKind};
