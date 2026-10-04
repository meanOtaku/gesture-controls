import type { Recipe } from "../../shared/protocol/events";

/**
 * How far a virtual device has moved its target for a given wrist rotation, as a fraction of the full range
 * (0.01 is one volume point). This mirrors `Device::position` in `crates/automation/src/device.rs`, so the
 * preview shows what a recipe would really do; the tests pin the same numbers the Rust tests do.
 */
export function devicePosition(device: Recipe["device"], degrees: number): number {
  const n = (key: string) => Number(device[key]);
  switch (device.kind) {
    case "rotationKnob":
      return degrees * n("fractionPerDegree");
    case "horizontalFader":
    case "verticalFader":
      return Math.min(1, Math.max(-1, degrees / n("travelDegrees"))) * n("fractionPerTravel");
    case "stepKnob":
      return Math.trunc(degrees / n("degreesPerStep")) * n("fractionPerStep");
    default:
      return 0;
  }
}

/** Where a fader's handle sits, from -1 (one end) to 1 (the other). */
export function faderHandle(device: Recipe["device"], degrees: number): number {
  return Math.min(1, Math.max(-1, degrees / Number(device.travelDegrees)));
}

/** The angle a step knob's pointer snaps to. */
export function snappedAngle(device: Recipe["device"], degrees: number): number {
  const step = Number(device.degreesPerStep);
  return Math.trunc(degrees / step) * step;
}
