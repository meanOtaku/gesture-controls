//! Shared wire and provider-independent domain types.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SONY_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonyHeadSample {
    pub version: u32,
    pub device: Option<String>,
    pub rotation_vector: [f64; 3],
    pub quaternion: [f64; 4],
    pub ypr_degrees: [f64; 3],
    pub gyroscope: Option<[f64; 3]>,
    pub accelerometer: Option<[f64; 3]>,
    pub angular_velocity: Option<[f64; 3]>,
    pub reset_counter: u64,
    pub packets_per_second: f64,
    pub receive_latency_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadPose {
    pub timestamp_ns: u64,
    pub device: Option<String>,
    pub quaternion: [f64; 4],
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    pub roll_deg: f64,
    pub angular_velocity: Option<[f64; 3]>,
    pub gyroscope: Option<[f64; 3]>,
    pub accelerometer: Option<[f64; 3]>,
    pub reset_counter: u64,
    pub packets_per_second: f64,
    pub receive_latency_ms: f64,
}

#[derive(Debug, Error)]
pub enum SonyPacketError {
    #[error("Sony head-tracker packet is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("unsupported Sony head-tracker protocol version {0}")]
    UnsupportedVersion(u32),
}

impl SonyHeadSample {
    pub fn from_json(datagram: &[u8]) -> Result<Self, SonyPacketError> {
        let sample: Self = serde_json::from_slice(datagram)?;
        if sample.version != SONY_PROTOCOL_VERSION {
            return Err(SonyPacketError::UnsupportedVersion(sample.version));
        }
        Ok(sample)
    }

    pub fn into_head_pose(self, timestamp_ns: u64) -> HeadPose {
        HeadPose {
            timestamp_ns,
            device: self.device,
            quaternion: self.quaternion,
            yaw_deg: self.ypr_degrees[0],
            pitch_deg: self.ypr_degrees[1],
            roll_deg: self.ypr_degrees[2],
            angular_velocity: self.angular_velocity.or(self.gyroscope),
            gyroscope: self.gyroscope,
            accelerometer: self.accelerometer,
            reset_counter: self.reset_counter,
            packets_per_second: self.packets_per_second,
            receive_latency_ms: self.receive_latency_ms,
        }
    }
}

// --- Galaxy Watch WebSocket protocol (v1) ---

pub const WATCH_PROTOCOL_VERSION: u32 = 1;

pub const WATCH_ORIENTATION_TYPE: &str = "watch.orientation";
pub const WATCH_HEARTBEAT_TYPE: &str = "watch.heartbeat";
pub const WATCH_TIME_SYNC_TYPE: &str = "watch.time_sync";
pub const WATCH_PPG_BATCH_TYPE: &str = "watch.ppg_batch";
/// One flush of motion and pulse samples in a single message.
pub const WATCH_SENSOR_BATCH_TYPE: &str = "watch.sensor_batch";
/// Most motion samples accepted in one `watch.sensor_batch`.
pub const MAX_IMU_BATCH_SAMPLES: usize = 64;
pub const WATCH_PPG_STATUS_TYPE: &str = "watch.ppg_status";
/// Whether the watch is on a wrist, from its off-body detector. While it is `false` the
/// watch stops its IMU and PPG collection (and, over Bluetooth, lets the CPU sleep).
pub const WATCH_WEAR_STATE_TYPE: &str = "watch.wear_state";
pub const WATCH_BUTTON_TYPE: &str = "watch.button";
pub const DESKTOP_CONNECTED_TYPE: &str = "desktop.connected";
pub const DESKTOP_TIME_SYNC_TYPE: &str = "desktop.time_sync";

// --- Medical tracker types (Samsung Health Sensor SDK 1.4.1) ---

pub const WATCH_HEART_RATE_BATCH_TYPE: &str = "watch.heart_rate_batch";
pub const WATCH_SKIN_TEMPERATURE_BATCH_TYPE: &str = "watch.skin_temperature_batch";
pub const WATCH_EDA_BATCH_TYPE: &str = "watch.eda_batch";
pub const WATCH_SPO2_BATCH_TYPE: &str = "watch.spo2_batch";
pub const WATCH_ECG_BATCH_TYPE: &str = "watch.ecg_batch";
pub const WATCH_BIA_RESULT_TYPE: &str = "watch.bia_result";
pub const WATCH_SWEAT_LOSS_BATCH_TYPE: &str = "watch.sweat_loss_batch";
pub const WATCH_MEDICAL_STATUS_TYPE: &str = "watch.medical_status";
pub const DESKTOP_START_MEASUREMENT_TYPE: &str = "desktop.start_measurement";
pub const DESKTOP_STOP_MEASUREMENT_TYPE: &str = "desktop.stop_measurement";

/// A short, bounded haptic pulse on the watch, e.g. feedback for a wrist-rotation
/// volume adjustment. Never used for sustained/looping vibration.
pub const DESKTOP_HAPTIC_TYPE: &str = "desktop.haptic";

/// Inclusive bounds for [`DesktopHapticPayload::duration_ms`], mirrored by
/// `MIN_HAPTIC_DURATION_MS`/`MAX_HAPTIC_DURATION_MS` in `WatchProtocol.kt`.
/// Kept short so a haptic command can never be (ab)used as a sustained buzz.
pub const MIN_HAPTIC_DURATION_MS: u32 = 10;
pub const MAX_HAPTIC_DURATION_MS: u32 = 200;

/// Generic enable/disable command for [`CONTROLLABLE_SENSOR_IDS`] — unlike
/// `desktop.start_measurement`, this toggles an always-available input on or
/// off rather than opening a bounded on-demand session.
pub const DESKTOP_SET_SENSOR_TYPE: &str = "desktop.set_sensor";
/// The watch's reply reporting an IMU sensor's current enabled state (see
/// [`IMU_SENSOR_IDS`]). Continuous medical trackers report via
/// `watch.medical_status` instead.
pub const WATCH_SENSOR_STATUS_TYPE: &str = "watch.sensor_status";

/// Per-sensor sampling-rate request for [`IMU_SENSOR_IDS`], added after the
/// v1 rollout — still `WATCH_PROTOCOL_VERSION == 1`, since it is a new
/// message type rather than a change to an existing one. Applied live by
/// `SensorCollector` via `SensorManager.registerListener(listener, sensor,
/// samplingPeriodUs)`, re-registering only the affected physical sensor.
/// Medical trackers are out of scope: Samsung Health Sensor SDK owns their
/// physical sampling rate and it is never requested or overridden here.
pub const DESKTOP_SET_SENSOR_RATE_TYPE: &str = "desktop.set_sensor_rate";

