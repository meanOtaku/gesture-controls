import { describe, expect, it } from "vitest";
import { analyse, scoreRule, type MeasureSample } from "./calibration";
import { GestureDetector } from "./detector";
import { blankDefinition } from "./definition";
import { measureHand } from "../camera/landmarkMath";
import { measureValue, MEASURE_NAMES } from "./definition";
import { makeHand, type HandSpec } from "./testHands";

/** A deterministic spread around a base value, as a real hand's reading wobbles. */
const wobble = (base: number, i: number, amount = 0.04) => base + Math.sin(i * 12.9898) * amount;

function sample(spec: HandSpec): MeasureSample {
  const measures = measureHand(makeHand(spec))!;
  return Object.fromEntries(MEASURE_NAMES.map((name) => [name, measureValue(measures, name)]));
}
const frames = (count: number, make: (i: number) => HandSpec) => Array.from({ length: count }, (_, i) => sample(make(i)));

describe("analyse", () => {
  it("finds the measure that separates a pinch from an open hand, with a looser end than start", () => {
    const positive = frames(60, (i) => ({ pinch: Math.max(0, wobble(0.1, i)) }));
    const negative = frames(60, (i) => ({ pinch: wobble(1.0, i, 0.3) }));
    const result = analyse(positive, negative);
    expect(result.verdict).toBe("good");
    expect(result.balancedAccuracy).toBeGreaterThan(0.95);
    expect(result.stats[0].measure).toBe("pinch.index");
    expect(result.conditions[0]).toMatchObject({ measure: "pinch.index", direction: "below" });
    const c = result.conditions[0];
    expect(c.enter).toBeLessThan(c.exit);
    expect(c.exit).toBeLessThan(0.9);
    // Fresh pinches are found and fresh open hands are not.
    expect(scoreRule(result.conditions, frames(40, (i) => ({ pinch: Math.max(0, wobble(0.12, i + 7)) })), frames(40, (i) => ({ pinch: wobble(1.1, i + 7, 0.3) })))).toBeGreaterThan(0.95);
  });

  it("finds a curled finger by its straightness, and can use two measures together", () => {
    const positive = frames(60, (i) => ({ pinch: 1.2, curl: { index: 0.9 + wobble(0, i, 0.05), middle: 0.9 + wobble(0, i + 3, 0.05) } }));
    const negative = frames(60, (i) => ({ pinch: wobble(1.2, i, 0.2), curl: { index: wobble(0.05, i, 0.04), middle: wobble(0.05, i + 1, 0.04) } }));
    const result = analyse(positive, negative);
    expect(result.verdict).toBe("good");
    expect(result.conditions.length).toBeGreaterThanOrEqual(1);
    // The thumb-to-index distance is the same in both groups here, so it must not be what the rule rests on.
    expect(result.conditions.some((c) => c.measure === "pinch.index")).toBe(false);
    expect(result.balancedAccuracy).toBeGreaterThan(0.95);
  });

  it("calls two groups that look the same weak, and says what to do", () => {
    const positive = frames(60, (i) => ({ pinch: wobble(0.8, i, 0.3) }));
    const negative = frames(60, (i) => ({ pinch: wobble(0.8, i + 100, 0.3) }));
    const result = analyse(positive, negative);
    expect(result.verdict).toBe("weak");
    expect(result.advice).toMatch(/cannot reliably tell/);
  });

  it("asks for more frames rather than trusting a handful", () => {
    const result = analyse(frames(5, () => ({ pinch: 0.1 })), frames(5, () => ({ pinch: 1 })));
    expect(result.verdict).toBe("needsMoreFrames");
    expect(result.advice).toMatch(/at least 30/);
    expect(result.advice).toMatch(/You have 5 and 5/);
  });

  it("copes with no data and with measures that could not be read", () => {
    expect(analyse([], []).conditions).toEqual([]);
    const missing: MeasureSample = { "pinch.index": null };
    expect(analyse([missing, missing, missing], [missing, missing, missing]).stats).toEqual([]);
  });

  it("adds a second measure only when it clearly helps", () => {
    const positive = frames(60, (i) => ({ pinch: Math.max(0, wobble(0.1, i)) }));
    const negative = frames(60, (i) => ({ pinch: wobble(1.0, i, 0.3) }));
    expect(analyse(positive, negative).conditions).toHaveLength(1);
  });

  it("produces a rule the detector then follows", () => {
    const positive = frames(60, (i) => ({ pinch: Math.max(0, wobble(0.1, i)) }));
    const negative = frames(60, (i) => ({ pinch: wobble(1.0, i, 0.3) }));
    const definition = { ...blankDefinition(), id: "g", name: "Pinch", conditions: analyse(positive, negative).conditions };
    const detector = new GestureDetector([definition]);
    const run = (hand: ReturnType<typeof makeHand>, n: number, from: number) => Array.from({ length: n }, (_, i) => detector.update(from + i * 33, [hand])).flat();
    expect(run(makeHand({ pinch: 1.1 }), 10, 0)).toEqual([]);
    expect(run(makeHand({ pinch: 0.1 }), 10, 400).map((e) => e.kind)).toEqual(["onset"]);
    expect(run(makeHand({ pinch: 1.1 }), 10, 800).map((e) => e.kind)).toEqual(["release"]);
  });
});
