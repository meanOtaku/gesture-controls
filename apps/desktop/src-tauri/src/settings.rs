use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use spatial_protocol::{
    CONTROLLABLE_SENSOR_IDS, MAX_PPG_FLUSH_RATE_HZ, MAX_SENSOR_RATE_HZ, MIN_PPG_FLUSH_RATE_HZ,
    MIN_SENSOR_RATE_HZ, SENSOR_ACCELERATION, SENSOR_GYROSCOPE, SENSOR_ORIENTATION,
    SENSOR_PPG_FLUSH,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{debug, warn};
use watch_bridge::{SensorControlCommand, SensorRateCommand, WatchBridgeServer};

pub const SETTINGS_UPDATED_EVENT: &str = "settings-updated";
const SETTINGS_FILE_NAME: &str = "settings.json";

pub const MIN_HEADPHONES_RATE_HZ: f64 = 1.0;
pub const MAX_HEADPHONES_RATE_HZ: f64 = 200.0;
pub const MIN_RECORDING_RATE_HZ: f64 = 1.0;
pub const MAX_RECORDING_RATE_HZ: f64 = 200.0;
pub const MIN_GRAPH_REFRESH_RATE_HZ: f64 = 1.0;
pub const MAX_GRAPH_REFRESH_RATE_HZ: f64 = 60.0;
pub const MIN_HEALTH_ACCEPTANCE_RATE_HZ: f64 = 0.1;
pub const MAX_HEALTH_ACCEPTANCE_RATE_HZ: f64 = 200.0;
pub const MIN_WRIST_DEAD_ZONE_DEGREES: f64 = 0.0;
pub const MAX_WRIST_DEAD_ZONE_DEGREES: f64 = 45.0;
pub const MIN_WRIST_SMOOTHING_ALPHA: f64 = 0.01;
pub const MAX_WRIST_SMOOTHING_ALPHA: f64 = 1.0;
pub const MIN_WRIST_VOLUME_POINTS_PER_DEGREE: f64 = 0.01;
pub const MAX_WRIST_VOLUME_POINTS_PER_DEGREE: f64 = 5.0;
pub const MIN_WRIST_ANGULAR_VELOCITY_DEGREES_PER_SECOND: f64 = 1.0;
pub const MAX_WRIST_ANGULAR_VELOCITY_DEGREES_PER_SECOND: f64 = 2_000.0;
pub const MIN_WRIST_VOLUME_POINTS_PER_SECOND: f64 = 1.0;
pub const MAX_WRIST_VOLUME_POINTS_PER_SECOND: f64 = 100.0;

/// Runtime-configurable settings, persisted as JSON in the Tauri app config
/// directory. `watchSensorsEnabled` mirrors the existing `desktop.set_sensor`
/// enable/disable switches; the three watch rate fields and
/// `headphonesRateHz` are independently applied live (see
/// [`SettingsRuntime::accept_headphones_pose`] and [`apply_watch_settings`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub headphones_enabled: bool,
    pub headphones_rate_hz: f64,
    pub recording_rate_hz: f64,
    pub graph_refresh_rate_hz: f64,
    pub watch_orientation_rate_hz: f64,
    pub watch_acceleration_rate_hz: f64,
    pub watch_gyroscope_rate_hz: f64,
    #[serde(
        default = "default_ppg_flush_rate_hz",
        alias = "watchPpgAcceptanceRateHz"
    )]
    pub watch_ppg_flush_rate_hz: f64,
    #[serde(default = "default_health_acceptance_rate_hz")]
    pub watch_heart_rate_acceptance_rate_hz: f64,
    #[serde(default = "default_health_acceptance_rate_hz")]
    pub watch_skin_temperature_acceptance_rate_hz: f64,
    #[serde(default = "default_health_acceptance_rate_hz")]
    pub watch_eda_acceptance_rate_hz: f64,
    #[serde(default = "default_wrist_dead_zone_degrees")]
    pub wrist_dead_zone_degrees: f64,
    #[serde(default = "default_wrist_smoothing_alpha")]
    pub wrist_smoothing_alpha: f64,
    #[serde(default = "default_wrist_volume_points_per_degree")]
    pub wrist_volume_points_per_degree: f64,
    #[serde(default = "default_wrist_max_angular_velocity_degrees_per_second")]
    pub wrist_max_angular_velocity_degrees_per_second: f64,
    #[serde(default = "default_wrist_max_volume_points_per_second")]
    pub wrist_max_volume_points_per_second: f64,
    pub watch_sensors_enabled: HashMap<String, bool>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            headphones_enabled: true,
            headphones_rate_hz: 60.0,
            recording_rate_hz: 30.0,
            graph_refresh_rate_hz: 15.0,
            watch_orientation_rate_hz: 50.0,
            watch_acceleration_rate_hz: 50.0,
            watch_gyroscope_rate_hz: 50.0,
            // Samsung controls physical sampling/callback cadence. Defaults at
            // the acceptance ceiling preserve every callback sample.
            watch_ppg_flush_rate_hz: default_ppg_flush_rate_hz(),
            watch_heart_rate_acceptance_rate_hz: MAX_HEALTH_ACCEPTANCE_RATE_HZ,
            watch_skin_temperature_acceptance_rate_hz: MAX_HEALTH_ACCEPTANCE_RATE_HZ,
            watch_eda_acceptance_rate_hz: MAX_HEALTH_ACCEPTANCE_RATE_HZ,
            wrist_dead_zone_degrees: default_wrist_dead_zone_degrees(),
            wrist_smoothing_alpha: default_wrist_smoothing_alpha(),
            wrist_volume_points_per_degree: default_wrist_volume_points_per_degree(),
            wrist_max_angular_velocity_degrees_per_second:
                default_wrist_max_angular_velocity_degrees_per_second(),
            wrist_max_volume_points_per_second: default_wrist_max_volume_points_per_second(),
            watch_sensors_enabled: CONTROLLABLE_SENSOR_IDS
                .iter()
                .map(|&sensor| (sensor.to_string(), true))
                .collect(),
        }
    }
}