/// Inclusive bounds for [`DesktopSensorRateCommandPayload::rate_hz`],
/// mirrored by `MIN_SENSOR_RATE_HZ`/`MAX_SENSOR_RATE_HZ` in
/// `MotionSensorProtocol.kt`.
pub const MIN_SENSOR_RATE_HZ: f64 = 1.0;
pub const MAX_SENSOR_RATE_HZ: f64 = 200.0;
pub const MIN_PPG_FLUSH_RATE_HZ: f64 = 0.1;
pub const MAX_PPG_FLUSH_RATE_HZ: f64 = 10.0;

/// Continuously-accessible trackers, capability-gated and auto-started
/// alongside `PPG_CONTINUOUS` (see `MedicalContinuousCollector.kt`).
pub const TRACKER_HEART_RATE_CONTINUOUS: &str = "heart_rate_continuous";
pub const TRACKER_SKIN_TEMPERATURE_CONTINUOUS: &str = "skin_temperature_continuous";
pub const TRACKER_EDA_CONTINUOUS: &str = "eda_continuous";
/// On-demand trackers: session-based, user/desktop-triggered, and gated by
/// Samsung Health's own consent and SDK policy — never auto-started or
/// coerced into a continuous stream (see `OnDemandMedicalSampler.kt`).
pub const TRACKER_SPO2_ON_DEMAND: &str = "spo2_on_demand";
pub const TRACKER_ECG_ON_DEMAND: &str = "ecg_on_demand";
pub const TRACKER_BIA_ON_DEMAND: &str = "bia_on_demand";
pub const TRACKER_SWEAT_LOSS_ON_DEMAND: &str = "sweat_loss_on_demand";

/// IMU sensor ids individually controllable via `desktop.set_sensor`/
/// `watch.sensor_status`, mirroring the physical inputs `SensorCollector`
/// bundles into `watch.orientation` (rotation vector, linear acceleration,
/// gyroscope). Disabling [`SENSOR_ORIENTATION`] stops every IMU sample,
/// since acceleration/gyroscope readings are only ever sent attached to a
/// rotation-vector event.
pub const SENSOR_ORIENTATION: &str = "orientation";
pub const SENSOR_ACCELERATION: &str = "acceleration";
pub const SENSOR_GYROSCOPE: &str = "gyroscope";
pub const SENSOR_PPG_FLUSH: &str = "ppg_continuous";

pub const IMU_SENSOR_IDS: &[&str] = &[SENSOR_ORIENTATION, SENSOR_ACCELERATION, SENSOR_GYROSCOPE];
pub const RATE_CONTROLLABLE_SENSOR_IDS: &[&str] = &[
    SENSOR_ORIENTATION,
    SENSOR_ACCELERATION,
    SENSOR_GYROSCOPE,
    SENSOR_PPG_FLUSH,
];

/// Every sensor controllable via the generic `desktop.set_sensor` command:
/// the three IMU inputs plus the continuously-accessible medical trackers.
/// On-demand trackers are excluded — they use bounded
/// `desktop.start_measurement`/`desktop.stop_measurement` sessions instead
/// (see [`ON_DEMAND_MEDICAL_TRACKER_IDS`]).
pub const CONTROLLABLE_SENSOR_IDS: &[&str] = &[
    SENSOR_ORIENTATION,
    SENSOR_ACCELERATION,
    SENSOR_GYROSCOPE,
    TRACKER_HEART_RATE_CONTINUOUS,
    TRACKER_SKIN_TEMPERATURE_CONTINUOUS,
    TRACKER_EDA_CONTINUOUS,
];

pub const MEDICAL_TRACKER_IDS: &[&str] = &[
    TRACKER_HEART_RATE_CONTINUOUS,
    TRACKER_SKIN_TEMPERATURE_CONTINUOUS,
    TRACKER_EDA_CONTINUOUS,
    TRACKER_SPO2_ON_DEMAND,
    TRACKER_ECG_ON_DEMAND,
    TRACKER_BIA_ON_DEMAND,
    TRACKER_SWEAT_LOSS_ON_DEMAND,
];

/// The subset of [`MEDICAL_TRACKER_IDS`] that must never be started other
/// than by an explicit `desktop.start_measurement` (or on-watch trigger):
/// bounded sessions only, per Samsung Health Sensor SDK policy.
pub const ON_DEMAND_MEDICAL_TRACKER_IDS: &[&str] = &[
    TRACKER_SPO2_ON_DEMAND,
    TRACKER_ECG_ON_DEMAND,
    TRACKER_BIA_ON_DEMAND,
    TRACKER_SWEAT_LOSS_ON_DEMAND,
];

/// Valid `payload.state` values for `watch.medical_status`. Continuous
/// trackers only ever report `idle`/`permission_required`/`connecting`/
/// `streaming`/`unavailable`/`error`; on-demand trackers report the same set
/// with `measuring` in place of `streaming` while a bounded session is active.
pub const MEDICAL_TRACKER_STATES: &[&str] = &[
    "idle",
    "permission_required",
    "connecting",
    "streaming",
    "measuring",
    "unavailable",
    "error",
];

/// Maximum samples accepted in a single medical batch payload; mirrors
/// [`MAX_PPG_BATCH_SAMPLES`].
pub const MAX_MEDICAL_BATCH_SAMPLES: usize = 512;

/// Identifies the Wear OS STEM_1 hardware key in `watch.button` messages (see
/// `MainActivity`'s `onKeyDown`/`onKeyUp`). The only button this milestone
/// dispatches; other IDs are reserved for future hardware buttons.
pub const STEM_PRIMARY_BUTTON_ID: &str = "stem_primary";

pub const BUTTON_STATE_DOWN: &str = "down";
pub const BUTTON_STATE_UP: &str = "up";

/// Valid `payload.state` values for `watch.button`.
pub const BUTTON_STATES: &[&str] = &[BUTTON_STATE_DOWN, BUTTON_STATE_UP];

/// Maximum samples accepted in a single `watch.ppg_batch` payload. Bounds memory
/// use against a malformed or malicious sender; the watch client batches in the
/// tens of samples (a few hundred ms of PPG_CONTINUOUS at ~25 Hz), well under this.
pub const MAX_PPG_BATCH_SAMPLES: usize = 512;

