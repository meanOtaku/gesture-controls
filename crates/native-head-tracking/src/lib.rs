//! Target-gated FFI contract for native (non-UDP) Sony head-tracking
//! providers. See `.hermes/plans/2026-09-14_065556-native-sony-head-tracking-cross-platform.md`.
//!
//! Milestone 0 scope only: this crate defines the C ABI contract this
//! repository owns (`include/spatial_head_tracker.h`), its Rust mirror
//! types, and pure conversion logic exercised with fake ABI events in
//! `tests/contract.rs`. No platform backend is compiled or linked yet; the
//! vendored engine sources this contract will eventually sit on top of live
//! under `third_party/sony-head-tracker/` with their own provenance record.
//! Milestone 1 (macOS) and Milestone 4 (Windows) add the `build.rs` that
//! compiles and links each platform implementation.

pub mod convert;
pub mod ffi;
