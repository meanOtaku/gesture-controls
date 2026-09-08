//! Desktop-only pinch inference: feature extraction, telemetry fusion, and
//! the fail-closed classification state machine that turns fused Watch
//! telemetry windows into [`interaction_engine::PinchTransition`]s. This
//! crate has no dependency on watch-bridge or any Tauri type -- it is pure,
//! synchronous, and unit-testable, matching the rest of the workspace's
//! desktop-owned logic (`interaction_engine::GesturePolicy`).
//!
//! Per `docs/architecture/project-brief.md` Milestone 11, the Watch and
//! headphones remain sensor-only sources; this crate (and only code that
//! runs inside the desktop app) is where fused telemetry actually gets
//! classified. See `apps/desktop/src-tauri/src/inference.rs` for the wiring
//! that feeds this crate's output into `GesturePolicy`.

mod features;
mod fusion;
#[cfg(feature = "litert")]
mod litert_model;
mod model;
mod runtime;

pub use features::{
    FEATURE_COUNT, FEATURE_NAMES, FusedWindow, OrientationSnapshot, extract_features,
};
pub use fusion::TelemetryFusion;
#[cfg(feature = "litert")]
pub use litert_model::LiteRtPinchModel;
pub use model::{CLASS_COUNT, PinchModel, PinchModelError, UnavailablePinchModel};
pub use runtime::DesktopPinchRuntime;