/// Valid `payload.state` values for `watch.ppg_status`, mirroring the watch's
/// `PpgCollector` state machine (permission/availability of Samsung Health
/// Sensor SDK raw PPG, not the WebSocket connection state).
pub const PPG_STATES: &[&str] = &[
    "idle",
    "permission_required",
    "connecting",
    "streaming",
    "unavailable",
    "error",
];

/// Raw v1 envelope shared by every watch-to-desktop message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEnvelope {
    #[serde(rename = "type")]
    pub message_type: String,
    pub version: u32,
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Error)]
pub enum WatchPacketError {
    #[error("watch message is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("unsupported watch protocol version {0}")]
    UnsupportedVersion(u32),
    #[error("watch message has an empty deviceId")]
    MissingDeviceId,
    #[error("unknown watch message type '{0}'")]
    UnknownMessageType(String),
    #[error("watch message payload is invalid: {0}")]
    InvalidPayload(serde_json::Error),
    #[error("watch PPG batch is malformed: {0}")]
    InvalidPpgBatch(String),
    #[error("watch sensor batch is malformed: {0}")]
    InvalidSensorBatch(String),
    #[error("watch PPG status has an unknown state '{0}'")]
    UnknownPpgState(String),
    #[error("watch button message has an unknown state '{0}'")]
    UnknownButtonState(String),
    #[error("watch medical batch is malformed: {0}")]
    InvalidMedicalBatch(String),
    #[error("watch medical status has an unknown tracker '{0}'")]
    UnknownMedicalTracker(String),
    #[error("watch medical status has an unknown state '{0}'")]
    UnknownMedicalState(String),
    #[error("watch sensor status has an unknown sensor id '{0}'")]
    UnknownSensorId(String),
}

impl WatchEnvelope {
    /// Parses and validates the outer envelope. Does not interpret `payload`.
    pub fn from_json(datagram: &[u8]) -> Result<Self, WatchPacketError> {
        let envelope: Self = serde_json::from_slice(datagram)?;
        if envelope.version != WATCH_PROTOCOL_VERSION {
            return Err(WatchPacketError::UnsupportedVersion(envelope.version));
        }
        if envelope.device_id.trim().is_empty() {
            return Err(WatchPacketError::MissingDeviceId);
        }
        Ok(envelope)
    }

