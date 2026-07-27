use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use head_tracking::{
    HeadPoseError, HeadPoseEvent, HeadPoseProvider, HeadTrackerRuntimeState,
    HeadTrackerRuntimeStatus, SonyDirectHeadPoseProvider, SonyUdpHeadPoseProvider,
};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tracing::{error, info, warn};

const SONY_JSON_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4243);
const CONNECTION_EVENT: &str = "head-tracker-connection";
const POSE_EVENT: &str = "head-pose-updated";
const RESET_EVENT: &str = "head-tracker-reset";
const STATUS_EVENT: &str = "head-tracker-status";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatusPayload {
    state: &'static str,
    message: String,
    device: Option<String>,
    revision: u64,
    can_recenter: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResetCounterPayload {
    previous: u64,
    current: u64,
}

impl RuntimeStatusPayload {
    fn starting() -> Self {
        Self {
            state: "starting",
            message: "Starting built-in Sony head tracker".to_owned(),
            device: None,
            revision: 0,
            can_recenter: true,
        }
    }

    fn from_provider(
        state: HeadTrackerRuntimeState,
        message: String,
        device: Option<String>,
    ) -> Self {
        let state = match state {
            HeadTrackerRuntimeState::Starting => "starting",
            HeadTrackerRuntimeState::Searching => "searching",
            HeadTrackerRuntimeState::Connected => "connected",
            HeadTrackerRuntimeState::Reconnecting => "reconnecting",
            HeadTrackerRuntimeState::PermissionRequired => "permissionRequired",
            HeadTrackerRuntimeState::Unsupported => "unsupported",
            HeadTrackerRuntimeState::Error => "error",
            HeadTrackerRuntimeState::Stopped => "stopped",
        };
        Self {
            state,
            message,
            device,
            revision: 0,
            can_recenter: true,
        }
    }

    fn from_snapshot(status: HeadTrackerRuntimeStatus, can_recenter: bool) -> Self {
        let mut payload = Self::from_provider(status.state, status.message, status.device);
        payload.can_recenter = can_recenter;
        payload
    }
}

fn emit_reset_if_changed(
    handle: &tauri::AppHandle,
    last_forwarded: &mut Option<u64>,
    current: u64,
    fallback_previous: Option<u64>,
) {
    let previous = (*last_forwarded).or(fallback_previous);
    if let Some(previous) = previous
        && previous != current
    {
        warn!(previous, current, "Sony reference frame reset");
        let _ = handle.emit(RESET_EVENT, ResetCounterPayload { previous, current });
    }
    *last_forwarded = Some(current);
}

fn publish_status(handle: &tauri::AppHandle, status: RuntimeStatusPayload) {
    let status = handle.state::<TrackerRuntime>().set_status(status);
    let _ = handle.emit(STATUS_EVENT, status);
}

struct TrackerRuntime {
    provider: Mutex<Option<Arc<dyn HeadPoseProvider>>>,
    status: Mutex<RuntimeStatusPayload>,
    shutdown_started: AtomicBool,
    status_revision: AtomicU64,
}

impl Default for TrackerRuntime {
    fn default() -> Self {
        Self {
            provider: Mutex::new(None),
            status: Mutex::new(RuntimeStatusPayload::starting()),
            shutdown_started: AtomicBool::new(false),
            status_revision: AtomicU64::new(0),
        }
    }
}

impl TrackerRuntime {
    fn set_provider(&self, provider: Arc<dyn HeadPoseProvider>) {
        if let Ok(mut active) = self.provider.lock() {
            *active = Some(provider);
        }
    }

    fn set_status(&self, mut status: RuntimeStatusPayload) -> RuntimeStatusPayload {
        status.revision = self.status_revision.fetch_add(1, Ordering::AcqRel) + 1;
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        status
    }

    async fn shutdown(&self) {
        let provider = self
            .provider
            .lock()
            .ok()
            .and_then(|mut active| active.take());
        if let Some(provider) = provider
            && let Err(error) = provider.stop().await
        {
            warn!(%error, "Sony head tracker shutdown failed");
        }
    }
}

#[tauri::command]
fn get_head_tracker_status(
    state: tauri::State<'_, TrackerRuntime>,
) -> Result<RuntimeStatusPayload, String> {
    state
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "head tracker status lock was poisoned".to_owned())
}

#[tauri::command]
fn recenter_head_tracker(state: tauri::State<'_, TrackerRuntime>) -> Result<(), String> {
    let provider = state
        .provider
        .lock()
        .map_err(|_| "head tracker state lock was poisoned".to_owned())?
        .clone()
        .ok_or_else(|| "head tracker has not started".to_owned())?;
    provider.recenter().map_err(|error| error.to_string())
}

