use crate::ControlError;

/// Changes the display brightness in whole steps. Some platforms can only press the brightness keys (so a step is
/// a sixteenth of the range); others can set a percentage, so a step is one percent.
pub trait BrightnessController: Send + Sync {
    /// How much of the full range one step is, in percent.
    fn step_percent(&self) -> f64;
    /// Moves brightness by `steps` (negative is dimmer).
    fn adjust_steps(&self, steps: i32) -> Result<(), ControlError>;
}

#[cfg(unix)]
fn run(program: &str, args: &[&str]) -> Result<(), ControlError> {
    use std::process::{Command, Stdio};
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| ControlError::Backend(format!("could not run {program}: {error}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(ControlError::Backend(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

/// The AppleScript that presses the brightness-up or -down key `count` times in one go.
#[cfg(any(target_os = "macos", test))]
fn macos_key_script(steps: i32) -> Option<String> {
    if steps == 0 {
        return None;
    }
    // Key codes 144 and 145 are the brightness up and down keys on Apple keyboards.
    let code = if steps > 0 { 144 } else { 145 };
    Some(format!(
        "tell application \"System Events\"\nrepeat {} times\nkey code {code}\nend repeat\nend tell",
        steps.unsigned_abs().min(32)
    ))
}

#[cfg(target_os = "macos")]
struct MacOsBrightness;

#[cfg(target_os = "macos")]
impl BrightnessController for MacOsBrightness {
    fn step_percent(&self) -> f64 {
        100.0 / 16.0
    }

    fn adjust_steps(&self, steps: i32) -> Result<(), ControlError> {
        let Some(script) = macos_key_script(steps) else {
            return Ok(());
        };
        run("osascript", &["-e", &script]).map_err(|error| match error {
            ControlError::Backend(message) if message.contains("not allowed") || message.contains("1002") => {
                ControlError::PermissionNeeded(
                    "Allow this app under System Settings > Privacy & Security > Accessibility to change brightness"
                        .into(),
                )
            }
            other => other,
        })
    }
}

#[cfg(target_os = "linux")]
struct LinuxBrightness;

#[cfg(target_os = "linux")]
impl BrightnessController for LinuxBrightness {
    fn step_percent(&self) -> f64 {
        1.0
    }

    fn adjust_steps(&self, steps: i32) -> Result<(), ControlError> {
        if steps == 0 {
            return Ok(());
        }
        // brightnessctl puts the sign before the number to raise and after it to lower.
        let argument = if steps > 0 {
            format!("+{steps}%")
        } else {
            format!("{}%-", steps.unsigned_abs())
        };
        run("brightnessctl", &["set", &argument]).map_err(|error| match error {
            ControlError::Backend(message) if message.contains("could not run") => {
                ControlError::Unsupported("brightness (install brightnessctl)")
            }
            other => other,
        })
    }
}

#[cfg(target_os = "windows")]
struct WindowsBrightness;

#[cfg(target_os = "windows")]
impl BrightnessController for WindowsBrightness {
    fn step_percent(&self) -> f64 {
        1.0
    }

    fn adjust_steps(&self, steps: i32) -> Result<(), ControlError> {
        use std::process::{Command, Stdio};
        if steps == 0 {
            return Ok(());
        }
        // Built-in displays only: external monitors do not expose WMI brightness.
        let script = format!(
            "$b=(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness;\
             $n=[Math]::Max(0,[Math]::Min(100,$b+({steps})));\
             Invoke-CimMethod -InputObject (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods) \
             -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness=$n}} | Out-Null"
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| ControlError::Backend(format!("could not run powershell: {error}")))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(ControlError::Backend(format!(
                "brightness change failed (only built-in displays are supported): {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
}

#[allow(dead_code)] // only the fallback on platforms without an adapter, and tests
struct UnsupportedBrightness;

impl BrightnessController for UnsupportedBrightness {
    fn step_percent(&self) -> f64 {
        1.0
    }

    fn adjust_steps(&self, _steps: i32) -> Result<(), ControlError> {
        Err(ControlError::Unsupported("brightness control"))
    }
}

pub fn platform_brightness_controller() -> Box<dyn BrightnessController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(MacOsBrightness)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxBrightness)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsBrightness)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Box::new(UnsupportedBrightness)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mac_script_presses_the_right_key_the_right_number_of_times() {
        assert_eq!(macos_key_script(0), None);
        let up = macos_key_script(3).unwrap();
        assert!(up.contains("repeat 3 times") && up.contains("key code 144"));
        let down = macos_key_script(-2).unwrap();
        assert!(down.contains("repeat 2 times") && down.contains("key code 145"));
        // A runaway request is capped rather than hammering the keyboard.
        assert!(macos_key_script(1000).unwrap().contains("repeat 32 times"));
    }

    #[test]
    fn an_unsupported_platform_says_so() {
        let controller = UnsupportedBrightness;
        assert_eq!(
            controller.adjust_steps(1),
            Err(ControlError::Unsupported("brightness control"))
        );
    }
}