    /// Interprets `payload` according to `message_type`.
    pub fn decode(self) -> Result<WatchInboundMessage, WatchPacketError> {
        match self.message_type.as_str() {
            WATCH_ORIENTATION_TYPE => {
                let payload: WatchOrientationPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                Ok(WatchInboundMessage::Orientation(WatchOrientationSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    quaternion: payload.quaternion,
                    accelerometer: payload.accelerometer,
                    gyroscope: payload.gyroscope,
                }))
            }
            WATCH_HEARTBEAT_TYPE => {
                let payload: WatchHeartbeatPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                Ok(WatchInboundMessage::Heartbeat(WatchHeartbeatSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    battery_percent: payload.battery_percent,
                }))
            }
            WATCH_TIME_SYNC_TYPE => {
                let payload: WatchTimeSyncPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                Ok(WatchInboundMessage::TimeSync(WatchTimeSyncSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    desktop_time_ns: payload.desktop_time_ns,
                    watch_time_ns: payload.watch_time_ns,
                }))
            }
            WATCH_PPG_BATCH_TYPE => {
                let payload: WatchPpgBatchPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                validate_ppg_batch(&payload)?;
                Ok(WatchInboundMessage::PpgBatch(WatchPpgBatchSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    sample_count: payload.sample_count,
                    timestamps_ns: payload.timestamps_ns,
                    green: payload.green,
                    green_status: payload.green_status,
                    red: payload.red,
                    red_status: payload.red_status,
                    ir: payload.ir,
                    ir_status: payload.ir_status,
                }))
            }
            WATCH_SENSOR_BATCH_TYPE => {
                let payload: WatchSensorBatchPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                let mut orientations = Vec::new();
                if let Some(packed) = &payload.imu_packed {
                    orientations = decode_packed_imu(packed, &self.device_id, self.sequence)?;
                } else if let Some(imu) = payload.imu {
                    let count = imu.count as usize;
                    if count == 0 || count > MAX_IMU_BATCH_SAMPLES {
                        return Err(WatchPacketError::InvalidSensorBatch(format!(
                            "motion sampleCount {count} is outside 1..={MAX_IMU_BATCH_SAMPLES}"
                        )));
                    }
                    let lengths = [
                        imu.timestamps_ns.len(),
                        imu.quaternion.len(),
                        imu.accelerometer.len(),
                        imu.gyroscope.len(),
                    ];
                    if lengths.iter().any(|&len| len != count) {
                        return Err(WatchPacketError::InvalidSensorBatch(format!(
                            "motion count {count} does not match array lengths {lengths:?}"
                        )));
                    }
                    for index in 0..count {
                        orientations.push(WatchOrientationSample {
                            device_id: self.device_id.clone(),
                            sequence: self.sequence,
                            timestamp_ns: imu.timestamps_ns[index],
                            quaternion: imu.quaternion[index],
                            accelerometer: imu.accelerometer[index],
                            gyroscope: imu.gyroscope[index],
                        });
                    }
                }
                let ppg = match payload.ppg {
                    Some(ppg) => {
                        validate_ppg_batch(&ppg)?;
                        Some(WatchPpgBatchSample {
                            device_id: self.device_id,
                            sequence: self.sequence,
                            timestamp_ns: self.timestamp_ns,
                            sample_count: ppg.sample_count,
                            timestamps_ns: ppg.timestamps_ns,
                            green: ppg.green,
                            green_status: ppg.green_status,
                            red: ppg.red,
                            red_status: ppg.red_status,
                            ir: ppg.ir,
                            ir_status: ppg.ir_status,
                        })
                    }
                    None => None,
                };
                if orientations.is_empty() && ppg.is_none() {
                    return Err(WatchPacketError::InvalidSensorBatch(
                        "batch has neither motion nor pulse samples".to_string(),
                    ));
                }
                Ok(WatchInboundMessage::SensorBatch(WatchSensorBatch {
                    orientations,
                    ppg,
                }))
            }
            WATCH_PPG_STATUS_TYPE => {
                let payload: WatchPpgStatusPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                if !PPG_STATES.contains(&payload.state.as_str()) {
                    return Err(WatchPacketError::UnknownPpgState(payload.state));
                }
                Ok(WatchInboundMessage::PpgStatus(WatchPpgStatusSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    state: payload.state,
                }))
            }
            WATCH_WEAR_STATE_TYPE => {
                let payload: WatchWearStatePayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                Ok(WatchInboundMessage::WearState(WatchWearStateSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    worn: payload.worn,
                }))
            }
            WATCH_BUTTON_TYPE => {
                let payload: WatchButtonPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                if !BUTTON_STATES.contains(&payload.state.as_str()) {
                    return Err(WatchPacketError::UnknownButtonState(payload.state));
                }
                Ok(WatchInboundMessage::Button(WatchButtonSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    button: payload.button,
                    state: payload.state,
                }))
            }
            WATCH_HEART_RATE_BATCH_TYPE => {
                let payload: WatchHeartRateBatchPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                let expected = payload.sample_count as usize;
                validate_batch_lengths(
                    expected,
                    &[
                        payload.timestamps_ns.len(),
                        payload.heart_rate.len(),
                        payload.heart_rate_status.len(),
                        payload.ibi_ms.len(),
                        payload.ibi_status.len(),
                    ],
                )?;
                Ok(WatchInboundMessage::HeartRateBatch(
                    WatchHeartRateBatchSample {
                        device_id: self.device_id,
                        sequence: self.sequence,
                        timestamp_ns: self.timestamp_ns,
                        sample_count: payload.sample_count,
                        timestamps_ns: payload.timestamps_ns,
                        heart_rate: payload.heart_rate,
                        heart_rate_status: payload.heart_rate_status,
                        ibi_ms: payload.ibi_ms,
                        ibi_status: payload.ibi_status,
                    },
                ))
            }
            WATCH_SKIN_TEMPERATURE_BATCH_TYPE => {
                let payload: WatchSkinTemperatureBatchPayload =
                    serde_json::from_value(self.payload)
                        .map_err(WatchPacketError::InvalidPayload)?;
                let expected = payload.sample_count as usize;
                validate_batch_lengths(
                    expected,
                    &[
                        payload.timestamps_ns.len(),
                        payload.object_temperature_celsius.len(),
                        payload.ambient_temperature_celsius.len(),
                        payload.status.len(),
                    ],
                )?;
                Ok(WatchInboundMessage::SkinTemperatureBatch(
                    WatchSkinTemperatureBatchSample {
                        device_id: self.device_id,
                        sequence: self.sequence,
                        timestamp_ns: self.timestamp_ns,
                        sample_count: payload.sample_count,
                        timestamps_ns: payload.timestamps_ns,
                        object_temperature_celsius: payload.object_temperature_celsius,
                        ambient_temperature_celsius: payload.ambient_temperature_celsius,
                        status: payload.status,
                    },
                ))
            }
            WATCH_EDA_BATCH_TYPE => {
                let payload: WatchEdaBatchPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                let expected = payload.sample_count as usize;
                validate_batch_lengths(
                    expected,
                    &[
                        payload.timestamps_ns.len(),
                        payload.skin_conductance_microsiemens.len(),
                        payload.status.len(),
                    ],
                )?;
                Ok(WatchInboundMessage::EdaBatch(WatchEdaBatchSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    sample_count: payload.sample_count,
                    timestamps_ns: payload.timestamps_ns,
                    skin_conductance_microsiemens: payload.skin_conductance_microsiemens,
                    status: payload.status,
                }))
            }
            WATCH_SPO2_BATCH_TYPE => {
                let payload: WatchSpo2BatchPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                let expected = payload.sample_count as usize;
                validate_batch_lengths(
                    expected,
                    &[
                        payload.timestamps_ns.len(),
                        payload.spo2.len(),
                        payload.heart_rate.len(),
                        payload.accuracy_flag.len(),
                        payload.status.len(),
                    ],
                )?;
                Ok(WatchInboundMessage::Spo2Batch(WatchSpo2BatchSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    sample_count: payload.sample_count,
                    timestamps_ns: payload.timestamps_ns,
                    spo2: payload.spo2,
                    heart_rate: payload.heart_rate,
                    accuracy_flag: payload.accuracy_flag,
                    status: payload.status,
                }))
            }
            WATCH_ECG_BATCH_TYPE => {
                let payload: WatchEcgBatchPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                let expected = payload.sample_count as usize;
                validate_batch_lengths(
                    expected,
                    &[
                        payload.timestamps_ns.len(),
                        payload.ecg_millivolts.len(),
                        payload.lead_off.len(),
                        payload.sequence_numbers.len(),
                        payload.max_threshold_millivolts.len(),
                        payload.min_threshold_millivolts.len(),
                    ],
                )?;
                Ok(WatchInboundMessage::EcgBatch(WatchEcgBatchSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    sample_count: payload.sample_count,
                    timestamps_ns: payload.timestamps_ns,
                    ecg_millivolts: payload.ecg_millivolts,
                    lead_off: payload.lead_off,
                    sequence_numbers: payload.sequence_numbers,
                    max_threshold_millivolts: payload.max_threshold_millivolts,
                    min_threshold_millivolts: payload.min_threshold_millivolts,
                }))
            }
            WATCH_BIA_RESULT_TYPE => {
                let payload: WatchBiaResultPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                Ok(WatchInboundMessage::BiaResult(WatchBiaResultSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    progress_percent: payload.progress_percent,
                    status: payload.status,
                    body_fat_ratio: payload.body_fat_ratio,
                    body_fat_mass_kg: payload.body_fat_mass_kg,
                    total_body_water_kg: payload.total_body_water_kg,
                    skeletal_muscle_ratio: payload.skeletal_muscle_ratio,
                    skeletal_muscle_mass_kg: payload.skeletal_muscle_mass_kg,
                    basal_metabolic_rate_kcal: payload.basal_metabolic_rate_kcal,
                    fat_free_ratio: payload.fat_free_ratio,
                    fat_free_mass_kg: payload.fat_free_mass_kg,
                    body_impedance_magnitude_ohm: payload.body_impedance_magnitude_ohm,
                    body_impedance_degree_deg: payload.body_impedance_degree_deg,
                }))
            }
            WATCH_SWEAT_LOSS_BATCH_TYPE => {
                let payload: WatchSweatLossBatchPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                let expected = payload.sample_count as usize;
                validate_batch_lengths(
                    expected,
                    &[
                        payload.timestamps_ns.len(),
                        payload.sweat_loss_milliliters.len(),
                        payload.status.len(),
                    ],
                )?;
                Ok(WatchInboundMessage::SweatLossBatch(
                    WatchSweatLossBatchSample {
                        device_id: self.device_id,
                        sequence: self.sequence,
                        timestamp_ns: self.timestamp_ns,
                        sample_count: payload.sample_count,
                        timestamps_ns: payload.timestamps_ns,
                        sweat_loss_milliliters: payload.sweat_loss_milliliters,
                        status: payload.status,
                    },
                ))
            }
            WATCH_MEDICAL_STATUS_TYPE => {
                let payload: WatchMedicalStatusPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                if !MEDICAL_TRACKER_IDS.contains(&payload.tracker.as_str()) {
                    return Err(WatchPacketError::UnknownMedicalTracker(payload.tracker));
                }
                if !MEDICAL_TRACKER_STATES.contains(&payload.state.as_str()) {
                    return Err(WatchPacketError::UnknownMedicalState(payload.state));
                }
                Ok(WatchInboundMessage::MedicalStatus(
                    WatchMedicalStatusSample {
                        device_id: self.device_id,
                        sequence: self.sequence,
                        timestamp_ns: self.timestamp_ns,
                        tracker: payload.tracker,
                        state: payload.state,
                    },
                ))
            }
            WATCH_SENSOR_STATUS_TYPE => {
                let payload: WatchSensorStatusPayload = serde_json::from_value(self.payload)
                    .map_err(WatchPacketError::InvalidPayload)?;
                if !IMU_SENSOR_IDS.contains(&payload.sensor.as_str()) {
                    return Err(WatchPacketError::UnknownSensorId(payload.sensor));
                }
                Ok(WatchInboundMessage::SensorStatus(WatchSensorStatusSample {
                    device_id: self.device_id,
                    sequence: self.sequence,
                    timestamp_ns: self.timestamp_ns,
                    sensor: payload.sensor,
                    enabled: payload.enabled,
                }))
            }
            other => Err(WatchPacketError::UnknownMessageType(other.to_string())),
        }
    }
}

