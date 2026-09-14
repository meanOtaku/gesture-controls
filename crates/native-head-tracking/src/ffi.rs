//! Rust mirror of `include/spatial_head_tracker.h`. Keep the two definitions
//! in sync by hand; there is no bindgen step yet.

use std::ffi::c_void;
use std::os::raw::c_char;

/// Mirrors `SpatialHeadTrackerSample`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NativeSample {
    pub quaternion: [f64; 4],
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    pub roll_deg: f64,
    pub gyroscope: [f64; 3],
    pub has_gyroscope: bool,
    pub accelerometer: [f64; 3],
    pub has_accelerometer: bool,
    pub reset_counter: u8,
    pub packets_per_second: f64,
    pub receive_latency_ms: f64,
}

/// Mirrors `SpatialHeadTrackerStatus`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeStatus {
    Stopped = 0,
    Scanning = 1,
    Connected = 2,
    Reconnecting = 3,
    PermissionDenied = 4,
    DeviceNotFound = 5,
    DeviceNotVerified = 6,
    FeatureWriteFailed = 7,
    StreamTimeout = 8,
    Error = 9,
}

/// Opaque per-instance native handle; mirrors `SpatialHeadTrackerHandle`.
#[repr(C)]
pub struct NativeHandle {
    _private: [u8; 0],
}

pub type SampleCallback = extern "C" fn(*const NativeSample, *mut c_void);
pub type StatusCallback = extern "C" fn(NativeStatus, *const c_char, *mut c_void);

// Target-gated: compiled only for platforms that will link a real backend.
// Milestone 1 (macOS) and Milestone 4 (Windows) add the `build.rs` that
// compiles `third_party/sony-head-tracker` behind this contract and provides
// these symbols; until then, declaring them here does not require a
// linkable implementation because nothing calls them yet. Linux has no
// physical Sony backend (see the plan's non-goals) and so declares none of
// this block.
#[cfg(target_os = "macos")]
unsafe extern "C" {
    pub fn spatial_head_tracker_create() -> *mut NativeHandle;
    pub fn spatial_head_tracker_destroy(handle: *mut NativeHandle);
    pub fn spatial_head_tracker_start(
        handle: *mut NativeHandle,
        sample_callback: SampleCallback,
        status_callback: StatusCallback,
        context: *mut c_void,
    ) -> bool;
    pub fn spatial_head_tracker_stop(handle: *mut NativeHandle);
    pub fn spatial_head_tracker_recenter(handle: *mut NativeHandle);
    pub fn spatial_head_tracker_get_diagnostics(
        handle: *mut NativeHandle,
        buffer: *mut c_char,
        capacity: usize,
    ) -> usize;
}

#[cfg(target_os = "windows")]
unsafe extern "C" {
    pub fn spatial_head_tracker_create() -> *mut NativeHandle;
    pub fn spatial_head_tracker_destroy(handle: *mut NativeHandle);
    pub fn spatial_head_tracker_start(
        handle: *mut NativeHandle,
        sample_callback: SampleCallback,
        status_callback: StatusCallback,
        context: *mut c_void,
    ) -> bool;
    pub fn spatial_head_tracker_stop(handle: *mut NativeHandle);
    pub fn spatial_head_tracker_recenter(handle: *mut NativeHandle);
    pub fn spatial_head_tracker_get_diagnostics(
        handle: *mut NativeHandle,
        buffer: *mut c_char,
        capacity: usize,
    ) -> usize;
}
