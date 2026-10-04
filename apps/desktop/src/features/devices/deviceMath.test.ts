import { describe, expect, it } from "vitest";
import { buildDevice, defaultNumbers } from "../recipes/recipeModel";
import { devicePosition, faderHandle, snappedAngle } from "./deviceMath";

describe("deviceMath", () => {
  it("a rotation knob turns endlessly, in either direction", () => {
    const knob = { kind: "rotationKnob", fractionPerDegree: 0.01 } as const;
    expect(devicePosition(knob, 30)).toBeCloseTo(0.3);
    expect(devicePosition(knob, -10)).toBeCloseTo(-0.1);
    expect(devicePosition(knob, 400)).toBeCloseTo(4); // no end stop
  });

  it("a fader stops at its ends", () => {
    const fader = { kind: "horizontalFader", travelDegrees: 40, fractionPerTravel: 0.5 } as const;
    expect(devicePosition(fader, 40)).toBeCloseTo(0.5);
    expect(devicePosition(fader, 80)).toBeCloseTo(0.5);
    expect(devicePosition(fader, -20)).toBeCloseTo(-0.25);
    expect(faderHandle(fader, 80)).toBe(1);
    expect(faderHandle(fader, -20)).toBeCloseTo(-0.5);
  });

  it("a step knob moves in whole detents, rounding towards the start", () => {
    const step = { kind: "stepKnob", degreesPerStep: 15, fractionPerStep: 0.05 } as const;
    expect(devicePosition(step, 14)).toBe(0);
    expect(devicePosition(step, 16)).toBeCloseTo(0.05);
    expect(devicePosition(step, -16)).toBeCloseTo(-0.05);
    expect(snappedAngle(step, 44)).toBe(30);
  });

  it("every default device does something for a 30 degree turn", () => {
    for (const kind of ["rotationKnob", "horizontalFader", "verticalFader", "stepKnob"] as const) {
      expect(Math.abs(devicePosition(buildDevice(kind, defaultNumbers(kind)), 30))).toBeGreaterThan(0);
    }
  });
});
