//! Pure conversion from ABI-contract values to the provider-neutral types the
//! rest of the app already consumes. No FFI calls happen here, which is why
//! `tests/contract.rs` can exercise this module with fake ABI events on any
//! host, including one with no Sony hardware.

use head_tracking::HeadPoseEvent;
use spatial_protocol::HeadPose;

use crate::ffi::{NativeSample, NativeStatus};

/// Converts one native sample into a `HeadPose`. `timestamp_ns` is stamped by
/// the caller at receipt time, matching `SonyHeadSample::into_head_pose`.
pub fn sample_to_head_pose(sample: &NativeSample, timestamp_ns: u64) -> HeadPose {
    HeadPose {
        timestamp_ns,
        device: None,
        quaternion: sample.quaternion,
        yaw_deg: sample.yaw_deg,
        pitch_deg: sample.pitch_deg,
        roll_deg: sample.roll_deg,
        angular_velocity: None,
        gyroscope: sample.has_gyroscope.then_some(sample.gyroscope),
        accelerometer: sample.has_accelerometer.then_some(sample.accelerometer),
        reset_counter: u64::from(sample.reset_counter),
        packets_per_second: sample.packets_per_second,
        receive_latency_ms: sample.receive_latency_ms,
    }
}

/// Maps a raw status onto the existing session event stream. `Scanning`,
/// `PermissionDenied`, `DeviceNotFound`, `DeviceNotVerified`,
/// `FeatureWriteFailed`, and `Error` have no session-event equivalent; see
/// `status_to_diagnostic` for those.
pub fn status_to_event(status: NativeStatus) -> Option<HeadPoseEvent> {
    match status {
        NativeStatus::Connected => Some(HeadPoseEvent::Connected),
        NativeStatus::Stopped | NativeStatus::Reconnecting | NativeStatus::StreamTimeout => {
            Some(HeadPoseEvent::Disconnected)
        }
        NativeStatus::Scanning
        | NativeStatus::PermissionDenied
        | NativeStatus::DeviceNotFound
        | NativeStatus::DeviceNotVerified
        | NativeStatus::FeatureWriteFailed
        | NativeStatus::Error => None,
    }
}

/// Typed diagnostic categories for the statuses `status_to_event` maps to
/// `None`. Deliberately as name/identifier-free as `NativeStatus` itself:
/// the ABI contract (`include/spatial_head_tracker.h`) never carries a
/// device name, and `spatial_head_tracker_get_diagnostics` documents the
/// same omission for its free-text snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeDiagnostic {
    Scanning,
    PermissionDenied,
    DeviceNotFound,
    DeviceNotVerified,
    FeatureWriteFailed,
    Error,
}

/// Companion to `status_to_event`: typed for product-facing diagnostics/UI
/// (Milestone 2 wires this into the app). Returns `None` for statuses that
/// already have a session-event mapping.
pub fn status_to_diagnostic(status: NativeStatus) -> Option<NativeDiagnostic> {
    match status {
        NativeStatus::Scanning => Some(NativeDiagnostic::Scanning),
        NativeStatus::PermissionDenied => Some(NativeDiagnostic::PermissionDenied),
        NativeStatus::DeviceNotFound => Some(NativeDiagnostic::DeviceNotFound),
        NativeStatus::DeviceNotVerified => Some(NativeDiagnostic::DeviceNotVerified),
        NativeStatus::FeatureWriteFailed => Some(NativeDiagnostic::FeatureWriteFailed),
        NativeStatus::Error => Some(NativeDiagnostic::Error),
        NativeStatus::Connected
        | NativeStatus::Stopped
        | NativeStatus::Reconnecting
        | NativeStatus::StreamTimeout => None,
    }
}
