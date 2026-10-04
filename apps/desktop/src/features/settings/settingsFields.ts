import { CONTROLLABLE_SENSORS, type AppSettings } from "../../shared/protocol/events";
import type { NumberSpec } from "../../shared/forms/numberField";

/** Mirrors `AppSettings::default()` in `apps/desktop/src-tauri/src/settings.rs`, used until the real settings load and as each field's default. */
export const DEFAULT_SETTINGS: AppSettings = {
  headphonesEnabled: true,
  headphonesRateHz: 60,
  recordingRateHz: 30,
  graphRefreshRateHz: 15,
  watchOrientationRateHz: 50,
  watchAccelerationRateHz: 50,
  watchGyroscopeRateHz: 50,
  watchPpgFlushRateHz: 1,
  watchHeartRateAcceptanceRateHz: 200,
  watchSkinTemperatureAcceptanceRateHz: 200,
  watchEdaAcceptanceRateHz: 200,
  shakePeakThreshold: 6,
  shakeStrokes: 4,
  swipePeakThreshold: 8,
  tapPeakThreshold: 12,
  rotateAngleDegrees: 60,
  watchWrist: "left",
  wristMaxAngularVelocityDegreesPerSecond: 360,
  wristMaxVolumePointsPerSecond: 30,
  watchSensorsEnabled: Object.fromEntries(CONTROLLABLE_SENSORS.map(({ id }) => [id, true])),
  watchTransport: "bluetooth",
};

export type NumericSettingKey =
  | "headphonesRateHz"
  | "recordingRateHz"
  | "graphRefreshRateHz"
  | "watchOrientationRateHz"
  | "watchAccelerationRateHz"
  | "watchGyroscopeRateHz"
  | "watchPpgFlushRateHz"
  | "watchHeartRateAcceptanceRateHz"
  | "watchSkinTemperatureAcceptanceRateHz"
  | "watchEdaAcceptanceRateHz"
  | "shakePeakThreshold"
  | "shakeStrokes"
  | "swipePeakThreshold"
  | "tapPeakThreshold"
  | "rotateAngleDegrees"
  | "wristMaxAngularVelocityDegreesPerSecond"
  | "wristMaxVolumePointsPerSecond";

const d = DEFAULT_SETTINGS;

/**
 * Every numeric setting once: its label, unit, allowed range, step and default. The input's
 * attributes, its validation, its hint text and its reset button all come from here. The ranges
 * are the ones `AppSettings::validate()` enforces in `settings.rs`, so a value this form accepts is
 * one the backend accepts.
 */
export const SETTINGS_FIELDS: Record<NumericSettingKey, NumberSpec> = {
  headphonesRateHz: {
    label: "Headphones rate", unit: "Hz", min: 1, max: 200, step: 1, integer: true, defaultValue: d.headphonesRateHz,
    description: "How many headphone samples per second are shown and recorded",
  },
  recordingRateHz: {
    label: "Recording rate", unit: "Hz", min: 1, max: 200, step: 1, integer: true, defaultValue: d.recordingRateHz,
    description: "Samples per second saved per channel",
  },
  graphRefreshRateHz: {
    label: "Graph refresh rate", unit: "Hz", min: 1, max: 60, step: 1, integer: true, defaultValue: d.graphRefreshRateHz,
    description: "How often the live charts redraw; does not change what is saved",
  },
  watchOrientationRateHz: {
    label: "Orientation", unit: "Hz", min: 1, max: 200, step: 1, integer: true, defaultValue: d.watchOrientationRateHz,
    description: "Watch rotation sensor rate; higher is smoother but costs battery",
  },
  watchAccelerationRateHz: {
    label: "Acceleration", unit: "Hz", min: 1, max: 200, step: 1, integer: true, defaultValue: d.watchAccelerationRateHz,
    description: "Watch acceleration sensor rate",
  },
  watchGyroscopeRateHz: {
    label: "Gyroscope", unit: "Hz", min: 1, max: 200, step: 1, integer: true, defaultValue: d.watchGyroscopeRateHz,
    description: "Watch gyroscope sensor rate",
  },
  watchPpgFlushRateHz: {
    label: "Raw PPG flush", unit: "Hz", min: 0.1, max: 10, step: 0.1, defaultValue: d.watchPpgFlushRateHz,
    description: "How often the watch hands over buffered PPG; higher uses more battery",
  },
  watchHeartRateAcceptanceRateHz: {
    label: "Heart rate", unit: "Hz", min: 0.1, max: 200, step: 0.1, defaultValue: d.watchHeartRateAcceptanceRateHz,
    description: "Most heart-rate samples per second the desktop accepts",
  },
  watchSkinTemperatureAcceptanceRateHz: {
    label: "Skin temperature", unit: "Hz", min: 0.1, max: 200, step: 0.1, defaultValue: d.watchSkinTemperatureAcceptanceRateHz,
    description: "Most temperature samples per second the desktop accepts",
  },
  watchEdaAcceptanceRateHz: {
    label: "EDA", unit: "Hz", min: 0.1, max: 200, step: 0.1, defaultValue: d.watchEdaAcceptanceRateHz,
    description: "Most skin-conductance samples per second the desktop accepts",
  },
  shakePeakThreshold: {
    label: "Shake strength", unit: "m/s²", min: 2, max: 30, step: 0.5, defaultValue: d.shakePeakThreshold,
    description: "How hard each stroke must be. Lower catches gentler shakes (and more accidents)",
  },
  shakeStrokes: {
    label: "Shake strokes", min: 3, max: 10, step: 1, integer: true, defaultValue: d.shakeStrokes,
    description: "How many quick strokes back and forth make a shake. Fewer is more sensitive",
  },
  swipePeakThreshold: {
    label: "Swipe strength", unit: "m/s²", min: 3, max: 30, step: 0.5, defaultValue: d.swipePeakThreshold,
    description: "How hard the push of a swipe must be. Lower catches gentler swipes (and more accidents)",
  },
  tapPeakThreshold: {
    label: "Tap strength", unit: "m/s²", min: 4, max: 40, step: 0.5, defaultValue: d.tapPeakThreshold,
    description: "How hard a knock on the watch must be. Lower catches lighter taps (and more accidental bumps)",
  },
  rotateAngleDegrees: {
    label: "Rotate angle", unit: "°", min: 30, max: 180, step: 5, integer: true, defaultValue: d.rotateAngleDegrees,
    description: "How far the wrist must twist, quickly, to count as a rotate. Smaller catches smaller twists (and more accidents)",
  },
  wristMaxAngularVelocityDegreesPerSecond: {
    label: "Max angular velocity", unit: "°/s", min: 1, max: 2000, step: 1, integer: true, defaultValue: d.wristMaxAngularVelocityDegreesPerSecond,
    description: "A turn faster than this is treated as a glitch and ignored",
  },
  wristMaxVolumePointsPerSecond: {
    label: "Max volume rate", unit: "pts/s", min: 1, max: 100, step: 1, integer: true, defaultValue: d.wristMaxVolumePointsPerSecond,
    description: "The fastest the volume is allowed to change",
  },
};

/** The numeric fields of `settings`, in the shape the draft hook wants. */
export function numericValues(settings: AppSettings): Record<NumericSettingKey, number> {
  const values = {} as Record<NumericSettingKey, number>;
  for (const key of Object.keys(SETTINGS_FIELDS) as NumericSettingKey[]) values[key] = settings[key];
  return values;
}
