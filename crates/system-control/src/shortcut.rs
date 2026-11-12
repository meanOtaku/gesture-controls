//! Presses a keyboard shortcut once, as if it had been typed, so a gesture can do anything a key can.
//!
//! A shortcut is written the way people say it: `cmd+shift+4`, `ctrl+alt+left`, `f5`. It must have a modifier unless
//! its key types nothing (a function key, an arrow, Escape and the like): a bare letter would be typed into whatever
//! has the keyboard.

use std::fmt;
use std::str::FromStr;

use crate::ControlError;

/// A key that is not a letter or a digit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NamedKey {
    Space,
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
}

const NAMED: [(&str, NamedKey); 14] = [
    ("space", NamedKey::Space),
    ("enter", NamedKey::Enter),
    ("tab", NamedKey::Tab),
    ("escape", NamedKey::Escape),
    ("backspace", NamedKey::Backspace),
    ("delete", NamedKey::Delete),
    ("left", NamedKey::Left),
    ("right", NamedKey::Right),
    ("up", NamedKey::Up),
    ("down", NamedKey::Down),
    ("home", NamedKey::Home),
    ("end", NamedKey::End),
    ("pageup", NamedKey::PageUp),
    ("pagedown", NamedKey::PageDown),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    /// `a` to `z`, lowercase.
    Letter(char),
    /// `0` to `9`.
    Digit(char),
    /// F1 to F12.
    Function(u8),
    Named(NamedKey),
}

/// One key with the modifiers held while it is pressed. `command` is the Windows key on Windows and Super on Linux.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct KeyCombo {
    pub command: bool,
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: Key,
}

impl KeyCombo {
    fn has_modifier(&self) -> bool {
        self.command || self.control || self.alt
    }
}

impl FromStr for KeyCombo {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        let mut combo = KeyCombo {
            command: false,
            control: false,
            alt: false,
            shift: false,
            key: Key::Named(NamedKey::Space),
        };
        let mut key = None;
        for part in text.split('+').map(|part| part.trim().to_ascii_lowercase()) {
            let modifier = match part.as_str() {
                "cmd" | "command" | "meta" | "super" | "win" => Some(&mut combo.command),
                "ctrl" | "control" => Some(&mut combo.control),
                "alt" | "option" | "opt" => Some(&mut combo.alt),
                "shift" => Some(&mut combo.shift),
                _ => None,
            };
            if let Some(held) = modifier {
                if std::mem::replace(held, true) {
                    return Err(format!("'{part}' is there twice"));
                }
                continue;
            }
            if key.is_some() {
                return Err("a shortcut has one key after its modifiers, as in cmd+shift+k".into());
            }
            let mut chars = part.chars();
            key = Some(match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_lowercase() => Key::Letter(c),
                (Some(c), None) if c.is_ascii_digit() => Key::Digit(c),
                _ => {
                    let function = part
                        .strip_prefix('f')
                        .and_then(|n| n.parse::<u8>().ok())
                        .filter(|n| (1..=12).contains(n));
                    let named = match part.as_str() {
                        "return" => Some(NamedKey::Enter),
                        "esc" => Some(NamedKey::Escape),
                        other => NAMED
                            .iter()
                            .find(|(name, _)| *name == other)
                            .map(|(_, k)| *k),
                    };
                    match (function, named) {
                        (Some(n), _) => Key::Function(n),
                        (None, Some(named)) => Key::Named(named),
                        _ if part.is_empty() => {
                            return Err("a shortcut needs a key, as in cmd+shift+k".into());
                        }
                        _ => {
                            return Err(format!(
                                "'{part}' is not a key this app can press: use a letter, a digit, f1 to f12, or one of space, enter, tab, escape, backspace, delete, left, right, up, down, home, end, pageup, pagedown"
                            ));
                        }
                    }
                }
            });
        }
        combo.key = key.ok_or("a shortcut needs a key, as in cmd+shift+k")?;
        let types = matches!(
            combo.key,
            Key::Letter(_)
                | Key::Digit(_)
                | Key::Named(
                    NamedKey::Space
                        | NamedKey::Enter
                        | NamedKey::Tab
                        | NamedKey::Backspace
                        | NamedKey::Delete
                )
        );
        if types && !combo.has_modifier() {
            return Err(
                "add cmd, ctrl or alt: that key alone would type into whatever has the keyboard"
                    .into(),
            );
        }
        Ok(combo)
    }
}

