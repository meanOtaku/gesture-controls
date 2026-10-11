//! The window as a grid: one row per channel, the same number of steps in every row. This is what a convolutional model
//! reads. Mirrors `tools/label-trainer/src/label_trainer/grid.py`, which describes it in full; the shared cases in
//! `tools/label-trainer/tests/fixtures/grid_cases.json` keep the two equal.
//!
//! Each channel is turned into `steps` values: only samples that really arrived in the window are used; with a spike
//! extraction method a pulse channel is first replaced by what the method leaves of it; the samples are taken as evenly
//! spaced across the window and laid onto `steps` evenly spaced points by linear interpolation; a channel with no samples
//! is all zeros and one with a single sample is that value throughout.

use crate::features::{FusedWindow, SpikeMethod, extract_spike_series};

/// One channel of the grid, named like the CSV column it comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridChannel {
    PpgGreen,
    PpgRed,
    PpgIr,
    AccelX,
    AccelY,
    AccelZ,
    GyroX,
    GyroY,
    GyroZ,
    QuatW,
    QuatX,
    QuatY,
    QuatZ,
}

/// A dense model reading raw columns may take a single step (the latest reading of each column).
pub const MIN_GRID_STEPS: u32 = 1;
pub const MAX_GRID_STEPS: u32 = 256;

impl GridChannel {
    pub const ALL: [GridChannel; 13] = [
        GridChannel::PpgGreen,
        GridChannel::PpgRed,
        GridChannel::PpgIr,
        GridChannel::AccelX,
        GridChannel::AccelY,
        GridChannel::AccelZ,
        GridChannel::GyroX,
        GridChannel::GyroY,
        GridChannel::GyroZ,
        GridChannel::QuatW,
        GridChannel::QuatX,
        GridChannel::QuatY,
        GridChannel::QuatZ,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::PpgGreen => "ppg_green",
            Self::PpgRed => "ppg_red",
            Self::PpgIr => "ppg_ir",
            Self::AccelX => "accel_x",
            Self::AccelY => "accel_y",
            Self::AccelZ => "accel_z",
            Self::GyroX => "gyro_x",
            Self::GyroY => "gyro_y",
            Self::GyroZ => "gyro_z",
            Self::QuatW => "quat_w",
            Self::QuatX => "quat_x",
            Self::QuatY => "quat_y",
            Self::QuatZ => "quat_z",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|channel| channel.name() == name)
    }

    pub fn is_ppg(self) -> bool {
        matches!(self, Self::PpgGreen | Self::PpgRed | Self::PpgIr)
    }
}

/// `values` laid onto `steps` evenly spaced points by linear interpolation (first to first, last to last).
pub fn resample(values: &[f64], steps: usize) -> Vec<f64> {
    let n = values.len();
    if n == 0 {
        return vec![0.0; steps];
    }
    if steps == 1 || n == 1 {
        return vec![values[n - 1]; steps]; // one step is the latest reading
    }
    (0..steps)
        .map(|k| {
            let position = ((k * (n - 1)) as f64) / ((steps - 1) as f64);
            let low = (position as usize).min(n - 2);
            let fraction = position - low as f64;
            values[low] + (values[low + 1] - values[low]) * fraction
        })
        .collect()
}

