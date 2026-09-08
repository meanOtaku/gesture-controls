//! Live desktop-side telemetry fusion: carries the last-known watch
//! orientation sample forward onto every PPG window, mirroring
//! `telemetryStore.ts`'s `lastKnownOrientationSample` used by the dataset
//! recorder. Orientation and PPG arrive as independent, differently-paced
//! streams from the watch; this never blocks a PPG window on a fresh
//! orientation sample, since the model was trained against exactly this
//! carry-forward contract.
//!
//! Freshness and identity are judged against the desktop's own monotonic
//! receive-time clock, supplied by the caller as `received_at_ns` -- never
//! against the watch's own envelope timestamps, which run on an unrelated,
//! unsynchronized device clock. This module never reads a clock itself.

use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::features::{FusedWindow, OrientationSnapshot};

/// Beyond this much desktop receive-time elapsed since the last orientation
/// sample, a PPG window is fused with a pose that can no longer be trusted
/// to reflect the wrist's current attitude.
pub const ORIENTATION_STALENESS_TIMEOUT_NS: u64 = 500_000_000;

/// Why [`TelemetryFusion::fuse_ppg_window`] refused to produce a window.
/// Every variant means: emit no inference and forcibly release any
/// in-progress interaction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FusionRejection {
    /// No orientation sample has ever been observed for any device.
    OrientationNeverObserved,
    /// The carried-forward orientation came from a different watch device
    /// than the one that produced this PPG window.
    OrientationDeviceMismatch,
    /// The carried-forward orientation is older than
    /// [`ORIENTATION_STALENESS_TIMEOUT_NS`], measured on the desktop's own
    /// receive-time clock.
    OrientationStale { elapsed_ns: u64 },
    /// The carried-forward orientation contains a NaN/infinite component.
    NonFiniteOrientation,
    /// The PPG batch's own internal sample timestamps are not strictly
    /// increasing.
    NonMonotonicPpgTimestamps,
}

/// Desktop-only: the watch and headphones remain sensor-only sources (see
/// `docs/architecture/project-brief.md` Milestone 11) -- this fuses their raw
/// timestamped telemetry locally, it never runs on-device.
#[derive(Debug, Clone, PartialEq)]
pub struct TelemetryFusion {
    orientation: OrientationSnapshot,
    orientation_device_id: Option<String>,
    orientation_received_at_ns: Option<u64>,
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
            orientation_device_id: None,
            orientation_received_at_ns: None,
        }
    }
}

impl TelemetryFusion {
    /// Updates the carried-forward orientation snapshot. A sample missing
    /// accel or gyro (either is optional on the wire) leaves that channel's
    /// last known value untouched rather than zeroing it out. `received_at_ns`
    /// is the desktop's own monotonic receive-time clock, not the watch's
    /// envelope timestamp.
    pub fn observe_orientation(&mut self, sample: &WatchOrientationSample, received_at_ns: u64) {
        if let Some(accel) = sample.accelerometer {
            self.orientation.accel = accel;
        }
        if let Some(gyro) = sample.gyroscope {
            self.orientation.gyro = gyro;
        }
        self.orientation.quat = sample.quaternion;
        self.orientation_device_id = Some(sample.device_id.clone());
        self.orientation_received_at_ns = Some(received_at_ns);
    }

