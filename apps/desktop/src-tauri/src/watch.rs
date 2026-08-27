use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use spatial_protocol::{
    CONTROLLABLE_SENSOR_IDS, MEDICAL_TRACKER_IDS, WatchBiaResultSample, WatchHeartbeatSample,
    WatchOrientationSample,
};
use tauri::{AppHandle, Emitter, State};
use watch_bridge::{
    ClockOffsetEstimate, MeasurementCommand, SensorControlCommand, SensorRateCommand,
    WatchBridgeServer, WatchEvent,
};

pub const WATCH_STATUS_EVENT: &str = "watch-status";
pub const WATCH_ORIENTATION_EVENT: &str = "watch-orientation";
pub const WATCH_PPG_BATCH_EVENT: &str = "watch-ppg-batch";
pub const WATCH_HEART_RATE_BATCH_EVENT: &str = "watch-heart-rate-batch";
pub const WATCH_SKIN_TEMPERATURE_BATCH_EVENT: &str = "watch-skin-temperature-batch";
pub const WATCH_EDA_BATCH_EVENT: &str = "watch-eda-batch";

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

/// Distilled last sample from a `watch.heart_rate_batch` (`HEART_RATE_CONTINUOUS`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartRateSampleSnapshot {
    pub timestamp_ns: u64,
    pub heart_rate: i32,
    pub heart_rate_status: i32,
    pub ibi_ms: Vec<i32>,
    pub ibi_status: Vec<i32>,
}

/// Distilled last sample from a `watch.skin_temperature_batch` (`SKIN_TEMPERATURE_CONTINUOUS`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinTemperatureSampleSnapshot {
    pub timestamp_ns: u64,
    pub object_temperature_celsius: f64,
    pub ambient_temperature_celsius: f64,
    pub status: i32,
}

/// Distilled last sample from a `watch.eda_batch` (`EDA_CONTINUOUS`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdaSampleSnapshot {
    pub timestamp_ns: u64,
    pub skin_conductance_microsiemens: f64,
    pub status: i32,
}

/// Distilled last sample from a `watch.spo2_batch` (`SPO2_ON_DEMAND`, bounded session only).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spo2SampleSnapshot {
    pub timestamp_ns: u64,
    pub spo2: i32,
    pub heart_rate: i32,
    pub accuracy_flag: i32,
    pub status: i32,
}

/// Distilled last sample from a `watch.ecg_batch` (`ECG_ON_DEMAND`, bounded session only).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EcgSampleSnapshot {
    pub timestamp_ns: u64,
    pub ecg_millivolts: f64,
    pub lead_off: i32,
    pub sequence_number: i32,
    pub max_threshold_millivolts: f64,
    pub min_threshold_millivolts: f64,
}

/// Distilled last sample from a `watch.sweat_loss_batch` (bounded session only).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweatLossSampleSnapshot {
    pub timestamp_ns: u64,
    pub sweat_loss_milliliters: f64,
    pub status: i32,
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
    /// Latest `watch.button` state (`"down"` or `"up"`) for the STEM button
    /// that grabs the volume overlay. Reset on disconnect.
    pub last_button_state: Option<String>,
    /// Latest `watch.medical_status` state per tracker id (see
    /// `spatial_protocol::MEDICAL_TRACKER_IDS`/`MEDICAL_TRACKER_STATES`).
    /// Populated for every supported *and* unsupported tracker the watch
    /// reports on, not just the ones currently streaming.
    pub medical_status: HashMap<String, String>,
    /// Latest `watch.sensor_status` per IMU sensor id (see
    /// `spatial_protocol::IMU_SENSOR_IDS`). Continuous medical trackers'
    /// enabled state is read from `medical_status` instead (`"streaming"`).
    pub sensor_status: HashMap<String, bool>,
    pub heart_rate_last: Option<HeartRateSampleSnapshot>,
    pub heart_rate_rate_hz: Option<f64>,
    pub skin_temperature_last: Option<SkinTemperatureSampleSnapshot>,
    pub skin_temperature_rate_hz: Option<f64>,
    pub eda_last: Option<EdaSampleSnapshot>,
    pub eda_rate_hz: Option<f64>,
    pub spo2_last: Option<Spo2SampleSnapshot>,
    pub ecg_last: Option<EcgSampleSnapshot>,
    pub bia_last: Option<WatchBiaResultSample>,
    pub sweat_loss_last: Option<SweatLossSampleSnapshot>,
}

