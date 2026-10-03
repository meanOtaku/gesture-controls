//! Live desktop-side telemetry fusion: attaches watch orientation to every PPG
//! window. Orientation and PPG arrive as independent, differently-paced
//! streams from the watch, so a PPG window is never blocked on a fresh
//! orientation sample: the last-known one is carried forward (like
//! `telemetryStore.ts`'s `lastKnownOrientationSample`), and the orientation
//! samples that arrived during the window's own span (desktop receive time)
//! travel with it, so the accel/gyro/quaternion statistics reflect in-window
//! motion as the training windows' do rather than one frozen snapshot.
//!
//! This approximates, and does not reproduce, the offline row model: training
//! windows are merged rows of both streams with per-channel carry-forward,
//! and the recorder's two watch clocks are not comparable (see the sensor
//! timing review, D-4). Only a trained bundle measured on hardware can
//! quantify the remaining gap.
//!
//! Freshness and identity are judged against the desktop's own monotonic
//! receive-time clock, supplied by the caller as `received_at_ns` -- never
//! against the watch's own envelope timestamps, which run on an unrelated,
//! unsynchronized device clock. This module never reads a clock itself.

use std::collections::VecDeque;

use spatial_protocol::{WatchOrientationSample, WatchPpgBatchSample};

use crate::features::{FusedWindow, OrientationSnapshot};

/// Beyond this much desktop receive-time elapsed since the last orientation
/// sample, a PPG window is fused with a pose that can no longer be trusted
/// to reflect the wrist's current attitude.
pub const ORIENTATION_STALENESS_TIMEOUT_NS: u64 = 500_000_000;

/// How much receive-time history of orientation samples is kept. A PPG
/// window only ever reaches back as far as its own batch span, so a couple of
/// seconds is ample; the cap bounds memory regardless of the sample rate.
const ORIENTATION_HISTORY_WINDOW_NS: u64 = 2_000_000_000;
const ORIENTATION_HISTORY_CAPACITY: usize = 512;

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
    /// Recent orientation samples (post carry-forward) with the desktop
    /// receive time of each, oldest first. Lets a PPG window's accel, gyro
    /// and quaternion statistics reflect the motion that happened during the
    /// window, as the training windows' do, instead of one frozen snapshot.
    history: VecDeque<(u64, OrientationSnapshot)>,
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
            history: VecDeque::new(),
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
        if self.orientation_device_id.as_deref() != Some(sample.device_id.as_str()) {
            // Another watch's samples must never be blended into this one's window.
            self.history.clear();
        }
        self.orientation_device_id = Some(sample.device_id.clone());
        self.orientation_received_at_ns = Some(received_at_ns);

        self.history.push_back((received_at_ns, self.orientation));
        let oldest_kept = received_at_ns.saturating_sub(ORIENTATION_HISTORY_WINDOW_NS);
        while self.history.len() > ORIENTATION_HISTORY_CAPACITY
            || self
                .history
                .front()
                .is_some_and(|(at, _)| *at < oldest_kept)
        {
            self.history.pop_front();
        }
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
        // The orientation samples that arrived during this PPG batch's span
        // (desktop receive time; the watch's two envelope clocks are not
        // comparable, see the module docs).
        let span_ns = match (sample.timestamps_ns.first(), sample.timestamps_ns.last()) {
            (Some(&first), Some(&last)) if last > first => last - first,
            _ => 0,
        };
        let window_start_ns = received_at_ns.saturating_sub(span_ns);
        let orientation_in_window: Vec<OrientationSnapshot> = self
            .history
            .iter()
            .filter(|(at, _)| *at >= window_start_ns && *at <= received_at_ns)
            .map(|(_, snapshot)| *snapshot)
            .collect();
        let all_finite = std::iter::once(&orientation)
            .chain(orientation_in_window.iter())
            .all(|snapshot| {
                snapshot
                    .accel
                    .iter()
                    .chain(snapshot.gyro.iter())
                    .chain(snapshot.quat.iter())
                    .all(|value| value.is_finite())
            });
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
            orientation_in_window,
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

    /// R-M2-1: a PPG window carries the orientation samples that arrived
    /// during its own span (desktop receive time), not just the latest one.
    #[test]
    fn fuse_ppg_window_collects_the_orientation_samples_inside_its_span() {
        let mut fusion = TelemetryFusion::default();
        // ppg_sample() spans 10 ms; the window is [received - 10 ms, received].
        let received = 1_000_000_000;
        for (offset_ms, x) in [(30u64, 1.0), (8, 2.0), (4, 3.0), (0, 4.0)] {
            fusion.observe_orientation(
                &orientation_sample(Some([x, 0.0, 0.0]), None, [1.0, 0.0, 0.0, 0.0]),
                received - offset_ms * 1_000_000,
            );
        }
        let window = fusion
            .fuse_ppg_window(&ppg_sample(), 0.0, received)
            .expect("fresh orientation must be accepted");
        let xs: Vec<f64> = window
            .orientation_in_window
            .iter()
            .map(|o| o.accel[0])
            .collect();
        assert_eq!(
            xs,
            vec![2.0, 3.0, 4.0],
            "the 30 ms-old sample is outside the window"
        );
        assert_eq!(window.orientation.accel, [4.0, 0.0, 0.0]);
    }

    #[test]
    fn orientation_history_is_bounded_and_dropped_when_the_device_changes() {
        let mut fusion = TelemetryFusion::default();
        for index in 0..(ORIENTATION_HISTORY_CAPACITY as u64 * 2) {
            fusion
                .observe_orientation(&orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]), index);
        }
        assert_eq!(fusion.history.len(), ORIENTATION_HISTORY_CAPACITY);

        let mut other = orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]);
        other.device_id = "watch-other".to_string();
        fusion.observe_orientation(&other, 10_000);
        assert_eq!(
            fusion.history.len(),
            1,
            "another watch's samples must not blend in"
        );
    }

    #[test]
    fn orientation_history_older_than_its_horizon_is_pruned() {
        let mut fusion = TelemetryFusion::default();
        fusion.observe_orientation(&orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]), 0);
        fusion.observe_orientation(
            &orientation_sample(None, None, [1.0, 0.0, 0.0, 0.0]),
            ORIENTATION_HISTORY_WINDOW_NS + 1,
        );
        assert_eq!(fusion.history.len(), 1);
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
