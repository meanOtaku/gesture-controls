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
//!
//! On Windows (Milestone 4), `build.rs` compiles upstream's Windows-native HID
//! engine sources (the root `third_party/sony-head-tracker/src/*.cpp` files --
//! upstream's own engine is Windows-first, with macOS as the ported platform,
//! so these are already the real HID/SetupAPI implementation, not stubs) plus
//! a repo-owned adapter (`windows/adapter.cpp`). Unlike macOS, upstream has no
//! reusable C ABI bridge object for Windows, so that adapter drives
//! `sony::HidBackend`/`sony::OrientationFilter` directly instead of
//! translating another C API; `src/provider.rs`'s wrapper and
//! `tests/ffi_windows.rs` are otherwise the same shape as the macOS ones.
//!
//! Linux has no physical Sony backend (see the plan's non-goals) and declares
//! no extern block at all.

pub mod convert;
pub mod ffi;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod provider;
