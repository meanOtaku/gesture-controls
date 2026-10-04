//! Calibration and interaction state for head-directed targets.

use std::time::Duration;

use nalgebra::Quaternion;
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod gesture_policy;
pub use gesture_policy::{
    DecisionReason, ForceReleaseReason, GestureIntent, GesturePolicy, GesturePolicyConfig,
    PinchTransition, PolicyDecision, PolicyMode,
};

#[derive(Debug, Error, PartialEq)]
pub enum CalibrationError {
    #[error("quaternion must contain finite values and have non-zero length")]
    InvalidQuaternion,
    #[error("activation threshold must be within (0, 180] degrees and dwell must be positive")]
    InvalidConfiguration,
    #[error(
        "a location id starts with a letter and has only letters, digits or underscores (at most 32)"
    )]
    InvalidTargetId,
    #[error("a location name must be 1 to 32 characters with no control characters")]
    InvalidLocationName,
    #[error("there is no such location")]
    UnknownTarget,
    #[error("a location with that id already exists")]
    DuplicateTarget,
    #[error("the most locations allowed has been reached")]
    TooManyLocations,
    #[error("Center is the reference every other location is judged against and cannot be removed")]
    CannotRemoveCenter,
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

/// Most locations a calibration may hold, Center included.
pub const MAX_LOCATIONS: usize = 12;
/// Longest display name of a location, in characters.
pub const MAX_LOCATION_NAME_CHARS: usize = 32;

/// A place the head can point at. An id is a short slug (`center`, `topRight`, `leftEdge`): stable, safe to
/// store and to send to the UI, and never shown to the user (the location's name is).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CalibrationTarget(String);

impl CalibrationTarget {
    pub const CENTER_ID: &'static str = "center";
    pub const TOP_RIGHT_ID: &'static str = "topRight";

    /// Letters, digits and underscores, starting with a letter, at most 32 characters.
    pub fn new(id: impl Into<String>) -> Result<Self, CalibrationError> {
        let id = id.into();
        let mut chars = id.chars();
        let valid = chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
            && id.len() <= 32
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if valid {
            Ok(Self(id))
        } else {
            Err(CalibrationError::InvalidTargetId)
        }
    }

    /// The neutral reference every other location is told apart from. Always present.
    pub fn center() -> Self {
        Self(Self::CENTER_ID.to_string())
    }

    /// The built-in location the volume gesture has always used.
    pub fn top_right() -> Self {
        Self(Self::TOP_RIGHT_ID.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_center(&self) -> bool {
        self.0 == Self::CENTER_ID
    }
}

impl TryFrom<String> for CalibrationTarget {
    type Error = CalibrationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<CalibrationTarget> for String {
    fn from(target: CalibrationTarget) -> Self {
        target.0
    }
}

#[derive(Debug, Clone, PartialEq)]
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

/// One location as the UI sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetState {
    pub id: CalibrationTarget,
    pub name: String,
    pub calibrated: bool,
    /// Center: it cannot be removed.
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationState {
    pub targets: Vec<TargetState>,
    pub requires_recalibration: bool,
    pub activation_threshold_degrees: f64,
    pub dwell_ms: u64,
    pub active_target: Option<CalibrationTarget>,
}

impl CalibrationState {
    /// Whether the location with this id exists and has been captured.
    pub fn is_calibrated(&self, id: &str) -> bool {
        self.targets
            .iter()
            .any(|target| target.id.as_str() == id && target.calibrated)
    }
}

#[derive(Debug)]
struct Location {
    target: CalibrationTarget,
    name: String,
    /// The captured pose; `None` until the user captures it.
    pose: Option<[f64; 4]>,
}

#[derive(Debug)]
pub struct HeadCalibration {
    config: CalibrationConfig,
    /// Center first, then the others in the order they were added.
    locations: Vec<Location>,
    candidate: Option<(CalibrationTarget, Duration)>,
    active: Option<CalibrationTarget>,
    /// First instant the currently active target stopped being confirmed by
    /// a sample (moved beyond its own activation threshold, or a different
    /// target became nearer). Mirrors the entry-side `candidate` dwell: a
    /// single noisy head-tracker sample must not instantly drop an active
    /// target the way it previously did, since entry already requires a
    /// sustained dwell but exit did not -- only a departure sustained for
    /// the same `dwell` duration now confirms a real exit. Reset to `None`
    /// the moment any sample reconfirms the active target, so a momentary
    /// jitter that recovers before the grace period elapses never emits
    /// `TargetExited` at all.
    exit_candidate: Option<Duration>,
    requires_recalibration: bool,
}

impl Default for HeadCalibration {
    fn default() -> Self {
        Self::new(CalibrationConfig::default()).expect("default calibration config is valid")
    }
}

fn validated_name(name: &str) -> Result<String, CalibrationError> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_LOCATION_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(CalibrationError::InvalidLocationName);
    }
    Ok(name.to_string())
}

impl HeadCalibration {
    /// Starts with Center and Top right, the two locations the volume gesture has always used.
    pub fn new(config: CalibrationConfig) -> Result<Self, CalibrationError> {
        validate_config(config)?;
        Ok(Self {
            config,
            locations: vec![
                Location {
                    target: CalibrationTarget::center(),
                    name: "Screen center".into(),
                    pose: None,
                },
                Location {
                    target: CalibrationTarget::top_right(),
                    name: "Top right".into(),
                    pose: None,
                },
            ],
            candidate: None,
            active: None,
            exit_candidate: None,
            requires_recalibration: true,
        })
    }