async fn create_provider() -> Result<(Arc<dyn HeadPoseProvider>, bool), HeadPoseError> {
    let source = std::env::var("SGC_HEAD_TRACKER_SOURCE").unwrap_or_else(|_| "direct".to_owned());
    if source.eq_ignore_ascii_case("udp") {
        let provider =
            SonyUdpHeadPoseProvider::bind(SONY_JSON_ADDRESS, Duration::from_millis(1_000)).await?;
        Ok((Arc::new(provider), true))
    } else {
        if !source.eq_ignore_ascii_case("direct") {
            warn!(%source, "unknown SGC_HEAD_TRACKER_SOURCE; using built-in direct provider");
        }
        Ok((Arc::new(SonyDirectHeadPoseProvider::new()), false))
    }
}

async fn run_tracker(handle: tauri::AppHandle) {
    let (provider, compatibility_udp) = match create_provider().await {
        Ok(provider) => provider,
        Err(error) => {
            error!(%error, "head-pose provider could not be created");
            let status = RuntimeStatusPayload {
                state: "error",
                message: error.to_string(),
                device: None,
                revision: 0,
                can_recenter: false,
            };
            publish_status(&handle, status);
            return;
        }
    };

    let mut events = provider.subscribe();
    handle
        .state::<TrackerRuntime>()
        .set_provider(Arc::clone(&provider));

    if compatibility_udp {
        let status = RuntimeStatusPayload {
            state: "searching",
            message: format!("Compatibility simulator listening on {SONY_JSON_ADDRESS}"),
            device: None,
            revision: 0,
            can_recenter: false,
        };
        publish_status(&handle, status);
    }

    match provider.start().await {
        Ok(()) => {
            if compatibility_udp {
                info!(address = %SONY_JSON_ADDRESS, "Sony compatibility UDP provider started");
            } else {
                info!("in-process Sony head tracker started");
            }
        }
        Err(HeadPoseError::UnsupportedPlatform) => {
            warn!("direct Sony tracking is unsupported on this platform");
        }
        Err(error) => {
            error!(%error, "Sony head-pose provider failed to start");
            let status = RuntimeStatusPayload {
                state: "error",
                message: error.to_string(),
                device: None,
                revision: 0,
                can_recenter: false,
            };
            publish_status(&handle, status);
        }
    }

    let mut last_forwarded_reset = None;
    loop {
        match events.recv().await {
            Ok(HeadPoseEvent::Connected) => {
                info!("Sony head tracker connected");
                let _ = handle.emit(CONNECTION_EVENT, true);
                if compatibility_udp {
                    let status = RuntimeStatusPayload {
                        state: "connected",
                        message: "Compatibility simulator connected".to_owned(),
                        device: None,
                        revision: 0,
                        can_recenter: false,
                    };
                    publish_status(&handle, status);
                }
            }
            Ok(HeadPoseEvent::Disconnected) => {
                warn!("Sony head tracker disconnected");
                let _ = handle.emit(CONNECTION_EVENT, false);
                if compatibility_udp {
                    let status = RuntimeStatusPayload {
                        state: "searching",
                        message: format!("Waiting for simulator data on {SONY_JSON_ADDRESS}"),
                        device: None,
                        revision: 0,
                        can_recenter: false,
                    };
                    publish_status(&handle, status);
                }
            }
            Ok(HeadPoseEvent::Pose(pose)) => {
                emit_reset_if_changed(&handle, &mut last_forwarded_reset, pose.reset_counter, None);
                if let Err(error) = handle.emit(POSE_EVENT, pose) {
                    warn!(%error, "failed to emit head-pose event");
                }
            }
            Ok(HeadPoseEvent::ResetCounterChanged { previous, current }) => {
                emit_reset_if_changed(&handle, &mut last_forwarded_reset, current, Some(previous));
            }
            Ok(HeadPoseEvent::RuntimeStatus {
                state,
                message,
                device,
            }) => {
                let status = RuntimeStatusPayload::from_provider(state, message, device);
                publish_status(&handle, status);
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(skipped, "head-pose event receiver lagged");
                let snapshot = provider.snapshot();
                let connected = snapshot.runtime.state == HeadTrackerRuntimeState::Connected;
                let status =
                    RuntimeStatusPayload::from_snapshot(snapshot.runtime, !compatibility_udp);
                publish_status(&handle, status);
                let _ = handle.emit(CONNECTION_EVENT, connected);
                if let Some(current) = snapshot.reset_counter {
                    emit_reset_if_changed(&handle, &mut last_forwarded_reset, current, None);
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_target(true)
        .with_thread_ids(true)
        .try_init()
        .ok();

    let app = tauri::Builder::default()
        .manage(TrackerRuntime::default())
        .invoke_handler(tauri::generate_handler![
            get_head_tracker_status,
            recenter_head_tracker
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(run_tracker(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Spatial Gesture Control");

    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = handle.state::<TrackerRuntime>();
            if !state.shutdown_started.swap(true, Ordering::AcqRel) {
                api.prevent_exit();
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    handle.state::<TrackerRuntime>().shutdown().await;
                    handle.exit(0);
                });
            }
        }
    });
}
