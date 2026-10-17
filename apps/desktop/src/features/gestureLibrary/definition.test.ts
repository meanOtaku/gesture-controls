import { describe, expect, it } from "vitest";
import { MEASURE_NAMES, blankDefinition, defaultCondition, definitionProblem, describeRule, measureValue, type GestureDefinition } from "./definition";
import { measureHand } from "../camera/landmarkMath";
import { makeHand } from "./testHands";

const valid = (): GestureDefinition => ({
  ...blankDefinition(), name: "Pinch", conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }],
});

describe("gesture definitions", () => {
  it("reads any measure from a hand's measures", () => {
    const measures = measureHand(makeHand({ pinch: 0.4 }))!;
    expect(measureValue(measures, "pinch.index")).toBeCloseTo(0.4, 4);
    expect(measureValue(measures, "extension.index")).toBeCloseTo(1, 4);
    for (const name of MEASURE_NAMES) expect(measureValue(measures, name)).not.toBeUndefined();
  });

  it("says a rule in words", () => {
    expect(describeRule(valid())).toBe("thumb to index tip below 0.3 hand sizes");
    expect(describeRule({ ...valid(), hand: "right", conditions: [...valid().conditions, { measure: "extension.middle", direction: "above", enter: 0.9, exit: 0.8 }] }))
      .toBe("thumb to index tip below 0.3 hand sizes and middle straightness above 0.9 (right hand only)");
    expect(describeRule(blankDefinition())).toBe("No rule yet");
  });

  it("accepts a good definition and explains each way one can be wrong", () => {
    expect(definitionProblem(valid())).toBeNull();
    const bad = (change: Partial<GestureDefinition>) => definitionProblem({ ...valid(), ...change });
    expect(bad({ name: "  " })).toMatch(/name/);
    expect(bad({ name: "x".repeat(41) })).toMatch(/at most 40/);
    expect(bad({ conditions: [] })).toMatch(/at least one condition/);
    expect(bad({ conditions: Array.from({ length: 5 }, (_, i) => ({ measure: MEASURE_NAMES[i], direction: "below" as const, enter: 0.3, exit: 0.5 })) })).toMatch(/at most 4/);
    expect(bad({ conditions: [valid().conditions[0], valid().conditions[0]] })).toMatch(/same measurement/);
    expect(bad({ conditions: [{ measure: "pinch.index", direction: "below", enter: Number.NaN, exit: 1 }] })).toMatch(/number/);
    expect(bad({ conditions: [{ measure: "pinch.index", direction: "below", enter: 0.5, exit: 0.3 }] })).toMatch(/looser/);
    expect(bad({ conditions: [{ measure: "extension.index", direction: "above", enter: 0.8, exit: 0.9 }] })).toMatch(/looser/);
    expect(bad({ minHoldMs: -1 })).toMatch(/hold time/);
    expect(bad({ releaseGraceMs: 5000 })).toMatch(/release time/);
  });
});

describe("a gesture with a pretrained gesture", () => {
  it("needs no conditions, but still a name, and the pretrained name must be known", () => {
    const base = { ...blankDefinition(), name: "Thumbs up" };
    expect(definitionProblem(base)).toMatch(/at least one condition, or a pretrained gesture/);
    expect(definitionProblem({ ...base, pretrained: "Thumb_Up" })).toBeNull();
    expect(definitionProblem({ ...base, pretrained: "Thumbs_Sideways" as never })).toMatch(/not one the recogniser knows/);
  });
  it("is described by what the model says", () => {
    expect(describeRule({ conditions: [], hand: "left", pretrained: "Thumb_Down" })).toBe("the pretrained model says “Thumb down” (left hand only)");
  });
});

describe("defaultCondition", () => {
  it("starts a hand-made pinch where real touching tips read (about 0.15 to 0.35), not near 0", () => {
    expect(defaultCondition("pinch.index")).toEqual({ measure: "pinch.index", direction: "below", enter: 0.35, exit: 0.45 });
    // Real pinch frames from a recording: most pass the default start threshold.
    const realPinch = [0.145, 0.18, 0.24, 0.27, 0.29, 0.31, 0.33, 0.34, 0.36, 0.39];
    expect(realPinch.filter((value) => value < defaultCondition("pinch.index").enter).length).toBeGreaterThanOrEqual(8);
    expect(defaultCondition("extension.index")).toMatchObject({ direction: "below", enter: 0.3, exit: 0.4 });
  });
});
