use std::process::Command;

use thiserror::Error;

const GET_VOLUME_SCRIPT: &str = "output volume of (get volume settings)";
const SET_VOLUME_SCRIPT: &str =
    "on run argv\nset volume output volume ((item 1 of argv) as integer)\nend run";
const GET_MUTED_SCRIPT: &str = "output muted of (get volume settings)";
const SET_MUTED_SCRIPT: &str = "on run argv\nif item 1 of argv is \"true\" then\nset volume with output muted\nelse\nset volume without output muted\nend if\nend run";

#[derive(Debug, Error, PartialEq)]
pub enum VolumeError {
    #[error("volume must be finite and within 0.0..=1.0")]
    InvalidVolume,
    #[error("native volume control is not available on this platform")]
    UnsupportedPlatform,
    #[error("system volume can only change while the volume overlay is visible")]
    OverlayInactive,
    #[error("volume adjustment must be finite")]
    InvalidAdjustment,
    #[error("native volume backend returned an invalid response: {0}")]
    InvalidResponse(String),
    #[error("native volume backend failed: {0}")]
    Backend(String),
}

pub trait VolumeController: Send + Sync {
    fn get_volume(&self) -> Result<f32, VolumeError>;
    fn set_volume(&self, volume: f32) -> Result<(), VolumeError>;
    fn get_muted(&self) -> Result<bool, VolumeError>;
    fn set_muted(&self, muted: bool) -> Result<(), VolumeError>;
}

pub trait AppleScriptRunner: Send + Sync {
    fn run(&self, script: &str, args: &[String]) -> Result<String, VolumeError>;
}

#[derive(Debug, Default)]
pub struct OsascriptRunner;

impl AppleScriptRunner for OsascriptRunner {
    fn run(&self, script: &str, args: &[String]) -> Result<String, VolumeError> {
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .args(args)
            .output()
            .map_err(|error| VolumeError::Backend(error.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(VolumeError::Backend(if stderr.is_empty() {
                format!("osascript exited with {}", output.status)
            } else {
                stderr
            }));
        }
        String::from_utf8(output.stdout)
            .map_err(|error| VolumeError::InvalidResponse(error.to_string()))
    }
}

#[derive(Debug)]
pub struct MacOsVolumeController<R = OsascriptRunner> {
    runner: R,
}

impl Default for MacOsVolumeController<OsascriptRunner> {
    fn default() -> Self {
        Self {
            runner: OsascriptRunner,
        }
    }
}

impl<R> MacOsVolumeController<R> {
    pub fn with_runner(runner: R) -> Self {
        Self { runner }
    }

    pub fn runner(&self) -> &R {
        &self.runner
    }
}

impl<R: AppleScriptRunner> VolumeController for MacOsVolumeController<R> {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        let response = self.runner.run(GET_VOLUME_SCRIPT, &[])?;
        let percent = response
            .trim()
            .parse::<f32>()
            .map_err(|_| VolumeError::InvalidResponse(response.trim().to_owned()))?;
        if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
            return Err(VolumeError::InvalidResponse(response.trim().to_owned()));
        }
        Ok(percent / 100.0)
    }

    fn set_volume(&self, volume: f32) -> Result<(), VolumeError> {
        validate_volume(volume)?;
        let percent = (volume * 100.0).round() as u8;
        self.runner.run(SET_VOLUME_SCRIPT, &[percent.to_string()])?;
        Ok(())
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        let response = self.runner.run(GET_MUTED_SCRIPT, &[])?;
        match response.trim().to_ascii_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(VolumeError::InvalidResponse(response.trim().to_owned())),
        }
    }

    fn set_muted(&self, muted: bool) -> Result<(), VolumeError> {
        self.runner.run(SET_MUTED_SCRIPT, &[muted.to_string()])?;
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct UnsupportedVolumeController;

impl VolumeController for UnsupportedVolumeController {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }

    fn set_volume(&self, _volume: f32) -> Result<(), VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }

    fn set_muted(&self, _muted: bool) -> Result<(), VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }
}

pub fn platform_volume_controller() -> Box<dyn VolumeController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(MacOsVolumeController::default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(UnsupportedVolumeController)
    }
}

pub fn adjust_system_volume(
    controller: &dyn VolumeController,
    overlay_visible: bool,
    delta_percent: f32,
) -> Result<f32, VolumeError> {
    if !overlay_visible {
        return Err(VolumeError::OverlayInactive);
    }
    if !delta_percent.is_finite() {
        return Err(VolumeError::InvalidAdjustment);
    }
    let current = controller.get_volume()?;
    validate_volume(current)?;
    let updated_percent = (current * 100.0 + delta_percent).clamp(0.0, 100.0).round();
    let updated = updated_percent / 100.0;
    controller.set_volume(updated)?;
    Ok(updated)
}

fn validate_volume(volume: f32) -> Result<(), VolumeError> {
    if volume.is_finite() && (0.0..=1.0).contains(&volume) {
        Ok(())
    } else {
        Err(VolumeError::InvalidVolume)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use std::fs;
    use std::process::Command;

    use super::{GET_MUTED_SCRIPT, GET_VOLUME_SCRIPT, SET_MUTED_SCRIPT, SET_VOLUME_SCRIPT};

    #[test]
    fn applescript_programs_compile() {
        for (index, script) in [
            GET_VOLUME_SCRIPT,
            SET_VOLUME_SCRIPT,
            GET_MUTED_SCRIPT,
            SET_MUTED_SCRIPT,
        ]
        .into_iter()
        .enumerate()
        {
            let directory = std::env::temp_dir().join(format!(
                "gesture-controls-volume-{}-{index}",
                std::process::id()
            ));
            fs::create_dir(&directory).expect("create isolated AppleScript test directory");
            let output = directory.join("script.scpt");
            let result = Command::new("/usr/bin/osacompile")
                .arg("-o")
                .arg(&output)
                .args(["-e", script])
                .output()
                .expect("osacompile must be available on macOS");
            let _ = fs::remove_dir_all(&directory);
            assert!(
                result.status.success(),
                "AppleScript failed to compile: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}
