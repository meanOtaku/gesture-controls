use crate::ControlError;

/// Moves the mouse pointer and presses its left button.
pub trait PointerController: Send + Sync {
    /// Moves the pointer by whole pixels, right and down positive. With `dragging` the left button is down, so the
    /// move is a drag. The pointer stays on a screen.
    fn move_by(&self, dx: i32, dy: i32, dragging: bool) -> Result<(), ControlError>;
    /// Presses (`true`) or lets go of the left button where the pointer is.
    fn button(&self, down: bool) -> Result<(), ControlError>;
    /// Presses and lets go of the left button.
    fn click(&self) -> Result<(), ControlError> {
        self.button(true)?;
        self.button(false)
    }
    /// The width and height, in the pixels [`Self::move_by`] counts, of the screen the pointer is on, when known.
    fn screen_size(&self) -> Option<(f64, f64)> {
        None
    }
}

/// The most one call may move, so a glitch cannot throw the pointer across the screen.
pub const MAX_POINTER_PIXELS_PER_CALL: i32 = 400;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    use super::*;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub(super) struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CGEventCreateMouseEvent(
            source: *const c_void,
            kind: u32,
            at: CGPoint,
            button: u32,
        ) -> *mut c_void;
        fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
        fn CGEventPost(tap: u32, event: *mut c_void);
        fn CGGetDisplaysWithPoint(
            at: CGPoint,
            max: u32,
            displays: *mut u32,
            count: *mut u32,
        ) -> i32;
        fn CGDisplayBounds(display: u32) -> CGRect;
        fn CGMainDisplayID() -> u32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(object: *const c_void);
    }

    const LEFT_MOUSE_DOWN: u32 = 1;
    const LEFT_MOUSE_UP: u32 = 2;
    const MOUSE_MOVED: u32 = 5;
    const LEFT_MOUSE_DRAGGED: u32 = 6;
    const LEFT_BUTTON: u32 = 0;
    const CLICK_STATE: u32 = 1;
    const HID_EVENT_TAP: u32 = 0;

    fn trusted() -> Result<(), ControlError> {
        // SAFETY: a plain query.
        if unsafe { AXIsProcessTrusted() } {
            Ok(())
        } else {
            Err(ControlError::PermissionNeeded(
                "Allow this app under System Settings > Privacy & Security > Accessibility to move the pointer".into(),
            ))
        }
    }

    fn location() -> Result<CGPoint, ControlError> {
        // SAFETY: an empty event is made only to read where the pointer is, then released.
        unsafe {
            let event = CGEventCreate(std::ptr::null());
            if event.is_null() {
                return Err(ControlError::Backend(
                    "could not read where the pointer is".into(),
                ));
            }
            let at = CGEventGetLocation(event);
            CFRelease(event);
            Ok(at)
        }
    }

    fn display_at(at: CGPoint) -> Option<u32> {
        let mut display = 0u32;
        let mut count = 0u32;
        // SAFETY: room for one display id, and its count.
        let status = unsafe { CGGetDisplaysWithPoint(at, 1, &mut display, &mut count) };
        (status == 0 && count > 0).then_some(display)
    }

    /// `to`, or the nearest point on the screen `from` is on when `to` is off every screen.
    pub(super) fn on_a_screen(from: CGPoint, to: CGPoint) -> CGPoint {
        if display_at(to).is_some() {
            return to;
        }
        // SAFETY: a plain query.
        let bounds =
            unsafe { CGDisplayBounds(display_at(from).unwrap_or_else(|| CGMainDisplayID())) };
        CGPoint {
            x: to
                .x
                .clamp(bounds.origin.x, bounds.origin.x + bounds.size.width - 1.0),
            y: to
                .y
                .clamp(bounds.origin.y, bounds.origin.y + bounds.size.height - 1.0),
        }
    }

    fn post(kind: u32, at: CGPoint, click_state: Option<i64>) -> Result<(), ControlError> {
        // SAFETY: the event is checked for null, posted, then released.
        unsafe {
            let event = CGEventCreateMouseEvent(std::ptr::null(), kind, at, LEFT_BUTTON);
            if event.is_null() {
                return Err(ControlError::Backend(
                    "could not create a mouse event".into(),
                ));
            }
            if let Some(state) = click_state {
                CGEventSetIntegerValueField(event, CLICK_STATE, state);
            }
            CGEventPost(HID_EVENT_TAP, event);
            CFRelease(event);
        }
        Ok(())
    }

    pub struct MacOsPointer;

    impl PointerController for MacOsPointer {
        fn screen_size(&self) -> Option<(f64, f64)> {
            let display = location().ok().and_then(display_at);
            // SAFETY: plain queries.
            let bounds = unsafe { CGDisplayBounds(display.unwrap_or_else(|| CGMainDisplayID())) };
            (bounds.size.width > 0.0 && bounds.size.height > 0.0)
                .then_some((bounds.size.width, bounds.size.height))
        }

        fn move_by(&self, dx: i32, dy: i32, dragging: bool) -> Result<(), ControlError> {
            if dx == 0 && dy == 0 {
                return Ok(());
            }
            trusted()?;
            let from = location()?;
            let to = on_a_screen(
                from,
                CGPoint {
                    x: from.x + f64::from(dx),
                    y: from.y + f64::from(dy),
                },
            );
            post(
                if dragging {
                    LEFT_MOUSE_DRAGGED
                } else {
                    MOUSE_MOVED
                },
                to,
                None,
            )
        }

        fn button(&self, down: bool) -> Result<(), ControlError> {
            trusted()?;
            post(
                if down { LEFT_MOUSE_DOWN } else { LEFT_MOUSE_UP },
                location()?,
                Some(1),
            )
        }
    }
}

