use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use head_tracking::{HeadPoseEvent, HeadPoseProvider, SonyUdpHeadPoseProvider};
use tauri::Emitter;
use tracing::{error, info, warn};

const SONY_JSON_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4243);
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
        .setup(|app| {
            let handle = app.handle().clone();
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
                            let _ = handle.emit(CONNECTION_EVENT, false);
                        }
                        Ok(HeadPoseEvent::Pose(pose)) => {
                            if let Err(error) = handle.emit(POSE_EVENT, pose) {
                                warn!(%error, "failed to emit head-pose event");
                            }
                        }
                        Ok(HeadPoseEvent::ResetCounterChanged { previous, current }) => {
                            warn!(previous, current, "Sony reference frame reset");
                            let _ = handle.emit(RESET_EVENT, (previous, current));
                        }
                        Err(error) => {
                            warn!(%error, "head-pose event receiver lagged or closed");
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Spatial Gesture Control");
}
