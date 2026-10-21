//! Runs per-label binary models (the pinch-start models: PPG + IMU, or the earlier PPG-only one): validates their bundles,
//! loads their trees, feeds them from one shared telemetry pipeline, and turns their scores into rising, active and falling
//! detections.
//!
//! The path is, in order: raw telemetry -> ordering and freshness checks -> per-model quality gates -> the pulse (and
//! motion) history of each decision -> the model's features (`pinch_inference::ppg_onset`, `imu_onset`) -> its trees
//! -> label scores -> temporal policy (thresholds, trigger, hysteresis, debounce, cooldown, exclusivity) -> detections.
//!
//! A model only ever produces evidence about its own label. Nothing here knows about volume, scrolling or any other
//! action; turning detections into actions is the recipe engine's job.
//!
//! Any fault (a stale or out-of-order stream, a failed window, a model error, the runtime being lost) clears the
//! affected labels' detections and reports a falling edge for each, so whatever depended on them is released.

mod bundle;
mod clock;
mod detection;
mod import;
mod inputs;
mod loader;
mod model;
mod pipeline;
mod runtime;
mod training;
mod trees;

pub use bundle::{
    BundleError, MODEL_FORMAT, Manifest, STRIDE_MS, TrainingRange, ValidatedBundle, WINDOW_MS,
    validate_bundle,
};
pub use detection::{
    ClearReason, Conflict, DetectionEvent, DetectionHub, ExclusivityGroup, TemporalDetector,
};
pub use import::{
    IMPORTED_MODELS_DIR, ImportError, ImportOutcome, STAGING_DIR, StagedBundle, clean_staging,
    import_bundle, publish_staged, publish_staged_with, stage_bundle,
};
pub use inputs::{ModelKind, PPG_IMU_PREPROCESSING, PPG_ONLY_PREPROCESSING};
pub use loader::{
    ModelLoadFailure, check_loadable, load_active_models, load_version, removable_model_dir,
};
pub use model::{FAR_EXCESS, InputCheck, LoadedModel, ModelError, OutsideInput, RANGE_MARGIN};
pub use pipeline::{LabelPipeline, LabelScore, Rejection, WindowRejection};
pub use runtime::{InputWarning, LabelRuntime, RuntimeMode, RuntimeOutput};
pub use training::{
    BegunRun, MIN_WINDOW_SAMPLES, RecordingInfo, RunPlan, TrainingError, begin_run, complete_run,
    evaluation_only_run, fail_run, monitor_only_run, pinch_start_contract, plan_split,
    plan_split_keeping, ppg_onset_contract, trainer_backend,
};
pub use trees::{TreeEnsemble, TreesError};