fn default_health_acceptance_rate_hz() -> f64 {
    MAX_HEALTH_ACCEPTANCE_RATE_HZ
}

fn default_ppg_flush_rate_hz() -> f64 {
    1.0
}

fn default_wrist_dead_zone_degrees() -> f64 {
    3.0
}
fn default_wrist_smoothing_alpha() -> f64 {
    0.2
}
fn default_wrist_volume_points_per_degree() -> f64 {
    1.0 / 3.0
}
fn default_wrist_max_angular_velocity_degrees_per_second() -> f64 {
    360.0
}
fn default_wrist_max_volume_points_per_second() -> f64 {
    30.0
}

impl AppSettings {
    pub fn validate(&self) -> Result<(), String> {
        in_range(
            "headphonesRateHz",
            self.headphones_rate_hz,
            MIN_HEADPHONES_RATE_HZ,
            MAX_HEADPHONES_RATE_HZ,
        )?;
        in_range(
            "recordingRateHz",
            self.recording_rate_hz,
            MIN_RECORDING_RATE_HZ,
            MAX_RECORDING_RATE_HZ,
        )?;
        in_range(
            "graphRefreshRateHz",
            self.graph_refresh_rate_hz,
            MIN_GRAPH_REFRESH_RATE_HZ,
            MAX_GRAPH_REFRESH_RATE_HZ,
        )?;
        in_range(
            "watchOrientationRateHz",
            self.watch_orientation_rate_hz,
            MIN_SENSOR_RATE_HZ,
            MAX_SENSOR_RATE_HZ,
        )?;
        in_range(
            "watchAccelerationRateHz",
            self.watch_acceleration_rate_hz,
            MIN_SENSOR_RATE_HZ,
            MAX_SENSOR_RATE_HZ,
        )?;
        in_range(
            "watchGyroscopeRateHz",
            self.watch_gyroscope_rate_hz,
            MIN_SENSOR_RATE_HZ,
            MAX_SENSOR_RATE_HZ,
        )?;
        in_range(
            "watchPpgFlushRateHz",
            self.watch_ppg_flush_rate_hz,
            MIN_PPG_FLUSH_RATE_HZ,
            MAX_PPG_FLUSH_RATE_HZ,
        )?;
        for (name, value) in [
            (
                "watchHeartRateAcceptanceRateHz",
                self.watch_heart_rate_acceptance_rate_hz,
            ),
            (
                "watchSkinTemperatureAcceptanceRateHz",
                self.watch_skin_temperature_acceptance_rate_hz,
            ),
            (
                "watchEdaAcceptanceRateHz",
                self.watch_eda_acceptance_rate_hz,
            ),
        ] {
            in_range(
                name,
                value,
                MIN_HEALTH_ACCEPTANCE_RATE_HZ,
                MAX_HEALTH_ACCEPTANCE_RATE_HZ,
            )?;
        }
        for sensor in self.watch_sensors_enabled.keys() {
            if !CONTROLLABLE_SENSOR_IDS.contains(&sensor.as_str()) {
                return Err(format!("'{sensor}' is not a controllable sensor id"));
            }
        }
        for (name, value, min, max) in [
            (
                "wristDeadZoneDegrees",
                self.wrist_dead_zone_degrees,
                MIN_WRIST_DEAD_ZONE_DEGREES,
                MAX_WRIST_DEAD_ZONE_DEGREES,
            ),
            (
                "wristSmoothingAlpha",
                self.wrist_smoothing_alpha,
                MIN_WRIST_SMOOTHING_ALPHA,
                MAX_WRIST_SMOOTHING_ALPHA,
            ),
            (
                "wristVolumePointsPerDegree",
                self.wrist_volume_points_per_degree,
                MIN_WRIST_VOLUME_POINTS_PER_DEGREE,
                MAX_WRIST_VOLUME_POINTS_PER_DEGREE,
            ),
            (
                "wristMaxAngularVelocityDegreesPerSecond",
                self.wrist_max_angular_velocity_degrees_per_second,
                MIN_WRIST_ANGULAR_VELOCITY_DEGREES_PER_SECOND,
                MAX_WRIST_ANGULAR_VELOCITY_DEGREES_PER_SECOND,
            ),
            (
                "wristMaxVolumePointsPerSecond",
                self.wrist_max_volume_points_per_second,
                MIN_WRIST_VOLUME_POINTS_PER_SECOND,
                MAX_WRIST_VOLUME_POINTS_PER_SECOND,
            ),
        ] {
            in_range(name, value, min, max)?;
        }
        Ok(())
    }
}

