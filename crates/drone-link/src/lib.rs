//! Flies a Wi-Fi toy drone that speaks the WIFI UAV app's protocol, such as the DM002HW.
//!
//! [`frame`] holds the wire format, [`Pilot`] decides what may be sent, and [`Link`] sends it over UDP at the app's
//! rate. The drone reports nothing back that says it is flying or that it heard us, so safety rests on what is sent:
//! nothing moves until the pilot is armed, and input that stops arriving centres the sticks and then lands. The
//! format is written up in `docs/protocols/wifi-uav-drone.md`.

pub mod frame;
mod link;
mod pilot;

pub use frame::{Button, Control, Sticks};
pub use link::{Endpoint, Link, LinkError, LinkPhase, LinkStatus, LinkTiming};
pub use pilot::{Pilot, PilotConfig, PilotError};