impl fmt::Display for KeyCombo {
    /// The one way to write it: modifiers in the order cmd, ctrl, alt, shift, then the key, all lowercase.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (held, name) in [
            (self.command, "cmd"),
            (self.control, "ctrl"),
            (self.alt, "alt"),
            (self.shift, "shift"),
        ] {
            if held {
                write!(f, "{name}+")?;
            }
        }
        match self.key {
            Key::Letter(c) | Key::Digit(c) => write!(f, "{c}"),
            Key::Function(n) => write!(f, "f{n}"),
            Key::Named(named) => {
                let name = NAMED
                    .iter()
                    .find(|(_, k)| *k == named)
                    .map_or("", |(name, _)| name);
                write!(f, "{name}")
            }
        }
    }
}

/// Presses a shortcut once: its modifiers down, the key down and up, the modifiers up.
pub trait ShortcutController: Send + Sync {
    fn press(&self, combo: &KeyCombo) -> Result<(), ControlError>;
}

/// The macOS virtual key code (ANSI layout) for a key.
#[cfg(any(target_os = "macos", test))]
fn macos_key_code(key: Key) -> u16 {
    match key {
        Key::Letter(c) => match c {
            'a' => 0,
            's' => 1,
            'd' => 2,
            'f' => 3,
            'h' => 4,
            'g' => 5,
            'z' => 6,
            'x' => 7,
            'c' => 8,
            'v' => 9,
            'b' => 11,
            'q' => 12,
            'w' => 13,
            'e' => 14,
            'r' => 15,
            'y' => 16,
            't' => 17,
            'o' => 31,
            'u' => 32,
            'i' => 34,
            'p' => 35,
            'l' => 37,
            'j' => 38,
            'k' => 40,
            'n' => 45,
            _ => 46, // m
        },
        Key::Digit(c) => match c {
            '1' => 18,
            '2' => 19,
            '3' => 20,
            '4' => 21,
            '5' => 23,
            '6' => 22,
            '7' => 26,
            '8' => 28,
            '9' => 25,
            _ => 29, // 0
        },
        Key::Function(n) => match n {
            1 => 122,
            2 => 120,
            3 => 99,
            4 => 118,
            5 => 96,
            6 => 97,
            7 => 98,
            8 => 100,
            9 => 101,
            10 => 109,
            11 => 103,
            _ => 111,
        },
        Key::Named(named) => match named {
            NamedKey::Space => 49,
            NamedKey::Enter => 36,
            NamedKey::Tab => 48,
            NamedKey::Escape => 53,
            NamedKey::Backspace => 51,
            NamedKey::Delete => 117,
            NamedKey::Left => 123,
            NamedKey::Right => 124,
            NamedKey::Down => 125,
            NamedKey::Up => 126,
            NamedKey::Home => 115,
            NamedKey::End => 119,
            NamedKey::PageUp => 116,
            NamedKey::PageDown => 121,
        },
    }
}

/// The macOS event flags for a shortcut's modifiers.
#[cfg(any(target_os = "macos", test))]
fn macos_flags(combo: &KeyCombo) -> u64 {
    [
        (combo.shift, 0x0002_0000u64),
        (combo.control, 0x0004_0000),
        (combo.alt, 0x0008_0000),
        (combo.command, 0x0010_0000),
    ]
    .iter()
    .filter(|(held, _)| *held)
    .map(|(_, flag)| flag)
    .sum()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    use super::*;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
        fn CGEventSetFlags(event: *mut c_void, flags: u64);
        fn CGEventPost(tap: u32, event: *mut c_void);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(object: *const c_void);
    }

    const HID_EVENT_TAP: u32 = 0;

    pub struct MacOsShortcut;

    impl ShortcutController for MacOsShortcut {
        fn press(&self, combo: &KeyCombo) -> Result<(), ControlError> {
            // SAFETY: plain C calls with valid arguments; each event is checked for null, posted, then released.
            unsafe {
                if !AXIsProcessTrusted() {
                    return Err(ControlError::PermissionNeeded(
                        "Allow this app under System Settings > Privacy & Security > Accessibility to press keys".into(),
                    ));
                }
                for down in [true, false] {
                    let event = CGEventCreateKeyboardEvent(
                        std::ptr::null(),
                        macos_key_code(combo.key),
                        down,
                    );
                    if event.is_null() {
                        return Err(ControlError::Backend("could not create a key event".into()));
                    }
                    CGEventSetFlags(event, macos_flags(combo));
                    CGEventPost(HID_EVENT_TAP, event);
                    CFRelease(event);
                }
            }
            Ok(())
        }
    }
}

