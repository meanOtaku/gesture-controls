use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use calibration::CalibrationRuntime;
use head_tracking::{HeadPoseEvent, HeadPoseProvider, SonyUdpHeadPoseProvider};
use tauri::{Emitter, Manager};
use tracing::{error, info, warn};
use watch_bridge::WatchBridgeServer;

mod calibration;
mod overlay;
mod watch;

const SONY_JSON_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4243);
const WATCH_WEBSOCKET_ADDRESS: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8766);
const WATCH_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(3);
const MAIN_WINDOW: &str = "main";
const CONNECTION_EVENT: &str = "head-tracker-connection";
const POSE_EVENT: &str = "head-pose-updated";
const RESET_EVENT: &str = "head-tracker-reset";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_target(true)
        .with_thread_ids(true)
        .try_init()
        .ok();

    tauri::Builder::default()
        .manage(CalibrationRuntime::default())
        .manage(overlay::OverlayRuntime::default())
        .manage(overlay::VolumeRuntime::default())
        .manage(watch::WatchRuntime::default())
        .invoke_handler(tauri::generate_handler![
            calibration::get_calibration_state,
            calibration::capture_calibration_target,
            calibration::update_calibration_config,
            overlay::get_overlay_state,
            overlay::show_overlay,
            overlay::hide_overlay,
            overlay::adjust_system_volume,
            overlay::refresh_system_volume,
            watch::get_watch_status,
        ])
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            overlay::prepare_window(&handle).map_err(std::io::Error::other)?;
            tauri::async_runtime::spawn(async move {
                let provider = match SonyUdpHeadPoseProvider::bind(
                    SONY_JSON_ADDRESS,
                    Duration::from_millis(1_000),
                )
                .await
                {
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
                info!(address = %SONY_JSON_ADDRESS, "Sony JSON UDP listener started");

                loop {
                    match events.recv().await {
                        Ok(HeadPoseEvent::Connected) => {
                            info!("Sony head tracker connected");
                            let _ = handle.emit(CONNECTION_EVENT, true);
                        }
                        Ok(HeadPoseEvent::Disconnected) => {
                            warn!("Sony head tracker disconnected");
                            match handle.state::<CalibrationRuntime>().disconnect(&handle) {
                                Ok(()) => {}
                                Err(error) => warn!(%error, "failed to suspend head calibration"),
                            }
                            let _ = handle.emit(CONNECTION_EVENT, false);
                        }
                        Ok(HeadPoseEvent::Pose(pose)) => {
                            match handle.state::<CalibrationRuntime>().observe(&handle, pose.quaternion) {
                                Ok(()) => {}
                                Err(error) => warn!(%error, "failed to evaluate head calibration"),
                            }
                            if let Err(error) = handle.emit(POSE_EVENT, pose) {
                                warn!(%error, "failed to emit head-pose event");
                            }
                        }
                        Ok(HeadPoseEvent::ResetCounterChanged { previous, current }) => {
                            warn!(previous, current, "Sony reference frame reset");
                            let runtime = handle.state::<CalibrationRuntime>();
                            match runtime.invalidate(&handle) {
                                Ok(_) => {}
                                Err(error) => warn!(%error, "failed to invalidate calibration"),
                            }
                            let _ = handle.emit(RESET_EVENT, (previous, current));
                        }
                        Err(error) => {
                            warn!(%error, "head-pose event receiver lagged or closed");
                        }
                    }
                }
            });

            let watch_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let server = match WatchBridgeServer::bind(
                    WATCH_WEBSOCKET_ADDRESS,
                    WATCH_HEARTBEAT_TIMEOUT,
                )
                .await
                {
                    Ok(server) => server,
                    Err(error) => {
                        error!(%error, address = %WATCH_WEBSOCKET_ADDRESS, "watch WebSocket listener failed to bind");
                        return;
                    }
                };

                let mut events = server.subscribe();
                if let Err(error) = server.start().await {
                    error!(%error, "watch bridge server failed to start");
                    return;
                }
                info!(address = %WATCH_WEBSOCKET_ADDRESS, "watch WebSocket server started");

                let runtime = watch_handle.state::<watch::WatchRuntime>();
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            if let Err(error) = runtime.apply(&watch_handle, event) {
                                warn!(%error, "failed to apply watch event");
                            }
                        }
                        Err(error) => {
                            warn!(%error, "watch event receiver lagged or closed");
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Spatial Gesture Control");
}
