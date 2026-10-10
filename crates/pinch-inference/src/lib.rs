//! Feature extraction and telemetry fusion for the watch's PPG and motion windows. The per-label models in
//! `label-inference` read their inputs through this crate. It is pure and synchronous, with no dependency on
//! watch-bridge or any Tauri type.

mod features;
mod fusion;

pub use features::{
    FEATURE_COUNT, FEATURE_NAMES, FusedWindow, OrientationSnapshot, extract_features,
    select_features,
};
pub use fusion::{FusionRejection, ORIENTATION_STALENESS_TIMEOUT_NS, TelemetryFusion};