#[cfg(target_os = "linux")]
struct LinuxPointer;

#[cfg(target_os = "linux")]
impl LinuxPointer {
    fn xdotool(args: &[&str]) -> Result<(), ControlError> {
        use std::process::{Command, Stdio};
        let output = Command::new("xdotool")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|_| {
                ControlError::Unsupported("the pointer (install xdotool; X11 sessions only)")
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

#[cfg(target_os = "linux")]
impl PointerController for LinuxPointer {
    fn move_by(&self, dx: i32, dy: i32, _dragging: bool) -> Result<(), ControlError> {
        if dx == 0 && dy == 0 {
            return Ok(());
        }
        Self::xdotool(&["mousemove_relative", "--", &dx.to_string(), &dy.to_string()])
    }

    fn button(&self, down: bool) -> Result<(), ControlError> {
        Self::xdotool(&[if down { "mousedown" } else { "mouseup" }, "1"])
    }

    fn click(&self) -> Result<(), ControlError> {
        Self::xdotool(&["click", "1"])
    }
}

#[cfg(target_os = "windows")]
struct WindowsPointer;

#[cfg(target_os = "windows")]
impl WindowsPointer {
    fn send(
        dx: i32,
        dy: i32,
        flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    ) -> Result<(), ControlError> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_MOUSE, MOUSEINPUT, SendInput,
        };
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: 0,
                    dwFlags: flags,
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
                "Windows refused the mouse input".into(),
            ))
        }
    }
}

#[cfg(target_os = "windows")]
impl PointerController for WindowsPointer {
    fn move_by(&self, dx: i32, dy: i32, _dragging: bool) -> Result<(), ControlError> {
        use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE;
        if dx == 0 && dy == 0 {
            return Ok(());
        }
        Self::send(dx, dy, MOUSEEVENTF_MOVE)
    }

    fn button(&self, down: bool) -> Result<(), ControlError> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        };
        Self::send(
            0,
            0,
            if down {
                MOUSEEVENTF_LEFTDOWN
            } else {
                MOUSEEVENTF_LEFTUP
            },
        )
    }
}

#[allow(dead_code)] // only the fallback on platforms without an adapter, and tests
struct UnsupportedPointer;

impl PointerController for UnsupportedPointer {
    fn move_by(&self, _dx: i32, _dy: i32, _dragging: bool) -> Result<(), ControlError> {
        Err(ControlError::Unsupported("the pointer"))
    }

    fn button(&self, _down: bool) -> Result<(), ControlError> {
        Err(ControlError::Unsupported("the pointer"))
    }
}

pub fn platform_pointer_controller() -> Box<dyn PointerController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacOsPointer)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxPointer)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsPointer)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Box::new(UnsupportedPointer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unsupported_platform_says_so() {
        assert_eq!(
            UnsupportedPointer.move_by(1, 1, false),
            Err(ControlError::Unsupported("the pointer"))
        );
        assert_eq!(
            UnsupportedPointer.click(),
            Err(ControlError::Unsupported("the pointer"))
        );
    }

    /// Moves the real pointer 3 px right and back. Needs Accessibility permission for whatever runs the test.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "moves the real pointer; run with --ignored"]
    fn the_real_pointer_moves_and_comes_back() {
        let pointer = platform_pointer_controller();
        match pointer.move_by(3, 0, false) {
            Err(ControlError::PermissionNeeded(message)) => println!("not allowed: {message}"),
            other => {
                other.unwrap();
                pointer.move_by(-3, 0, false).unwrap();
                println!("moved the pointer and back");
            }
        }
    }

    /// A point far off every screen is brought back to the edge of the screen the pointer is on.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_move_off_the_screen_stops_at_its_edge() {
        use macos::{CGPoint, on_a_screen};
        let from = CGPoint { x: 10.0, y: 10.0 };
        let to = on_a_screen(
            from,
            CGPoint {
                x: -100_000.0,
                y: 10.0,
            },
        );
        assert!(to.x > -100_000.0 && to.y == 10.0, "{to:?}");
        assert_eq!(
            on_a_screen(from, CGPoint { x: 20.0, y: 20.0 }),
            CGPoint { x: 20.0, y: 20.0 }
        );
    }
}
