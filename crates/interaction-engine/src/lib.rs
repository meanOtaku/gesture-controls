//! Calibration and interaction state for head-directed targets.

use std::time::Duration;

use nalgebra::Quaternion;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum CalibrationError {
    #[error("quaternion must contain finite values and have non-zero length")]
    InvalidQuaternion,
    #[error("activation threshold must be within (0, 180] degrees and dwell must be positive")]
    InvalidConfiguration,
}

fn normalized_quaternion(value: [f64; 4]) -> Result<Quaternion<f64>, CalibrationError> {
    if !value.iter().all(|component| component.is_finite()) {
        return Err(CalibrationError::InvalidQuaternion);
    }
    let quaternion = Quaternion::new(value[0], value[1], value[2], value[3]);
    let norm = quaternion.norm();
    if norm <= 1e-12 {
        return Err(CalibrationError::InvalidQuaternion);
    }
    Ok(quaternion / norm)
}

pub fn quaternion_angular_distance(
    left: [f64; 4],
    right: [f64; 4],
) -> Result<f64, CalibrationError> {
    let left = normalized_quaternion(left)?;
    let right = normalized_quaternion(right)?;
    let dot = left.coords.dot(&right.coords).abs().clamp(0.0, 1.0);
    Ok(2.0 * dot.acos())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalibrationTarget {
    Center,
    TopRight,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CalibrationEvent {
    TargetEntered(CalibrationTarget),
    TargetExited(CalibrationTarget),
}

#[derive(Debug, Clone, Copy)]
pub struct CalibrationConfig {
    pub activation_threshold_degrees: f64,
    pub dwell: Duration,
}

impl Default for CalibrationConfig {
    fn default() -> Self {
        Self {
            activation_threshold_degrees: 12.0,
            dwell: Duration::from_millis(400),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationState {
    pub center_calibrated: bool,
    pub top_right_calibrated: bool,
    pub requires_recalibration: bool,
    pub activation_threshold_degrees: f64,
    pub dwell_ms: u64,
    pub active_target: Option<CalibrationTarget>,
}

#[derive(Debug)]
pub struct HeadCalibration {
    config: CalibrationConfig,
    center: Option<[f64; 4]>,
    top_right: Option<[f64; 4]>,
    candidate: Option<(CalibrationTarget, Duration)>,
    active: Option<CalibrationTarget>,
    requires_recalibration: bool,
}

impl Default for HeadCalibration {
    fn default() -> Self {
        Self::new(CalibrationConfig::default()).expect("default calibration config is valid")
    }
}

impl HeadCalibration {
    pub fn new(config: CalibrationConfig) -> Result<Self, CalibrationError> {
        validate_config(config)?;
        Ok(Self {
            config,
            center: None,
            top_right: None,
            candidate: None,
            active: None,
            requires_recalibration: true,
        })
    }

    pub fn capture(
        &mut self,
        target: CalibrationTarget,
        quaternion: [f64; 4],
    ) -> Result<Vec<CalibrationEvent>, CalibrationError> {
        let quaternion = normalized_quaternion(quaternion)?;
        let value = [quaternion.w, quaternion.i, quaternion.j, quaternion.k];
        let events = self.deactivate();
        match target {
            CalibrationTarget::Center => self.center = Some(value),
            CalibrationTarget::TopRight => self.top_right = Some(value),
        }
        self.candidate = None;
        self.requires_recalibration = !(self.center.is_some() && self.top_right.is_some());
        Ok(events)
    }

    pub fn update_config(
        &mut self,
        activation_threshold_degrees: f64,
        dwell_ms: u64,
    ) -> Result<(), CalibrationError> {
        let config = CalibrationConfig {
            activation_threshold_degrees,
            dwell: Duration::from_millis(dwell_ms),
        };
        validate_config(config)?;
        self.config = config;
        self.candidate = None;
        Ok(())
    }

    pub fn observe(
        &mut self,
        quaternion: [f64; 4],
        now: Duration,
    ) -> Result<Vec<CalibrationEvent>, CalibrationError> {
        let Some(nearest) = self.nearest_target(quaternion)? else {
            return Ok(Vec::new());
        };
        let mut events = Vec::new();
        if nearest.1.to_degrees() > self.config.activation_threshold_degrees {
            self.candidate = None;
            if let Some(active) = self.active.take() {
                events.push(CalibrationEvent::TargetExited(active));
            }
            return Ok(events);
        }

        if self.active == Some(nearest.0) {
            self.candidate = None;
            return Ok(events);
        }
        if let Some(active) = self.active.take() {
            events.push(CalibrationEvent::TargetExited(active));
        }

        let started = match self.candidate {
            Some((target, started)) if target == nearest.0 => started,
            _ => {
                self.candidate = Some((nearest.0, now));
                return Ok(events);
            }
        };
        if now.saturating_sub(started) >= self.config.dwell {
            self.candidate = None;
            self.active = Some(nearest.0);
            events.push(CalibrationEvent::TargetEntered(nearest.0));
        }
        Ok(events)
    }

    pub fn deactivate(&mut self) -> Vec<CalibrationEvent> {
        self.candidate = None;
        self.active
            .take()
            .map(CalibrationEvent::TargetExited)
            .into_iter()
            .collect()
    }

    pub fn invalidate(&mut self) -> Vec<CalibrationEvent> {
        let events = self.deactivate();
        self.center = None;
        self.top_right = None;
        self.candidate = None;
        self.requires_recalibration = true;
        events
    }

    pub fn state(&self) -> CalibrationState {
        CalibrationState {
            center_calibrated: self.center.is_some(),
            top_right_calibrated: self.top_right.is_some(),
            requires_recalibration: self.requires_recalibration,
            activation_threshold_degrees: self.config.activation_threshold_degrees,
            dwell_ms: self.config.dwell.as_millis().min(u64::MAX as u128) as u64,
            active_target: self.active,
        }
    }

    fn nearest_target(
        &self,
        quaternion: [f64; 4],
    ) -> Result<Option<(CalibrationTarget, f64)>, CalibrationError> {
        if self.requires_recalibration {
            return Ok(None);
        }
        let current = normalized_quaternion(quaternion)?;
        let current = [current.w, current.i, current.j, current.k];
        let mut targets = Vec::with_capacity(2);
        if let Some(center) = self.center {
            targets.push((
                CalibrationTarget::Center,
                quaternion_angular_distance(current, center)?,
            ));
        }
        if let Some(top_right) = self.top_right {
            targets.push((
                CalibrationTarget::TopRight,
                quaternion_angular_distance(current, top_right)?,
            ));
        }
        Ok(targets
            .into_iter()
            .min_by(|left, right| left.1.total_cmp(&right.1)))
    }
}

fn validate_config(config: CalibrationConfig) -> Result<(), CalibrationError> {
    if !config.activation_threshold_degrees.is_finite()
        || !(0.0..=180.0).contains(&config.activation_threshold_degrees)
        || config.activation_threshold_degrees == 0.0
        || config.dwell.is_zero()
    {
        return Err(CalibrationError::InvalidConfiguration);
    }
    Ok(())
}

pub fn commit_visibility_after<E>(
    current: &mut bool,
    visible: bool,
    transition: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    transition()?;
    *current = visible;
    Ok(())
}

#[derive(Debug, Error, PartialEq)]
#[error("volume must be a finite value")]
pub struct VolumeError;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct VolumeSimulation {
    current: f32,
}

impl Default for VolumeSimulation {
    fn default() -> Self {
        Self { current: 50.0 }
    }
}

impl VolumeSimulation {
    pub fn new(initial: f32) -> Result<Self, VolumeError> {
        let mut simulation = Self::default();
        simulation.set(initial)?;
        Ok(simulation)
    }

    pub fn current(&self) -> f32 {
        self.current
    }

    pub fn set(&mut self, volume: f32) -> Result<f32, VolumeError> {
        if !volume.is_finite() {
            return Err(VolumeError);
        }
        self.current = volume.clamp(0.0, 100.0);
        Ok(self.current)
    }

    pub fn adjust(&mut self, delta: f32) -> f32 {
        if delta.is_finite() {
            self.current = (self.current + delta).clamp(0.0, 100.0);
        }
        self.current
    }
}