/// Rejects PPG batches that are empty, oversized, or whose per-channel arrays
/// disagree with `sampleCount` (a malformed or truncated batch, since every
/// array must carry exactly one entry per sample).
fn validate_ppg_batch(payload: &WatchPpgBatchPayload) -> Result<(), WatchPacketError> {
    let expected = payload.sample_count as usize;
    if expected == 0 {
        return Err(WatchPacketError::InvalidPpgBatch(
            "PPG batch has sampleCount 0".to_string(),
        ));
    }
    if expected > MAX_PPG_BATCH_SAMPLES {
        return Err(WatchPacketError::InvalidPpgBatch(format!(
            "PPG batch sampleCount {expected} exceeds max {MAX_PPG_BATCH_SAMPLES}"
        )));
    }
    let lengths = [
        payload.timestamps_ns.len(),
        payload.green.len(),
        payload.green_status.len(),
        payload.red.len(),
        payload.red_status.len(),
        payload.ir.len(),
        payload.ir_status.len(),
    ];
    if lengths.iter().any(|&len| len != expected) {
        return Err(WatchPacketError::InvalidPpgBatch(format!(
            "PPG batch sampleCount {expected} does not match channel array lengths {lengths:?}"
        )));
    }
    Ok(())
}

/// Rejects a medical batch that's empty, oversized, or whose parallel arrays
/// disagree with `sampleCount`; shared by every `watch.*_batch` medical
/// tracker message. `lengths` is every per-sample array's length.
fn validate_batch_lengths(expected: usize, lengths: &[usize]) -> Result<(), WatchPacketError> {
    if expected == 0 {
        return Err(WatchPacketError::InvalidMedicalBatch(
            "medical batch has sampleCount 0".to_string(),
        ));
    }
    if expected > MAX_MEDICAL_BATCH_SAMPLES {
        return Err(WatchPacketError::InvalidMedicalBatch(format!(
            "medical batch sampleCount {expected} exceeds max {MAX_MEDICAL_BATCH_SAMPLES}"
        )));
    }
    if lengths.iter().any(|&len| len != expected) {
        return Err(WatchPacketError::InvalidMedicalBatch(format!(
            "medical batch sampleCount {expected} does not match channel array lengths {lengths:?}"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchOrientationPayload {
    pub quaternion: [f64; 4],
    pub accelerometer: Option<[f64; 3]>,
    pub gyroscope: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchHeartbeatPayload {
    pub battery_percent: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchTimeSyncPayload {
    pub desktop_time_ns: u64,
    pub watch_time_ns: u64,
}

/// One `watch.ppg_batch` payload: parallel per-channel arrays, one entry per
/// sample, in ascending SDK-timestamp order. `green`/`red`/`ir` are the raw
/// PPG_CONTINUOUS ADC counts from Samsung Health Sensor SDK 1.4.1's
/// `ValueKey.PpgSet`; the `*_status` arrays are the SDK's per-channel status
/// code for that sample (0 = valid on Samsung's convention; non-zero flags a
/// degraded or invalid reading, e.g. poor skin contact).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPpgBatchPayload {
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub green: Vec<i32>,
    pub green_status: Vec<i32>,
    pub red: Vec<i32>,
    pub red_status: Vec<i32>,
    pub ir: Vec<i32>,
    pub ir_status: Vec<i32>,
}

/// The motion half of a `watch.sensor_batch`: one entry per sample in every array; a sensor that gave
/// nothing for a sample is `null` there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchImuBatchPayload {
    pub count: u32,
    pub timestamps_ns: Vec<u64>,
    pub quaternion: Vec<[f64; 4]>,
    pub accelerometer: Vec<Option<[f64; 3]>>,
    pub gyroscope: Vec<Option<[f64; 3]>>,
}

/// `watch.sensor_batch` payload: the motion and pulse samples of one flush, either of which may be absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSensorBatchPayload {
    #[serde(default)]
    pub imu: Option<WatchImuBatchPayload>,
    /// The motion samples packed as binary (see [`decode_packed_imu`]), in place of `imu`: about 60 bytes a sample against
    /// about 140 as JSON numbers, which leaves room on a Bluetooth link for the motion sensors at up to 200 Hz.
    #[serde(default)]
    pub imu_packed: Option<String>,
    #[serde(default)]
    pub ppg: Option<WatchPpgBatchPayload>,
}

/// The version of the packed motion layout this desktop reads.
pub const PACKED_IMU_VERSION: u8 = 1;
const PACKED_IMU_HEADER: usize = 1 + 2 + 8;
const PACKED_IMU_SAMPLE: usize = 4 + 1 + 10 * 4;

/// Decodes `imuPacked`: standard base64 of, little-endian,
///
/// ```text
/// u8 version (1)  u16 count  i64 first timestamp (ns, watch clock)
/// per sample:  u32 ns after the first  u8 flags (bit 0 accelerometer, bit 1 gyroscope)
///              f32 quaternion w x y z  f32 accelerometer x y z  f32 gyroscope x y z  (an absent sensor's are 0)
/// ```
///
/// The values are the sensors' own single-precision floats, so nothing is lost against the JSON numbers.
pub fn decode_packed_imu(
    text: &str,
    device_id: &str,
    sequence: u64,
) -> Result<Vec<WatchOrientationSample>, WatchPacketError> {
    let bad = |detail: &str| WatchPacketError::InvalidSensorBatch(format!("packed motion: {detail}"));
    let bytes = base64_decode(text).ok_or_else(|| bad("not base64"))?;
    if bytes.len() < PACKED_IMU_HEADER || bytes[0] != PACKED_IMU_VERSION {
        return Err(bad("unknown layout"));
    }
    let count = u16::from_le_bytes([bytes[1], bytes[2]]) as usize;
    if count == 0 || count > MAX_IMU_BATCH_SAMPLES {
        return Err(bad(&format!("sampleCount {count} is outside 1..={MAX_IMU_BATCH_SAMPLES}")));
    }
    if bytes.len() != PACKED_IMU_HEADER + count * PACKED_IMU_SAMPLE {
        return Err(bad("its length does not match its sample count"));
    }
    let first = i64::from_le_bytes(bytes[3..11].try_into().expect("8 bytes"));
    let first = u64::try_from(first).map_err(|_| bad("a negative timestamp"))?;
    let f32_at = |at: usize| f64::from(f32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes")));
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let at = PACKED_IMU_HEADER + index * PACKED_IMU_SAMPLE;
        let offset = u32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"));
        let flags = bytes[at + 4];
        let value = |k: usize| f32_at(at + 5 + k * 4);
        let three = |from: usize| [value(from), value(from + 1), value(from + 2)];
        out.push(WatchOrientationSample {
            device_id: device_id.to_string(),
            sequence,
            timestamp_ns: first + u64::from(offset),
            quaternion: [value(0), value(1), value(2), value(3)],
            accelerometer: (flags & 1 != 0).then(|| three(4)),
            gyroscope: (flags & 2 != 0).then(|| three(7)),
        });
    }
    Ok(out)
}

/// Standard base64 (with or without padding); `None` for anything else.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let digits: Vec<u8> = text.trim_end_matches('=').bytes().collect();
    if digits.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let mut word = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            word |= value(c)? << (18 - 6 * i);
        }
        let bytes = word.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

/// A decoded `watch.sensor_batch`: each motion sample as the orientation sample it would have been on its
/// own (with its own timestamp), and the pulse samples as the batch they would have been.
#[derive(Debug, Clone, PartialEq)]
pub struct WatchSensorBatch {
    pub orientations: Vec<WatchOrientationSample>,
    pub ppg: Option<WatchPpgBatchSample>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPpgBatchSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub green: Vec<i32>,
    pub green_status: Vec<i32>,
    pub red: Vec<i32>,
    pub red_status: Vec<i32>,
    pub ir: Vec<i32>,
    pub ir_status: Vec<i32>,
}

/// `watch.ppg_status` payload: the watch's `PpgCollector` state, one of
/// [`PPG_STATES`]. Distinct from the WebSocket `ConnectionState` — the watch
/// can be connected to the desktop with PPG unavailable or awaiting the
/// Samsung Health permission grant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPpgStatusPayload {
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPpgStatusSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub state: String,
}

/// `watch.wear_state` payload: `worn` is the watch's off-body detector, `true` on a wrist.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchWearStatePayload {
    pub worn: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchWearStateSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub worn: bool,
}

// --- Medical tracker payloads/samples ---
//
// Field units and types below are read from the Samsung Health Sensor SDK
// 1.4.1 AAR's `ValueKey` generic signatures (`HeartRateSet`, `SkinTemperatureSet`,
// `EdaSet`, `SpO2Set`, `EcgSet`, `BiaSet`, `SweatLossSet`); the SDK's own
// programming-guide/api-reference docs are a JS single-page app with no
// static HTML, so unit names (e.g. `ECG_MV` implying millivolts) are taken
// from the SDK's own field names, not independently confirmed against prose
// documentation.

/// One `watch.heart_rate_batch` payload: `HEART_RATE_CONTINUOUS`, gated the
/// same way as `PPG_CONTINUOUS` (see [`WatchPpgBatchPayload`]). `ibiMs`/
/// `ibiStatus` are per-sample lists (a `HEART_RATE_CONTINUOUS` `DataPoint`
/// can carry more than one inter-beat interval).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHeartRateBatchPayload {
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub heart_rate: Vec<i32>,
    pub heart_rate_status: Vec<i32>,
    pub ibi_ms: Vec<Vec<i32>>,
    pub ibi_status: Vec<Vec<i32>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHeartRateBatchSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub heart_rate: Vec<i32>,
    pub heart_rate_status: Vec<i32>,
    pub ibi_ms: Vec<Vec<i32>>,
    pub ibi_status: Vec<Vec<i32>>,
}

