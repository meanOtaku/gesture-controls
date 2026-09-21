use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use spatial_protocol::{BUTTON_STATE_DOWN, BUTTON_STATE_UP, STEM_PRIMARY_BUTTON_ID};
use tauri::Manager;
use tracing::{error, info, warn};
use watch_bridge::{WatchBridgeServer, WatchEvent};

mod calibration;
mod environment;
mod head_pose;
mod inference;
mod label_registry;
mod model_lab;
mod model_registry;
mod overlay;
mod recording_bundle;
mod settings;
mod training_label_mapping;
mod watch;

const WATCH_WEBSOCKET_ADDRESS: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8766);
const WATCH_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(3);
const MAIN_WINDOW: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_target(true)
        .with_thread_ids(true)
        .try_init()
        .ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(calibration::CalibrationRuntime::default())
        .manage(overlay::OverlayRuntime::default())
        .manage(overlay::VolumeRuntime::default())
        .manage(watch::WatchRuntime::default())
        .manage(model_lab::ModelLabRuntime::default())
        .manage(label_registry::LabelRegistryRuntime::default())
        .manage(model_registry::ModelRegistryRuntime::default())
        .manage(inference::GesturePolicyRuntime::default())
        .manage(inference::PpgIngestRuntime::default())
        .manage(inference::PinchInferenceRuntime::default())
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
            environment::get_environment_diagnostics,
            head_pose::get_head_tracker_provider,
            model_lab::import_model_dataset,
            model_lab::list_model_datasets,
            model_lab::delete_model_dataset,
            model_lab::start_training_job,
            model_lab::cancel_training_job,
            model_lab::get_training_status,
            model_lab::list_trained_models,
            model_lab::replay_model_dataset,
            recording_bundle::save_recording_bundle,
            recording_bundle::import_recording_from_raw_csv,
            recording_bundle::list_recording_bundles,
            recording_bundle::load_recording_bundle,
            recording_bundle::delete_recording_bundle,
            recording_bundle::get_raw_recording_window,
            recording_bundle::set_interval_curation_status,
            label_registry::list_model_labels,
            label_registry::create_model_label,
            label_registry::set_model_label_archived,
            model_registry::get_model_registry,
            model_registry::import_custom_tflite_bundle,
            model_registry::transition_model_state,
            model_registry::update_model_thresholds,
            model_registry::update_model_quality_gate,
            model_registry::set_model_intent_bindings,
            model_registry::activate_model,
            model_registry::rollback_active_model,
            model_registry::set_inference_mode,
            inference::report_pinch_transition,
            inference::report_model_runtime_failure,
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
            head_pose::spawn(handle.clone());

            let policy_watchdog_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(inference::STALENESS_WATCHDOG_INTERVAL);
                loop {
                    interval.tick().await;
                    let runtime = policy_watchdog_handle.state::<inference::GesturePolicyRuntime>();
                    match runtime.tick() {
                        Ok(Some(decision)) => inference::apply_decision(&policy_watchdog_handle, decision),
                        Ok(None) => {}
                        Err(error) => warn!(%error, "gesture policy staleness watchdog failed"),
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
                                    match watch_handle.state::<settings::SettingsRuntime>().get() {
                                        Ok(settings) => {
                                            let orientation = runtime.latest_orientation().unwrap_or_default();
                                            if let Err(error) = overlay.begin_volume_interaction(
                                                &watch_handle,
                                                settings.wrist_rotation_config(),
                                                orientation.as_ref(),
                                            ) {
                                                warn!(%error, "failed to begin volume interaction");
                                            }
                                        }
                                        Err(error) => {
                                            warn!(%error, "failed to read settings for volume interaction");
                                        }
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
                                    inference::force_release_and_hide(
                                        &watch_handle,
                                        interaction_engine::ForceReleaseReason::WatchDisconnected,
                                    );
                                }
                                WatchEvent::Orientation(sample) => {
                                    let volume_runtime = watch_handle.state::<overlay::VolumeRuntime>();
                                    if let Err(error) = overlay.apply_wrist_rotation(&watch_handle, sample, &volume_runtime) {
                                        warn!(%error, "failed to apply wrist rotation to volume");
                                    }
                                    watch_handle
                                        .state::<inference::PinchInferenceRuntime>()
                                        .observe_orientation(sample);
                                }
                                WatchEvent::Ppg(sample) => {
                                    inference::ingest_ppg_window(&watch_handle, sample);
                                }
                                WatchEvent::InvalidMessage { reason } => {
                                    warn!(reason = %reason, "rejecting malformed or out-of-order watch message");
                                    inference::force_release_and_hide(
                                        &watch_handle,
                                        interaction_engine::ForceReleaseReason::StaleSensorWindow,
                                    );
                                }
                                WatchEvent::PpgStatusUpdated(sample)
                                    if sample.state == "unavailable" || sample.state == "error" =>
                                {
                                    warn!(state = %sample.state, "watch PPG sensor became unavailable; forcing release");
                                    inference::force_release_and_hide(
                                        &watch_handle,
                                        interaction_engine::ForceReleaseReason::StaleSensorWindow,
                                    );
                                }
                                _ => {}
                            }
                            if let Err(error) = runtime.apply(&watch_handle, event) {
                                warn!(%error, "failed to apply watch event");
                            }
                        }
                        Err(error) => {
                            warn!(%error, "watch event receiver lagged or closed; failing closed");
                            inference::force_release_and_hide(
                                &watch_handle,
                                interaction_engine::ForceReleaseReason::StaleSensorWindow,
                            );
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Spatial Gesture Control");
}
