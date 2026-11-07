//! Flies a Wi-Fi toy drone that speaks the WIFI UAV app's protocol, such as the DM002HW.
//!
//! [`frame`] holds the wire format, [`Pilot`] decides what may be sent, and [`Link`] sends it over UDP at the app's
//! rate. The drone reports nothing back that says it is flying or that it heard us, so safety rests on what is sent:
//! nothing moves until the pilot is armed, and input that stops arriving centres the sticks and then lands. The
//! format is written up in `docs/protocols/wifi-uav-drone.md`.

pub mod flight_log;
pub mod frame;
pub mod hold;
mod link;
mod pilot;
mod steering;
pub mod vision;

pub use frame::{Button, Control, DroneStatus, Sticks};
pub use hold::{Autopilot, Calibration, Correction, HoldAxis, HoldConfig, HoldFault, HoldPhase};
pub use link::{
    Endpoint, Link, LinkError, LinkPhase, LinkStatus, LinkTiming, LiveFrame, UnknownPacket, Viewer,
};
pub use pilot::{Pilot, PilotConfig, PilotError};
pub use steering::{Steering, SteeringConfig};
