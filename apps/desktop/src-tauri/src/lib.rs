use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use spatial_protocol::{BUTTON_STATE_DOWN, BUTTON_STATE_UP, STEM_PRIMARY_BUTTON_ID};
use tauri::Manager;
use tracing::{debug, error, info, warn};
use watch_bridge::{WatchBridgeServer, WatchEvent};

mod calibration;
mod environment;
mod head_pose;
mod inference;
mod label_registry;
mod latest_write;
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
/// Upper bound on stopping both watch transports when the main window
/// closes (each is internally bounded, but nothing bounded the pair).
/// How long the watch transports get to disconnect before the app exits regardless. Shorter than
/// the launcher's own grace period (5 s), so a closed `npm start` finishes the teardown before it
/// would be killed.
const TEARDOWN_TIMEOUT: Duration = Duration::from_secs(4);

/// A graceful exit has begun (the first caller of [`exit_gracefully`] wins).
static EXITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The watch transports have been released; from here the runtime may exit.
static TORN_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Releases the watch transports (disconnecting Bluetooth, closing the listener), then exits.
///
/// Every way out goes through here: closing the window, Cmd+Q, and the signals a terminal or the
/// launcher sends (Ctrl+C, SIGTERM, SIGHUP). Dying without it leaves the Bluetooth connection to
/// the watch for the system to clean up eventually, and the watch can go on believing a desktop
/// is attached (it stops advertising while one is) so the next launch cannot find it.
fn exit_gracefully(handle: tauri::AppHandle, reason: &'static str) {
    use std::sync::atomic::Ordering;
    if EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    info!(reason, "shutting down: releasing the watch transports");
    tauri::async_runtime::spawn(async move {
        if let Some(server) = handle.try_state::<Arc<WatchBridgeServer>>() {
            // Both transports are torn down regardless of which one is selected, so neither a
            // listener nor a GATT connection outlives the app. The whole teardown is bounded:
            // a hung transport must not be able to keep a closed app's process alive.
            let teardown = async {
                if let Err(error) = server.stop_ble().await {
                    warn!(%error, "failed to stop watch BLE transport during teardown");
                }
                if let Err(error) = server.stop().await {
                    warn!(%error, "failed to stop watch bridge server during teardown");
                }
            };
            if tokio::time::timeout(TEARDOWN_TIMEOUT, teardown)
                .await
                .is_err()
            {
                warn!(timeout = ?TEARDOWN_TIMEOUT, "watch transport teardown timed out; exiting anyway");
            }
        }
        TORN_DOWN.store(true, Ordering::SeqCst);
        handle.exit(0);
    });
}

/// The signals that mean "stop": Ctrl+C, a terminate request from the launcher or a shell, and a
/// hangup when the terminal goes away. Registered up front, so a signal that arrives before anyone
/// is waiting is not lost.
struct TerminationSignals {
    #[cfg(unix)]
    streams: [tokio::signal::unix::Signal; 3],
}

