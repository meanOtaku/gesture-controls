use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use calibration::CalibrationRuntime;
use head_tracking::{HeadPoseEvent, HeadPoseProvider, SonyUdpHeadPoseProvider};
use spatial_protocol::{BUTTON_STATE_DOWN, BUTTON_STATE_UP, STEM_PRIMARY_BUTTON_ID};
use tauri::{Emitter, Manager};
use tracing::{error, info, warn};
use watch_bridge::{WatchBridgeServer, WatchEvent};

mod calibration;
mod overlay;
mod settings;
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
            watch::get_medical_tracker_ids,
            watch::start_measurement,
            watch::stop_measurement,
            watch::get_controllable_sensor_ids,
            watch::set_sensor_enabled,
            watch::set_sensor_rate,
            settings::get_settings,
            settings::update_settings,
            settings::reset_settings,
        ])
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(server) = handle.try_state::<Arc<WatchBridgeServer>>()
                        && let Err(error) = server.stop().await
                    {
                        warn!(%error, "failed to stop watch bridge server during teardown");
                    }
                    handle.exit(0);
                });
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(settings::SettingsRuntime::load(&handle));
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
                            if handle.state::<settings::SettingsRuntime>().accept_headphones_pose()
                                && let Err(error) = handle.emit(POSE_EVENT, pose)
                            {
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
                watch_handle.manage(Arc::new(server));

                let runtime = watch_handle.state::<watch::WatchRuntime>();
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let overlay = watch_handle.state::<overlay::OverlayRuntime>();
                            match &event {
                                WatchEvent::Connected => {
                                    if let (Ok(settings), Some(server)) = (
                                        watch_handle.state::<settings::SettingsRuntime>().get(),
                                        watch_handle.try_state::<Arc<WatchBridgeServer>>(),
                                    ) {
                                        settings::apply_watch_settings(&server, &settings);
                                    }
                                }
                                WatchEvent::Button(sample)
                                    if sample.button == STEM_PRIMARY_BUTTON_ID
                                        && sample.state == BUTTON_STATE_DOWN =>
                                {
                                    if let Err(error) = overlay.grab(&watch_handle) {
                                        warn!(%error, "failed to grab volume overlay");
                                    } else if let Ok(settings) = watch_handle.state::<settings::SettingsRuntime>().get()
                                        && let Err(error) = overlay.configure_wrist_rotation(interaction_engine::WristRotationConfig {
                                            dead_zone_degrees: settings.wrist_dead_zone_degrees,
                                            smoothing_alpha: settings.wrist_smoothing_alpha,
                                            volume_points_per_degree: settings.wrist_volume_points_per_degree,
                                            max_angular_velocity_degrees_per_second: settings.wrist_max_angular_velocity_degrees_per_second,
                                            max_volume_points_per_second: settings.wrist_max_volume_points_per_second,
                                        })
                                    {
                                        warn!(%error, "failed to apply wrist rotation settings");
                                    } else if let Ok(Some(sample)) = runtime.latest_orientation()
                                        && let Err(error) = overlay.begin_wrist_rotation(&sample)
                                    {
                                        warn!(%error, "failed to establish wrist rotation reference pose");
                                    }
                                }
                                WatchEvent::Button(sample)
                                    if sample.button == STEM_PRIMARY_BUTTON_ID
                                        && sample.state == BUTTON_STATE_UP =>
                                {
                                    if let Err(error) = overlay.release(&watch_handle) {
                                        warn!(%error, "failed to release volume overlay");
                                    }
                                }
                                WatchEvent::Disconnected => {
                                    if let Err(error) = overlay.release(&watch_handle) {
                                        warn!(%error, "failed to release volume overlay on watch disconnect");
                                    }
                                }
                                WatchEvent::Orientation(sample) => {
                                    let volume_runtime = watch_handle.state::<overlay::VolumeRuntime>();
                                    if let Err(error) = overlay.apply_wrist_rotation(&watch_handle, sample, &volume_runtime) {
                                        warn!(%error, "failed to apply wrist rotation to volume");
                                    }
                                }
                                _ => {}
                            }
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
