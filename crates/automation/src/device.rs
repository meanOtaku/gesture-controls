use serde::{Deserialize, Serialize};

/// What a virtual device asks of its action: change the controlled value by this fraction of its full range
/// (`0.01` is one volume point). Every device speaks this one language, so any device can drive any action.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub delta_fraction: f64,
}

/// The kinds of virtual device a recipe can map. More are added here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    RotationKnob,
    HorizontalFader,
    VerticalFader,
    StepKnob,
}

/// A virtual device and how it turns wrist rotation (degrees from where the hold began) into output.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Device {
    /// Endless knob: every degree turned changes the value, in either direction, with no end stops.
    RotationKnob { fraction_per_degree: f64 },
    /// Fader with finite travel: the handle follows the wrist across `travel_degrees` each way from where it
    /// started, and stops at the ends. Horizontal suits yaw, vertical suits pitch.
    HorizontalFader {
        travel_degrees: f64,
        fraction_per_travel: f64,
    },
    VerticalFader {
        travel_degrees: f64,
        fraction_per_travel: f64,
    },
    /// Knob with detents: it only moves one whole step at a time, every `degrees_per_step`.
    StepKnob {
        degrees_per_step: f64,
        fraction_per_step: f64,
    },
}

impl Device {
    pub fn kind(&self) -> DeviceKind {
        match self {
            Device::RotationKnob { .. } => DeviceKind::RotationKnob,
            Device::HorizontalFader { .. } => DeviceKind::HorizontalFader,
            Device::VerticalFader { .. } => DeviceKind::VerticalFader,
            Device::StepKnob { .. } => DeviceKind::StepKnob,
        }
    }

    pub fn default_for(kind: DeviceKind) -> Self {
        match kind {
            DeviceKind::RotationKnob => Device::RotationKnob {
                fraction_per_degree: 1.0 / 300.0,
            },
            DeviceKind::HorizontalFader => Device::HorizontalFader {
                travel_degrees: 45.0,
                fraction_per_travel: 0.5,
            },
            DeviceKind::VerticalFader => Device::VerticalFader {
                travel_degrees: 45.0,
                fraction_per_travel: 0.5,
            },
            DeviceKind::StepKnob => Device::StepKnob {
                degrees_per_step: 15.0,
                fraction_per_step: 0.05,
            },
        }
    }

    pub(crate) fn validate(&self) -> Result<(), ()> {
        let positive = |v: f64| v.is_finite() && v > 0.0;
        let ok = match *self {
            Device::RotationKnob {
                fraction_per_degree,
            } => positive(fraction_per_degree) && fraction_per_degree <= 1.0,
            Device::HorizontalFader {
                travel_degrees,
                fraction_per_travel,
            }
            | Device::VerticalFader {
                travel_degrees,
                fraction_per_travel,
            } => {
                positive(travel_degrees)
                    && travel_degrees <= 180.0
                    && positive(fraction_per_travel)
                    && fraction_per_travel <= 1.0
            }
            Device::StepKnob {
                degrees_per_step,
                fraction_per_step,
            } => {
                positive(degrees_per_step)
                    && degrees_per_step <= 180.0
                    && positive(fraction_per_step)
                    && fraction_per_step <= 1.0
            }
        };
        if ok { Ok(()) } else { Err(()) }
    }

    /// The device's position for a wrist rotation of `degrees`, in the device's own units (fraction of range
    /// for knobs and faders, whole steps for a step knob). The change in position between two readings is the
    /// output, so a device never needs to know the current value of what it drives.
    pub(crate) fn position(&self, degrees: f64) -> f64 {
        match *self {
            Device::RotationKnob {
                fraction_per_degree,
            } => degrees * fraction_per_degree,
            Device::HorizontalFader {
                travel_degrees,
                fraction_per_travel,
            }
            | Device::VerticalFader {
                travel_degrees,
                fraction_per_travel,
            } => (degrees / travel_degrees).clamp(-1.0, 1.0) * fraction_per_travel,
            Device::StepKnob {
                degrees_per_step,
                fraction_per_step,
            } => (degrees / degrees_per_step).trunc() * fraction_per_step,
        }
    }
}