/// The window as one flat row of `channels.len() * steps` numbers, channel after channel.
pub fn build_grid(
    window: &FusedWindow,
    channels: &[GridChannel],
    steps: usize,
    spike_method: Option<SpikeMethod>,
) -> Vec<f32> {
    let ppg_span_ms = match (
        window.ppg_timestamps_ns.first(),
        window.ppg_timestamps_ns.last(),
    ) {
        (Some(&first), Some(&last)) => (last as f64 - first as f64) / 1_000_000.0,
        _ => 0.0,
    };
    let motion = |select: &dyn Fn(&crate::features::OrientationSnapshot) -> f64| -> Vec<f64> {
        window.orientation_in_window.iter().map(select).collect()
    };
    let mut out = Vec::with_capacity(channels.len() * steps);
    for channel in channels {
        let series: Vec<f64> = match channel {
            GridChannel::PpgGreen | GridChannel::PpgRed | GridChannel::PpgIr => {
                let raw = match channel {
                    GridChannel::PpgGreen => &window.ppg_green,
                    GridChannel::PpgRed => &window.ppg_red,
                    _ => &window.ppg_ir,
                };
                match spike_method {
                    Some(method) if raw.len() >= 4 => {
                        extract_spike_series(method, raw, ppg_span_ms)
                    }
                    Some(_) => Vec::new(), // too short for the method to say anything
                    None => raw.clone(),
                }
            }
            GridChannel::AccelX => motion(&|s| s.accel[0]),
            GridChannel::AccelY => motion(&|s| s.accel[1]),
            GridChannel::AccelZ => motion(&|s| s.accel[2]),
            GridChannel::GyroX => motion(&|s| s.gyro[0]),
            GridChannel::GyroY => motion(&|s| s.gyro[1]),
            GridChannel::GyroZ => motion(&|s| s.gyro[2]),
            GridChannel::QuatW => motion(&|s| s.quat[0]),
            GridChannel::QuatX => motion(&|s| s.quat[1]),
            GridChannel::QuatY => motion(&|s| s.quat[2]),
            GridChannel::QuatZ => motion(&|s| s.quat[3]),
        };
        out.extend(resample(&series, steps).into_iter().map(|v| v as f32));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::OrientationSnapshot;

    #[test]
    fn resampling_keeps_the_ends_and_interpolates_between() {
        assert_eq!(resample(&[], 4), [0.0; 4]);
        assert_eq!(resample(&[7.0], 3), [7.0; 3]);
        assert_eq!(resample(&[0.0, 10.0], 5), [0.0, 2.5, 5.0, 7.5, 10.0]);
        assert_eq!(resample(&[1.0, 2.0, 4.0], 3), [1.0, 2.0, 4.0]); // as many steps as samples: unchanged
        assert_eq!(resample(&[1.0, 2.0, 4.0], 1), [4.0]); // one step is the latest reading
        assert_eq!(resample(&[], 1), [0.0]);
    }

    #[test]
    fn channel_names_round_trip() {
        for channel in GridChannel::ALL {
            assert_eq!(GridChannel::from_name(channel.name()), Some(channel));
        }
        assert_eq!(GridChannel::from_name("contact_quality"), None);
    }

    #[test]
    fn a_window_becomes_channels_one_after_another() {
        let still = OrientationSnapshot {
            accel: [0.0; 3],
            gyro: [0.0; 3],
            quat: [1.0, 0.0, 0.0, 0.0],
        };
        let window = FusedWindow {
            ppg_green: vec![1.0, 2.0, 3.0, 4.0],
            ppg_red: vec![],
            ppg_ir: vec![],
            ppg_timestamps_ns: vec![0, 1, 2, 3],
            orientation: still,
            orientation_in_window: vec![
                OrientationSnapshot {
                    accel: [1.0, 2.0, 3.0],
                    ..still
                },
                OrientationSnapshot {
                    accel: [3.0, 4.0, 5.0],
                    ..still
                },
            ],
            contact_quality_mean: 0.0,
            baseline: None,
        };
        let grid = build_grid(
            &window,
            &[
                GridChannel::PpgGreen,
                GridChannel::PpgRed,
                GridChannel::AccelX,
            ],
            4,
            None,
        );
        assert_eq!(grid.len(), 12);
        assert_eq!(&grid[0..4], [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(&grid[4..8], [0.0; 4]); // no red samples
        assert_eq!(
            &grid[8..12],
            [1.0, 1.0 + 2.0 / 3.0, 1.0 + 4.0 / 3.0, 3.0].map(|v: f64| v as f32)
        );
    }

    /// The same cases the trainer's tests check (`tools/label-trainer/tests/fixtures/grid_cases.json`): the grid made here
    /// must equal the one it makes, or a convolutional model trained there would see different numbers live.
    #[test]
    fn grids_match_the_trainer_on_the_shared_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tools/label-trainer/tests/fixtures/grid_cases.json"
        ))
        .unwrap();
        let order: Vec<&str> = fixture["channelOrder"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let known: Vec<&str> = GridChannel::ALL.iter().map(|c| c.name()).collect();
        assert_eq!(
            order, known,
            "the trainer and the runtime list the same channels"
        );
        let numbers = |value: &serde_json::Value| -> Vec<f64> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_f64().unwrap())
                .collect()
        };
        let triple = |value: &serde_json::Value| -> [f64; 3] {
            let v = numbers(value);
            [v[0], v[1], v[2]]
        };
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 12);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let ppg = &case["ppg"];
            let window = FusedWindow {
                ppg_green: numbers(&ppg["green"]),
                ppg_red: numbers(&ppg["red"]),
                ppg_ir: numbers(&ppg["ir"]),
                ppg_timestamps_ns: ppg["timestampsNs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap())
                    .collect(),
                orientation: OrientationSnapshot {
                    accel: [0.0; 3],
                    gyro: [0.0; 3],
                    quat: [1.0, 0.0, 0.0, 0.0],
                },
                orientation_in_window: case["orientation"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| {
                        let q = numbers(&s["quat"]);
                        OrientationSnapshot {
                            accel: triple(&s["accel"]),
                            gyro: triple(&s["gyro"]),
                            quat: [q[0], q[1], q[2], q[3]],
                        }
                    })
                    .collect(),
                contact_quality_mean: 0.0,
                baseline: None,
            };
            let channels: Vec<GridChannel> = case["channels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| GridChannel::from_name(c.as_str().unwrap()).unwrap())
                .collect();
            let method = case["method"]
                .as_str()
                .map(|m| SpikeMethod::from_name(m).unwrap());
            let steps = case["steps"].as_u64().unwrap() as usize;
            let got = build_grid(&window, &channels, steps, method);
            let want = numbers(&case["expected"]);
            assert_eq!(got.len(), want.len(), "{name}");
            for (i, (g, w)) in got.iter().zip(&want).enumerate() {
                // The runtime works in single precision; the trainer's numbers are double.
                let tolerance = 1e-6 * (1.0 + w.abs());
                assert!(
                    ((*g as f64) - w).abs() <= tolerance,
                    "{name}[{i}]: {g} vs {w}"
                );
            }
        }
    }
}
