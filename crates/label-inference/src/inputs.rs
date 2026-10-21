//! The two kinds of pinch-start model this app runs, and what each reads.
//!
//! * [`ModelKind::PpgImu`], which Model Lab trains: the pulse sensor's 1,701 features ([`pinch_inference::ppg_onset`]) and
//!   the motion sensors' 1,032 ([`pinch_inference::imu_onset`]), in that order.
//! * [`ModelKind::PpgOnly`], the earlier model: the pulse sensor's features alone. Versions trained before the motion model
//!   keep running.
//!
//! A bundle says which it is by its preprocessing kind, and must then declare exactly that kind's sources and features.

use std::sync::LazyLock;

use model_lab_core::{InputContract, StreamSource};
use pinch_inference::{imu_onset, ppg_onset};

use crate::bundle::{STRIDE_MS, WINDOW_MS};
use crate::training::MIN_WINDOW_SAMPLES;

pub const PPG_ONLY_PREPROCESSING: &str = "ppg_multiscale_onset";
pub const PPG_IMU_PREPROCESSING: &str = "ppg_imu_onset";

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
}

impl ModelKind {
    /// The kind a bundle's preprocessing names, if this app runs it.
    pub fn from_preprocessing(kind: &str) -> Option<Self> {
        match kind {
            PPG_ONLY_PREPROCESSING => Some(Self::PpgOnly),
            PPG_IMU_PREPROCESSING => Some(Self::PpgImu),
            _ => None,
        }
    }

    pub fn preprocessing(self) -> &'static str {
        match self {
            Self::PpgOnly => PPG_ONLY_PREPROCESSING,
            Self::PpgImu => PPG_IMU_PREPROCESSING,
        }
    }

    /// Whether the model reads the motion sensors as well as the pulse.
    pub fn reads_motion(self) -> bool {
        self == Self::PpgImu
    }

    pub fn sources(self) -> Vec<StreamSource> {
        match self {
            Self::PpgOnly => vec![StreamSource::WatchPpg],
            Self::PpgImu => vec![StreamSource::WatchPpg, StreamSource::WatchOrientation],
        }
    }

    pub fn feature_names(self) -> &'static [String] {
        match self {
            Self::PpgOnly => &ppg_onset::FEATURE_NAMES,
            Self::PpgImu => &PPG_IMU_FEATURE_NAMES,
        }
    }

    pub fn feature_count(self) -> usize {
        match self {
            Self::PpgOnly => ppg_onset::FEATURE_COUNT,
            Self::PpgImu => ppg_onset::FEATURE_COUNT + imu_onset::FEATURE_COUNT,
        }
    }

    /// What a model of this kind reads: its sources and features, a decision every 40 ms from the pulse's last 5.6 s (the
    /// motion's 4.3 s lie inside it). The trainer's manifest must declare exactly this.
    pub fn contract(self) -> InputContract {
        InputContract {
            sources: self.sources(),
            features: self.feature_names().to_vec(),
            window_ms: WINDOW_MS,
            stride_ms: STRIDE_MS,
            max_gap_ms: ppg_onset::MAX_GAP_MS as u32,
            min_samples: MIN_WINDOW_SAMPLES,
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
        for kind in [ModelKind::PpgOnly, ModelKind::PpgImu] {
            assert_eq!(
                ModelKind::from_preprocessing(kind.preprocessing()),
                Some(kind)
            );
            kind.contract().validate().unwrap();
        }
        assert_eq!(ModelKind::from_preprocessing("spike_extraction"), None);
    }
}
