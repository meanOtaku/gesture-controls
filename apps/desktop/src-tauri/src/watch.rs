use std::sync::Mutex;

use serde::Serialize;
use spatial_protocol::{WatchHeartbeatSample, WatchOrientationSample};
use tauri::{AppHandle, Emitter, State};
use watch_bridge::{ClockOffsetEstimate, WatchEvent};

pub const WATCH_STATUS_EVENT: &str = "watch-status";

/// Distilled last sample from a `watch.ppg_batch` for dashboard display; the
/// full per-batch channel arrays aren't retained in runtime state.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PpgSampleSnapshot {
    pub timestamp_ns: u64,
    pub green: i32,
    pub green_status: i32,
    pub red: i32,
    pub red_status: i32,
    pub ir: i32,
    pub ir_status: i32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub connected: bool,
    pub last_orientation: Option<WatchOrientationSample>,
    pub last_heartbeat: Option<WatchHeartbeatSample>,
    pub clock_offset_ns: Option<i64>,
    pub round_trip_ns: Option<u64>,
    /// Watch-reported `PpgCollector` state (see `spatial_protocol::PPG_STATES`):
    /// permission/availability of Samsung Health Sensor SDK raw PPG.
    pub ppg_state: Option<String>,
    pub ppg_last_sample: Option<PpgSampleSnapshot>,
    /// Sample rate in Hz, derived from the first/last timestamp within the
    /// most recent PPG batch.
    pub ppg_rate_hz: Option<f64>,
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
            WatchEvent::Ppg(sample) => {
                state.connected = true;
                if let (Some(&first), Some(&last)) =
                    (sample.timestamps_ns.first(), sample.timestamps_ns.last())
                    && sample.sample_count > 1
                    && last > first
                {
                    let seconds = (last - first) as f64 / 1_000_000_000.0;
                    state.ppg_rate_hz = Some((sample.sample_count as f64 - 1.0) / seconds);
                }
                if let (
                    Some(&timestamp_ns),
                    Some(&green),
                    Some(&green_status),
                    Some(&red),
                    Some(&red_status),
                    Some(&ir),
                    Some(&ir_status),
                ) = (
                    sample.timestamps_ns.last(),
                    sample.green.last(),
                    sample.green_status.last(),
                    sample.red.last(),
                    sample.red_status.last(),
                    sample.ir.last(),
                    sample.ir_status.last(),
                ) {
                    state.ppg_last_sample = Some(PpgSampleSnapshot {
                        timestamp_ns,
                        green,
                        green_status,
                        red,
                        red_status,
                        ir,
                        ir_status,
                    });
                }
            }
            WatchEvent::PpgStatusUpdated(sample) => {
                state.connected = true;
                state.ppg_state = Some(sample.state);
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