    /// Fuses one raw PPG batch with the current carried-forward orientation
    /// into a [`FusedWindow`] ready for [`crate::features::extract_features`].
    /// `contact_quality_mean` is passed in rather than recomputed here since
    /// callers (the sensor-quality gate) have already derived it once from
    /// the same batch. `received_at_ns` is the desktop's own monotonic
    /// receive-time clock for this PPG window, used only to judge orientation
    /// staleness -- never compared against any watch-sourced timestamp.
    pub fn fuse_ppg_window(
        &self,
        sample: &WatchPpgBatchSample,
        contact_quality_mean: f64,
        received_at_ns: u64,
    ) -> Result<FusedWindow, FusionRejection> {
        let Some(orientation_device_id) = self.orientation_device_id.as_deref() else {
            return Err(FusionRejection::OrientationNeverObserved);
        };
        if orientation_device_id != sample.device_id {
            return Err(FusionRejection::OrientationDeviceMismatch);
        }
        let observed_at_ns = self.orientation_received_at_ns.unwrap_or(received_at_ns);
        let elapsed_ns = received_at_ns.saturating_sub(observed_at_ns);
        if elapsed_ns >= ORIENTATION_STALENESS_TIMEOUT_NS {
            return Err(FusionRejection::OrientationStale { elapsed_ns });
        }
        let orientation = self.orientation;
        let all_finite = orientation
            .accel
            .iter()
            .chain(orientation.gyro.iter())
            .chain(orientation.quat.iter())
            .all(|value| value.is_finite());
        if !all_finite {
            return Err(FusionRejection::NonFiniteOrientation);
        }
        let strictly_increasing = sample
            .timestamps_ns
            .windows(2)
            .all(|pair| pair[1] > pair[0]);
        if !strictly_increasing {
            return Err(FusionRejection::NonMonotonicPpgTimestamps);
        }
        Ok(FusedWindow {
            ppg_green: sample.green.iter().map(|&value| value as f64).collect(),
            ppg_red: sample.red.iter().map(|&value| value as f64).collect(),
            ppg_ir: sample.ir.iter().map(|&value| value as f64).collect(),
            ppg_timestamps_ns: sample.timestamps_ns.clone(),
            orientation,
            contact_quality_mean,
        })
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

    fn fused_orientation(sample: &WatchOrientationSample, received_at_ns: u64) -> TelemetryFusion {
        let mut fusion = TelemetryFusion::default();
        fusion.observe_orientation(sample, received_at_ns);
        fusion
    }

    #[test]
    fn fuse_ppg_window_rejects_when_orientation_never_observed() {
        let fusion = TelemetryFusion::default();
        let result = fusion.fuse_ppg_window(&ppg_sample(), 0.0, 1_000_000_000);
        assert_eq!(result, Err(FusionRejection::OrientationNeverObserved));
    }

    #[test]
    fn observe_orientation_carries_forward_into_later_windows() {
        let fusion = fused_orientation(
            &orientation_sample(
                Some([1.0, 2.0, 3.0]),
                Some([0.1, 0.2, 0.3]),
                [0.0, 1.0, 0.0, 0.0],
            ),
            1_000_000_000,
        );
        let window = fusion
            .fuse_ppg_window(&ppg_sample(), 0.0, 1_000_000_001)
            .expect("fresh, matched-device orientation must be accepted");
        assert_eq!(window.orientation.accel, [1.0, 2.0, 3.0]);
        assert_eq!(window.orientation.gyro, [0.1, 0.2, 0.3]);
        assert_eq!(window.orientation.quat, [0.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn observe_orientation_missing_channel_keeps_previous_value() {
        let mut fusion = TelemetryFusion::default();
        fusion.observe_orientation(
            &orientation_sample(
                Some([1.0, 2.0, 3.0]),
                Some([0.1, 0.2, 0.3]),
                [0.0, 1.0, 0.0, 0.0],
            ),
            1_000_000_000,
        );
        // A sample with no accel/gyro payload must not zero out the carry.
        fusion.observe_orientation(
            &orientation_sample(None, None, [0.0, 0.0, 1.0, 0.0]),
            1_000_000_100,
        );
        let window = fusion
            .fuse_ppg_window(&ppg_sample(), 0.0, 1_000_000_200)
            .expect("carried-forward orientation must still be accepted");
        assert_eq!(window.orientation.accel, [1.0, 2.0, 3.0]);
        assert_eq!(window.orientation.gyro, [0.1, 0.2, 0.3]);
        assert_eq!(window.orientation.quat, [0.0, 0.0, 1.0, 0.0]);
    }

    #[test]
    fn fuse_ppg_window_copies_channel_arrays_and_quality() {
        let fusion = fused_orientation(&orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]), 0);
        let window = fusion
            .fuse_ppg_window(&ppg_sample(), 0.5, 1)
            .expect("valid window must be accepted");
        assert_eq!(window.ppg_green, vec![1.0, 2.0]);
        assert_eq!(window.ppg_red, vec![3.0, 4.0]);
        assert_eq!(window.ppg_ir, vec![5.0, 6.0]);
        assert_eq!(window.ppg_timestamps_ns, vec![0, 10_000_000]);
        assert_eq!(window.contact_quality_mean, 0.5);
    }

    #[test]
    fn fuse_ppg_window_rejects_stale_orientation() {
        let fusion = fused_orientation(&orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]), 0);
        let result = fusion.fuse_ppg_window(&ppg_sample(), 0.0, ORIENTATION_STALENESS_TIMEOUT_NS);
        assert_eq!(
            result,
            Err(FusionRejection::OrientationStale {
                elapsed_ns: ORIENTATION_STALENESS_TIMEOUT_NS
            })
        );
    }

    #[test]
    fn fuse_ppg_window_accepts_orientation_just_under_staleness_timeout() {
        let fusion = fused_orientation(&orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]), 0);
        let result =
            fusion.fuse_ppg_window(&ppg_sample(), 0.0, ORIENTATION_STALENESS_TIMEOUT_NS - 1);
        assert!(result.is_ok());
    }

    #[test]
    fn fuse_ppg_window_rejects_mismatched_device_orientation() {
        let mut orientation = orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]);
        orientation.device_id = "watch-other".to_string();
        let fusion = fused_orientation(&orientation, 0);
        let result = fusion.fuse_ppg_window(&ppg_sample(), 0.0, 1);
        assert_eq!(result, Err(FusionRejection::OrientationDeviceMismatch));
    }

    #[test]
    fn fuse_ppg_window_rejects_non_finite_orientation() {
        let fusion = fused_orientation(
            &orientation_sample(None, None, [f64::NAN, 0.0, 0.0, 0.0]),
            0,
        );
        let result = fusion.fuse_ppg_window(&ppg_sample(), 0.0, 1);
        assert_eq!(result, Err(FusionRejection::NonFiniteOrientation));
    }

    #[test]
    fn fuse_ppg_window_rejects_non_monotonic_ppg_timestamps() {
        let fusion = fused_orientation(&orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]), 0);
        let mut sample = ppg_sample();
        sample.timestamps_ns = vec![10_000_000, 0];
        let result = fusion.fuse_ppg_window(&sample, 0.0, 1);
        assert_eq!(result, Err(FusionRejection::NonMonotonicPpgTimestamps));
    }
}