/// Sample rate in Hz from a batch's first/last SDK timestamp, mirroring the
/// `watch.ppg_batch` rate estimate.
fn batch_rate_hz(timestamps_ns: &[u64]) -> Option<f64> {
    let (&first, &last) = (timestamps_ns.first()?, timestamps_ns.last()?);
    if timestamps_ns.len() < 2 || last <= first {
        return None;
    }
    let seconds = (last - first) as f64 / 1_000_000_000.0;
    Some((timestamps_ns.len() as f64 - 1.0) / seconds)
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
                let _ = app.emit(WATCH_ORIENTATION_EVENT, &sample);
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
                let _ = app.emit(WATCH_PPG_BATCH_EVENT, &sample);
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
            WatchEvent::Button(sample) => {
                state.connected = true;
                state.last_button_state = Some(sample.state);
            }
            WatchEvent::HeartRate(sample) => {
                let _ = app.emit(WATCH_HEART_RATE_BATCH_EVENT, &sample);
                state.connected = true;
                state.heart_rate_rate_hz = batch_rate_hz(&sample.timestamps_ns);
                if let (
                    Some(&timestamp_ns),
                    Some(&heart_rate),
                    Some(&heart_rate_status),
                    Some(ibi_ms),
                    Some(ibi_status),
                ) = (
                    sample.timestamps_ns.last(),
                    sample.heart_rate.last(),
                    sample.heart_rate_status.last(),
                    sample.ibi_ms.last(),
                    sample.ibi_status.last(),
                ) {
                    state.heart_rate_last = Some(HeartRateSampleSnapshot {
                        timestamp_ns,
                        heart_rate,
                        heart_rate_status,
                        ibi_ms: ibi_ms.clone(),
                        ibi_status: ibi_status.clone(),
                    });
                }
            }
            WatchEvent::SkinTemperature(sample) => {
                let _ = app.emit(WATCH_SKIN_TEMPERATURE_BATCH_EVENT, &sample);
                state.connected = true;
                state.skin_temperature_rate_hz = batch_rate_hz(&sample.timestamps_ns);
                if let (
                    Some(&timestamp_ns),
                    Some(&object_temperature_celsius),
                    Some(&ambient_temperature_celsius),
                    Some(&status),
                ) = (
                    sample.timestamps_ns.last(),
                    sample.object_temperature_celsius.last(),
                    sample.ambient_temperature_celsius.last(),
                    sample.status.last(),
                ) {
                    state.skin_temperature_last = Some(SkinTemperatureSampleSnapshot {
                        timestamp_ns,
                        object_temperature_celsius,
                        ambient_temperature_celsius,
                        status,
                    });
                }
            }
            WatchEvent::Eda(sample) => {
                let _ = app.emit(WATCH_EDA_BATCH_EVENT, &sample);
                state.connected = true;
                state.eda_rate_hz = batch_rate_hz(&sample.timestamps_ns);
                if let (Some(&timestamp_ns), Some(&skin_conductance_microsiemens), Some(&status)) = (
                    sample.timestamps_ns.last(),
                    sample.skin_conductance_microsiemens.last(),
                    sample.status.last(),
                ) {
                    state.eda_last = Some(EdaSampleSnapshot {
                        timestamp_ns,
                        skin_conductance_microsiemens,
                        status,
                    });
                }
            }
            WatchEvent::Spo2(sample) => {
                state.connected = true;
                if let (
                    Some(&timestamp_ns),
                    Some(&spo2),
                    Some(&heart_rate),
                    Some(&accuracy_flag),
                    Some(&status),
                ) = (
                    sample.timestamps_ns.last(),
                    sample.spo2.last(),
                    sample.heart_rate.last(),
                    sample.accuracy_flag.last(),
                    sample.status.last(),
                ) {
                    state.spo2_last = Some(Spo2SampleSnapshot {
                        timestamp_ns,
                        spo2,
                        heart_rate,
                        accuracy_flag,
                        status,
                    });
                }
            }
            WatchEvent::Ecg(sample) => {
                state.connected = true;
                if let (
                    Some(&timestamp_ns),
                    Some(&ecg_millivolts),
                    Some(&lead_off),
                    Some(&sequence_number),
                    Some(&max_threshold_millivolts),
                    Some(&min_threshold_millivolts),
                ) = (
                    sample.timestamps_ns.last(),
                    sample.ecg_millivolts.last(),
                    sample.lead_off.last(),
                    sample.sequence_numbers.last(),
                    sample.max_threshold_millivolts.last(),
                    sample.min_threshold_millivolts.last(),
                ) {
                    state.ecg_last = Some(EcgSampleSnapshot {
                        timestamp_ns,
                        ecg_millivolts,
                        lead_off,
                        sequence_number,
                        max_threshold_millivolts,
                        min_threshold_millivolts,
                    });
                }
            }
            WatchEvent::BiaResult(sample) => {
                state.connected = true;
                state.bia_last = Some(sample);
            }
            WatchEvent::SweatLoss(sample) => {
                state.connected = true;
                if let (Some(&timestamp_ns), Some(&sweat_loss_milliliters), Some(&status)) = (
                    sample.timestamps_ns.last(),
                    sample.sweat_loss_milliliters.last(),
                    sample.status.last(),
                ) {
                    state.sweat_loss_last = Some(SweatLossSampleSnapshot {
                        timestamp_ns,
                        sweat_loss_milliliters,
                        status,
                    });
                }
            }
            WatchEvent::MedicalStatusUpdated(sample) => {
                state.connected = true;
                state.medical_status.insert(sample.tracker, sample.state);
            }
            WatchEvent::SensorStatusUpdated(sample) => {
                state.connected = true;
                state.sensor_status.insert(sample.sensor, sample.enabled);
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

/// Every tracker id the protocol knows about (`spatial_protocol::MEDICAL_TRACKER_IDS`),
/// so the frontend can render a row — supported or not — for each one
/// without duplicating the id list.
#[tauri::command]
pub fn get_medical_tracker_ids() -> Vec<&'static str> {
    MEDICAL_TRACKER_IDS.to_vec()
}

/// Starts a bounded on-demand medical measurement session on the watch.
/// Rejects continuous trackers and unknown ids; see `MeasurementCommand`.
#[tauri::command]
pub fn start_measurement(
    server: State<'_, std::sync::Arc<WatchBridgeServer>>,
    tracker: String,
) -> Result<(), String> {
    server
        .send_measurement_command(MeasurementCommand::Start(tracker))
        .map_err(|error| error.to_string())
}

/// Stops an in-progress on-demand medical measurement session on the watch.
#[tauri::command]
pub fn stop_measurement(
    server: State<'_, std::sync::Arc<WatchBridgeServer>>,
    tracker: String,
) -> Result<(), String> {
    server
        .send_measurement_command(MeasurementCommand::Stop(tracker))
        .map_err(|error| error.to_string())
}

/// Every sensor id controllable via [`set_sensor_enabled`]
/// (`spatial_protocol::CONTROLLABLE_SENSOR_IDS`): the IMU inputs plus the
/// continuous medical trackers.
#[tauri::command]
pub fn get_controllable_sensor_ids() -> Vec<&'static str> {
    CONTROLLABLE_SENSOR_IDS.to_vec()
}

/// Enables or disables an IMU input or continuous medical tracker in place.
/// Rejects on-demand trackers and unknown ids; see `SensorControlCommand`.
#[tauri::command]
pub fn set_sensor_enabled(
    server: State<'_, std::sync::Arc<WatchBridgeServer>>,
    sensor: String,
    enabled: bool,
) -> Result<(), String> {
    let command = if enabled {
        SensorControlCommand::Enable(sensor)
    } else {
        SensorControlCommand::Disable(sensor)
    };
    server
        .send_sensor_control_command(command)
        .map_err(|error| error.to_string())
}

/// Requests a new sampling rate for one IMU sensor (`spatial_protocol::IMU_SENSOR_IDS`).
/// Rejects medical trackers and out-of-range rates; see `SensorRateCommand`.
#[tauri::command]
pub fn set_sensor_rate(
    server: State<'_, std::sync::Arc<WatchBridgeServer>>,
    sensor: String,
    rate_hz: f64,
) -> Result<(), String> {
    server
        .send_sensor_rate_command(SensorRateCommand { sensor, rate_hz })
        .map_err(|error| error.to_string())
}
