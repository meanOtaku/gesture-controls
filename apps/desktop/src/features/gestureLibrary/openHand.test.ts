import { describe, expect, it } from "vitest";
import { analyse, firingRate, type MeasureSample } from "./calibration";
import { MEASURE_NAMES } from "./definition";
import { OPEN_HAND_FRAMES, openHandGroup } from "./openHand";

/** A deterministic share from 0 to 1, different for each frame and measure. */
const share = (i: number, k: number) => (((i * 0.754877 + k * 0.569840) % 1) + 1) % 1;
const between = (low: number, high: number) => (i: number, k: number) => low + (high - low) * share(i, k);

/** Frames built from ranges of each measure; measures not named are left out, as if they could not be read. */
function frames(count: number, ranges: Partial<Record<(typeof MEASURE_NAMES)[number], [number, number]>>): MeasureSample[] {
  return Array.from({ length: count }, (_, i) => {
    const sample: MeasureSample = {};
    MEASURE_NAMES.forEach((name, k) => {
      const range = ranges[name];
      if (range) sample[name] = between(range[0], range[1])(i, k);
    });
    return sample;
  });
}

/**
 * Shaped on a real calibration that went wrong: an "OK sign" pinch (the other three fingers straight), against a
 * background of a resting, half-curled hand. The thumb-to-index distance is the pinch, but it wobbles and overlaps
 * the background; the little finger happens to be straighter while pinching than at rest, and separates the two
 * recordings better on its own.
 */
const pinch = frames(300, {
  "pinch.index": [0.15, 0.6],
  "extension.index": [0.8, 0.92],
  "extension.middle": [0.89, 0.97],
  "extension.ring": [0.94, 0.99],
  "extension.pinky": [0.95, 0.985],
  "thumb.out": [0.4, 0.65],
});
const resting = frames(300, {
  "pinch.index": [0.45, 1.1],
  "extension.index": [0.75, 0.95],
  "extension.middle": [0.75, 0.95],
  "extension.ring": [0.75, 0.95],
  "extension.pinky": [0.8, 0.955],
  "thumb.out": [0.4, 0.9],
});

describe("calibrating a pinch", () => {
  it("without the open-hand check, rests the rule on the little finger (the bug)", () => {
    const result = analyse(pinch, resting, [], { openHand: false });
    expect(result.conditions[0].measure).toBe("extension.pinky");
    // ...and that rule is set off by most open hands.
    expect(firingRate(result.conditions, [...OPEN_HAND_FRAMES])).toBeGreaterThan(0.3);
  });

  it("with the open-hand check, uses the thumb-to-index distance and does not fire on an open hand", () => {
    const result = analyse(pinch, resting);
    expect(result.conditions[0].measure).toBe("pinch.index");
    expect(firingRate(result.conditions, [...OPEN_HAND_FRAMES])).toBeLessThan(0.1);
    expect(result.openHandFiresOn!).toBeLessThan(0.1);
    // The open hand is reported on its own, not as one of the person's gestures.
    expect(result.confusions).toEqual([]);
  });

  it("keeps the measures the person put in the rule, first, with thresholds fitted to the recording", () => {
    const result = analyse(pinch, resting, [], { keep: ["pinch.index"], openHand: false });
    expect(result.conditions[0]).toMatchObject({ measure: "pinch.index", direction: "below" });
    expect(result.conditions[0].enter).toBeLessThan(result.conditions[0].exit);
    expect(result.conditions[0].enter).toBeGreaterThan(0.15);
    expect(result.conditions[0].exit).toBeLessThan(1.1);
  });

  it("ignores a kept measure the recording could not read, and never keeps more than the rule allows", () => {
    const result = analyse(pinch, resting, [], { keep: ["hand.up", "pinch.index"], openHand: false });
    expect(result.conditions[0].measure).toBe("pinch.index");
    expect(result.conditions.length).toBeLessThanOrEqual(4);
  });

  it("calls a rule that an open hand sets off weak, and says to add the measure that makes the gesture", () => {
    // Only the little finger differs between the two recordings, so nothing else can keep open hands out.
    const result = analyse(frames(60, { "extension.pinky": [0.955, 0.99] }), frames(60, { "extension.pinky": [0.8, 0.94] }));
    expect(result.conditions.map((c) => c.measure)).toEqual(["extension.pinky"]);
    expect(result.openHandFiresOn!).toBeGreaterThanOrEqual(0.3);
    expect(result.verdict).toBe("weak");
    expect(result.advice).toMatch(/open hand would set it off/);
    expect(result.advice).toMatch(/thumb to index tip/);
  });
});

describe("the open-hand check", () => {
  it("is left out for a gesture that is itself an open hand", () => {
    const palm = frames(60, { "pinch.index": [0.9, 1.3], "extension.fingers": [0.94, 1.0] });
    expect(openHandGroup(palm)).toEqual([]);
    expect(openHandGroup(pinch)).toHaveLength(1);
  });

  it("holds the hand at every angle, so a rule on which way the hand points is not mistaken for one on its shape", () => {
    const ups = OPEN_HAND_FRAMES.map((f) => f["hand.up"] as number);
    expect(Math.max(...ups)).toBeGreaterThan(0.95);
    expect(Math.min(...ups)).toBeLessThan(-0.95);
    for (const frame of OPEN_HAND_FRAMES) expect(frame["pinch.index"]).toBeGreaterThan(0.7);
  });
});