impl TerminationSignals {
    fn register() -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Ok(Self {
                streams: [
                    signal(SignalKind::interrupt())?,
                    signal(SignalKind::terminate())?,
                    signal(SignalKind::hangup())?,
                ],
            })
        }
        #[cfg(not(unix))]
        {
            Ok(Self {})
        }
    }

    async fn wait(&mut self) {
        #[cfg(unix)]
        {
            let [interrupt, terminate, hangup] = &mut self.streams;
            tokio::select! {
                _ = interrupt.recv() => {}
                _ = terminate.recv() => {}
                _ = hangup.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

/// True when the watch event channel can never deliver again (every sender
/// dropped), as opposed to `Lagged`, which only means some events were
/// skipped.
fn watch_events_closed(error: &tokio::sync::broadcast::error::RecvError) -> bool {
    matches!(error, tokio::sync::broadcast::error::RecvError::Closed)
}

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
        .manage(recording_bundle::RawColumnCache::default())
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
            watch::get_watch_link_diagnostics,
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
            recording_bundle::get_raw_recording_derivative_window,
            recording_bundle::get_compact_observation_window,
            recording_bundle::get_recording_quality_summary,
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
            inference::report_model_runtime_failure,
            watch::get_watch_transport_status,
            watch::set_watch_transport,
            watch::rescan_watch_ble,
        ])
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                exit_gracefully(window.app_handle().clone(), "window closed");
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(settings::SettingsRuntime::load(&handle));
            overlay::prepare_window(&handle).map_err(std::io::Error::other)?;
            model_registry::reconcile_inference_mode_at_startup(&handle);
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

            // `npm start` asks where to send its "please quit" first, so it can wait for the
            // watch to be disconnected before tearing the rest of the process tree down.
            if let Some(path) = std::env::var_os("SPATIAL_APP_PID_FILE")
                && let Err(error) = std::fs::write(&path, std::process::id().to_string())
            {
                warn!(%error, "could not write the app's pid file");
            }

            // Ctrl+C / SIGTERM / SIGHUP take the same graceful path as closing the window.
            match TerminationSignals::register() {
                Ok(mut signals) => {
                    let signal_handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        signals.wait().await;
                        exit_gracefully(signal_handle, "termination signal");
                    });
                }
                Err(error) => warn!(%error, "could not install the termination signal handlers"),
            }

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
                let server = Arc::new(server);
                watch_handle.manage(Arc::clone(&server));
                watch::spawn_link_diagnostics_emitter(watch_handle.clone(), Arc::clone(&server));

                // Start only the transport the user selected; a fresh install
                // (and any settings.json predating the field) selects
                // Bluetooth. A failure is surfaced through the transport's own
                // status, never by quietly starting the other one.
                let transport = watch_handle
                    .state::<settings::SettingsRuntime>()
                    .get()
                    .map(|settings| settings.watch_transport)
                    .unwrap_or_default();
                if let Err(error) = settings::apply_watch_transport(&watch_handle, transport).await {
                    error!(%error, ?transport, "watch transport failed to start");
                }
                info!(?transport, "watch bridge started");

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
                                            let volume_runtime =
                                                watch_handle.state::<overlay::VolumeRuntime>();
                                            if let Err(error) = overlay.begin_volume_interaction(
                                                &watch_handle,
                                                overlay::GrabOwner::WatchButton,
                                                settings.wrist_rotation_config(),
                                                orientation.as_ref(),
                                                &volume_runtime,
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
                                    if let Err(error) = overlay
                                        .release_if_owner(&watch_handle, overlay::GrabOwner::WatchButton)
                                    {
                                        warn!(%error, "failed to release volume overlay");
                                    }
                                }
                                WatchEvent::Disconnected => {
                                    watch_handle
                                        .state::<inference::PpgIngestRuntime>()
                                        .clear();
                                    inference::force_release_and_hide(
                                        &watch_handle,
                                        interaction_engine::ForceReleaseReason::WatchDisconnected,
                                    );
                                }
                                WatchEvent::Orientation(sample) => {
                                    if let Err(error) = overlay.apply_wrist_rotation(&watch_handle, sample) {
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
                                WatchEvent::WearStateUpdated(sample) if sample.worn => {
                                    debug!("watch wear state: worn");
                                }
                                WatchEvent::WearStateUpdated(sample) if !sample.worn => {
                                    // Off the wrist the watch stops streaming on purpose; a held
                                    // grab must not outlive the data that was driving it.
                                    info!("watch taken off the wrist; releasing any interaction");
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
                            // `Lagged` is recoverable (events were dropped, the
                            // stream continues); `Closed` is permanent, and
                            // looping on it would spin force-releasing forever.
                            if watch_events_closed(&error) {
                                error!("watch event channel closed; stopping the watch event loop");
                                break;
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Spatial Gesture Control")
        .run(|handle, event| {
            // Cmd+Q and the app menu's Quit ask to exit without going through a window; hold
            // them until the transports are released, then let the exit through.
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !TORN_DOWN.load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_exit();
                exit_gracefully(handle.clone(), "quit requested");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast::error::RecvError;

    /// Sends `signal` to this very process. Safe only once a handler for it is registered.
    #[cfg(unix)]
    fn raise(signal: &str) {
        let status = std::process::Command::new("kill")
            .args([format!("-{signal}"), std::process::id().to_string()])
            .status()
            .expect("kill is available");
        assert!(status.success());
    }

    #[cfg(unix)]
    #[test]
    fn a_termination_signal_is_caught_rather_than_killing_the_process() {
        // The point of the handler: SIGTERM from the launcher used to end the app on the spot,
        // before the Bluetooth connection to the watch was released.
        for signal in ["TERM", "INT", "HUP"] {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let mut signals = TerminationSignals::register().unwrap();
                    raise(signal);
                    tokio::time::timeout(Duration::from_secs(3), signals.wait())
                        .await
                        .unwrap_or_else(|_| panic!("SIG{signal} was not delivered to the handler"));
                });
        }
    }

    /// R-M4-1: only `Closed` may end the watch event loop.
    #[test]
    fn only_a_closed_watch_event_channel_ends_the_loop() {
        assert!(watch_events_closed(&RecvError::Closed));
        assert!(!watch_events_closed(&RecvError::Lagged(3)));
    }
}
