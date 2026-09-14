//! Head-pose provider selection and the event pipeline shared by the
//! native (macOS/Windows) provider and the external Sony CLI bridge
//! (Milestones 2 and 5 of
//! `.hermes/plans/2026-09-14_065556-native-sony-head-tracking-cross-platform.md`).
//!
//! macOS and Windows default to the in-process `native-head-tracking`
//! provider. Setting `SONY_HEAD_TRACKER_PROVIDER=external` falls back to the
//! external `SonyUdpHeadPoseProvider` -- the same UDP listener Linux still
//! uses today, since Linux has no native provider (see the plan's
//! non-goals).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use head_tracking::{HeadPoseEvent, HeadPoseProvider, SonyUdpHeadPoseProvider};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

use crate::calibration::CalibrationRuntime;
use crate::settings::SettingsRuntime;

pub const CONNECTION_EVENT: &str = "head-tracker-connection";
pub const POSE_EVENT: &str = "head-pose-updated";
pub const RESET_EVENT: &str = "head-tracker-reset";
pub const DIAGNOSTIC_EVENT: &str = "head-tracker-diagnostic";

const SONY_JSON_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4243);
const SONY_DISCONNECT_TIMEOUT: Duration = Duration::from_millis(1_000);
const PROVIDER_OVERRIDE_ENV: &str = "SONY_HEAD_TRACKER_PROVIDER";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderSelection {
    /// The in-process native provider (`native-head-tracking`; macOS or
    /// Windows).
    Native,
    /// The external Sony Head Tracker CLI bridge over loopback UDP.
    External,
}

impl ProviderSelection {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderSelection::Native => "native",
            ProviderSelection::External => "external",
        }
    }
}

/// Pure decision logic, kept separate from environment/`cfg!` reads so it is
/// unit-testable without mutating process-global environment state.
fn select_provider_for(native_available: bool, override_value: Option<&str>) -> ProviderSelection {
    let external_requested =
        override_value.is_some_and(|value| value.eq_ignore_ascii_case("external"));
    if native_available && !external_requested {
        ProviderSelection::Native
    } else {
        ProviderSelection::External
    }
}

pub fn select_provider() -> ProviderSelection {
    select_provider_for(
        cfg!(target_os = "macos") || cfg!(target_os = "windows"),
        std::env::var(PROVIDER_OVERRIDE_ENV).ok().as_deref(),
    )
}

/// Reports which head-pose provider this session selected, so the UI can be
/// transparent about the temporary external-bridge fallback.
#[tauri::command]
pub fn get_head_tracker_provider() -> &'static str {
    select_provider().as_str()
}

/// A shareable, typed diagnostic for statuses that have no session-event
/// equivalent (native-only today; see `native_head_tracking::convert`).
/// `None` (over the `DIAGNOSTIC_EVENT` channel) means no active diagnostic.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadTrackerDiagnosticPayload {
    pub id: &'static str,
    pub title: &'static str,
    pub detail: &'static str,
    pub action: Option<&'static str>,
}