    fn position(&self, target: &CalibrationTarget) -> Option<usize> {
        self.locations
            .iter()
            .position(|location| &location.target == target)
    }

    /// Adds a location to point at. It starts uncaptured; capture it with [`Self::capture`].
    pub fn add_location(
        &mut self,
        target: CalibrationTarget,
        name: &str,
    ) -> Result<(), CalibrationError> {
        let name = validated_name(name)?;
        if self.position(&target).is_some() {
            return Err(CalibrationError::DuplicateTarget);
        }
        if self.locations.len() >= MAX_LOCATIONS {
            return Err(CalibrationError::TooManyLocations);
        }
        self.locations.push(Location {
            target,
            name,
            pose: None,
        });
        Ok(())
    }

    /// Removes a location (never Center). If it was the active one, that ends first and says so.
    pub fn remove_location(
        &mut self,
        target: &CalibrationTarget,
    ) -> Result<Vec<CalibrationEvent>, CalibrationError> {
        if target.is_center() {
            return Err(CalibrationError::CannotRemoveCenter);
        }
        let index = self
            .position(target)
            .ok_or(CalibrationError::UnknownTarget)?;
        let events = if self.active.as_ref() == Some(target) {
            self.deactivate()
        } else {
            Vec::new()
        };
        self.locations.remove(index);
        self.candidate = None;
        self.exit_candidate = None;
        self.refresh_requirement();
        Ok(events)
    }

    /// Ready once Center and at least one other location are captured: with fewer there is nothing to tell apart.
    fn refresh_requirement(&mut self) {
        let center = self
            .locations
            .iter()
            .any(|l| l.target.is_center() && l.pose.is_some());
        let other = self
            .locations
            .iter()
            .any(|l| !l.target.is_center() && l.pose.is_some());
        self.requires_recalibration = !(center && other);
    }

    pub fn capture(
        &mut self,
        target: &CalibrationTarget,
        quaternion: [f64; 4],
    ) -> Result<Vec<CalibrationEvent>, CalibrationError> {
        let index = self
            .position(target)
            .ok_or(CalibrationError::UnknownTarget)?;
        let quaternion = normalized_quaternion(quaternion)?;
        let value = [quaternion.w, quaternion.i, quaternion.j, quaternion.k];
        let events = self.deactivate();
        self.locations[index].pose = Some(value);
        self.candidate = None;
        self.refresh_requirement();
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
        self.exit_candidate = None;
        Ok(())
    }

