use crate::ControlError;

/// A transport key on a keyboard or headset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaKey {
    PlayPause,
    NextTrack,
    PreviousTrack,
}

/// Presses a media key once, as if it had been pressed on a keyboard, so whatever app is playing responds.
pub trait MediaController: Send + Sync {
    fn press(&self, key: MediaKey) -> Result<(), ControlError>;
}

/// The macOS "special key" code (`NX_KEYTYPE_*`) for a media key.
#[cfg(any(target_os = "macos", test))]
fn macos_key_type(key: MediaKey) -> u32 {
    match key {
        MediaKey::PlayPause => 16,
        MediaKey::NextTrack => 17,
        MediaKey::PreviousTrack => 18,
    }
}

/// JavaScript for Automation that posts a system-defined key down and up, which is how the media keys reach apps.
#[cfg(any(target_os = "macos", test))]
fn macos_script(key: MediaKey) -> String {
    format!(
        "ObjC.import('AppKit');\n\
         function post(down) {{\n\
           var flags = down ? 0xa00 : 0xb00;\n\
           var data = ({code} << 16) | ((down ? 0xa : 0xb) << 8);\n\
           var event = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(\n\
             14, $.NSMakePoint(0, 0), flags, 0, 0, 0, 8, data, -1);\n\
           $.CGEventPost(0, event.CGEvent);\n\
         }}\n\
         post(true);\n\
         post(false);",
        code = macos_key_type(key)
    )
}

#[cfg(target_os = "macos")]
struct MacOsMedia;

#[cfg(target_os = "macos")]
impl MediaController for MacOsMedia {
    fn press(&self, key: MediaKey) -> Result<(), ControlError> {
        use std::process::{Command, Stdio};
        let output = Command::new("osascript")
            .args(["-l", "JavaScript", "-e", &macos_script(key)])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| ControlError::Backend(format!("could not run osascript: {error}")))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(ControlError::Backend(format!(
                "media key failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn playerctl_argument(key: MediaKey) -> &'static str {
    match key {
        MediaKey::PlayPause => "play-pause",
        MediaKey::NextTrack => "next",
        MediaKey::PreviousTrack => "previous",
    }
}

#[cfg(target_os = "linux")]
struct LinuxMedia;

#[cfg(target_os = "linux")]
impl MediaController for LinuxMedia {
    fn press(&self, key: MediaKey) -> Result<(), ControlError> {
        use std::process::{Command, Stdio};
        let output = Command::new("playerctl")
            .arg(playerctl_argument(key))
            .stdin(Stdio::null())
            .output()
            .map_err(|_| ControlError::Unsupported("media keys (install playerctl)"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(ControlError::Backend(format!(
                "playerctl failed (is a player running?): {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
}

/// The Windows virtual-key code for a media key.
#[cfg(any(target_os = "windows", test))]
fn windows_virtual_key(key: MediaKey) -> u16 {
    match key {
        MediaKey::PlayPause => 0xB3,
        MediaKey::NextTrack => 0xB0,
        MediaKey::PreviousTrack => 0xB1,
    }
}

#[cfg(target_os = "windows")]
struct WindowsMedia;

#[cfg(target_os = "windows")]
impl MediaController for WindowsMedia {
    fn press(&self, key: MediaKey) -> Result<(), ControlError> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
            SendInput, VIRTUAL_KEY,
        };
        let event = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(windows_virtual_key(key)),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [event(KEYBD_EVENT_FLAGS(0)), event(KEYEVENTF_KEYUP)];
        // SAFETY: two fully initialised INPUTs and their true size.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == 2 {
            Ok(())
        } else {
            Err(ControlError::Backend(
                "Windows refused the media key".into(),
            ))
        }
    }
}

#[allow(dead_code)] // only the fallback on platforms without an adapter, and tests
struct UnsupportedMedia;

impl MediaController for UnsupportedMedia {
    fn press(&self, _key: MediaKey) -> Result<(), ControlError> {
        Err(ControlError::Unsupported("media keys"))
    }
}

pub fn platform_media_controller() -> Box<dyn MediaController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(MacOsMedia)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxMedia)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsMedia)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Box::new(UnsupportedMedia)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_key_maps_to_its_platform_code() {
        assert_eq!(macos_key_type(MediaKey::PlayPause), 16);
        assert_eq!(macos_key_type(MediaKey::NextTrack), 17);
        assert_eq!(macos_key_type(MediaKey::PreviousTrack), 18);
        assert_eq!(windows_virtual_key(MediaKey::PlayPause), 0xB3);
        assert_eq!(windows_virtual_key(MediaKey::NextTrack), 0xB0);
        assert_eq!(windows_virtual_key(MediaKey::PreviousTrack), 0xB1);
        assert_eq!(playerctl_argument(MediaKey::PlayPause), "play-pause");
        assert_eq!(playerctl_argument(MediaKey::PreviousTrack), "previous");
    }

    #[test]
    fn the_mac_script_posts_a_key_down_then_up_for_the_right_key() {
        let script = macos_script(MediaKey::NextTrack);
        assert!(script.contains("(17 << 16)"));
        assert!(script.find("post(true)").unwrap() < script.find("post(false)").unwrap());
    }

    #[test]
    fn an_unsupported_platform_says_so() {
        assert_eq!(
            UnsupportedMedia.press(MediaKey::PlayPause),
            Err(ControlError::Unsupported("media keys"))
        );
    }
}