#[cfg(target_os = "macos")]
fn diagnostic_payload(
    diagnostic: native_head_tracking::convert::NativeDiagnostic,
) -> HeadTrackerDiagnosticPayload {
    use native_head_tracking::convert::NativeDiagnostic;
    match diagnostic {
        NativeDiagnostic::Scanning => HeadTrackerDiagnosticPayload {
            id: "scanning",
            title: "Scanning for the Sony head tracker",
            detail: "Looking for a compatible Sony head-tracking device over Bluetooth.",
            action: Some(
                "Make sure the headset is powered on and already paired in Bluetooth settings.",
            ),
        },
        NativeDiagnostic::PermissionDenied => HeadTrackerDiagnosticPayload {
            id: "permission-denied",
            title: "Input Monitoring permission needed",
            detail: "macOS requires Input Monitoring permission to read the head tracker's sensor input.",
            action: Some(
                "Open System Settings -> Privacy & Security -> Input Monitoring, allow Spatial Gesture Control, then restart the app.",
            ),
        },
        NativeDiagnostic::DeviceNotFound => HeadTrackerDiagnosticPayload {
            id: "device-not-found",
            title: "No supported head tracker found",
            detail: "No compatible Sony head-tracking device is reachable over Bluetooth.",
            action: Some("Pair the headset in Bluetooth settings and make sure it is powered on."),
        },
        NativeDiagnostic::DeviceNotVerified => HeadTrackerDiagnosticPayload {
            id: "device-not-verified",
            title: "Head tracker not verified",
            detail: "The connected device could not be verified as a supported Sony head tracker.",
            action: Some("Reconnect the supported Sony headset model."),
        },
        NativeDiagnostic::FeatureWriteFailed => HeadTrackerDiagnosticPayload {
            id: "feature-write-failed",
            title: "Head tracker configuration failed",
            detail: "The app could not configure a required sensor feature on the head tracker.",
            action: Some("Reconnect the headset and try again."),
        },
        NativeDiagnostic::Error => HeadTrackerDiagnosticPayload {
            id: "error",
            title: "Head tracker error",
            detail: "The native head-tracking engine reported an unexpected error.",
            action: Some(
                "Restart the app. If this continues, set SONY_HEAD_TRACKER_PROVIDER=external as a temporary fallback.",
            ),
        },
    }
}

/// Windows counterpart to the macOS `diagnostic_payload` above. Wording
/// differs because the underlying causes differ -- Windows has no Input
/// Monitoring-style app permission; `PermissionDenied` here comes from
/// `CreateFileW` failing with `ERROR_ACCESS_DENIED` while enumerating the
/// HID node (see `windows/adapter.cpp`, Milestone 4). Per the plan's
/// Milestone 5 guardrail, every action string only ever points the user at
/// Sony's own documented Repair Tracker flow -- this app never elevates or
/// repairs the driver itself.
#[cfg(target_os = "windows")]
fn diagnostic_payload(
    diagnostic: native_head_tracking::convert::NativeDiagnostic,
) -> HeadTrackerDiagnosticPayload {
    use native_head_tracking::convert::NativeDiagnostic;
    match diagnostic {
        NativeDiagnostic::Scanning => HeadTrackerDiagnosticPayload {
            id: "scanning",
            title: "Scanning for the Sony head tracker",
            detail: "Looking for a compatible Sony head-tracking device over Bluetooth.",
            action: Some(
                "Make sure the headset is powered on and already paired in Windows Bluetooth settings.",
            ),
        },
        NativeDiagnostic::PermissionDenied => HeadTrackerDiagnosticPayload {
            id: "permission-denied",
            title: "Head tracker device access denied",
            detail: "Windows denied access to the head tracker's sensor device.",
            action: Some(
                "Close any other app that may already be using the headset. If the sensor node is missing, follow Sony Head Tracker's documented Repair Tracker instructions, then restart Spatial Gesture Control -- this app does not perform elevated driver repair on its own.",
            ),
        },
        NativeDiagnostic::DeviceNotFound => HeadTrackerDiagnosticPayload {
            id: "device-not-found",
            title: "No supported head tracker found",
            detail: "No compatible Sony head-tracking device is reachable over Bluetooth.",
            action: Some(
                "Pair the headset in Windows Bluetooth settings and make sure it is powered on.",
            ),
        },
        NativeDiagnostic::DeviceNotVerified => HeadTrackerDiagnosticPayload {
            id: "device-not-verified",
            title: "Head tracker not verified",
            detail: "The connected device could not be verified as a supported Sony head tracker.",
            action: Some("Reconnect the supported Sony headset model."),
        },
        NativeDiagnostic::FeatureWriteFailed => HeadTrackerDiagnosticPayload {
            id: "feature-write-failed",
            title: "Head tracker configuration failed",
            detail: "The app could not configure a required sensor feature on the head tracker.",
            action: Some(
                "Reconnect the headset. If this continues, follow Sony Head Tracker's documented Repair Tracker instructions -- Spatial Gesture Control will not repair the driver for you.",
            ),
        },
        NativeDiagnostic::Error => HeadTrackerDiagnosticPayload {
            id: "error",
            title: "Head tracker error",
            detail: "The native head-tracking engine reported an unexpected error.",
            action: Some(
                "Restart the app. If this continues, set SONY_HEAD_TRACKER_PROVIDER=external as a temporary fallback.",
            ),
        },
    }
}

