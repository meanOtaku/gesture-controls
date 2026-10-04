use crate::ControlError;

/// Scrolls whatever is under the pointer. Positive is down, in whole pixels (a line is about 40).
pub trait ScrollController: Send + Sync {
    fn scroll_pixels(&self, pixels: i32) -> Result<(), ControlError>;
}

/// The most one call may scroll, so a glitch cannot throw the page across the screen.
pub const MAX_PIXELS_PER_CALL: i32 = 600;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    use super::*;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn CGEventCreateScrollWheelEvent(
            source: *const c_void,
            units: u32,
            wheel_count: u32,
            wheel1: i32,
            ...
        ) -> *mut c_void;
        fn CGEventPost(tap: u32, event: *mut c_void);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(object: *const c_void);
    }

    const SCROLL_UNIT_PIXEL: u32 = 0;
    const HID_EVENT_TAP: u32 = 0;

    pub struct MacOsScroll;

    impl ScrollController for MacOsScroll {
        fn scroll_pixels(&self, pixels: i32) -> Result<(), ControlError> {
            if pixels == 0 {
                return Ok(());
            }
            // SAFETY: plain C calls with valid arguments; the event is checked for null, posted, then released.
            unsafe {
                if !AXIsProcessTrusted() {
                    return Err(ControlError::PermissionNeeded(
                        "Allow this app under System Settings > Privacy & Security > Accessibility to scroll".into(),
                    ));
                }
                // On macOS a positive wheel value scrolls up, so scrolling down is negative.
                let event =
                    CGEventCreateScrollWheelEvent(std::ptr::null(), SCROLL_UNIT_PIXEL, 1, -pixels);
                if event.is_null() {
                    return Err(ControlError::Backend(
                        "could not create a scroll event".into(),
                    ));
                }
                CGEventPost(HID_EVENT_TAP, event);
                CFRelease(event);
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
struct LinuxScroll;

#[cfg(target_os = "linux")]
impl ScrollController for LinuxScroll {
    fn scroll_pixels(&self, pixels: i32) -> Result<(), ControlError> {
        use std::process::{Command, Stdio};
        let clicks = (pixels.unsigned_abs() / 40).max(u32::from(pixels != 0));
        if pixels == 0 {
            return Ok(());
        }
        // X11 button 5 is wheel down, 4 is wheel up. Wayland sessions have no equivalent without extra tools.
        let button = if pixels > 0 { "5" } else { "4" };
        let output = Command::new("xdotool")
            .args(["click", "--repeat", &clicks.to_string(), button])
            .stdin(Stdio::null())
            .output()
            .map_err(|_| {
                ControlError::Unsupported("scrolling (install xdotool; X11 sessions only)")
            })?;
        if output.status.success() {
            Ok(())
        } else {
            Err(ControlError::Backend(format!(
                "xdotool failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
}

#[cfg(target_os = "windows")]
struct WindowsScroll;

#[cfg(target_os = "windows")]
impl ScrollController for WindowsScroll {
    fn scroll_pixels(&self, pixels: i32) -> Result<(), ControlError> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
        };
        if pixels == 0 {
            return Ok(());
        }
        // One wheel notch is 120 units and about 40 pixels; negative scrolls down.
        let units = -(pixels * 3);
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: units as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        // SAFETY: one fully initialised INPUT and its true size.
        let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            Err(ControlError::Backend(
                "Windows refused the scroll input".into(),
            ))
        }
    }
}

#[allow(dead_code)] // only the fallback on platforms without an adapter, and tests
struct UnsupportedScroll;

impl ScrollController for UnsupportedScroll {
    fn scroll_pixels(&self, _pixels: i32) -> Result<(), ControlError> {
        Err(ControlError::Unsupported("scrolling"))
    }
}

pub fn platform_scroll_controller() -> Box<dyn ScrollController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacOsScroll)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxScroll)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsScroll)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Box::new(UnsupportedScroll)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unsupported_platform_says_so() {
        assert_eq!(
            UnsupportedScroll.scroll_pixels(40),
            Err(ControlError::Unsupported("scrolling"))
        );
    }
}
