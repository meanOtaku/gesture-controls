use crate::ControlError;

/// Changes the display brightness in whole steps. Some platforms can only press the brightness keys (so a step is
/// a sixteenth of the range); others can set a percentage, so a step is one percent.
pub trait BrightnessController: Send + Sync {
    /// How much of the full range one step is, in percent.
    fn step_percent(&self) -> f64;
    /// Moves brightness by `steps` (negative is dimmer).
    fn adjust_steps(&self, steps: i32) -> Result<(), ControlError>;
    /// The brightness now, in percent, when this platform can read it.
    fn level(&self) -> Option<f64> {
        None
    }
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

/// The Mac's built-in display brightness set directly, through macOS's DisplayServices framework: one-percent steps,
/// no AppleScript, and no Accessibility permission. DisplayServices is not public API, so it is loaded at run time and
/// the app falls back to pressing the brightness keys when it is missing or the main display is not one it controls
/// (an external monitor).
#[cfg(target_os = "macos")]
mod display_services {
    use std::ffi::{c_char, c_void};
    use std::sync::OnceLock;

    type GetBrightness = unsafe extern "C" fn(display: u32, brightness: *mut f32) -> i32;
    type SetBrightness = unsafe extern "C" fn(display: u32, brightness: f32) -> i32;

    unsafe extern "C" {
        fn dlopen(path: *const c_char, mode: i32) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
    }

    const RTLD_LAZY: i32 = 1;

    #[derive(Clone, Copy)]
    pub struct DisplayServices {
        get: GetBrightness,
        set: SetBrightness,
    }

    impl DisplayServices {
        /// The framework, once per process; `None` when this macOS does not have it.
        pub fn load() -> Option<Self> {
            static LOADED: OnceLock<Option<DisplayServices>> = OnceLock::new();
            *LOADED.get_or_init(|| {
                // SAFETY: valid C strings; a null result is checked before use, and the symbols have the signatures
                // DisplayServices has had since macOS 10.12.
                unsafe {
                    let handle = dlopen(
                        c"/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices".as_ptr(),
                        RTLD_LAZY,
                    );
                    if handle.is_null() {
                        return None;
                    }
                    let get = dlsym(handle, c"DisplayServicesGetBrightness".as_ptr());
                    let set = dlsym(handle, c"DisplayServicesSetBrightness".as_ptr());
                    if get.is_null() || set.is_null() {
                        return None;
                    }
                    Some(DisplayServices {
                        get: std::mem::transmute::<*mut c_void, GetBrightness>(get),
                        set: std::mem::transmute::<*mut c_void, SetBrightness>(set),
                    })
                }
            })
        }

        /// The main display's brightness, 0 to 1.
        pub fn brightness(&self) -> Option<f32> {
            let mut value = -1.0f32;
            // SAFETY: a valid display id and a pointer to an f32.
            let status = unsafe { (self.get)(CGMainDisplayID(), &mut value) };
            (status == 0 && value.is_finite() && (0.0..=1.0).contains(&value)).then_some(value)
        }

        pub fn set_brightness(&self, value: f32) -> bool {
            // SAFETY: a valid display id and a value in range.
            unsafe { (self.set)(CGMainDisplayID(), value.clamp(0.0, 1.0)) == 0 }
        }
    }
}

/// Sets the main display's brightness in one-percent steps through DisplayServices when the display allows it, else
/// presses the brightness keys (a sixteenth of the range each) through AppleScript. Which one is chosen once, when the
/// controller is made.
#[cfg(target_os = "macos")]
struct MacOsBrightness {
    direct: Option<display_services::DisplayServices>,
}

#[cfg(target_os = "macos")]
impl MacOsBrightness {
    fn new() -> Self {
        let direct = display_services::DisplayServices::load()
            .filter(|services| services.brightness().is_some());
        Self { direct }
    }
}

/// The brightness after moving `current` (0 to 1) by `steps` percent.
#[cfg(any(target_os = "macos", test))]
fn moved_by_percent(current: f32, steps: i32) -> f32 {
    (current + steps as f32 / 100.0).clamp(0.0, 1.0)
}

#[cfg(target_os = "macos")]
impl BrightnessController for MacOsBrightness {
    fn level(&self) -> Option<f64> {
        self.direct
            .and_then(|services| services.brightness())
            .map(|value| f64::from(value) * 100.0)
    }

    fn step_percent(&self) -> f64 {
        if self.direct.is_some() {
            1.0
        } else {
            100.0 / 16.0
        }
    }

    fn adjust_steps(&self, steps: i32) -> Result<(), ControlError> {
        if let Some(services) = self.direct {
            if steps == 0 {
                return Ok(());
            }
            let current = services.brightness().ok_or_else(|| {
                ControlError::Backend("the main display no longer reports its brightness".into())
            })?;
            return if services.set_brightness(moved_by_percent(current, steps)) {
                Ok(())
            } else {
                Err(ControlError::Backend(
                    "the main display refused the brightness change".into(),
                ))
            };
        }
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
    fn level(&self) -> Option<f64> {
        let output = std::process::Command::new("brightnessctl")
            .arg("-m")
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| brightnessctl_percent(&String::from_utf8_lossy(&output.stdout)))
            .flatten()
    }

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

/// The percentage in `brightnessctl -m`'s machine-readable line: `device,class,current,percent%,max`.
#[cfg(any(target_os = "linux", test))]
fn brightnessctl_percent(output: &str) -> Option<f64> {
    let percent = output
        .lines()
        .next()?
        .split(',')
        .nth(3)?
        .trim()
        .strip_suffix('%')?;
    percent
        .parse::<f64>()
        .ok()
        .filter(|p| p.is_finite() && (0.0..=100.0).contains(p))
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

/// Does the slow once-per-process part of brightness control now: on a Mac, loading DisplayServices and its first
/// read take several seconds. Call it on a background thread at start-up, so the first gesture does not wait.
pub fn prepare_brightness() {
    #[cfg(target_os = "macos")]
    {
        let _ =
            display_services::DisplayServices::load().and_then(|services| services.brightness());
    }
}

pub fn platform_brightness_controller() -> Box<dyn BrightnessController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(MacOsBrightness::new())
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
    fn brightnessctl_reports_its_percentage() {
        assert_eq!(
            brightnessctl_percent("intel_backlight,backlight,9600,50%,19200\n"),
            Some(50.0)
        );
        assert_eq!(brightnessctl_percent("garbage"), None);
        assert_eq!(brightnessctl_percent(""), None);
    }

    #[test]
    fn a_direct_change_moves_by_whole_percent_and_stops_at_the_ends() {
        assert!((moved_by_percent(0.5, 3) - 0.53).abs() < 1e-6);
        assert!((moved_by_percent(0.5, -10) - 0.40).abs() < 1e-6);
        assert_eq!(moved_by_percent(0.98, 5), 1.0);
        assert_eq!(moved_by_percent(0.01, -5), 0.0);
    }

    /// Reads the real main display's brightness through DisplayServices and sets the same value back.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches the real display; run with --ignored"]
    fn display_services_reads_and_rewrites_the_real_brightness() {
        let start = std::time::Instant::now();
        let services = display_services::DisplayServices::load().expect("DisplayServices loads");
        let value = services
            .brightness()
            .expect("the main display reports its brightness");
        let first = start.elapsed();
        let start = std::time::Instant::now();
        assert!(services.set_brightness(value));
        assert!(services.brightness().is_some());
        println!(
            "brightness {value}: loading and the first read {first:?}, then a write and a read {:?}",
            start.elapsed()
        );
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
