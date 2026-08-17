use std::sync::Mutex;

use serde::Serialize;
use spatial_protocol::{WatchHeartbeatSample, WatchOrientationSample};
use tauri::{AppHandle, Emitter, State};
use watch_bridge::{ClockOffsetEstimate, WatchEvent};

pub const WATCH_STATUS_EVENT: &str = "watch-status";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub connected: bool,
    pub last_orientation: Option<WatchOrientationSample>,
    pub last_heartbeat: Option<WatchHeartbeatSample>,
    pub clock_offset_ns: Option<i64>,
    pub round_trip_ns: Option<u64>,
}

#[derive(Default)]
pub struct WatchRuntime {
    state: Mutex<WatchStatus>,
}

impl WatchRuntime {
    pub fn apply(&self, app: &AppHandle, event: WatchEvent) -> Result<WatchStatus, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "watch status lock was poisoned")?;
        match event {
            WatchEvent::Connected => {
                *state = WatchStatus {
                    connected: true,
                    ..WatchStatus::default()
                };
            }
            WatchEvent::Disconnected => {
                *state = WatchStatus::default();
            }
            WatchEvent::Orientation(sample) => {
                state.connected = true;
                state.last_orientation = Some(sample);
            }
            WatchEvent::Heartbeat(sample) => {
                state.connected = true;
                state.last_heartbeat = Some(sample);
            }
            WatchEvent::ClockOffsetUpdated(ClockOffsetEstimate {
                offset_ns,
                round_trip_ns,
                ..
            }) => {
                state.clock_offset_ns = Some(offset_ns);
                state.round_trip_ns = Some(round_trip_ns);
            }
            WatchEvent::InvalidMessage { .. } => {
                return Ok(state.clone());
            }
        }
        let snapshot = state.clone();
        let _ = app.emit(WATCH_STATUS_EVENT, &snapshot);
        Ok(snapshot)
    }

    pub fn state(&self) -> Result<WatchStatus, String> {
        self.state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "watch status lock was poisoned".to_string())
    }
}

#[tauri::command]
pub fn get_watch_status(runtime: State<'_, WatchRuntime>) -> Result<WatchStatus, String> {
    runtime.state()
}