    pub fn observe(
        &mut self,
        quaternion: [f64; 4],
        now: Duration,
    ) -> Result<Vec<CalibrationEvent>, CalibrationError> {
        let Some((nearest, distance)) = self.nearest_target(quaternion)? else {
            return Ok(Vec::new());
        };
        let mut events = Vec::new();
        let within = distance.to_degrees() <= self.config.activation_threshold_degrees;
        let confirms_active = self.active.as_ref() == Some(&nearest) && within;

        if let Some(active) = self.active.clone() {
            if confirms_active {
                self.exit_candidate = None;
                self.candidate = None;
                return Ok(events);
            }
            let exit_started = *self.exit_candidate.get_or_insert(now);
            if now.saturating_sub(exit_started) < self.config.dwell {
                // Not yet a confirmed exit -- a single noisy sample (or a
                // brief glance elsewhere) must not instantly drop an active
                // target. Leave `active` (and any in-progress candidate for
                // a different target) untouched until the departure is
                // sustained for a full dwell.
                return Ok(events);
            }
            self.exit_candidate = None;
            self.active = None;
            events.push(CalibrationEvent::TargetExited(active));
        }

        if !within {
            self.candidate = None;
            return Ok(events);
        }

        let started = match &self.candidate {
            Some((target, started)) if *target == nearest => *started,
            _ => {
                self.candidate = Some((nearest, now));
                return Ok(events);
            }
        };
        if now.saturating_sub(started) >= self.config.dwell {
            self.candidate = None;
            self.active = Some(nearest.clone());
            events.push(CalibrationEvent::TargetEntered(nearest));
        }
        Ok(events)
    }

    pub fn deactivate(&mut self) -> Vec<CalibrationEvent> {
        self.candidate = None;
        self.exit_candidate = None;
        self.active
            .take()
            .map(CalibrationEvent::TargetExited)
            .into_iter()
            .collect()
    }

    /// Forgets every captured pose (a tracker reset invalidates them) but keeps the locations themselves.
    pub fn invalidate(&mut self) -> Vec<CalibrationEvent> {
        let events = self.deactivate();
        for location in &mut self.locations {
            location.pose = None;
        }
        self.candidate = None;
        self.exit_candidate = None;
        self.requires_recalibration = true;
        events
    }

