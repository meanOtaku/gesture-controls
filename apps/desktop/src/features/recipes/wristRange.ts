import type { Quaternion } from "../../shared/protocol/events";
import type { Axis, DeviceKind, DeviceNumbers } from "./recipeModel";

/** A range narrower than this is a slip, not a range: too little to steer anything with. */
export const MIN_WRIST_RANGE_DEGREES = 10;

/**
 * Rotation about `axis` of the watch body from `start` to `current`, in degrees in (-180, 180]. The same reading as the
 * recipe runner's (`twist` in `crates/automation/src/runner.rs`), so a range measured here is the range a recipe sees.
 */
export function twistDegrees(start: Quaternion, current: Quaternion, axis: Axis): number {
  const [sw, si, sj, sk] = start;
  const [cw, ci, cj, ck] = current;
  const w = sw * cw + si * ci + sj * cj + sk * ck;
  const i = sw * ci - si * cw - sj * ck + sk * cj;
  const j = sw * cj + si * ck - sj * cw - sk * ci;
  const k = sw * ck - si * cj + sj * ci - sk * cw;
  const component = axis === "roll" ? i : axis === "pitch" ? j : k;
  const degrees = (2 * Math.atan2(component, w) * 180) / Math.PI;
  return wrap(degrees);
}

function wrap(degrees: number): number {
  return ((((degrees + 540) % 360) + 360) % 360) - 180;
}

/** How far the wrist turned about one axis while calibrating: where it is now and the furthest it went each way. */
export interface WristRange {
  /** Degrees from where calibration began, following each step the short way round (so past 180 is fine). */
  now: number;
  min: number;
  max: number;
}

/** Follows the wrist about `axis` from the first sample it is given. */
export class WristRangeMeter {
  private start: Quaternion | null = null;
  private lastTwist = 0;
  private range: WristRange = { now: 0, min: 0, max: 0 };

  constructor(private readonly axis: Axis) {}

  observe(quaternion: Quaternion): WristRange {
    if (!quaternion.every(Number.isFinite) || Math.hypot(...quaternion) < 1e-9) return this.range;
    if (!this.start) {
      this.start = quaternion;
      return this.range;
    }
    const twist = twistDegrees(this.start, quaternion, this.axis);
    const now = this.range.now + wrap(twist - this.lastTwist);
    this.lastTwist = twist;
    this.range = { now, min: Math.min(this.range.min, now), max: Math.max(this.range.max, now) };
    return this.range;
  }

  get current(): WristRange {
    return this.range;
  }
}

/** The span from one end of a measured range to the other, in degrees. */
export function spanOf(range: WristRange): number {
  return range.max - range.min;
}

/**
 * The device's numbers (as the editor shows them, in the action's units) for which turning the wrist across `span`
 * degrees moves the controlled value from one end of its range to the other. `scale` is the action's full range in
 * those units (100 points of volume). A step knob keeps its step size and spreads its steps over the span.
 */
export function calibratedNumbers(kind: DeviceKind, span: number, scale: number, current: DeviceNumbers): DeviceNumbers {
  const round = (value: number, places: number) => Number(value.toFixed(places));
  switch (kind) {
    case "rotationKnob":
      return { a: round(scale / span, 4), b: current.b };
    case "horizontalFader":
    case "verticalFader":
      // The handle starts wherever the value is, so a whole span either way must reach either end.
      return { a: round(Math.min(span, 180), 1), b: scale };
    case "stepKnob": {
      const steps = Math.max(1, Math.round(scale / current.b));
      return { a: round(Math.min(180, Math.max(1, span / steps)), 1), b: current.b };
    }
  }
}

/** How much of the value one full turn across the calibrated span gives, read back from the device's numbers. */
export function spanForNumbers(kind: DeviceKind, numbers: DeviceNumbers, scale: number): number | null {
  switch (kind) {
    case "rotationKnob":
      return numbers.a > 0 ? scale / numbers.a : null;
    case "horizontalFader":
    case "verticalFader":
      return numbers.b > 0 ? (numbers.a * scale) / numbers.b : null;
    case "stepKnob":
      return numbers.b > 0 ? (numbers.a * scale) / numbers.b : null;
  }
}
