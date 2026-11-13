//! Which app is in front, by the name the system shows for it, so a recipe can be for some apps only.

use crate::ControlError;

/// The name in `lsappinfo info -only name`'s answer, `"LSDisplayName"="Safari"`.
#[cfg(any(target_os = "macos", test))]
fn lsappinfo_name(output: &str) -> Option<String> {
    let (_, value) = output.trim().split_once('=')?;
    let name = value.trim().trim_matches('"');
    (!name.is_empty() && name != "[ NULL ]").then(|| name.to_string())
}

/// The app in front right now, or `None` when the system names none (the desktop itself, or a screen that is locked).
pub fn front_app() -> Result<Option<String>, ControlError> {
    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        let run = |arguments: &[&str]| -> Result<String, ControlError> {
            let output = Command::new("lsappinfo")
                .args(arguments)
                .stdin(Stdio::null())
                .output()
                .map_err(|error| {
                    ControlError::Backend(format!("could not run lsappinfo: {error}"))
                })?;
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        };
        let front = run(&["front"])?;
        if front.is_empty() {
            return Ok(None);
        }
        Ok(lsappinfo_name(&run(&["info", "-only", "name", &front])?))
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        // X11 only: Wayland sessions have no equivalent without extra tools.
        let output = Command::new("xdotool")
            .args(["getactivewindow", "getwindowclassname"])
            .stdin(Stdio::null())
            .output()
            .map_err(|_| {
                ControlError::Unsupported("recipes for some apps only (install xdotool)")
            })?;
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!name.is_empty()).then_some(name))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(ControlError::Unsupported("recipes for some apps only"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_name_lsappinfo_gives_and_nothing_from_an_empty_answer() {
        assert_eq!(
            lsappinfo_name("\"LSDisplayName\"=\"Safari\"\n"),
            Some("Safari".into())
        );
        assert_eq!(
            lsappinfo_name("\"LSDisplayName\"=\"Visual Studio Code\""),
            Some("Visual Studio Code".into())
        );
        assert_eq!(lsappinfo_name(""), None);
        assert_eq!(lsappinfo_name("\"LSDisplayName\"=[ NULL ]"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn asking_this_mac_does_not_fail() {
        assert!(front_app().is_ok());
    }
}