/// Starts the selected head-pose provider and feeds its events into the
/// existing calibration/telemetry paths. Spawns its own task; callers do not
/// need to await this.
pub fn spawn(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        match select_provider() {
            ProviderSelection::Native => {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                {
                    run_native(handle).await;
                }
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                {
                    let _ = handle;
                    unreachable!("select_provider only returns Native on macOS/Windows");
                }
            }
            ProviderSelection::External => run_external(handle).await,
        }
    });
}

/// Applies one provider-neutral event to calibration/telemetry state. Shared
/// by both the native and external providers so the two pipelines cannot
/// drift apart.
fn handle_head_event(handle: &AppHandle, event: HeadPoseEvent) {
    match event {
        HeadPoseEvent::Connected => {
            info!("Sony head tracker connected");
            let _ = handle.emit(DIAGNOSTIC_EVENT, None::<HeadTrackerDiagnosticPayload>);
            let _ = handle.emit(CONNECTION_EVENT, true);
        }
        HeadPoseEvent::Disconnected => {
            warn!("Sony head tracker disconnected");
            if let Err(error) = handle.state::<CalibrationRuntime>().disconnect(handle) {
                warn!(%error, "failed to suspend head calibration");
            }
            let _ = handle.emit(CONNECTION_EVENT, false);
        }
        HeadPoseEvent::Pose(pose) => {
            if let Err(error) = handle
                .state::<CalibrationRuntime>()
                .observe(handle, pose.quaternion)
            {
                warn!(%error, "failed to evaluate head calibration");
            }
            if handle.state::<SettingsRuntime>().accept_headphones_pose()
                && let Err(error) = handle.emit(POSE_EVENT, pose)
            {
                warn!(%error, "failed to emit head-pose event");
            }
        }
        HeadPoseEvent::ResetCounterChanged { previous, current } => {
            warn!(previous, current, "Sony reference frame reset");
            if let Err(error) = handle.state::<CalibrationRuntime>().invalidate(handle) {
                warn!(%error, "failed to invalidate calibration");
            }
            let _ = handle.emit(RESET_EVENT, (previous, current));
        }
    }
}

async fn run_external(handle: AppHandle) {
    let provider =
        match SonyUdpHeadPoseProvider::bind(SONY_JSON_ADDRESS, SONY_DISCONNECT_TIMEOUT).await {
            Ok(provider) => provider,
            Err(error) => {
                error!(%error, address = %SONY_JSON_ADDRESS, "Sony UDP listener failed to bind");
                let _ = handle.emit(CONNECTION_EVENT, false);
                return;
            }
        };

    let mut events = provider.subscribe();
    if let Err(error) = provider.start().await {
        error!(%error, "Sony head-pose provider failed to start");
        let _ = handle.emit(CONNECTION_EVENT, false);
        return;
    }
    info!(address = %SONY_JSON_ADDRESS, "Sony JSON UDP listener started (external bridge)");

    loop {
        match events.recv().await {
            Ok(event) => handle_head_event(&handle, event),
            Err(error) => warn!(%error, "head-pose event receiver lagged or closed"),
        }
    }
}