fn in_range(name: &str, value: f64, min: f64, max: f64) -> Result<(), String> {
    if value.is_finite() && (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "{name} must be between {min} and {max}Hz (got {value})"
        ))
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("failed to resolve app config directory: {error}"))?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

/// Writes `settings.json` atomically: serialize to a sibling `.tmp` file,
/// then rename over the real path so a crash or concurrent read never
/// observes a partially written file.
fn write_atomic(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "settings path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(&tmp_path, json).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|error| error.to_string())?;
    Ok(())
}

fn load_or_default(app: &AppHandle) -> AppSettings {
    let path = match settings_path(app) {
        Ok(path) => path,
        Err(error) => {
            warn!(%error, "failed to resolve settings path; using defaults");
            return AppSettings::default();
        }
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return AppSettings::default();
    };
    match serde_json::from_str::<AppSettings>(&contents) {
        Ok(settings) => match settings.validate() {
            Ok(()) => settings,
            Err(error) => {
                warn!(%error, "persisted settings failed validation; using defaults");
                AppSettings::default()
            }
        },
        Err(error) => {
            warn!(%error, "failed to parse persisted settings; using defaults");
            AppSettings::default()
        }
    }
}

pub struct SettingsRuntime {
    state: RwLock<AppSettings>,
    last_headphones_emit: Mutex<Option<Instant>>,
}

impl SettingsRuntime {
    pub fn load(app: &AppHandle) -> Self {
        Self {
            state: RwLock::new(load_or_default(app)),
            last_headphones_emit: Mutex::new(None),
        }
    }

    pub fn get(&self) -> Result<AppSettings, String> {
        self.state
            .read()
            .map(|settings| settings.clone())
            .map_err(|_| "settings lock was poisoned".to_string())
    }

    pub fn update(&self, app: &AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
        settings.validate()?;
        write_atomic(app, &settings)?;
        *self
            .state
            .write()
            .map_err(|_| "settings lock was poisoned")? = settings.clone();
        self.reset_headphones_throttle();
        Ok(settings)
    }

    pub fn reset_to_defaults(&self, app: &AppHandle) -> Result<AppSettings, String> {
        let defaults = AppSettings::default();
        write_atomic(app, &defaults)?;
        *self
            .state
            .write()
            .map_err(|_| "settings lock was poisoned")? = defaults.clone();
        self.reset_headphones_throttle();
        Ok(defaults)
    }

    fn reset_headphones_throttle(&self) {
        if let Ok(mut last) = self.last_headphones_emit.lock() {
            *last = None;
        }
    }

