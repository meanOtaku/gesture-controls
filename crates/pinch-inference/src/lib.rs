//! The inputs of the PPG pinch-start model: multi-scale causal z-score, cubic derivatives and their window summaries (see
//! [`ppg_onset`]). The per-label models in `label-inference` read their inputs through this crate. It is pure and
//! synchronous, with no dependency on watch-bridge or any Tauri type.

pub mod ppg_onset;

pub use ppg_onset::{FEATURE_COUNT, FEATURE_NAMES, PpgSample, features};
