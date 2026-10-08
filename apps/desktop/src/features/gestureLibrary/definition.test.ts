import { describe, expect, it } from "vitest";
import { MEASURE_NAMES, blankDefinition, definitionProblem, describeRule, measureValue, type GestureDefinition } from "./definition";
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
