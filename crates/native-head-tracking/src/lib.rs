//! Target-gated FFI contract for native (non-UDP) Sony head-tracking
//! providers. See `.hermes/plans/2026-09-14_065556-native-sony-head-tracking-cross-platform.md`.
//!
//! This crate defines the C ABI contract this repository owns
//! (`include/spatial_head_tracker.h`), its Rust mirror types (`src/ffi.rs`),
//! and pure conversion logic (`src/convert.rs`) exercised with fake ABI
//! events in `tests/contract.rs` on every platform.
//!
//! On macOS (Milestone 1), `build.rs` additionally compiles the vendored
//! engine sources under `third_party/sony-head-tracker/` plus a repo-owned
//! adapter (`macos/adapter.cpp`) that maps upstream's own bridge ABI onto
//! `include/spatial_head_tracker.h`, and links the real Apple frameworks;
//! `src/provider.rs` is the safe Rust wrapper around that link, and
//! `tests/ffi_macos.rs` exercises it with no physical headset required.
//! Windows (Milestone 4) has no `build.rs` step yet, so its extern block in
//! `src/ffi.rs` stays declaration-only -- nothing calls it, so it does not
//! need a linkable implementation. Linux has no physical Sony backend (see
//! the plan's non-goals) and declares no extern block at all.

pub mod convert;
pub mod ffi;
#[cfg(target_os = "macos")]
pub mod provider;
