//! The macOS system volume through Core Audio, in process: no `osascript` per change.
//!
//! The volume is the default output device's *virtual main volume*, the one value the menu bar slider and the volume
//! keys move however many channels the device has. A device without it (some USB and HDMI outputs) falls back to its
//! main-element volume, then to its first two channels. The default output device is looked up on every call, so
//! switching to headphones never leaves the app driving the old device.

use std::ffi::c_void;

use crate::{VolumeController, VolumeError, validate_volume};

#[repr(C)]
struct AudioObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

type OsStatus = i32;

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectHasProperty(object: u32, address: *const AudioObjectPropertyAddress) -> u8;
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const AudioObjectPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> OsStatus;
    fn AudioObjectSetPropertyData(
        object: u32,
        address: *const AudioObjectPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> OsStatus;
}

// The virtual main volume belongs to the Audio Hardware Service in AudioToolbox, not to Core Audio's own objects.
#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
    fn AudioHardwareServiceHasProperty(
        object: u32,
        address: *const AudioObjectPropertyAddress,
    ) -> u8;
    fn AudioHardwareServiceGetPropertyData(
        object: u32,
        address: *const AudioObjectPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> OsStatus;
    fn AudioHardwareServiceSetPropertyData(
        object: u32,
        address: *const AudioObjectPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> OsStatus;
}

const fn four_cc(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

const SYSTEM_OBJECT: u32 = 1;
const DEFAULT_OUTPUT_DEVICE: u32 = four_cc(b"dOut");
const VIRTUAL_MAIN_VOLUME: u32 = four_cc(b"vmvc");
const VOLUME_SCALAR: u32 = four_cc(b"volm");
const MUTE: u32 = four_cc(b"mute");
const SCOPE_GLOBAL: u32 = four_cc(b"glob");
const SCOPE_OUTPUT: u32 = four_cc(b"outp");
const ELEMENT_MAIN: u32 = 0;
const NO_DEVICE: u32 = 0;

fn address(selector: u32, scope: u32, element: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        selector,
        scope,
        element,
    }
}

fn check(status: OsStatus, what: &str) -> Result<(), VolumeError> {
    if status == 0 {
        Ok(())
    } else {
        Err(VolumeError::Backend(format!(
            "Core Audio could not {what} (status {status})"
        )))
    }
}

/// Where the volume of one device lives.
#[derive(Clone, Copy)]
enum VolumeProperty {
    VirtualMain,
    Element(u32),
}

/// Core Audio adapter for the current default output device.
#[derive(Default)]
pub struct CoreAudioVolumeController;

impl CoreAudioVolumeController {
    fn default_output_device() -> Result<u32, VolumeError> {
        let address = address(DEFAULT_OUTPUT_DEVICE, SCOPE_GLOBAL, ELEMENT_MAIN);
        let mut device = NO_DEVICE;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `device` is a u32 and `size` says so; Core Audio writes at most that many bytes.
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut device as *mut u32).cast(),
            )
        };
        check(status, "find the default output device")?;
        if device == NO_DEVICE {
            return Err(VolumeError::Backend(
                "there is no default output device".into(),
            ));
        }
        Ok(device)
    }

    /// The properties that hold this device's volume: the virtual main volume when it has one, else its main element,
    /// else its first two channels.
    fn volume_properties(device: u32) -> Result<Vec<VolumeProperty>, VolumeError> {
        // SAFETY: plain queries with valid addresses.
        unsafe {
            if AudioHardwareServiceHasProperty(
                device,
                &address(VIRTUAL_MAIN_VOLUME, SCOPE_OUTPUT, ELEMENT_MAIN),
            ) != 0
            {
                return Ok(vec![VolumeProperty::VirtualMain]);
            }
            if AudioObjectHasProperty(device, &address(VOLUME_SCALAR, SCOPE_OUTPUT, ELEMENT_MAIN))
                != 0
            {
                return Ok(vec![VolumeProperty::Element(ELEMENT_MAIN)]);
            }
            let channels: Vec<_> = [1, 2]
                .into_iter()
                .filter(|&channel| {
                    AudioObjectHasProperty(device, &address(VOLUME_SCALAR, SCOPE_OUTPUT, channel))
                        != 0
                })
                .map(VolumeProperty::Element)
                .collect();
            if channels.is_empty() {
                Err(VolumeError::Backend(
                    "the output device has no volume Core Audio can change".into(),
                ))
            } else {
                Ok(channels)
            }
        }
    }

    fn read(device: u32, property: VolumeProperty) -> Result<f32, VolumeError> {
        let mut value = 0.0f32;
        let mut size = std::mem::size_of::<f32>() as u32;
        let out = (&mut value as *mut f32).cast();
        // SAFETY: `value` is an f32 and `size` says so.
        let status = unsafe {
            match property {
                VolumeProperty::VirtualMain => AudioHardwareServiceGetPropertyData(
                    device,
                    &address(VIRTUAL_MAIN_VOLUME, SCOPE_OUTPUT, ELEMENT_MAIN),
                    0,
                    std::ptr::null(),
                    &mut size,
                    out,
                ),
                VolumeProperty::Element(element) => AudioObjectGetPropertyData(
                    device,
                    &address(VOLUME_SCALAR, SCOPE_OUTPUT, element),
                    0,
                    std::ptr::null(),
                    &mut size,
                    out,
                ),
            }
        };
        check(status, "read the volume")?;
        if value.is_finite() && (0.0..=1.0).contains(&value) {
            Ok(value)
        } else {
            Err(VolumeError::InvalidResponse(value.to_string()))
        }
    }

    fn write(device: u32, property: VolumeProperty, volume: f32) -> Result<(), VolumeError> {
        let size = std::mem::size_of::<f32>() as u32;
        let data = (&volume as *const f32).cast();
        // SAFETY: `volume` is an f32 and `size` says so.
        let status = unsafe {
            match property {
                VolumeProperty::VirtualMain => AudioHardwareServiceSetPropertyData(
                    device,
                    &address(VIRTUAL_MAIN_VOLUME, SCOPE_OUTPUT, ELEMENT_MAIN),
                    0,
                    std::ptr::null(),
                    size,
                    data,
                ),
                VolumeProperty::Element(element) => AudioObjectSetPropertyData(
                    device,
                    &address(VOLUME_SCALAR, SCOPE_OUTPUT, element),
                    0,
                    std::ptr::null(),
                    size,
                    data,
                ),
            }
        };
        check(status, "set the volume")
    }
}