/// The name `xdotool key` knows a shortcut by, such as `super+shift+k`.
#[cfg(any(target_os = "linux", test))]
fn xdotool_keys(combo: &KeyCombo) -> String {
    let mut parts: Vec<String> = [
        (combo.command, "super"),
        (combo.control, "ctrl"),
        (combo.alt, "alt"),
        (combo.shift, "shift"),
    ]
    .iter()
    .filter(|(held, _)| *held)
    .map(|(_, name)| (*name).to_string())
    .collect();
    parts.push(match combo.key {
        Key::Letter(c) | Key::Digit(c) => c.to_string(),
        Key::Function(n) => format!("F{n}"),
        Key::Named(named) => match named {
            NamedKey::Space => "space",
            NamedKey::Enter => "Return",
            NamedKey::Tab => "Tab",
            NamedKey::Escape => "Escape",
            NamedKey::Backspace => "BackSpace",
            NamedKey::Delete => "Delete",
            NamedKey::Left => "Left",
            NamedKey::Right => "Right",
            NamedKey::Up => "Up",
            NamedKey::Down => "Down",
            NamedKey::Home => "Home",
            NamedKey::End => "End",
            NamedKey::PageUp => "Prior",
            NamedKey::PageDown => "Next",
        }
        .to_string(),
    });
    parts.join("+")
}

#[cfg(target_os = "linux")]
struct LinuxShortcut;

#[cfg(target_os = "linux")]
impl ShortcutController for LinuxShortcut {
    fn press(&self, combo: &KeyCombo) -> Result<(), ControlError> {
        use std::process::{Command, Stdio};
        // X11 only: Wayland sessions have no equivalent without extra tools.
        let output = Command::new("xdotool")
            .args(["key", &xdotool_keys(combo)])
            .stdin(Stdio::null())
            .output()
            .map_err(|_| ControlError::Unsupported("keyboard shortcuts (install xdotool)"))?;
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

/// The Windows virtual-key codes for a shortcut: its modifiers, then its key.
#[cfg(any(target_os = "windows", test))]
fn windows_virtual_keys(combo: &KeyCombo) -> Vec<u16> {
    let mut keys: Vec<u16> = [
        (combo.command, 0x5Bu16), // VK_LWIN
        (combo.control, 0x11),    // VK_CONTROL
        (combo.alt, 0x12),        // VK_MENU
        (combo.shift, 0x10),      // VK_SHIFT
    ]
    .iter()
    .filter(|(held, _)| *held)
    .map(|(_, key)| *key)
    .collect();
    keys.push(match combo.key {
        Key::Letter(c) => c.to_ascii_uppercase() as u16,
        Key::Digit(c) => c as u16,
        Key::Function(n) => 0x6F + u16::from(n), // VK_F1 is 0x70
        Key::Named(named) => match named {
            NamedKey::Space => 0x20,
            NamedKey::Enter => 0x0D,
            NamedKey::Tab => 0x09,
            NamedKey::Escape => 0x1B,
            NamedKey::Backspace => 0x08,
            NamedKey::Delete => 0x2E,
            NamedKey::Left => 0x25,
            NamedKey::Up => 0x26,
            NamedKey::Right => 0x27,
            NamedKey::Down => 0x28,
            NamedKey::Home => 0x24,
            NamedKey::End => 0x23,
            NamedKey::PageUp => 0x21,
            NamedKey::PageDown => 0x22,
        },
    });
    keys
}

#[cfg(target_os = "windows")]
struct WindowsShortcut;

#[cfg(target_os = "windows")]
impl ShortcutController for WindowsShortcut {
    fn press(&self, combo: &KeyCombo) -> Result<(), ControlError> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
            SendInput, VIRTUAL_KEY,
        };
        let event = |key: u16, flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(key),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let keys = windows_virtual_keys(combo);
        // Down in order, up in reverse, so the modifiers are held around the key.
        let inputs: Vec<INPUT> = keys
            .iter()
            .map(|key| event(*key, KEYBD_EVENT_FLAGS(0)))
            .chain(keys.iter().rev().map(|key| event(*key, KEYEVENTF_KEYUP)))
            .collect();
        // SAFETY: fully initialised INPUTs and their true size.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err(ControlError::Backend("Windows refused the shortcut".into()))
        }
    }
}