/// One `watch.skin_temperature_batch` payload: `SKIN_TEMPERATURE_CONTINUOUS`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSkinTemperatureBatchPayload {
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub object_temperature_celsius: Vec<f64>,
    pub ambient_temperature_celsius: Vec<f64>,
    pub status: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSkinTemperatureBatchSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub object_temperature_celsius: Vec<f64>,
    pub ambient_temperature_celsius: Vec<f64>,
    pub status: Vec<i32>,
}

/// One `watch.eda_batch` payload: `EDA_CONTINUOUS` (electrodermal
/// activity/skin conductance). Not available on all Galaxy Watch models —
/// see `watch.medical_status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEdaBatchPayload {
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub skin_conductance_microsiemens: Vec<f64>,
    pub status: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEdaBatchSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub skin_conductance_microsiemens: Vec<f64>,
    pub status: Vec<i32>,
}

/// One `watch.spo2_batch` payload: `SPO2_ON_DEMAND`, a bounded on-demand
/// measurement session (see [`ON_DEMAND_MEDICAL_TRACKER_IDS`]) — never
/// continuous. `spo2` is a percentage (0-100); this is a wellness reading
/// from the Samsung Health Sensor SDK, not a diagnostic pulse oximeter
/// measurement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSpo2BatchPayload {
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub spo2: Vec<i32>,
    pub heart_rate: Vec<i32>,
    pub accuracy_flag: Vec<i32>,
    pub status: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSpo2BatchSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub spo2: Vec<i32>,
    pub heart_rate: Vec<i32>,
    pub accuracy_flag: Vec<i32>,
    pub status: Vec<i32>,
}