impl VolumeController for CoreAudioVolumeController {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        let device = Self::default_output_device()?;
        let properties = Self::volume_properties(device)?;
        let mut total = 0.0;
        for &property in &properties {
            total += Self::read(device, property)?;
        }
        Ok(total / properties.len() as f32)
    }

    fn set_volume(&self, volume: f32) -> Result<(), VolumeError> {
        validate_volume(volume)?;
        let device = Self::default_output_device()?;
        for property in Self::volume_properties(device)? {
            Self::write(device, property, volume)?;
        }
        Ok(())
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        let device = Self::default_output_device()?;
        let address = address(MUTE, SCOPE_OUTPUT, ELEMENT_MAIN);
        let mut muted = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: the mute property is a u32 and `size` says so.
        let status = unsafe {
            if AudioObjectHasProperty(device, &address) == 0 {
                return Err(VolumeError::Backend(
                    "the output device cannot be muted".into(),
                ));
            }
            AudioObjectGetPropertyData(
                device,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut muted as *mut u32).cast(),
            )
        };
        check(status, "read the mute")?;
        Ok(muted != 0)
    }

    fn set_muted(&self, muted: bool) -> Result<(), VolumeError> {
        let device = Self::default_output_device()?;
        let address = address(MUTE, SCOPE_OUTPUT, ELEMENT_MAIN);
        let value = u32::from(muted);
        // SAFETY: the mute property is a u32 and `size` says so.
        let status = unsafe {
            if AudioObjectHasProperty(device, &address) == 0 {
                return Err(VolumeError::Backend(
                    "the output device cannot be muted".into(),
                ));
            }
            AudioObjectSetPropertyData(
                device,
                &address,
                0,
                std::ptr::null(),
                std::mem::size_of::<u32>() as u32,
                (&value as *const u32).cast(),
            )
        };
        check(status, "set the mute")
    }
}
