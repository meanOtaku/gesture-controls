//! Runs per-label binary models: validates their bundles, loads them into an in-process ONNX runtime, feeds them from
//! one shared telemetry pipeline, and turns their scores into rising, active and falling detections.
//!
//! The path is, in order: raw telemetry -> ordering and freshness checks -> per-model quality gates -> window
//! construction -> canonical feature extraction -> each model's declared feature subset -> inference -> label scores
//! -> temporal policy (thresholds, hysteresis, debounce, cooldown, exclusivity) -> detections.
//!
//! A model only ever produces evidence about its own label. Nothing here knows about volume, scrolling or any other
//! action; turning detections into actions is the recipe engine's job.
//!
//! Any fault (a stale or out-of-order stream, a failed window, a model error, the runtime being lost) clears the
//! affected labels' detections and reports a falling edge for each, so whatever depended on them is released.

mod bundle;
mod detection;
mod loader;
mod model;
mod pipeline;
mod runtime;

pub use bundle::{BundleError, Manifest, ValidatedBundle, validate_bundle};
pub use detection::{
    ClearReason, Conflict, DetectionEvent, DetectionHub, ExclusivityGroup, TemporalDetector,
};
pub use loader::{ModelLoadFailure, load_active_models};
pub use model::{LoadedModel, ModelError};
pub use pipeline::{LabelPipeline, LabelScore, Rejection, WindowRejection};
pub use runtime::{LabelRuntime, RuntimeMode, RuntimeOutput};
