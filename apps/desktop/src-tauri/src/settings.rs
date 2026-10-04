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
use watch_bridge::{SensorControlCommand, SensorRateCommand, WatchBridgeServer, WatchTransport};

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
pub const MIN_SHAKE_PEAK_THRESHOLD: f64 = 2.0;
pub const MAX_SHAKE_PEAK_THRESHOLD: f64 = 30.0;
pub const MIN_SHAKE_STROKES: u32 = 3;
pub const MAX_SHAKE_STROKES: u32 = 10;
pub const MIN_SWIPE_PEAK_THRESHOLD: f64 = 3.0;
pub const MAX_SWIPE_PEAK_THRESHOLD: f64 = 30.0;
pub const MIN_TAP_PEAK_THRESHOLD: f64 = 4.0;
pub const MAX_TAP_PEAK_THRESHOLD: f64 = 40.0;
pub const MIN_ROLL_ANGLE_DEGREES: f64 = 30.0;
pub const MAX_ROLL_ANGLE_DEGREES: f64 = 180.0;
pub const MIN_PITCH_ANGLE_DEGREES: f64 = 20.0;
pub const MAX_PITCH_ANGLE_DEGREES: f64 = 120.0;
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
    /// How far above the resting signal an acceleration peak must reach to count as part of a shake, in m/s².
    /// Lower is more sensitive.
    #[serde(default = "default_shake_peak_threshold")]
    pub shake_peak_threshold: f64,
    /// How many quick strokes back and forth make a shake. Fewer is more sensitive.
    #[serde(default = "default_shake_strokes")]
    pub shake_strokes: u32,
    /// How hard a push must be to count as a swipe, in m/s². Lower is more sensitive.
    #[serde(default = "default_swipe_peak_threshold")]
    pub swipe_peak_threshold: f64,
    /// How hard a knock on the watch must be to count as a tap, in m/s². Lower is more sensitive.
    #[serde(default = "default_tap_peak_threshold")]
    pub tap_peak_threshold: f64,
    /// How far the wrist must twist, quickly, to count as a roll gesture, in degrees. Smaller is more sensitive.
    #[serde(default = "default_roll_angle_degrees", alias = "rotateAngleDegrees")]
    pub roll_angle_degrees: f64,
    /// How far the hand must tilt up or down at the wrist, quickly, to count as a pitch gesture, in degrees.
    #[serde(default = "default_pitch_angle_degrees")]
    pub pitch_angle_degrees: f64,
    /// Which wrist the watch is worn on. Only the roll gesture needs it: clockwise is the way you turn a screwdriver.
    #[serde(default)]
    pub watch_wrist: automation::Wrist,
    /// Which side of the watch face the crown is on, as you read it. Decides which way along the forearm is left for a
    /// swipe, and (with the wrist) which way is clockwise for a roll.
    #[serde(default)]
    pub crown_side: automation::CrownSide,
    #[serde(default = "default_wrist_max_angular_velocity_degrees_per_second")]
    pub wrist_max_angular_velocity_degrees_per_second: f64,
    #[serde(default = "default_wrist_max_volume_points_per_second")]
    pub wrist_max_volume_points_per_second: f64,
    /// Missing entirely (e.g. a settings.json from before this field
    /// existed) falls back to every controllable sensor enabled via
    /// [`default_watch_sensors_enabled`], not to the whole-struct default —
    /// so an older persisted file only migrates this one field forward and
    /// keeps the rest of the user's settings. A key present with `false`
    /// (an explicit user disable) is never overridden; only an *absent* key
    /// is treated as "enabled" — see [`apply_watch_settings`].
    #[serde(default = "default_watch_sensors_enabled")]
    pub watch_sensors_enabled: HashMap<String, bool>,
    /// Which link reaches the Watch. Absent from an older settings.json — every
    /// file written before GC-037 — migrates to [`WatchTransport::Bluetooth`],
    /// which is also what a fresh install gets. Only one transport is ever
    /// live: see `lib.rs`'s `apply_watch_transport`.
    #[serde(default)]
    pub watch_transport: WatchTransport,
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
            shake_peak_threshold: default_shake_peak_threshold(),
            shake_strokes: default_shake_strokes(),
            swipe_peak_threshold: default_swipe_peak_threshold(),
            tap_peak_threshold: default_tap_peak_threshold(),
            roll_angle_degrees: default_roll_angle_degrees(),
            pitch_angle_degrees: default_pitch_angle_degrees(),
            watch_wrist: automation::Wrist::default(),
            crown_side: automation::CrownSide::default(),
            wrist_max_angular_velocity_degrees_per_second:
                default_wrist_max_angular_velocity_degrees_per_second(),
            wrist_max_volume_points_per_second: default_wrist_max_volume_points_per_second(),
            watch_sensors_enabled: default_watch_sensors_enabled(),
            watch_transport: WatchTransport::default(),
        }
    }
}

