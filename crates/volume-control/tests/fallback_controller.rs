use std::sync::Mutex;

use volume_control::{FallbackVolumeController, VolumeController, VolumeError};

/// A controller that answers every call with `volume`, or fails every call, and remembers what it was asked to set.
struct Fake {
    volume: Result<f32, VolumeError>,
    set: Mutex<Vec<f32>>,
}

impl Fake {
    fn working(volume: f32) -> Self {
        Self {
            volume: Ok(volume),
            set: Mutex::new(Vec::new()),
        }
    }

    fn failing() -> Self {
        Self {
            volume: Err(VolumeError::Backend("no volume here".into())),
            set: Mutex::new(Vec::new()),
        }
    }
}

impl VolumeController for Fake {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        self.volume.clone()
    }

    fn set_volume(&self, volume: f32) -> Result<(), VolumeError> {
        if !(0.0..=1.0).contains(&volume) {
            return Err(VolumeError::InvalidVolume);
        }
        self.volume.clone()?;
        self.set.lock().unwrap().push(volume);
        Ok(())
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        self.volume.clone().map(|v| v == 0.0)
    }

    fn set_muted(&self, _muted: bool) -> Result<(), VolumeError> {
        self.volume.clone().map(|_| ())
    }
}

#[test]
fn the_primary_answers_when_it_can_and_the_fallback_is_left_alone() {
    let controller = FallbackVolumeController::new(Fake::working(0.4), Fake::working(0.9));
    assert_eq!(controller.get_volume(), Ok(0.4));
    controller.set_volume(0.5).unwrap();
}

#[test]
fn a_device_the_primary_cannot_drive_is_driven_by_the_fallback() {
    let fallback = Fake::working(0.9);
    let controller = FallbackVolumeController::new(Fake::failing(), fallback);
    assert_eq!(controller.get_volume(), Ok(0.9));
    assert_eq!(controller.set_volume(0.25), Ok(()));
    assert_eq!(controller.get_muted(), Ok(false));
}

#[test]
fn an_out_of_range_volume_is_refused_without_trying_the_fallback() {
    let controller = FallbackVolumeController::new(Fake::working(0.4), Fake::working(0.9));
    assert_eq!(controller.set_volume(1.5), Err(VolumeError::InvalidVolume));
}

#[test]
fn when_both_fail_the_fallback_error_is_reported() {
    let controller = FallbackVolumeController::new(Fake::failing(), Fake::failing());
    assert!(matches!(
        controller.get_volume(),
        Err(VolumeError::Backend(_))
    ));
}

/// Reads the real Mac's volume through Core Audio and writes the same value back, so nothing audible changes.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "touches the real audio device; run with --ignored"]
fn core_audio_reads_and_rewrites_the_real_volume() {
    let controller = volume_control::CoreAudioVolumeController;
    let volume = controller.get_volume().expect("read the volume");
    controller.set_volume(volume).expect("write it back");
    let again = controller.get_volume().unwrap();
    assert!((again - volume).abs() < 0.01, "{volume} then {again}");
    let muted = controller.get_muted().expect("read the mute");
    controller.set_muted(muted).expect("write the mute back");
    println!("Core Audio volume {volume}, muted {muted}");
}

/// How long one volume read takes through Core Audio and through AppleScript, on the real Mac.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "touches the real audio device; run with --ignored"]
fn core_audio_is_quicker_than_applescript() {
    use std::time::Instant;
    let time = |controller: &dyn VolumeController| {
        // The first call in a process starts the audio system; that once-only cost is not what a change costs.
        controller.get_volume().unwrap();
        let start = Instant::now();
        for _ in 0..20 {
            controller.get_volume().unwrap();
        }
        start.elapsed().as_secs_f64() * 1000.0 / 20.0
    };
    let core = time(&volume_control::CoreAudioVolumeController);
    let script = time(&volume_control::MacOsVolumeController::default());
    println!("one volume read: Core Audio {core:.3} ms, AppleScript {script:.1} ms");
    assert!(core < script);
}
