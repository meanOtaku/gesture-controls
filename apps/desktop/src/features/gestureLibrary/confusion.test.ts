import { describe, expect, it } from "vitest";
import { analyse, type MeasureSample } from "./calibration";
import { checkLibrary } from "./confusion";
import { blankDefinition, type GestureDefinition } from "./definition";
import { fromSampleSet, handsOverlap, MAX_KEPT_FRAMES, othersWithSamples, toSampleSet } from "./sampleStore";

const gesture = (id: string, name: string, conditions: GestureDefinition["conditions"], hand: GestureDefinition["hand"] = "either"): GestureDefinition => ({ ...blankDefinition(), id, name, conditions, hand });
const frames = (value: number, count = 40): MeasureSample[] => Array.from({ length: count }, () => ({ "thumb.up": value, "thumb.out": 1.5 }));
const up = gesture("up", "Thumbs up", [{ measure: "thumb.up", direction: "above", enter: 0.5, exit: 0.3 }]);
const down = gesture("down", "Thumbs down", [{ measure: "thumb.up", direction: "below", enter: -0.5, exit: -0.3 }]);
const loose = gesture("loose", "Any thumb", [{ measure: "thumb.out", direction: "above", enter: 1, exit: 0.8 }]);

describe("checkLibrary", () => {
  it("is clear for gestures whose rules do not fire on each other's frames", () => {
    const check = checkLibrary([up, down], { up: frames(0.9), down: frames(-0.9) });
    expect(check.pairs).toEqual([]);
    expect(check.recall.map((r) => r.finds)).toEqual([1, 1]);
    expect(check.checked).toBe(2);
  });

  it("names a rule that fires on another gesture's frames, worst first", () => {
    const check = checkLibrary([up, down, loose], { up: frames(0.9), down: frames(-0.9), loose: frames(0) });
    const pairs = check.pairs.map((p) => `${p.rule.name} on ${p.on.name}: ${p.severity}`);
    expect(pairs).toEqual(expect.arrayContaining(["Any thumb on Thumbs up: bad", "Any thumb on Thumbs down: bad"]));
    expect(pairs.some((p) => p.startsWith("Thumbs up on"))).toBe(false);
  });

  it("leaves out gestures that have no saved frames, and says which", () => {
    const check = checkLibrary([up, down], { up: frames(0.9) });
    expect(check.unchecked.map((g) => g.name)).toEqual(["Thumbs down"]);
    expect(check.checked).toBe(1);
  });

  it("does not compare a left-hand gesture with a right-hand one", () => {
    const left = { ...loose, id: "l", hand: "left" as const };
    const right = { ...up, id: "r", hand: "right" as const };
    expect(checkLibrary([left, right], { l: frames(0), r: frames(0.9) }).pairs).toEqual([]);
    expect(handsOverlap("left", "right")).toBe(false);
    expect(handsOverlap("either", "right")).toBe(true);
  });
});

describe("saved frames", () => {
  it("keep at most a few hundred frames spread over the whole recording, rounded", () => {
    const long: MeasureSample[] = Array.from({ length: 900 }, (_, i) => ({ "thumb.up": i / 900 + 0.123456789 }));
    const set = toSampleSet(long);
    expect(set.rows.length).toBeLessThanOrEqual(MAX_KEPT_FRAMES);
    const index = set.measures.indexOf("thumb.up");
    expect(set.rows[0][index]).toBeCloseTo(0.1235, 4);
    expect(set.rows.at(-1)![index]!).toBeGreaterThan(1); // from the end of the recording, not only its start
    expect(set.rows[0][set.measures.indexOf("thumb.out")]).toBeNull();
  });

  it("read back as the frames they were, ignoring measurements this version does not know", () => {
    const back = fromSampleSet({ measures: ["thumb.up", "something.new"], rows: [[0.5, 9], [null, 1]] });
    expect(back).toEqual([{ "thumb.up": 0.5 }, { "thumb.up": null }]);
  });

  it("offer the other gestures that have frames for the check", () => {
    const others = othersWithSamples([up, down, loose], { up: frames(0.9), loose: [] }, "down");
    expect(others.map((o) => o.name)).toEqual(["Thumbs up"]);
  });

  it("let a recorded gesture be rejected against what was kept for another", () => {
    const kept = fromSampleSet(toSampleSet(frames(0.9, 60)));
    const analysis = analyse(frames(-0.9, 60), frames(0, 60), [{ name: "Thumbs up", samples: kept }]);
    expect(analysis.confusions[0].firesOn).toBeLessThan(0.05);
  });
});
