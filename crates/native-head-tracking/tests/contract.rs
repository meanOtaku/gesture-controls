//! Fake-ABI contract tests. These never link a real native backend -- they
//! construct `NativeSample`/`NativeStatus` values by hand (as a real bridge
//! would populate a callback argument) and check the conversion into
//! provider-neutral types.

use head_tracking::HeadPoseEvent;
use native_head_tracking::convert::{
    NativeDiagnostic, sample_to_head_pose, status_to_diagnostic, status_to_event,
};
use native_head_tracking::ffi::{NativeSample, NativeStatus};

fn fake_sample() -> NativeSample {
    NativeSample {
        quaternion: [1.0, 0.0, 0.0, 0.0],
        yaw_deg: 12.5,
        pitch_deg: -3.0,
        roll_deg: 0.25,
        gyroscope: [0.1, 0.2, 0.3],
        has_gyroscope: true,
        accelerometer: [0.0, 0.0, 9.8],
        has_accelerometer: true,
        reset_counter: 4,
        packets_per_second: 120.0,
        receive_latency_ms: 1.5,
    }
}

#[test]
fn sample_conversion_preserves_orientation_and_reset_counter() {
    let pose = sample_to_head_pose(&fake_sample(), 42);
    assert_eq!(pose.timestamp_ns, 42);
    assert_eq!(pose.quaternion, [1.0, 0.0, 0.0, 0.0]);
    assert_eq!(pose.yaw_deg, 12.5);
    assert_eq!(pose.pitch_deg, -3.0);
    assert_eq!(pose.roll_deg, 0.25);
    assert_eq!(pose.reset_counter, 4);
    assert_eq!(pose.packets_per_second, 120.0);
    assert_eq!(pose.receive_latency_ms, 1.5);
    assert_eq!(pose.gyroscope, Some([0.1, 0.2, 0.3]));
    assert_eq!(pose.accelerometer, Some([0.0, 0.0, 9.8]));
    assert_eq!(pose.angular_velocity, None);
}

#[test]
fn sample_conversion_omits_absent_optional_channels() {
    let mut sample = fake_sample();
    sample.has_gyroscope = false;
    sample.has_accelerometer = false;
    let pose = sample_to_head_pose(&sample, 0);
    assert_eq!(pose.gyroscope, None);
    assert_eq!(pose.accelerometer, None);
}

#[test]
fn connected_status_maps_to_connected_event() {
    assert!(matches!(
        status_to_event(NativeStatus::Connected),
        Some(HeadPoseEvent::Connected)
    ));
}

#[test]
fn stopped_reconnecting_and_timeout_map_to_disconnected_event() {
    for status in [
        NativeStatus::Stopped,
        NativeStatus::Reconnecting,
        NativeStatus::StreamTimeout,
    ] {
        assert!(matches!(
            status_to_event(status),
            Some(HeadPoseEvent::Disconnected)
        ));
    }
}

#[test]
fn diagnostics_only_statuses_produce_no_session_event() {
    for status in [
        NativeStatus::Scanning,
        NativeStatus::PermissionDenied,
        NativeStatus::DeviceNotFound,
        NativeStatus::DeviceNotVerified,
        NativeStatus::FeatureWriteFailed,
        NativeStatus::Error,
    ] {
        assert!(status_to_event(status).is_none());
    }
}

#[test]
fn diagnostics_only_statuses_map_to_typed_diagnostics() {
    let cases = [
        (NativeStatus::Scanning, NativeDiagnostic::Scanning),
        (
            NativeStatus::PermissionDenied,
            NativeDiagnostic::PermissionDenied,
        ),
        (
            NativeStatus::DeviceNotFound,
            NativeDiagnostic::DeviceNotFound,
        ),
        (
            NativeStatus::DeviceNotVerified,
            NativeDiagnostic::DeviceNotVerified,
        ),
        (
            NativeStatus::FeatureWriteFailed,
            NativeDiagnostic::FeatureWriteFailed,
        ),
        (NativeStatus::Error, NativeDiagnostic::Error),
    ];
    for (status, expected) in cases {
        assert_eq!(status_to_diagnostic(status), Some(expected));
    }
}

#[test]
fn session_event_statuses_produce_no_diagnostic() {
    for status in [
        NativeStatus::Connected,
        NativeStatus::Stopped,
        NativeStatus::Reconnecting,
        NativeStatus::StreamTimeout,
    ] {
        assert!(status_to_diagnostic(status).is_none());
    }
}