/// One `watch.ecg_batch` payload: `ECG_ON_DEMAND`, a bounded on-demand
/// measurement session — never continuous. Not a diagnostic-grade ECG.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEcgBatchPayload {
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub ecg_millivolts: Vec<f64>,
    pub lead_off: Vec<i32>,
    pub sequence_numbers: Vec<i32>,
    pub max_threshold_millivolts: Vec<f64>,
    pub min_threshold_millivolts: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEcgBatchSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub ecg_millivolts: Vec<f64>,
    pub lead_off: Vec<i32>,
    pub sequence_numbers: Vec<i32>,
    pub max_threshold_millivolts: Vec<f64>,
    pub min_threshold_millivolts: Vec<f64>,
}

/// One `watch.bia_result` payload: `BIA_ON_DEMAND`, a single bounded
/// on-demand session (~tens of seconds) reported as it progresses rather
/// than batched — `progressPercent` climbs to 100 and the body-composition
/// fields are `null` until the SDK has computed them. Never continuous.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchBiaResultPayload {
    pub progress_percent: f64,
    pub status: i32,
    pub body_fat_ratio: Option<f64>,
    pub body_fat_mass_kg: Option<f64>,
    pub total_body_water_kg: Option<f64>,
    pub skeletal_muscle_ratio: Option<f64>,
    pub skeletal_muscle_mass_kg: Option<f64>,
    pub basal_metabolic_rate_kcal: Option<f64>,
    pub fat_free_ratio: Option<f64>,
    pub fat_free_mass_kg: Option<f64>,
    pub body_impedance_magnitude_ohm: Option<f64>,
    pub body_impedance_degree_deg: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchBiaResultSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub progress_percent: f64,
    pub status: i32,
    pub body_fat_ratio: Option<f64>,
    pub body_fat_mass_kg: Option<f64>,
    pub total_body_water_kg: Option<f64>,
    pub skeletal_muscle_ratio: Option<f64>,
    pub skeletal_muscle_mass_kg: Option<f64>,
    pub basal_metabolic_rate_kcal: Option<f64>,
    pub fat_free_ratio: Option<f64>,
    pub fat_free_mass_kg: Option<f64>,
    pub body_impedance_magnitude_ohm: Option<f64>,
    pub body_impedance_degree_deg: Option<f64>,
}

/// One `watch.sweat_loss_batch` payload: the `SWEAT_LOSS` tracker type. Despite
/// lacking an `_ON_DEMAND` suffix in the SDK's own `HealthTrackerType` enum,
/// it is exercise-session-scoped, not continuously available — treated the
/// same as the other on-demand trackers (see [`ON_DEMAND_MEDICAL_TRACKER_IDS`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSweatLossBatchPayload {
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub sweat_loss_milliliters: Vec<f64>,
    pub status: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSweatLossBatchSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sample_count: u32,
    pub timestamps_ns: Vec<u64>,
    pub sweat_loss_milliliters: Vec<f64>,
    pub status: Vec<i32>,
}

/// `watch.medical_status` payload: `tracker` is one of [`MEDICAL_TRACKER_IDS`],
/// `state` is one of [`MEDICAL_TRACKER_STATES`]. Sent for every supported
/// *and* unsupported medical tracker so the desktop can show honest
/// availability instead of guessing from silence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchMedicalStatusPayload {
    pub tracker: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchMedicalStatusSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub tracker: String,
    pub state: String,
}

/// `watch.sensor_status` payload: `sensor` is one of [`IMU_SENSOR_IDS`],
/// `enabled` reflects whether `SensorCollector` currently has that physical
/// sensor registered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSensorStatusPayload {
    pub sensor: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSensorStatusSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub sensor: String,
    pub enabled: bool,
}

/// `watch.button` payload: `button` identifies the physical key (currently
/// only [`STEM_PRIMARY_BUTTON_ID`]), `state` is one of [`BUTTON_STATES`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchButtonPayload {
    pub button: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchButtonSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub button: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchOrientationSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub quaternion: [f64; 4],
    pub accelerometer: Option<[f64; 3]>,
    pub gyroscope: Option<[f64; 3]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHeartbeatSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub battery_percent: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchTimeSyncSample {
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ns: u64,
    pub desktop_time_ns: u64,
    pub watch_time_ns: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WatchInboundMessage {
    Orientation(WatchOrientationSample),
    Heartbeat(WatchHeartbeatSample),
    TimeSync(WatchTimeSyncSample),
    PpgBatch(WatchPpgBatchSample),
    SensorBatch(WatchSensorBatch),
    PpgStatus(WatchPpgStatusSample),
    WearState(WatchWearStateSample),
    Button(WatchButtonSample),
    HeartRateBatch(WatchHeartRateBatchSample),
    SkinTemperatureBatch(WatchSkinTemperatureBatchSample),
    EdaBatch(WatchEdaBatchSample),
    Spo2Batch(WatchSpo2BatchSample),
    EcgBatch(WatchEcgBatchSample),
    BiaResult(WatchBiaResultSample),
    SweatLossBatch(WatchSweatLossBatchSample),
    MedicalStatus(WatchMedicalStatusSample),
    SensorStatus(WatchSensorStatusSample),
}

/// Generic desktop-to-watch envelope for `desktop.connected` / `desktop.time_sync`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOutboundEnvelope<T: Serialize> {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub version: u32,
    pub timestamp_ns: u64,
    pub payload: T,
}

