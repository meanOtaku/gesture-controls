use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use spatial_protocol::{
    CONTROLLABLE_SENSOR_IDS, MEDICAL_TRACKER_IDS, WatchBiaResultSample, WatchHeartbeatSample,
    WatchOrientationSample,
};
use tauri::{AppHandle, Emitter, Manager, State};
use watch_bridge::{
    ClockOffsetEstimate, LinkDiagnostics, MeasurementCommand, SensorControlCommand,
    SensorRateCommand, WatchBridgeServer, WatchEvent, WatchTransport, ble::BleStatus,
};

pub const WATCH_STATUS_EVENT: &str = "watch-status";
/// The link's phase, counters, latencies and recent events, once a second.
pub const WATCH_LINK_DIAGNOSTICS_EVENT: &str = "watch-link-diagnostics";
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
    /// Whether the watch's off-body detector says it is on a wrist (`watch.wear_state`).
    /// `None` until it reports, and again after a disconnect. While `Some(false)` the watch
    /// has stopped its IMU and PPG collection on purpose, so no samples are expected.
    pub worn: Option<bool>,
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

/// The longest an orientation-driven status update may be held back. Orientation arrives at
/// up to 200 Hz, and the frontend can render at most ~15 Hz (the telemetry publish interval),
/// so more frequent status events only cost serialization and an IPC round trip each. The
/// orientation itself is delivered on its own, never-throttled event, and the frontend
/// de-duplicates the copy carried inside the status, so no sample is lost by this.
const STATUS_COALESCE_INTERVAL: Duration = Duration::from_millis(100);

/// Whether a status event should be sent now. Only `coalescible` updates (a new orientation
/// on an already-connected watch, which changes nothing but `last_orientation`) may be held
/// back; every other change is sent at once.
fn status_emit_due(last_emit: Option<Instant>, now: Instant, coalescible: bool) -> bool {
    !coalescible
        || last_emit.is_none_or(|previous| now.duration_since(previous) >= STATUS_COALESCE_INTERVAL)
}

#[derive(Default)]
pub struct WatchRuntime {
    state: Mutex<WatchStatus>,
    last_status_emit: Mutex<Option<Instant>>,
}

impl WatchRuntime {
    pub fn latest_orientation(&self) -> Result<Option<WatchOrientationSample>, String> {
        self.state
            .lock()
            .map(|state| state.last_orientation.clone())
            .map_err(|_| "watch status lock was poisoned".to_string())
    }

    pub fn apply(&self, app: &AppHandle, event: WatchEvent) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "watch status lock was poisoned")?;
        let mut coalescible = false;
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
                // Only a new orientation on an already-connected watch is coalescible; the
                // one that first marks the watch connected must be reported at once.
                coalescible = state.connected;
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
            WatchEvent::WearStateUpdated(sample) => {
                state.connected = true;
                state.worn = Some(sample.worn);
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
            WatchEvent::InvalidMessage { .. } => return Ok(()),
        }
        let now = Instant::now();
        let mut last_emit = self
            .last_status_emit
            .lock()
            .map_err(|_| "watch status emit gate was poisoned")?;
        if status_emit_due(*last_emit, now, coalescible) {
            // Serialized in place: cloning the whole status (two maps, nested vectors) just
            // to serialize the copy was pure overhead on every sensor event.
            let _ = app.emit(WATCH_STATUS_EVENT, &*state);
            *last_emit = Some(now);
        }
        Ok(())
    }

    pub fn state(&self) -> Result<WatchStatus, String> {
        self.state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "watch status lock was poisoned".to_string())
    }
}

#[tauri::command]
pub fn get_watch_link_diagnostics(app: AppHandle) -> LinkDiagnostics {
    app.try_state::<std::sync::Arc<WatchBridgeServer>>()
        .map(|server| server.link_diagnostics())
        .unwrap_or_else(|| LinkDiagnostics {
            phase: "idle",
            ..LinkDiagnostics::default()
        })
}

/// Publishes the link diagnostics once a second for the "Link health" card. The card also asks
/// for a snapshot when it opens, so it never waits for the next tick.
pub fn spawn_link_diagnostics_emitter(app: AppHandle, server: std::sync::Arc<WatchBridgeServer>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let _ = app.emit(WATCH_LINK_DIAGNOSTICS_EVENT, server.link_diagnostics());
        }
    });
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

/// The selected Watch transport plus what the BLE central is currently doing,
/// so the settings UI can show both without a second round trip.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchTransportStatus {
    pub selected: WatchTransport,
    pub ble: BleStatus,
}

#[tauri::command]
pub fn get_watch_transport_status(app: AppHandle) -> Result<WatchTransportStatus, String> {
    Ok(WatchTransportStatus {
        selected: app
            .state::<crate::settings::SettingsRuntime>()
            .get()?
            .watch_transport,
        // The bridge task publishes the server asynchronously at startup, so
        // the UI can legitimately ask before it exists.
        ble: app
            .try_state::<std::sync::Arc<WatchBridgeServer>>()
            .map(|server| server.ble_status())
            .unwrap_or(BleStatus::Idle),
    })
}

/// Switches the live Watch transport and persists the choice. Starting one
/// stops the other completely — no mDNS advertisement, pairing browser,
/// WebSocket listener, or GATT connection is left running behind it.
#[tauri::command]
pub async fn set_watch_transport(app: AppHandle, transport: WatchTransport) -> Result<(), String> {
    crate::settings::set_watch_transport(&app, transport).await
}

/// Re-runs the BLE scan/connect cycle (for a "Scan again" button): stops the
/// current session, then starts a fresh one. Only valid while BLE is selected.
#[tauri::command]
pub async fn rescan_watch_ble(app: AppHandle) -> Result<(), String> {
    let transport = app
        .state::<crate::settings::SettingsRuntime>()
        .get()?
        .watch_transport;
    if transport != WatchTransport::Bluetooth {
        return Err("Bluetooth is not the selected Watch transport".to_string());
    }
    crate::settings::restart_watch_ble(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAP: Duration = STATUS_COALESCE_INTERVAL;

    #[test]
    fn a_coalescible_update_is_held_back_until_the_interval_has_passed() {
        let start = Instant::now();
        assert!(
            status_emit_due(None, start, true),
            "the first one always goes out"
        );
        assert!(!status_emit_due(Some(start), start, true));
        assert!(!status_emit_due(
            Some(start),
            start + GAP - Duration::from_millis(1),
            true
        ));
        assert!(status_emit_due(Some(start), start + GAP, true));
    }

    #[test]
    fn every_other_change_is_sent_immediately_whatever_was_sent_just_before() {
        let start = Instant::now();
        assert!(status_emit_due(Some(start), start, false));
        assert!(status_emit_due(None, start, false));
    }

    /// 200 Hz orientation for one second reaches the frontend as about ten status events
    /// instead of two hundred, while a non-coalescible change in the middle is never delayed.
    #[test]
    fn a_two_hundred_hertz_stream_yields_about_ten_status_events_a_second() {
        let start = Instant::now();
        let mut last_emit = None;
        let mut emitted = 0;
        for tick in 0..200u64 {
            let now = start + Duration::from_millis(tick * 5);
            // A sensor-status change at 497 ms must not wait for the window.
            let coalescible = tick != 99;
            if status_emit_due(last_emit, now, coalescible) {
                emitted += 1;
                last_emit = Some(now);
            }
        }
        assert!((9..=12).contains(&emitted), "emitted {emitted}");
    }
}