#[allow(dead_code)] // only the fallback on platforms without an adapter, and tests
struct UnsupportedShortcut;

impl ShortcutController for UnsupportedShortcut {
    fn press(&self, _combo: &KeyCombo) -> Result<(), ControlError> {
        Err(ControlError::Unsupported("keyboard shortcuts"))
    }
}

pub fn platform_shortcut_controller() -> Box<dyn ShortcutController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacOsShortcut)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(LinuxShortcut)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(WindowsShortcut)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Box::new(UnsupportedShortcut)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> KeyCombo {
        text.parse().unwrap()
    }

    #[test]
    fn a_shortcut_is_read_however_it_is_written_and_written_one_way() {
        for (written, normal) in [
            ("cmd+shift+4", "cmd+shift+4"),
            ("Shift + Command + K", "cmd+shift+k"),
            ("option+ctrl+Left", "ctrl+alt+left"),
            ("win+d", "cmd+d"),
            ("F5", "f5"),
            ("esc", "escape"),
            ("ctrl+return", "ctrl+enter"),
            ("alt+pagedown", "alt+pagedown"),
        ] {
            assert_eq!(parse(written).to_string(), normal, "{written}");
            assert_eq!(parse(normal), parse(written));
        }
    }

    #[test]
    fn a_key_that_types_needs_a_modifier_and_nonsense_is_refused_in_words() {
        let error = |text: &str| text.parse::<KeyCombo>().unwrap_err();
        assert!(error("k").contains("add cmd, ctrl or alt"));
        assert!(
            error("shift+k").contains("add cmd, ctrl or alt"),
            "shift alone still types"
        );
        assert!(error("space").contains("add cmd, ctrl or alt"));
        assert!(error("cmd+").contains("needs a key"));
        assert!(error("").contains("needs a key"));
        assert!(error("cmd+shift").contains("needs a key"));
        assert!(error("cmd+k+j").contains("one key"));
        assert!(error("cmd+cmd+k").contains("twice"));
        assert!(error("cmd+f13").contains("not a key"));
        assert!(error("cmd+ü").contains("not a key"));
        // Keys that type nothing may stand alone.
        for alone in ["f1", "escape", "left", "pageup", "home"] {
            assert!(alone.parse::<KeyCombo>().is_ok(), "{alone}");
        }
    }

    #[test]
    fn each_platform_gets_its_own_codes() {
        let combo = parse("cmd+shift+4");
        assert_eq!(macos_key_code(combo.key), 21);
        assert_eq!(macos_flags(&combo), 0x0012_0000);
        assert_eq!(windows_virtual_keys(&combo), vec![0x5B, 0x10, 0x34]);
        assert_eq!(xdotool_keys(&combo), "super+shift+4");
        let arrow = parse("ctrl+alt+left");
        assert_eq!(macos_key_code(arrow.key), 123);
        assert_eq!(windows_virtual_keys(&arrow), vec![0x11, 0x12, 0x25]);
        assert_eq!(xdotool_keys(&arrow), "ctrl+alt+Left");
        assert_eq!(windows_virtual_keys(&parse("f5")), vec![0x74]);
        assert_eq!(macos_key_code(parse("cmd+m").key), 46);
        assert_eq!(macos_key_code(parse("cmd+0").key), 29);
        // Every letter and digit has a code of its own.
        let mut codes: Vec<u16> = ('a'..='z')
            .map(|c| macos_key_code(Key::Letter(c)))
            .chain(('0'..='9').map(|c| macos_key_code(Key::Digit(c))))
            .collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 36);
    }

    #[test]
    fn an_unsupported_platform_says_so() {
        assert_eq!(
            UnsupportedShortcut.press(&parse("f5")),
            Err(ControlError::Unsupported("keyboard shortcuts"))
        );
    }
}
