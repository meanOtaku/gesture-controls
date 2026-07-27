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