fn default_watch_sensors_enabled() -> HashMap<String, bool> {
    CONTROLLABLE_SENSOR_IDS
        .iter()
        .map(|&sensor| (sensor.to_string(), true))
        .collect()
}

fn default_health_acceptance_rate_hz() -> f64 {
    MAX_HEALTH_ACCEPTANCE_RATE_HZ
}

fn default_ppg_flush_rate_hz() -> f64 {
    1.0
}

fn default_shake_peak_threshold() -> f64 {
    6.0
}
fn default_pitch_angle_degrees() -> f64 {
    40.0
}
fn default_roll_angle_degrees() -> f64 {
    60.0
}
fn default_tap_peak_threshold() -> f64 {
    12.0
}
fn default_swipe_peak_threshold() -> f64 {
    8.0
}
fn default_shake_strokes() -> u32 {
    4
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
        in_range(
            "shakePeakThreshold",
            self.shake_peak_threshold,
            MIN_SHAKE_PEAK_THRESHOLD,
            MAX_SHAKE_PEAK_THRESHOLD,
        )?;
        in_range(
            "swipePeakThreshold",
            self.swipe_peak_threshold,
            MIN_SWIPE_PEAK_THRESHOLD,
            MAX_SWIPE_PEAK_THRESHOLD,
        )?;
        in_range(
            "tapPeakThreshold",
            self.tap_peak_threshold,
            MIN_TAP_PEAK_THRESHOLD,
            MAX_TAP_PEAK_THRESHOLD,
        )?;
        in_range(
            "rollAngleDegrees",
            self.roll_angle_degrees,
            MIN_ROLL_ANGLE_DEGREES,
            MAX_ROLL_ANGLE_DEGREES,
        )?;
        in_range(
            "pitchAngleDegrees",
            self.pitch_angle_degrees,
            MIN_PITCH_ANGLE_DEGREES,
            MAX_PITCH_ANGLE_DEGREES,
        )?;
        if !(MIN_SHAKE_STROKES..=MAX_SHAKE_STROKES).contains(&self.shake_strokes) {
            return Err(format!(
                "shakeStrokes must be between {MIN_SHAKE_STROKES} and {MAX_SHAKE_STROKES} (got {})",
                self.shake_strokes
            ));
        }
        for (name, value, min, max) in [
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

/// A sensor absent from `watch_sensors_enabled` (a legacy/persisted settings
/// object migrating forward, or a sensor added to `CONTROLLABLE_SENSOR_IDS`
/// after the file was written) is treated as enabled by default. A sensor
/// *present* with `false` is an explicit user disable and is never
/// overridden.
fn effective_sensor_enabled(settings: &AppSettings, sensor: &str) -> bool {
    settings
        .watch_sensors_enabled
        .get(sensor)
        .copied()
        .unwrap_or(true)
}

/// Pushes `settings`' watch-facing configuration (per-IMU enable state and
/// sampling rate) to the connected watch. Best-effort: errors (most commonly
/// "no watch connected") are logged and swallowed, since settings must always
/// persist locally regardless of watch connectivity — see
/// [`SettingsRuntime::update`]/[`SettingsRuntime::reset_to_defaults`] and the
/// `WatchEvent::Connected` replay in `lib.rs`.
pub fn apply_watch_settings(server: &WatchBridgeServer, settings: &AppSettings) {
    for &sensor in CONTROLLABLE_SENSOR_IDS {
        let enabled = effective_sensor_enabled(settings, sensor);
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

/// Makes `transport` the live Watch link. Starting one transport stops the
/// other outright: selecting Bluetooth tears down the WebSocket listener, its
/// mDNS advertisement and the pairing browser, and selecting Wi-Fi releases the
/// BLE scan, GATT connection and notification subscription. A failure to start
/// the selected transport is reported, never papered over by falling back to
/// the other one.
pub async fn apply_watch_transport(
    app: &AppHandle,
    transport: WatchTransport,
) -> Result<(), String> {
    let Some(server) = app.try_state::<std::sync::Arc<WatchBridgeServer>>() else {
        // The bridge task hasn't published the server yet; it reads the
        // persisted setting itself when it does.
        return Ok(());
    };
    match transport {
        WatchTransport::Bluetooth => {
            server.stop().await.map_err(|error| error.to_string())?;
            server.start_ble().map_err(|error| error.to_string())
        }
        WatchTransport::WiFi => {
            server.stop_ble().await.map_err(|error| error.to_string())?;
            server.start().await.map_err(|error| error.to_string())
        }
    }
}

/// Persists `transport` and switches to it.
pub async fn set_watch_transport(app: &AppHandle, transport: WatchTransport) -> Result<(), String> {
    let runtime = app.state::<SettingsRuntime>();
    let mut settings = runtime.get()?;
    if settings.watch_transport == transport {
        return Ok(());
    }
    settings.watch_transport = transport;
    let applied = runtime.update(app, settings)?;
    apply_watch_transport(app, transport).await?;
    let _ = app.emit(SETTINGS_UPDATED_EVENT, &applied);
    Ok(())
}

/// Stops and restarts the BLE session, for a user-initiated rescan.
pub async fn restart_watch_ble(app: &AppHandle) -> Result<(), String> {
    let Some(server) = app.try_state::<std::sync::Arc<WatchBridgeServer>>() else {
        return Err("watch bridge is not running yet".to_string());
    };
    server.stop_ble().await.map_err(|error| error.to_string())?;
    server.start_ble().map_err(|error| error.to_string())
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
    let previous_transport = runtime.get().map(|current| current.watch_transport).ok();
    let applied = runtime.update(&app, settings)?;
    app.state::<crate::automation::AutomationRuntime>()
        .apply_settings(&app, &applied);
    if let Some(server) = app.try_state::<std::sync::Arc<WatchBridgeServer>>() {
        apply_watch_settings(&server, &applied);
    }
    // Transport switches are asynchronous (they stop listeners and GATT
    // connections), so they can't run inline in this sync command.
    if previous_transport != Some(applied.watch_transport) {
        let handle = app.clone();
        let transport = applied.watch_transport;
        tauri::async_runtime::spawn(async move {
            if let Err(error) = apply_watch_transport(&handle, transport).await {
                warn!(%error, "failed to switch the watch transport");
            }
        });
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
    app.state::<crate::automation::AutomationRuntime>()
        .apply_settings(&app, &applied);
    if let Some(server) = app.try_state::<std::sync::Arc<WatchBridgeServer>>() {
        apply_watch_settings(&server, &applied);
    }
    let _ = app.emit(SETTINGS_UPDATED_EVENT, &applied);
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smoothing control was removed (it never affected the mapper); a
    /// settings.json written before that must still load and validate.
    #[test]
    fn legacy_settings_with_a_wrist_smoothing_alpha_still_load() {
        let mut json = serde_json::to_value(AppSettings::default()).unwrap();
        json["wristSmoothingAlpha"] = serde_json::json!(0.5);
        // Dead zone and sensitivity moved into each recipe; an old file still carrying them must load.
        json["wristDeadZoneDegrees"] = serde_json::json!(4.0);
        json["wristVolumePointsPerDegree"] = serde_json::json!(0.5);
        let settings: AppSettings =
            serde_json::from_value(json).expect("legacy key must be ignored, not rejected");
        settings.validate().expect("must validate");
    }

    #[test]
    fn shake_settings_are_range_checked_and_an_old_file_gets_the_defaults() {
        let mut settings = AppSettings::default();
        assert_eq!(
            (settings.shake_peak_threshold, settings.shake_strokes),
            (6.0, 4)
        );
        settings.shake_peak_threshold = 1.0;
        assert!(settings.validate().is_err());
        settings.shake_peak_threshold = 6.0;
        settings.shake_strokes = 2;
        assert!(settings.validate().unwrap_err().contains("shakeStrokes"));
        settings.shake_strokes = 11;
        assert!(settings.validate().is_err());
        settings.shake_strokes = 4;
        settings.tap_peak_threshold = 1.0;
        assert!(
            settings
                .validate()
                .unwrap_err()
                .contains("tapPeakThreshold")
        );
        settings.tap_peak_threshold = 12.0;
        settings.roll_angle_degrees = 10.0;
        assert!(
            settings
                .validate()
                .unwrap_err()
                .contains("rollAngleDegrees")
        );
        settings.roll_angle_degrees = 60.0;
        settings.pitch_angle_degrees = 5.0;
        assert!(
            settings
                .validate()
                .unwrap_err()
                .contains("pitchAngleDegrees")
        );
        settings.pitch_angle_degrees = 40.0;
        settings.swipe_peak_threshold = 40.0;
        assert!(
            settings
                .validate()
                .unwrap_err()
                .contains("swipePeakThreshold")
        );
        // A settings.json from before these existed still loads, with the defaults.
        let mut json = serde_json::to_value(AppSettings::default()).unwrap();
        json.as_object_mut().unwrap().remove("shakePeakThreshold");
        json.as_object_mut().unwrap().remove("shakeStrokes");
        json.as_object_mut().unwrap().remove("crownSide");
        let loaded: AppSettings = serde_json::from_value(json).unwrap();
        assert_eq!(
            (loaded.shake_peak_threshold, loaded.shake_strokes),
            (6.0, 4)
        );
        assert_eq!(loaded.crown_side, automation::CrownSide::Right);
    }

    #[test]
    fn a_settings_file_using_the_old_rotate_name_still_loads_its_angle() {
        let mut json = serde_json::to_value(AppSettings::default()).unwrap();
        json.as_object_mut().unwrap().remove("rollAngleDegrees");
        json["rotateAngleDegrees"] = serde_json::json!(75.0);
        let loaded: AppSettings = serde_json::from_value(json).unwrap();
        assert_eq!(loaded.roll_angle_degrees, 75.0);
    }

    #[test]
    fn defaults_pass_validation() {
        AppSettings::default()
            .validate()
            .expect("defaults must validate");
    }

    #[test]
    fn rejects_out_of_range_rate() {
        let settings = AppSettings {
            watch_orientation_rate_hz: 0.0,
            ..Default::default()
        };
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

    // GC-037: Bluetooth is the default Watch transport, for fresh installs and
    // for settings files written before the field existed.

    #[test]
    fn fresh_settings_select_the_bluetooth_watch_transport() {
        assert_eq!(
            AppSettings::default().watch_transport,
            WatchTransport::Bluetooth
        );
    }

    #[test]
    fn legacy_settings_json_without_a_transport_field_migrates_to_bluetooth() {
        let json = serde_json::json!({
            "headphonesEnabled": true,
            "headphonesRateHz": 60.0,
            "recordingRateHz": 30.0,
            "graphRefreshRateHz": 15.0,
            "watchOrientationRateHz": 50.0,
            "watchAccelerationRateHz": 50.0,
            "watchGyroscopeRateHz": 50.0,
        });
        let settings: AppSettings =
            serde_json::from_value(json).expect("legacy settings must deserialize");
        settings
            .validate()
            .expect("migrated settings must be valid");
        assert_eq!(settings.watch_transport, WatchTransport::Bluetooth);
    }

    #[test]
    fn an_explicit_wifi_choice_survives_a_persistence_round_trip() {
        let settings = AppSettings {
            watch_transport: WatchTransport::WiFi,
            ..Default::default()
        };
        let json = serde_json::to_value(&settings).expect("serializable");
        assert_eq!(json["watchTransport"], "wifi");
        let restored: AppSettings = serde_json::from_value(json).expect("deserializable");
        assert_eq!(restored.watch_transport, WatchTransport::WiFi);
    }

    // GC-035: a connected Watch must receive its current configured motion
    // settings. These test the pure `effective_sensor_enabled` decision that
    // `apply_watch_settings` replays on every `WatchEvent::Connected` (see
    // `lib.rs`) without needing a live `WatchBridgeServer`/connection.

    #[test]
    fn fresh_settings_enable_every_motion_sensor() {
        let settings = AppSettings::default();
        for sensor in [SENSOR_ORIENTATION, SENSOR_ACCELERATION, SENSOR_GYROSCOPE] {
            assert!(
                effective_sensor_enabled(&settings, sensor),
                "{sensor} must be enabled by default"
            );
        }
    }

    #[test]
    fn legacy_settings_json_missing_watch_sensors_enabled_field_defaults_motion_sensors_on() {
        // Simulates a settings.json persisted before `watchSensorsEnabled`
        // existed: the field is absent from the JSON entirely, not merely
        // empty.
        let json = serde_json::json!({
            "headphonesEnabled": true,
            "headphonesRateHz": 60.0,
            "recordingRateHz": 30.0,
            "graphRefreshRateHz": 15.0,
            "watchOrientationRateHz": 50.0,
            "watchAccelerationRateHz": 50.0,
            "watchGyroscopeRateHz": 50.0,
        });
        let settings: AppSettings =
            serde_json::from_value(json).expect("legacy settings must deserialize");
        settings
            .validate()
            .expect("migrated settings must be valid");
        for sensor in [SENSOR_ORIENTATION, SENSOR_ACCELERATION, SENSOR_GYROSCOPE] {
            assert!(
                effective_sensor_enabled(&settings, sensor),
                "{sensor} missing from a legacy settings file must migrate to enabled"
            );
        }
    }

    #[test]
    fn persisted_explicit_disable_is_preserved_while_missing_entries_migrate_to_enabled() {
        // A persisted settings object where the user explicitly disabled
        // orientation, but the file predates acceleration/gyroscope having
        // their own persisted entries.
        let settings = AppSettings {
            watch_sensors_enabled: HashMap::from([(SENSOR_ORIENTATION.to_string(), false)]),
            ..Default::default()
        };
        settings
            .validate()
            .expect("partial map must still validate");

        assert!(
            !effective_sensor_enabled(&settings, SENSOR_ORIENTATION),
            "an explicit user disable must never be force-enabled"
        );
        for sensor in [SENSOR_ACCELERATION, SENSOR_GYROSCOPE] {
            assert!(
                effective_sensor_enabled(&settings, sensor),
                "{sensor} absent from the persisted map must migrate to enabled"
            );
        }
    }

    #[test]
    fn ppg_flush_rate_is_independent_of_motion_sensor_enable_state() {
        // PPG isn't in `watch_sensors_enabled`/`CONTROLLABLE_SENSOR_IDS` at
        // all (it's controlled purely by rate, see `SENSOR_PPG_FLUSH`), so
        // disabling every motion sensor must leave its rate untouched.
        let settings = AppSettings {
            watch_sensors_enabled: HashMap::from([
                (SENSOR_ORIENTATION.to_string(), false),
                (SENSOR_ACCELERATION.to_string(), false),
                (SENSOR_GYROSCOPE.to_string(), false),
            ]),
            ..Default::default()
        };
        assert!(!CONTROLLABLE_SENSOR_IDS.contains(&SENSOR_PPG_FLUSH));
        assert_eq!(
            settings.watch_ppg_flush_rate_hz,
            default_ppg_flush_rate_hz()
        );
    }
}