/// Shared between macOS and Windows: `NativeProvider` (and its
/// `MacosProvider`/`WindowsProvider` aliases) is the same wrapper type on
/// both platforms, and `diagnostic_payload` above is `cfg`-selected per
/// platform under the same name, so this function's body needs no `cfg`
/// branching of its own.
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn run_native(handle: AppHandle) {
    use std::time::{SystemTime, UNIX_EPOCH};

    use native_head_tracking::convert::{
        NativeDiagnostic, sample_to_head_pose, status_to_diagnostic, status_to_event,
    };
    use native_head_tracking::ffi::{NativeSample, NativeStatus};
    use native_head_tracking::provider::{NativeEventSink, NativeProvider};
    use tokio::sync::mpsc;

    enum NativeChannelEvent {
        Head(Box<HeadPoseEvent>),
        Diagnostic(NativeDiagnostic),
    }

    struct Sink {
        tx: mpsc::UnboundedSender<NativeChannelEvent>,
        previous_reset_counter: Option<u64>,
    }

    impl NativeEventSink for Sink {
        fn on_sample(&mut self, sample: NativeSample) {
            let timestamp_ns = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .min(u64::MAX as u128) as u64;
            let reset_counter = u64::from(sample.reset_counter);
            if let Some(previous) = self.previous_reset_counter
                && previous != reset_counter
            {
                let _ = self.tx.send(NativeChannelEvent::Head(Box::new(
                    HeadPoseEvent::ResetCounterChanged {
                        previous,
                        current: reset_counter,
                    },
                )));
            }
            self.previous_reset_counter = Some(reset_counter);
            let pose = sample_to_head_pose(&sample, timestamp_ns);
            let _ = self
                .tx
                .send(NativeChannelEvent::Head(Box::new(HeadPoseEvent::Pose(
                    pose,
                ))));
        }

        fn on_status(&mut self, status: NativeStatus, _message: String) {
            if let Some(event) = status_to_event(status) {
                let _ = self.tx.send(NativeChannelEvent::Head(Box::new(event)));
            }
            if let Some(diagnostic) = status_to_diagnostic(status) {
                let _ = self.tx.send(NativeChannelEvent::Diagnostic(diagnostic));
            }
        }
    }

    let Some(provider) = NativeProvider::new() else {
        error!("failed to create native head-tracker provider");
        let _ = handle.emit(CONNECTION_EVENT, false);
        return;
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let sink = Sink {
        tx,
        previous_reset_counter: None,
    };
    if !provider.start(Box::new(sink)) {
        error!("native head-tracker provider failed to start");
        let _ = handle.emit(CONNECTION_EVENT, false);
        return;
    }
    info!("native Sony head-tracker provider started");

    // `provider` must outlive this loop: dropping it stops the native worker
    // thread and frees the callback context `tx` was moved into.
    while let Some(event) = rx.recv().await {
        match event {
            NativeChannelEvent::Head(head_event) => handle_head_event(&handle, *head_event),
            NativeChannelEvent::Diagnostic(diagnostic) => {
                let _ = handle.emit(DIAGNOSTIC_EVENT, Some(diagnostic_payload(diagnostic)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `select_provider_for`'s `native_available` bool stands in for
    // `cfg!(target_os = "macos") || cfg!(target_os = "windows")`, so these
    // cases cover both native platforms identically; `select_provider`
    // itself just wires that `cfg!` into the `true` branch below.

    #[test]
    fn native_platform_without_override_selects_native() {
        assert_eq!(select_provider_for(true, None), ProviderSelection::Native);
    }

    #[test]
    fn native_platform_with_external_override_selects_external() {
        assert_eq!(
            select_provider_for(true, Some("external")),
            ProviderSelection::External
        );
        assert_eq!(
            select_provider_for(true, Some("EXTERNAL")),
            ProviderSelection::External
        );
    }

    #[test]
    fn non_native_platform_always_selects_external() {
        assert_eq!(
            select_provider_for(false, None),
            ProviderSelection::External
        );
        assert_eq!(
            select_provider_for(false, Some("external")),
            ProviderSelection::External
        );
    }

    #[test]
    fn unrecognized_override_value_does_not_force_external() {
        assert_eq!(
            select_provider_for(true, Some("native")),
            ProviderSelection::Native
        );
        assert_eq!(
            select_provider_for(true, Some("")),
            ProviderSelection::Native
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn select_provider_defaults_to_native_on_this_platform() {
        assert_eq!(select_provider(), ProviderSelection::Native);
    }
}
