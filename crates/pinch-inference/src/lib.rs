//! Feature extraction and telemetry fusion for the watch's PPG and motion windows. The per-label models in
//! `label-inference` read their inputs through this crate. It is pure and synchronous, with no dependency on
//! watch-bridge or any Tauri type.

mod features;
mod fusion;
mod grid;

pub use features::{
    BASE_FEATURE_COUNT, BASELINE_HIGH_PERCENT, BASELINE_LOW_PERCENT, BASELINE_MIN_SAMPLES,
    BASELINE_SLACK_MS, FEATURE_COUNT, FEATURE_NAMES, FusedWindow, MOTION_FEATURE_START,
    MOTION_STATS, OrientationSnapshot, PpgBaseline, SPIKE_STATS_PER_CHANNEL, SpikeMethod, Z_CLIP,
    Z_SCALE_FLOOR, baseline_features, baseline_z_features, extract_features, extract_features_with,
    motion_features, pulse_z, select_features, spike_features,
};
pub use fusion::{FusionRejection, ORIENTATION_STALENESS_TIMEOUT_NS, TelemetryFusion};
pub use grid::{
    GridChannel, GridPulse, GridTiming, MAX_GRID_STEPS, MIN_GRID_STEPS, build_grid, resample,
    resample_in_time,
};