    pub fn state(&self) -> CalibrationState {
        CalibrationState {
            targets: self
                .locations
                .iter()
                .map(|location| TargetState {
                    id: location.target.clone(),
                    name: location.name.clone(),
                    calibrated: location.pose.is_some(),
                    builtin: location.target.is_center(),
                })
                .collect(),
            requires_recalibration: self.requires_recalibration,
            activation_threshold_degrees: self.config.activation_threshold_degrees,
            dwell_ms: self.config.dwell.as_millis().min(u64::MAX as u128) as u64,
            active_target: self.active.clone(),
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
        let mut nearest: Option<(&CalibrationTarget, f64)> = None;
        for location in &self.locations {
            let Some(pose) = location.pose else { continue };
            let distance = quaternion_angular_distance(current, pose)?;
            if nearest.is_none_or(|(_, best)| distance.total_cmp(&best).is_lt()) {
                nearest = Some((&location.target, distance));
            }
        }
        Ok(nearest.map(|(target, distance)| (target.clone(), distance)))
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

pub fn top_right_overlay_position(
    work_area_origin: (i32, i32),
    work_area_size: (u32, u32),
    logical_window_size: (f64, f64),
    destination_scale_factor: f64,
    logical_margin: f64,
) -> Option<(i32, i32)> {
    if !destination_scale_factor.is_finite()
        || destination_scale_factor <= 0.0
        || !logical_window_size.0.is_finite()
        || logical_window_size.0 < 0.0
        || !logical_window_size.1.is_finite()
        || logical_window_size.1 < 0.0
        || !logical_margin.is_finite()
        || logical_margin < 0.0
    {
        return None;
    }

    let physical_window_width =
        rounded_nonnegative_i64(logical_window_size.0 * destination_scale_factor)?;
    let physical_margin = rounded_nonnegative_i64(logical_margin * destination_scale_factor)?;
    let work_x = i64::from(work_area_origin.0);
    let work_y = i64::from(work_area_origin.1);
    let work_width = i64::from(work_area_size.0);
    let margin_within_work_area = physical_margin.min(work_width);
    let left_bound = work_x.checked_add(margin_within_work_area)?;
    let right_aligned = work_x
        .checked_add(work_width)?
        .checked_sub(physical_window_width)?
        .checked_sub(physical_margin)?;
    let x = right_aligned.max(left_bound);
    let y = work_y.checked_add(i64::from(work_area_size.1).min(physical_margin))?;

    Some((clamp_i64_to_i32(x), clamp_i64_to_i32(y)))
}

fn rounded_nonnegative_i64(value: f64) -> Option<i64> {
    if !value.is_finite() || !(0.0..=i64::MAX as f64).contains(&value) {
        return None;
    }
    Some(value.round() as i64)
}

fn clamp_i64_to_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
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

/// Maps relative watch orientation around the local forearm (X) axis to an
/// absolute target volume: `activation_volume + signed(relative_degrees) *
/// volume_points_per_degree`, clamped to the valid volume range. The target
/// is a pure function of the reference pose and activation volume captured
/// at [`WristRotation::begin`]/[`WristRotation::begin_with_config`] and the
/// current sample -- never of any previously applied volume -- so holding a
/// fixed wrist angle holds a fixed volume and returning to the reference
/// angle restores the activation volume exactly, with no per-event
/// accumulation to drift.
///
/// The forearm's long axis runs through the watch case's 9-3 (X) direction,
/// not 12-6 (Y): the band wraps the wrist circumferentially through the 12
/// and 6 lugs, so 12-6 (Y) is the around-the-wrist direction and 9-3 (X) is
/// the along-the-arm one. Confirmed against real Watch hardware, where
/// rolling the wrist produced no signal on the previously-used Y axis.
#[derive(Debug, Clone, Copy)]
pub struct WristRotationConfig {
    pub dead_zone_degrees: f64,
    pub volume_points_per_degree: f64,
    pub max_angular_velocity_degrees_per_second: f64,
    /// Slew limit on the output target, in volume points per second. The
    /// angle-derived target is still computed absolutely from the reference
    /// pose, but the value returned from [`WristRotation::observe`] moves
    /// toward it by at most this rate (times the elapsed time since the
    /// previous sample), so a fast wrist roll cannot change the loudness
    /// faster than this.
    pub max_volume_points_per_second: f64,
    /// Flips clockwise/counter-clockwise sign to correct for a Watch worn or
    /// mounted with the opposite physical handedness than this convention
    /// assumes. Calibration, not a gesture tuning knob: leave `false` unless
    /// a real Watch has been confirmed to produce the wrong sign.
    pub invert_direction: bool,
}

impl Default for WristRotationConfig {
    fn default() -> Self {
        Self {
            dead_zone_degrees: 3.0,
            volume_points_per_degree: 1.0 / 3.0,
            max_angular_velocity_degrees_per_second: 360.0,
            max_volume_points_per_second: 30.0,
            invert_direction: false,
        }
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum WristRotationError {
    #[error("invalid wrist rotation configuration")]
    InvalidConfiguration,
    #[error("orientation timestamp must increase while grabbed")]
    NonMonotonicTimestamp,
    #[error(transparent)]
    InvalidQuaternion(#[from] CalibrationError),
}

#[derive(Debug, Default)]
pub struct WristRotation {
    config: WristRotationConfig,
    start: Option<Quaternion<f64>>,
    /// Desktop volume percent (0.0..=100.0) captured once when the
    /// reference pose is established. The sole baseline every absolute
    /// target is computed from; nothing outside a fresh [`Self::begin`] /
    /// [`Self::begin_with_config`] call can change it, so it cannot drift
    /// across repeated samples.
    activation_volume_percent: Option<f32>,
    previous_raw_degrees: Option<f64>,
    /// Timestamp `previous_raw_degrees` was captured at. Paired with it and
    /// updated only together (on an *accepted* sample), so the
    /// velocity-outlier elapsed-time baseline can never desync from the
    /// angle it is being compared against -- see [`Self::observe`].
    previous_raw_degrees_at_ns: Option<u64>,
    /// Absolute target volume percent from the most recent [`Self::observe`]
    /// call. Reused verbatim when a sample is rejected as a velocity
    /// outlier, so a bad sample freezes the target instead of jumping it.
    last_target_volume_percent: Option<f32>,
    last_timestamp_ns: Option<u64>,
    /// Raw relative roll (degrees from the reference pose, pre-dead-zone)
    /// from the most recent [`Self::observe`] call while a reference is
    /// active. Diagnostic-only: never fed back into volume math, so it
    /// cannot influence the mapper this task must preserve. `None` before a
    /// reference is established or after [`Self::end`].
    last_relative_degrees: Option<f64>,
}

impl WristRotation {
    pub fn new(config: WristRotationConfig) -> Result<Self, WristRotationError> {
        validate_wrist_config(config)?;
        Ok(Self {
            config,
            ..Self::default()
        })
    }

    pub fn update_config(&mut self, config: WristRotationConfig) -> Result<(), WristRotationError> {
        validate_wrist_config(config)?;
        self.config = config;
        Ok(())
    }

    /// Establishes a fresh reference pose and captures `activation_volume_percent`
    /// (the desktop's current volume at activation) as the baseline every
    /// subsequent [`Self::observe`] target is computed from.
    pub fn begin(
        &mut self,
        quaternion: [f64; 4],
        timestamp_ns: u64,
        activation_volume_percent: f32,
    ) -> Result<(), WristRotationError> {
        if !activation_volume_percent.is_finite() {
            return Err(WristRotationError::InvalidConfiguration);
        }
        self.start = Some(normalized_quaternion(quaternion)?);
        let clamped = activation_volume_percent.clamp(0.0, 100.0);
        self.activation_volume_percent = Some(clamped);
        // The reference pose is, by definition, 0 degrees at `timestamp_ns`.
        // Seeding the velocity baseline with it means the very first sample
        // is outlier-checked like every later one, instead of being able to
        // jump the target across the whole range in one step.
        self.previous_raw_degrees = Some(0.0);
        self.previous_raw_degrees_at_ns = Some(timestamp_ns);
        self.last_target_volume_percent = Some(clamped);
        self.last_timestamp_ns = Some(timestamp_ns);
        self.last_relative_degrees = None;
        Ok(())
    }

    /// Validates `config`, `quaternion`, and `activation_volume_percent`
    /// before mutating any state, so a button-start and a model-start
    /// always establish a fresh reference pose and activation-volume
    /// baseline under the intended settings or leave the previous
    /// interaction (if any) completely untouched -- never a config swapped
    /// in with no matching reference pose, or vice versa.
    pub fn begin_with_config(
        &mut self,
        config: WristRotationConfig,
        quaternion: [f64; 4],
        timestamp_ns: u64,
        activation_volume_percent: f32,
    ) -> Result<(), WristRotationError> {
        validate_wrist_config(config)?;
        if !activation_volume_percent.is_finite() {
            return Err(WristRotationError::InvalidConfiguration);
        }
        let start = normalized_quaternion(quaternion)?;
        let clamped = activation_volume_percent.clamp(0.0, 100.0);
        self.config = config;
        self.start = Some(start);
        self.activation_volume_percent = Some(clamped);
        // The reference pose is, by definition, 0 degrees at `timestamp_ns`.
        // Seeding the velocity baseline with it means the very first sample
        // is outlier-checked like every later one, instead of being able to
        // jump the target across the whole range in one step.
        self.previous_raw_degrees = Some(0.0);
        self.previous_raw_degrees_at_ns = Some(timestamp_ns);
        self.last_target_volume_percent = Some(clamped);
        self.last_timestamp_ns = Some(timestamp_ns);
        self.last_relative_degrees = None;
        Ok(())
    }

    pub fn end(&mut self) {
        self.start = None;
        self.activation_volume_percent = None;
        self.previous_raw_degrees = None;
        self.previous_raw_degrees_at_ns = None;
        self.last_target_volume_percent = None;
        self.last_timestamp_ns = None;
        self.last_relative_degrees = None;
    }

    /// True once a reference pose has been established by [`Self::begin`] or
    /// [`Self::begin_with_config`] and not yet cleared by [`Self::end`].
    pub fn is_active(&self) -> bool {
        self.start.is_some()
    }

    /// Raw relative roll (degrees from the reference pose) from the most
    /// recent [`Self::observe`] call, before dead-zone/velocity
    /// clamping. Diagnostic-only, for surfacing "is the wrist roll actually
    /// changing" independent of whether it produced a volume delta.
    pub fn last_relative_degrees(&self) -> Option<f64> {
        self.last_relative_degrees
    }

    /// Computes the absolute target volume percent (0.0..=100.0) for the
    /// current orientation sample using
    /// `activation_volume + signed(relative_roll) * volume_points_per_degree`,
    /// clamped to the valid range.
    ///
    /// This is a pure function of the reference pose, the activation-volume baseline, and
    /// this sample alone -- never of any previously applied volume -- so
    /// holding a fixed wrist angle holds a fixed target and returning to the
    /// reference angle restores the activation volume exactly, with nothing
    /// accumulated across samples to drift.
    ///
    /// Returns `0.0` if no reference is active; callers must gate on
    /// [`Self::is_active`] before treating the result as meaningful.
    ///
    /// Ignores high-velocity orientation outliers rather than risking a
    /// jump: an outlier tick returns the previous target unchanged instead
    /// of a freshly computed one. The velocity is measured against the last
    /// *accepted* sample's angle and timestamp together (never a rejected
    /// one), so one genuine outlier can never desync the elapsed-time
    /// baseline from the angle baseline and cascade into rejecting the
    /// legitimate reversal samples that follow it.
    pub fn observe(
        &mut self,
        quaternion: [f64; 4],
        timestamp_ns: u64,
    ) -> Result<f64, WristRotationError> {
        let (Some(start), Some(activation_volume_percent)) =
            (self.start, self.activation_volume_percent)
        else {
            return Ok(0.0);
        };
        let previous_timestamp = self
            .last_timestamp_ns
            .ok_or(WristRotationError::NonMonotonicTimestamp)?;
        if timestamp_ns <= previous_timestamp {
            return Err(WristRotationError::NonMonotonicTimestamp);
        }
        self.last_timestamp_ns = Some(timestamp_ns);
        let current = normalized_quaternion(quaternion)?;
        let relative = start.conjugate() * current;
        let mut raw_degrees = (2.0 * relative.i.atan2(relative.w)).to_degrees();
        if raw_degrees > 180.0 {
            raw_degrees -= 360.0;
        }
        if raw_degrees < -180.0 {
            raw_degrees += 360.0;
        }
        if self.config.invert_direction {
            raw_degrees = -raw_degrees;
        }
        self.last_relative_degrees = Some(raw_degrees);
        if let (Some(previous), Some(previous_at_ns)) =
            (self.previous_raw_degrees, self.previous_raw_degrees_at_ns)
        {
            let elapsed_seconds = (timestamp_ns - previous_at_ns) as f64 / 1_000_000_000.0;
            if (raw_degrees - previous).abs() / elapsed_seconds
                > self.config.max_angular_velocity_degrees_per_second
            {
                return Ok(self
                    .last_target_volume_percent
                    .map(f64::from)
                    .unwrap_or(f64::from(activation_volume_percent)));
            }
        }
        self.previous_raw_degrees = Some(raw_degrees);
        self.previous_raw_degrees_at_ns = Some(timestamp_ns);
        let elapsed_since_last_sample =
            (timestamp_ns - previous_timestamp) as f64 / 1_000_000_000.0;
        let dead_zoned = if raw_degrees.abs() <= self.config.dead_zone_degrees {
            0.0
        } else {
            raw_degrees - self.config.dead_zone_degrees.copysign(raw_degrees)
        };
        let desired = (f64::from(activation_volume_percent)
            + dead_zoned * self.config.volume_points_per_degree)
            .clamp(0.0, 100.0);
        let previous_target = self
            .last_target_volume_percent
            .map(f64::from)
            .unwrap_or(f64::from(activation_volume_percent));
        let max_step = self.config.max_volume_points_per_second * elapsed_since_last_sample;
        let target = previous_target + (desired - previous_target).clamp(-max_step, max_step);
        self.last_target_volume_percent = Some(target as f32);
        Ok(target)
    }
}

fn validate_wrist_config(config: WristRotationConfig) -> Result<(), WristRotationError> {
    if !config.dead_zone_degrees.is_finite()
        || !(0.0..90.0).contains(&config.dead_zone_degrees)
        || !config.volume_points_per_degree.is_finite()
        || config.volume_points_per_degree <= 0.0
        || !config.max_angular_velocity_degrees_per_second.is_finite()
        || config.max_angular_velocity_degrees_per_second <= 0.0
        || !config.max_volume_points_per_second.is_finite()
        || config.max_volume_points_per_second <= 0.0
    {
        return Err(WristRotationError::InvalidConfiguration);
    }
    Ok(())
}