    /// Gates whether a Sony head-pose sample should be forwarded to the
    /// frontend (and thus displayed/recorded) right now, per
    /// `headphonesEnabled`/`headphonesRateHz`. Every incoming packet still
    /// updates the Sony bridge's internal filter, connection monitor, and
    /// calibration state upstream of this call — only the live UI/recording
    /// path is throttled, so full incoming fidelity is preserved internally.
    pub fn accept_headphones_pose(&self) -> bool {
        let Ok(settings) = self.state.read() else {
            return false;
        };
        let (enabled, rate_hz) = (settings.headphones_enabled, settings.headphones_rate_hz);
        drop(settings);
        if !enabled {
            return false;
        }
        let min_interval = Duration::from_secs_f64(1.0 / rate_hz.max(0.001));
        let Ok(mut last) = self.last_headphones_emit.lock() else {
            return false;
        };
        let now = Instant::now();
        let accept = last
            .map(|previous| now.duration_since(previous) >= min_interval)
            .unwrap_or(true);
        if accept {
            *last = Some(now);
        }
        accept
    }
}

/// Pushes `settings`' watch-facing configuration (per-IMU enable state and
/// sampling rate) to the connected watch. Best-effort: errors (most commonly
/// "no watch connected") are logged and swallowed, since settings must always
/// persist locally regardless of watch connectivity — see
/// [`SettingsRuntime::update`]/[`SettingsRuntime::reset_to_defaults`] and the
/// `WatchEvent::Connected` replay in `lib.rs`.
pub fn apply_watch_settings(server: &WatchBridgeServer, settings: &AppSettings) {
    for &sensor in CONTROLLABLE_SENSOR_IDS {
        let enabled = settings
            .watch_sensors_enabled
            .get(sensor)
            .copied()
            .unwrap_or(true);
        let command = if enabled {
            SensorControlCommand::Enable(sensor.to_string())
        } else {
            SensorControlCommand::Disable(sensor.to_string())
        };
        if let Err(error) = server.send_sensor_control_command(command) {
            debug!(%error, sensor, "skipped replaying sensor-enable state");
        }
    }
    let rates = [
        (SENSOR_ORIENTATION, settings.watch_orientation_rate_hz),
        (SENSOR_ACCELERATION, settings.watch_acceleration_rate_hz),
        (SENSOR_GYROSCOPE, settings.watch_gyroscope_rate_hz),
        (SENSOR_PPG_FLUSH, settings.watch_ppg_flush_rate_hz),
    ];
    for (sensor, rate_hz) in rates {
        let command = SensorRateCommand {
            sensor: sensor.to_string(),
            rate_hz,
        };
        if let Err(error) = server.send_sensor_rate_command(command) {
            debug!(%error, sensor, rate_hz, "skipped replaying sensor rate");
        }
    }
}

#[tauri::command]
pub fn get_settings(runtime: State<'_, SettingsRuntime>) -> Result<AppSettings, String> {
    runtime.get()
}

#[tauri::command]
pub fn update_settings(
    settings: AppSettings,
    runtime: State<'_, SettingsRuntime>,
    app: AppHandle,
) -> Result<AppSettings, String> {
    let applied = runtime.update(&app, settings)?;
    if let Some(server) = app.try_state::<std::sync::Arc<WatchBridgeServer>>() {
        apply_watch_settings(&server, &applied);
    }
    let _ = app.emit(SETTINGS_UPDATED_EVENT, &applied);
    Ok(applied)
}

#[tauri::command]
pub fn reset_settings(
    runtime: State<'_, SettingsRuntime>,
    app: AppHandle,
) -> Result<AppSettings, String> {
    let applied = runtime.reset_to_defaults(&app)?;
    if let Some(server) = app.try_state::<std::sync::Arc<WatchBridgeServer>>() {
        apply_watch_settings(&server, &applied);
    }
    let _ = app.emit(SETTINGS_UPDATED_EVENT, &applied);
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_pass_validation() {
        AppSettings::default()
            .validate()
            .expect("defaults must validate");
    }

    #[test]
    fn rejects_out_of_range_rate() {
        let mut settings = AppSettings::default();
        settings.watch_orientation_rate_hz = 0.0;
        assert!(settings.validate().is_err());
    }

    #[test]
    fn rejects_unknown_sensor_key() {
        let mut settings = AppSettings::default();
        settings
            .watch_sensors_enabled
            .insert("bogus".to_string(), true);
        assert!(settings.validate().is_err());
    }
}
