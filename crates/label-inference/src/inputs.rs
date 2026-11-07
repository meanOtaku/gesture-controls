//! The kinds of pinch-start model this app runs, and what each reads.
//!
//! * [`ModelKind::PpgImu`], which Model Lab trains by default: the pulse sensor's 1,701 features
//!   ([`pinch_inference::ppg_onset`]) and the motion sensors' 1,032 ([`pinch_inference::imu_onset`]), in that order, read by
//!   trees.
//! * [`ModelKind::CnnMedian`], which Model Lab can train instead: the last second of motion and pulse, each channel scaled
//!   by its recent median ([`pinch_inference::cnn_input`]), read by a small convolutional network ([`crate::cnn`]).
//! * [`ModelKind::Cnn`], the earlier CNN: the same network and inputs scaled by a rolling mean and deviation, which a burst
//!   of motion upsets for 10 s. Versions trained on it keep running as they were.
//! * [`ModelKind::PpgOnly`], the earlier model: the pulse sensor's features alone. Versions trained before the motion model
//!   keep running.
//!
//! A bundle says which it is by its preprocessing kind, and must then declare exactly that kind's sources and features.

use std::sync::LazyLock;

use model_lab_core::{InputContract, StreamSource};
use pinch_inference::cnn_input::{self, Scaling};
use pinch_inference::{imu_onset, ppg_onset};

use crate::bundle::{STRIDE_MS, WINDOW_MS};
use crate::training::MIN_WINDOW_SAMPLES;

pub const PPG_ONLY_PREPROCESSING: &str = "ppg_multiscale_onset";
pub const PPG_IMU_PREPROCESSING: &str = "ppg_imu_onset";
pub const CNN_PREPROCESSING: &str = "ppg_imu_cnn";
pub const CNN_MEDIAN_PREPROCESSING: &str = "ppg_imu_cnn_median";
/// The history a CNN decision reads: its grid of 10.96 s, rounded up.
pub const CNN_WINDOW_MS: u32 = 11_000;

static PPG_IMU_FEATURE_NAMES: LazyLock<Vec<String>> = LazyLock::new(|| {
    ppg_onset::FEATURE_NAMES
        .iter()
        .chain(imu_onset::FEATURE_NAMES.iter())
        .cloned()
        .collect()
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    PpgOnly,
    PpgImu,
    Cnn,
    CnnMedian,
}

impl ModelKind {
    /// The kind a bundle's preprocessing names, if this app runs it.
    pub fn from_preprocessing(kind: &str) -> Option<Self> {
        match kind {
            PPG_ONLY_PREPROCESSING => Some(Self::PpgOnly),
            PPG_IMU_PREPROCESSING => Some(Self::PpgImu),
            CNN_PREPROCESSING => Some(Self::Cnn),
            CNN_MEDIAN_PREPROCESSING => Some(Self::CnnMedian),
            _ => None,
        }
    }

    pub fn preprocessing(self) -> &'static str {
        match self {
            Self::PpgOnly => PPG_ONLY_PREPROCESSING,
            Self::PpgImu => PPG_IMU_PREPROCESSING,
            Self::Cnn => CNN_PREPROCESSING,
            Self::CnnMedian => CNN_MEDIAN_PREPROCESSING,
        }
    }

    /// The model file format a model of this kind is stored in (`crate::trees` or `crate::cnn`).
    pub fn model_format(self) -> &'static str {
        match self {
            Self::PpgOnly | Self::PpgImu => crate::bundle::MODEL_FORMAT,
            Self::Cnn | Self::CnnMedian => crate::bundle::CNN_MODEL_FORMAT,
        }
    }

    /// How a CNN's inputs are scaled; `None` for a model of trees.
    pub fn cnn_scaling(self) -> Option<Scaling> {
        match self {
            Self::PpgOnly | Self::PpgImu => None,
            Self::Cnn => Some(Scaling::Rolling),
            Self::CnnMedian => Some(Scaling::Median),
        }
    }

    /// Whether the model reads the motion sensors as well as the pulse.
    pub fn reads_motion(self) -> bool {
        self != Self::PpgOnly
    }

    pub fn sources(self) -> Vec<StreamSource> {
        match self {
            Self::PpgOnly => vec![StreamSource::WatchPpg],
            Self::PpgImu | Self::Cnn | Self::CnnMedian => {
                vec![StreamSource::WatchPpg, StreamSource::WatchOrientation]
            }
        }
    }

    pub fn feature_names(self) -> &'static [String] {
        match self {
            Self::PpgOnly => &ppg_onset::FEATURE_NAMES,
            Self::PpgImu => &PPG_IMU_FEATURE_NAMES,
            Self::Cnn | Self::CnnMedian => &cnn_input::FEATURE_NAMES,
        }
    }

    pub fn feature_count(self) -> usize {
        match self {
            Self::PpgOnly => ppg_onset::FEATURE_COUNT,
            Self::PpgImu => ppg_onset::FEATURE_COUNT + imu_onset::FEATURE_COUNT,
            Self::Cnn | Self::CnnMedian => cnn_input::FEATURE_COUNT,
        }
    }

    /// What a model of this kind reads: its sources and features, a decision every 40 ms from the pulse's last 5.6 s (the
    /// motion's 4.3 s lie inside it), or for the CNN the last 11 s of both. The trainer's manifest must declare exactly this.
    pub fn contract(self) -> InputContract {
        InputContract {
            sources: self.sources(),
            features: self.feature_names().to_vec(),
            window_ms: self.window_ms(),
            stride_ms: STRIDE_MS,
            max_gap_ms: ppg_onset::MAX_GAP_MS as u32,
            min_samples: MIN_WINDOW_SAMPLES,
        }
    }
}

impl ModelKind {
    /// How much history a decision reads.
    pub fn window_ms(self) -> u32 {
        match self {
            Self::PpgOnly | Self::PpgImu => WINDOW_MS,
            Self::Cnn | Self::CnnMedian => CNN_WINDOW_MS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_reads_its_own_sources_and_features() {
        assert_eq!(ModelKind::PpgImu.feature_count(), 2733);
        assert_eq!(ModelKind::PpgImu.feature_names().len(), 2733);
        assert_eq!(
            ModelKind::PpgImu.feature_names()[1701],
            "imu_accel_x_raw_n320ms_q10"
        );
        assert_eq!(
            ModelKind::PpgOnly.feature_names(),
            &ppg_onset::FEATURE_NAMES[..]
        );
        assert_eq!(ModelKind::Cnn.feature_count(), 450);
        assert_eq!(ModelKind::Cnn.feature_names()[0], "cnn_accel_x_t00");
        assert!(ModelKind::Cnn.reads_motion());
        assert_eq!(ModelKind::Cnn.contract().window_ms, 11_000);
        assert_eq!(
            ModelKind::CnnMedian.contract(),
            ModelKind::Cnn.contract(),
            "the kinds differ only in how they scale"
        );
        assert_eq!(ModelKind::Cnn.cnn_scaling(), Some(Scaling::Rolling));
        assert_eq!(ModelKind::CnnMedian.cnn_scaling(), Some(Scaling::Median));
        assert_eq!(ModelKind::PpgImu.cnn_scaling(), None);
        for kind in [
            ModelKind::PpgOnly,
            ModelKind::PpgImu,
            ModelKind::Cnn,
            ModelKind::CnnMedian,
        ] {
            assert_eq!(
                ModelKind::from_preprocessing(kind.preprocessing()),
                Some(kind)
            );
            kind.contract().validate().unwrap();
        }
        assert_eq!(ModelKind::from_preprocessing("spike_extraction"), None);
    }
}
