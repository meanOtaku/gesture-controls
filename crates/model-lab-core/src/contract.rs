use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContractError {
    #[error("choose at least one input stream")]
    NoSources,
    #[error("an input stream is listed twice")]
    DuplicateSource,
    #[error("choose at least one feature")]
    NoFeatures,
    #[error("a feature name is empty, too long or listed twice")]
    BadFeature,
    #[error("{0}")]
    OutOfRange(String),
    #[error("{0}")]
    BadThreshold(String),
}

/// A stream of data a model can be fed. Which of these a model reads is declared in its input contract, so the
/// runtime routes only what is asked for and nothing else is windowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamSource {
    WatchOrientation,
    WatchAcceleration,
    WatchGyroscope,
    WatchPpg,
    HeadPose,
}

/// Exactly what a model reads and how: the streams, the ordered feature names, and the window they are computed over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputContract {
    pub sources: Vec<StreamSource>,
    /// Ordered: position *n* is input *n* of the model.
    pub features: Vec<String>,
    pub window_ms: u32,
    pub stride_ms: u32,
    /// A gap in the telemetry longer than this rejects the window.
    pub max_gap_ms: u32,
    pub min_samples: u32,
}

impl InputContract {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.sources.is_empty() {
            return Err(ContractError::NoSources);
        }
        if self.sources.iter().collect::<BTreeSet<_>>().len() != self.sources.len() {
            return Err(ContractError::DuplicateSource);
        }
        if self.features.is_empty() {
            return Err(ContractError::NoFeatures);
        }
        let unique: BTreeSet<&String> = self.features.iter().collect();
        if unique.len() != self.features.len()
            || self
                .features
                .iter()
                .any(|f| f.is_empty() || f.len() > 96 || f.chars().any(char::is_control))
        {
            return Err(ContractError::BadFeature);
        }
        let in_range = |name: &str, value: u32, min: u32, max: u32| {
            if (min..=max).contains(&value) {
                Ok(())
            } else {
                Err(ContractError::OutOfRange(format!(
                    "{name} must be from {min} to {max}, got {value}"
                )))
            }
        };
        in_range("windowMs", self.window_ms, 50, 10_000)?;
        in_range("strideMs", self.stride_ms, 10, 10_000)?;
        in_range("maxGapMs", self.max_gap_ms, 1, 10_000)?;
        in_range("minSamples", self.min_samples, 1, 10_000)?;
        if self.stride_ms > self.window_ms {
            return Err(ContractError::OutOfRange(
                "strideMs must not exceed windowMs, or samples would be skipped".into(),
            ));
        }
        Ok(())
    }
}

/// When a score turns into a detection: it starts when it reaches `activation`, ends when it falls to `release`
/// (never above activation, which gives the hysteresis), and `debounce_ms` and `cooldown_ms` bound how fast it can
/// flip and how soon it can start again.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    pub activation: f64,
    pub release: f64,
    pub debounce_ms: u32,
    pub cooldown_ms: u32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            activation: 0.8,
            release: 0.6,
            debounce_ms: 0,
            cooldown_ms: 0,
        }
    }
}

impl Thresholds {
    pub fn validate(&self) -> Result<(), ContractError> {
        for (name, value) in [("activation", self.activation), ("release", self.release)] {
            if !(value.is_finite() && value > 0.0 && value <= 1.0) {
                return Err(ContractError::BadThreshold(format!(
                    "{name} must be in (0, 1], got {value}"
                )));
            }
        }
        if self.release > self.activation {
            return Err(ContractError::BadThreshold(
                "release must not be above activation, or a detection could end before it starts"
                    .into(),
            ));
        }
        if self.debounce_ms > 10_000 || self.cooldown_ms > 60_000 {
            return Err(ContractError::BadThreshold(
                "debounce and cooldown are too long".into(),
            ));
        }
        Ok(())
    }
}

/// Gates a window before a model sees it. `max_contact_quality` is a defect code: lower is better.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityRules {
    pub max_contact_quality: f64,
    pub min_sample_count: u32,
}

impl Default for QualityRules {
    fn default() -> Self {
        Self {
            max_contact_quality: 0.0,
            min_sample_count: 3,
        }
    }
}

impl QualityRules {
    pub fn validate(&self) -> Result<(), ContractError> {
        if !self.max_contact_quality.is_finite() || self.min_sample_count == 0 {
            return Err(ContractError::BadThreshold(
                "quality rules need a finite contact quality and at least one sample".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrainerBackend {
    ScikitLearn,
    Keras,
    PyTorch,
    /// A model built elsewhere and imported as a validated bundle; nothing is trained.
    ExternalImport,
}

/// A trainer and its settings. The settings are the trainer's own and opaque here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainerConfig {
    pub backend: TrainerBackend,
    #[serde(default)]
    pub params: BTreeMap<String, serde_json::Value>,
}
