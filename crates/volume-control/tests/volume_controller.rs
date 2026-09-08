use std::sync::Mutex;

#[cfg(not(unix))]
use volume_control::OsascriptRunner;
#[cfg(target_os = "windows")]
use volume_control::WindowsVolumeController;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
use volume_control::platform_volume_controller;
use volume_control::{
    AppleScriptRunner, MacOsVolumeController, VolumeController, VolumeError, adjust_system_volume,
};

#[derive(Default)]
struct FakeRunner {
    responses: Mutex<Vec<Result<String, VolumeError>>>,
    calls: Mutex<Vec<(String, Vec<String>)>>,
}

impl FakeRunner {
    fn with_responses(responses: Vec<Result<&str, VolumeError>>) -> Self {
        Self {
            responses: Mutex::new(
                responses
                    .into_iter()
                    .map(|result| result.map(str::to_owned))
                    .rev()
                    .collect(),
            ),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl AppleScriptRunner for FakeRunner {
    fn run(&self, script: &str, args: &[String]) -> Result<String, VolumeError> {
        self.calls
            .lock()
            .unwrap()
            .push((script.to_owned(), args.to_vec()));
        self.responses.lock().unwrap().pop().unwrap()
    }
}

#[test]
fn macos_controller_normalizes_volume_and_uses_argument_safe_set_commands() {
    let controller =
        MacOsVolumeController::with_runner(FakeRunner::with_responses(vec![Ok("64\n"), Ok("")]));

    assert_eq!(controller.get_volume().unwrap(), 0.64);
    controller.set_volume(0.555).unwrap();

    let calls = controller.runner().calls.lock().unwrap();
    assert!(
        calls[0]
            .0
            .contains("output volume of (get volume settings)")
    );
    assert!(calls[0].1.is_empty());
    assert!(calls[1].0.contains("on run argv"));
    assert!(calls[1].0.contains("set volume output volume"));
    assert_eq!(calls[1].1, ["56"]);
}

#[test]
fn macos_controller_reads_and_sets_mute_without_interpolating_arguments() {
    let controller = MacOsVolumeController::with_runner(FakeRunner::with_responses(vec![
        Ok("true\n"),
        Ok(""),
        Ok(""),
    ]));

    assert!(controller.get_muted().unwrap());
    controller.set_muted(false).unwrap();
    controller.set_muted(true).unwrap();

    let calls = controller.runner().calls.lock().unwrap();
    assert!(calls[0].0.contains("output muted of (get volume settings)"));
    assert!(calls[1].0.contains("with output muted"));
    assert!(calls[1].0.contains("without output muted"));
    assert_eq!(calls[1].1, ["false"]);
    assert_eq!(calls[2].1, ["true"]);
}

#[test]
fn controller_rejects_invalid_values_and_backend_output() {
    let controller = MacOsVolumeController::with_runner(FakeRunner::with_responses(vec![
        Ok("loud"),
        Ok("maybe"),
    ]));

    assert!(matches!(
        controller.set_volume(f32::NAN),
        Err(VolumeError::InvalidVolume)
    ));
    assert!(matches!(
        controller.set_volume(1.1),
        Err(VolumeError::InvalidVolume)
    ));
    assert!(matches!(
        controller.get_volume(),
        Err(VolumeError::InvalidResponse(_))
    ));
    assert!(matches!(
        controller.get_muted(),
        Err(VolumeError::InvalidResponse(_))
    ));

    for output in ["-1", "101", "NaN", "inf"] {
        let controller =
            MacOsVolumeController::with_runner(FakeRunner::with_responses(vec![Ok(output)]));
        assert!(matches!(
            controller.get_volume(),
            Err(VolumeError::InvalidResponse(_))
        ));
    }
}

#[test]
fn macos_controller_rounds_normalized_volume_at_integer_boundaries() {
    let controller = MacOsVolumeController::with_runner(FakeRunner::with_responses(vec![
        Ok(""),
        Ok(""),
        Ok(""),
        Ok(""),
    ]));

    for volume in [0.0, 0.004, 0.005, 1.0] {
        controller.set_volume(volume).unwrap();
    }

    let calls = controller.runner().calls.lock().unwrap();
    let arguments = calls
        .iter()
        .map(|call| call.1[0].as_str())
        .collect::<Vec<_>>();
    assert_eq!(arguments, ["0", "0", "1", "100"]);
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[test]
fn default_controller_reports_the_platform_as_unsupported() {
    let controller = platform_volume_controller();
    assert!(matches!(
        controller.get_volume(),
        Err(VolumeError::UnsupportedPlatform)
    ));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_controller_rejects_invalid_volume_before_opening_a_native_audio_endpoint() {
    let controller = WindowsVolumeController;

    assert!(matches!(
        controller.set_volume(f32::NAN),
        Err(VolumeError::InvalidVolume)
    ));
    assert!(matches!(
        controller.set_volume(-0.01),
        Err(VolumeError::InvalidVolume)
    ));
    assert!(matches!(
        controller.set_volume(1.01),
        Err(VolumeError::InvalidVolume)
    ));
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct FakeLinuxRunner {
    responses: Mutex<Vec<Result<String, VolumeError>>>,
    calls: Mutex<Vec<(String, Vec<String>)>>,
}

#[cfg(target_os = "linux")]
impl FakeLinuxRunner {
    fn with_responses(responses: Vec<Result<&str, VolumeError>>) -> Self {
        Self {
            responses: Mutex::new(
                responses
                    .into_iter()
                    .map(|response| response.map(str::to_owned))
                    .rev()
                    .collect(),
            ),
            calls: Mutex::new(Vec::new()),
        }
    }
}

#[cfg(target_os = "linux")]
impl volume_control::LinuxCommandRunner for FakeLinuxRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, VolumeError> {
        self.calls.lock().unwrap().push((
            program.to_owned(),
            args.iter().map(|argument| (*argument).to_owned()).collect(),
        ));
        self.responses.lock().unwrap().pop().unwrap()
    }
}

#[cfg(target_os = "linux")]
#[test]
fn linux_controller_prefers_pipewire_and_parses_volume_and_mute() {
    let controller =
        volume_control::LinuxVolumeController::with_runner(FakeLinuxRunner::with_responses(vec![
            Ok("Volume: 0.64\n"),
            Ok("Volume: 0.64 [MUTED]\n"),
        ]));

    assert_eq!(controller.get_volume().unwrap(), 0.64);
    assert!(controller.get_muted().unwrap());
    let calls = controller.runner().calls.lock().unwrap();
    assert_eq!(calls[0].0, "wpctl");
    assert_eq!(calls[0].1, ["get-volume", "@DEFAULT_AUDIO_SINK@"]);
    assert_eq!(calls[1].0, "wpctl");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_controller_falls_back_to_pulseaudio_and_uses_normalized_writes() {
    let unavailable = || VolumeError::Backend("not found".to_string());
    let controller =
        volume_control::LinuxVolumeController::with_runner(FakeLinuxRunner::with_responses(vec![
            Err(unavailable()),
            Ok("Volume: front-left: 65536 /  50% / -18.06 dB\n"),
            Err(unavailable()),
            Ok(""),
            Err(unavailable()),
            Ok("Mute: yes\n"),
            Err(unavailable()),
            Ok(""),
        ]));

    assert_eq!(controller.get_volume().unwrap(), 0.5);
    controller.set_volume(0.555).unwrap();
    assert!(controller.get_muted().unwrap());
    controller.set_muted(false).unwrap();
    let calls = controller.runner().calls.lock().unwrap();
    assert_eq!(calls[3].0, "pactl");
    assert_eq!(calls[3].1, ["set-sink-volume", "@DEFAULT_SINK@", "56%"]);
    assert_eq!(calls[7].0, "pactl");
    assert_eq!(calls[7].1, ["set-sink-mute", "@DEFAULT_SINK@", "0"]);
}

#[cfg(not(unix))]
#[test]
fn osascript_runner_does_not_spawn_native_commands() {
    assert!(matches!(
        OsascriptRunner.run("", &[]),
        Err(VolumeError::UnsupportedPlatform)
    ));
}

struct FakeVolumeController {
    volume: f32,
    writes: Mutex<Vec<f32>>,
}

impl VolumeController for FakeVolumeController {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        Ok(self.volume)
    }

    fn set_volume(&self, volume: f32) -> Result<(), VolumeError> {
        self.writes.lock().unwrap().push(volume);
        Ok(())
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        Ok(false)
    }

    fn set_muted(&self, _muted: bool) -> Result<(), VolumeError> {
        Ok(())
    }
}

#[test]
fn keyboard_adjustment_reads_real_volume_clamps_and_writes_normalized_volume() {
    let controller = FakeVolumeController {
        volume: 0.98,
        writes: Mutex::new(Vec::new()),
    };

    let updated = adjust_system_volume(&controller, true, 5.0).unwrap();

    assert_eq!(updated, 1.0);
    assert_eq!(*controller.writes.lock().unwrap(), [1.0]);
}

#[test]
fn adjustment_returns_the_whole_percentage_written_by_the_native_backend() {
    let controller = FakeVolumeController {
        volume: 0.555,
        writes: Mutex::new(Vec::new()),
    };

    let updated = adjust_system_volume(&controller, true, 0.1).unwrap();

    assert!((updated - 0.56).abs() < f32::EPSILON);
    assert_eq!(*controller.writes.lock().unwrap(), [0.56]);
}

#[test]
fn finite_extreme_deltas_clamp_before_writing() {
    for (delta, expected) in [(f32::MAX, 1.0), (-f32::MAX, 0.0)] {
        let controller = FakeVolumeController {
            volume: 0.5,
            writes: Mutex::new(Vec::new()),
        };
        assert_eq!(
            adjust_system_volume(&controller, true, delta).unwrap(),
            expected
        );
        assert_eq!(*controller.writes.lock().unwrap(), [expected]);
    }
}

struct RejectingVolumeController;

impl VolumeController for RejectingVolumeController {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        Ok(0.5)
    }

    fn set_volume(&self, _volume: f32) -> Result<(), VolumeError> {
        Err(VolumeError::Backend("write rejected".into()))
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        Ok(false)
    }

    fn set_muted(&self, _muted: bool) -> Result<(), VolumeError> {
        Ok(())
    }
}

#[test]
fn backend_write_failures_are_returned_instead_of_reporting_a_new_volume() {
    assert!(matches!(
        adjust_system_volume(&RejectingVolumeController, true, 5.0),
        Err(VolumeError::Backend(message)) if message == "write rejected"
    ));
}

#[test]
fn hidden_overlay_cannot_change_system_volume() {
    let controller = FakeVolumeController {
        volume: 0.5,
        writes: Mutex::new(Vec::new()),
    };

    assert!(matches!(
        adjust_system_volume(&controller, false, 5.0),
        Err(VolumeError::OverlayInactive)
    ));
    assert!(controller.writes.lock().unwrap().is_empty());
}
