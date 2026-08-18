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
pub const WATCH_PPG_STATUS_TYPE: &str = "watch.ppg_status";
pub const DESKTOP_CONNECTED_TYPE: &str = "desktop.connected";
pub const DESKTOP_TIME_SYNC_TYPE: &str = "desktop.time_sync";

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
    #[error("watch PPG status has an unknown state '{0}'")]
    UnknownPpgState(String),
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
    PpgStatus(WatchPpgStatusSample),
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