impl<T: Serialize> DesktopOutboundEnvelope<T> {
    pub fn new(message_type: &'static str, timestamp_ns: u64, payload: T) -> Self {
        Self {
            message_type,
            version: WATCH_PROTOCOL_VERSION,
            timestamp_ns,
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConnectedPayload {
    pub session_id: String,
    pub server_time_ns: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTimeSyncPayload {
    pub desktop_time_ns: u64,
}

/// `desktop.start_measurement` / `desktop.stop_measurement` payload:
/// `tracker` must be one of [`ON_DEMAND_MEDICAL_TRACKER_IDS`]. Starts or ends
/// a bounded on-demand medical measurement session on the watch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMeasurementCommandPayload {
    pub tracker: String,
}

/// `desktop.set_sensor` payload: `sensor` must be one of
/// [`CONTROLLABLE_SENSOR_IDS`]. Enables or disables an IMU input or
/// continuous medical tracker in place, without tearing down the underlying
/// sensor connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSensorControlPayload {
    pub sensor: String,
    pub enabled: bool,
}

/// `desktop.set_sensor_rate` payload: `sensor` must be one of
/// [`RATE_CONTROLLABLE_SENSOR_IDS`]. IMU values request Android delivery rates;
/// `ppg_continuous` controls the existing `HealthTracker.flush()` schedule and
/// never overrides Samsung's physical sampling behavior. `rate_hz` must fall
/// within [`MIN_SENSOR_RATE_HZ`]..=[`MAX_SENSOR_RATE_HZ`]; `SensorCollector`
/// converts it to `samplingPeriodUs` and re-registers only that sensor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSensorRateCommandPayload {
    pub sensor: String,
    pub rate_hz: f64,
}

/// `desktop.haptic` payload: `duration_ms` must fall within
/// [`MIN_HAPTIC_DURATION_MS`]..=[`MAX_HAPTIC_DURATION_MS`].
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHapticPayload {
    pub duration_ms: u32,
}

#[cfg(test)]
mod sensor_batch_tests {
    use super::*;

    /// Two motion samples packed as the watch packs them (`WatchProtocol.packImu`; its test checks it gives exactly this):
    /// 20 ms apart, the second without a gyroscope reading.
    pub(crate) const PACKED_IMU_EXAMPLE: &str = "AQIAAM+YTm4zBwAAAAAAA87CVj9OmHC+PPQdvQuW+r4K6Jw8CuicOw9c6zx5IqA6eSIgPHkioDsALTEBAQAAgD8AAAAAAAAAAAAAAADNzMw9zcxMPpqZmT4AAAAAAAAAAAAAAAA=";

    #[test]
    fn packed_motion_reads_as_the_samples_it_holds() {
        let samples = decode_packed_imu(PACKED_IMU_EXAMPLE, "w", 9).unwrap();
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].timestamp_ns, 2_026_873_695_031_040);
        assert_eq!(samples[1].timestamp_ns, 2_026_873_715_031_040, "20 ms after the first");
        assert_eq!(samples[0].quaternion[0], f64::from(0.83891f32), "the sensor's own float, exactly");
        assert_eq!(samples[0].accelerometer.unwrap()[1], f64::from(0.0047884034f32));
        assert_eq!(samples[0].gyroscope.unwrap()[2], f64::from(0.004886922f32));
        assert_eq!(samples[1].accelerometer, Some([0.1f32, 0.2, 0.3].map(f64::from)));
        assert_eq!(samples[1].gyroscope, None, "a sensor that gave nothing is absent");
        assert_eq!((samples[1].device_id.as_str(), samples[1].sequence), ("w", 9));
    }

    #[test]
    fn a_sensor_batch_carries_packed_motion_in_place_of_the_json_lists() {
        let datagram = format!(
            r#"{{"type":"watch.sensor_batch","version":1,"deviceId":"w","sequence":4,"timestampNs":5,"payload":{{"imuPacked":"{PACKED_IMU_EXAMPLE}"}}}}"#
        );
        match decode(&datagram).unwrap() {
            WatchInboundMessage::SensorBatch(batch) => {
                assert_eq!(batch.orientations.len(), 2);
                assert!(batch.ppg.is_none());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn packed_motion_that_is_cut_short_or_not_base64_is_refused() {
        let bytes = base64_decode(PACKED_IMU_EXAMPLE).unwrap();
        assert_eq!(bytes.len(), 11 + 2 * 45);
        assert!(decode_packed_imu("not base64!", "w", 1).is_err());
        let short: String = PACKED_IMU_EXAMPLE.chars().take(40).collect();
        assert!(decode_packed_imu(&short, "w", 1).is_err());
    }

    fn decode(json: &str) -> Result<WatchInboundMessage, WatchPacketError> {
        WatchEnvelope::from_json(json.as_bytes())?.decode()
    }

    fn envelope(payload: &str) -> String {
        format!(
            r#"{{"type":"watch.sensor_batch","version":1,"deviceId":"w","sequence":5,"timestampNs":900,"payload":{payload}}}"#
        )
    }

    const IMU: &str = r#""imu":{"count":2,"timestampsNs":[100,120],"quaternion":[[1,0,0,0],[1,0,0,0]],"accelerometer":[[0,0,9.8],null],"gyroscope":[null,[0.1,0,0]]}"#;
    const PPG: &str = r#""ppg":{"sampleCount":1,"timestampsNs":[110],"green":[5],"greenStatus":[0],"red":[6],"redStatus":[0],"ir":[7],"irStatus":[0]}"#;

    #[test]
    fn splits_into_one_orientation_per_motion_sample_and_one_pulse_batch() {
        let message = decode(&envelope(&format!("{{{IMU},{PPG}}}"))).unwrap();
        let WatchInboundMessage::SensorBatch(batch) = message else {
            panic!("expected a sensor batch");
        };
        assert_eq!(batch.orientations.len(), 2);
        assert_eq!(batch.orientations[1].timestamp_ns, 120);
        assert_eq!(batch.orientations[0].accelerometer, Some([0.0, 0.0, 9.8]));
        assert_eq!(batch.orientations[1].accelerometer, None);
        assert_eq!(batch.orientations[0].gyroscope, None);
        let ppg = batch.ppg.unwrap();
        assert_eq!(
            (ppg.timestamps_ns, ppg.ir, ppg.timestamp_ns),
            (vec![110], vec![7], 900)
        );
    }

    #[test]
    fn either_half_may_be_missing_but_not_both() {
        assert!(decode(&envelope(&format!("{{{IMU}}}"))).is_ok());
        assert!(decode(&envelope(&format!("{{{PPG}}}"))).is_ok());
        assert!(matches!(
            decode(&envelope("{}")),
            Err(WatchPacketError::InvalidSensorBatch(_))
        ));
    }

    #[test]
    fn rejects_motion_arrays_that_disagree_with_the_count() {
        let short = r#"{"imu":{"count":2,"timestampsNs":[100],"quaternion":[[1,0,0,0],[1,0,0,0]],"accelerometer":[null,null],"gyroscope":[null,null]}}"#;
        assert!(matches!(
            decode(&envelope(short)),
            Err(WatchPacketError::InvalidSensorBatch(_))
        ));
        let zero = r#"{"imu":{"count":0,"timestampsNs":[],"quaternion":[],"accelerometer":[],"gyroscope":[]}}"#;
        assert!(decode(&envelope(zero)).is_err());
    }
}
