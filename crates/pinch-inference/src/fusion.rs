//! Live desktop-side telemetry fusion: carries the last-known watch
//! orientation sample forward onto every PPG window, mirroring
//! `telemetryStore.ts`'s `lastKnownOrientationSample` used by the dataset
//! recorder. Orientation and PPG arrive as independent, differently-paced
//! streams from the watch; this never blocks a PPG window on a fresh
//! orientation sample, since the model was trained against exactly this
//! carry-forward contract.

use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::features::{FusedWindow, OrientationSnapshot};

/// Desktop-only: the watch and headphones remain sensor-only sources (see
/// `docs/architecture/project-brief.md` Milestone 11) -- this fuses their raw
/// timestamped telemetry locally, it never runs on-device.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TelemetryFusion {
    orientation: OrientationSnapshot,
}

impl Default for TelemetryFusion {
    fn default() -> Self {
        Self {
            // Identity quaternion (w, x, y, z), matching telemetryStore.ts's
            // pre-connection default before any orientation sample arrives.
            orientation: OrientationSnapshot {
                accel: [0.0; 3],
                gyro: [0.0; 3],
                quat: [1.0, 0.0, 0.0, 0.0],
            },
        }
    }
}

impl TelemetryFusion {
    /// Updates the carried-forward orientation snapshot. A sample missing
    /// accel or gyro (either is optional on the wire) leaves that channel's
    /// last known value untouched rather than zeroing it out.
    pub fn observe_orientation(&mut self, sample: &WatchOrientationSample) {
        if let Some(accel) = sample.accelerometer {
            self.orientation.accel = accel;
        }
        if let Some(gyro) = sample.gyroscope {
            self.orientation.gyro = gyro;
        }
        self.orientation.quat = sample.quaternion;
    }

    /// Fuses one raw PPG batch with the current carried-forward orientation
    /// into a [`FusedWindow`] ready for [`crate::features::extract_features`].
    /// `contact_quality_mean` is passed in rather than recomputed here since
    /// callers (the sensor-quality gate) have already derived it once from
    /// the same batch.
    pub fn fuse_ppg_window(
        &self,
        sample: &WatchPpgBatchSample,
        contact_quality_mean: f64,
    ) -> FusedWindow {
        FusedWindow {
            ppg_green: sample.green.iter().map(|&value| value as f64).collect(),
            ppg_red: sample.red.iter().map(|&value| value as f64).collect(),
            ppg_ir: sample.ir.iter().map(|&value| value as f64).collect(),
            ppg_timestamps_ns: sample.timestamps_ns.clone(),
            orientation: self.orientation,
            contact_quality_mean,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orientation_sample(
        accel: Option<[f64; 3]>,
        gyro: Option<[f64; 3]>,
        quat: [f64; 4],
    ) -> WatchOrientationSample {
        WatchOrientationSample {
            device_id: "watch-1".to_string(),
            sequence: 1,
            timestamp_ns: 1,
            quaternion: quat,
            accelerometer: accel,
            gyroscope: gyro,
        }
    }

    fn ppg_sample() -> WatchPpgBatchSample {
        WatchPpgBatchSample {
            device_id: "watch-1".to_string(),
            sequence: 1,
            timestamp_ns: 100,
            sample_count: 2,
            timestamps_ns: vec![0, 10_000_000],
            green: vec![1, 2],
            red: vec![3, 4],
            ir: vec![5, 6],
            green_status: vec![0, 0],
            red_status: vec![0, 0],
            ir_status: vec![0, 0],
        }
    }

    #[test]
    fn default_fusion_uses_identity_quaternion_and_zero_motion() {
        let fusion = TelemetryFusion::default();
        let window = fusion.fuse_ppg_window(&ppg_sample(), 0.0);
        assert_eq!(window.orientation.accel, [0.0; 3]);
        assert_eq!(window.orientation.gyro, [0.0; 3]);
        assert_eq!(window.orientation.quat, [1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn observe_orientation_carries_forward_into_later_windows() {
        let mut fusion = TelemetryFusion::default();
        fusion.observe_orientation(&orientation_sample(
            Some([1.0, 2.0, 3.0]),
            Some([0.1, 0.2, 0.3]),
            [0.0, 1.0, 0.0, 0.0],
        ));
        let window = fusion.fuse_ppg_window(&ppg_sample(), 0.0);
        assert_eq!(window.orientation.accel, [1.0, 2.0, 3.0]);
        assert_eq!(window.orientation.gyro, [0.1, 0.2, 0.3]);
        assert_eq!(window.orientation.quat, [0.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn observe_orientation_missing_channel_keeps_previous_value() {
        let mut fusion = TelemetryFusion::default();
        fusion.observe_orientation(&orientation_sample(
            Some([1.0, 2.0, 3.0]),
            Some([0.1, 0.2, 0.3]),
            [0.0, 1.0, 0.0, 0.0],
        ));
        // A sample with no accel/gyro payload must not zero out the carry.
        fusion.observe_orientation(&orientation_sample(None, None, [0.0, 0.0, 1.0, 0.0]));
        let window = fusion.fuse_ppg_window(&ppg_sample(), 0.0);
        assert_eq!(window.orientation.accel, [1.0, 2.0, 3.0]);
        assert_eq!(window.orientation.gyro, [0.1, 0.2, 0.3]);
        assert_eq!(window.orientation.quat, [0.0, 0.0, 1.0, 0.0]);
    }

    #[test]
    fn fuse_ppg_window_copies_channel_arrays_and_quality() {
        let fusion = TelemetryFusion::default();
        let window = fusion.fuse_ppg_window(&ppg_sample(), 0.5);
        assert_eq!(window.ppg_green, vec![1.0, 2.0]);
        assert_eq!(window.ppg_red, vec![3.0, 4.0]);
        assert_eq!(window.ppg_ir, vec![5.0, 6.0]);
        assert_eq!(window.ppg_timestamps_ns, vec![0, 10_000_000]);
        assert_eq!(window.contact_quality_mean, 0.5);
    }
}
