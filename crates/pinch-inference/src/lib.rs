//! The inputs of the pinch-start models: multi-scale causal z-score derivatives of the pulse (see [`ppg_onset`]) and window
//! summaries of the motion sensors (see [`imu_onset`]). The per-label models in `label-inference` read their inputs through
//! this crate. It is pure and synchronous, with no dependency on watch-bridge or any Tauri type.

pub mod imu_onset;
pub mod ppg_onset;

pub use imu_onset::MotionSample;
pub use ppg_onset::{FEATURE_COUNT, FEATURE_NAMES, PpgSample, features};
