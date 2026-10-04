//! Controls for the parts of the computer a gesture recipe can drive besides volume: screen brightness and
//! scrolling. Each is a small trait with one adapter per platform, so the recipe engine never knows which OS it
//! is on, and so the quantizing logic that sits above them can be tested without touching the real machine.

mod accumulator;
mod brightness;
mod media;
mod scroll;

pub use accumulator::Accumulator;
pub use brightness::{BrightnessController, platform_brightness_controller};
pub use media::{MediaController, MediaKey, platform_media_controller};
pub use scroll::{MAX_PIXELS_PER_CALL, ScrollController, platform_scroll_controller};

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Clone)]
pub enum ControlError {
    #[error("{0} is not supported on this platform")]
    Unsupported(&'static str),
    /// The OS refused because the app lacks a permission the user can grant.
    #[error("{0}")]
    PermissionNeeded(String),
    #[error("{0}")]
    Backend(String),
}
