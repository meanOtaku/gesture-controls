import { describe, expect, it } from "vitest";
import { NO_LABEL } from "./labellingModel";
import { effectiveSpans, nextProblem, problemsIn } from "./problems";

const name = (label: string) => label;

describe("where the labels, the camera and a model disagree", () => {
  it("takes your labels over the recorded ones", () => {
    const [only, ...rest] = effectiveSpans([{ startMs: 0, endMs: 1000, label: "pinch" }], [{ startMs: 500, endMs: 1000, label: NO_LABEL }]);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ startMs: 0, label: "pinch" });
    expect(only.endMs).toBeCloseTo(500);
  });

  it("finds short holds, labels without a contact, contacts without a label, false detections and misses", () => {
    const problems = problemsIn({
      recorded: [
        { startMs: 1000, endMs: 1500, label: "pinch" }, // a contact at 1.1 s, caught at 1.9 s
        { startMs: 5000, endMs: 5100, label: "pinch" }, // too short; no contact; missed
        { startMs: 9000, endMs: 9600, label: "typing" }, // not a gesture: no contact wanted
      ],
      byHand: [],
      contacts: [{ startMs: 1100, endMs: 1300 }, { startMs: 12_000, endMs: 12_200 }],
      gestures: new Set(["pinch"]),
      models: [{ label: "pinch", detections: [{ startMs: 1900, endMs: 1950, label: "pinch" }, { startMs: 15_000, endMs: 15_050, label: "pinch" }] }],
      nameOf: name,
    });
    expect(problems.map((p) => [p.atMs, p.text])).toEqual([
      [5000, "pinch lasts 100 ms: too short to train on"],
      [5000, "pinch is labelled, but the camera saw no contact near it"],
      [5000, "The pinch model missed this pinch"],
      [12_000, "The camera saw the fingers close, with no gesture labelled"],
      [15_000, "The pinch model fired with no pinch starting 0.68 to 1.28 s before"],
    ]);
    expect(nextProblem(problems, 0, 1)?.atMs).toBe(5000);
    expect(nextProblem(problems, 5000, 1)?.atMs).toBe(12_000);
    expect(nextProblem(problems, 12_000, -1)?.atMs).toBe(5000);
    expect(nextProblem(problems, 15_000, 1)).toBeNull();
  });
});
