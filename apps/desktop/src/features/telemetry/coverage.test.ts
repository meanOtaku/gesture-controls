import { describe, expect, it } from "vitest";
import type { DatasetSummary } from "../model-lab/types";
import { coverageOf } from "./coverage";

const recording = (id: string, holds: Record<string, number>, context?: Record<string, string>): DatasetSummary => ({
  id, originalFilename: id, importedAt: "", label: "", rowCount: 1, quality: { poorContactShare: 0, holds, shortHolds: 0 }, context,
});

describe("coverage of a label by session details", () => {
  it("counts its holds by arm and wrist, and by the other details", () => {
    const coverage = coverageOf(
      [
        recording("a", { pinch: 20 }, { arm: "resting", wrist: "left", activity: "Typing" }),
        recording("b", { pinch: 10, fist: 4 }, { arm: "resting", wrist: "left", activity: "typing", strap: "tight" }),
        recording("c", { pinch: 5 }, { arm: "walking" }),
        recording("d", { pinch: 7 }),
        recording("e", { fist: 9 }, { arm: "raised" }),
      ],
      "pinch",
    );
    expect(coverage.grid.resting.left).toBe(30);
    expect(coverage.grid.walking[""]).toBe(5);
    expect(coverage.grid[""][""]).toBe(7);
    expect(coverage.grid.raised.left).toBe(0); // only fists there
    expect(coverage.total).toBe(42);
    expect(coverage.recordings).toBe(4);
    expect(coverage.byField.find((entry) => entry.field === "activity")?.counts).toEqual([["typing", 30], ["", 12]]);
  });
});

describe("a training split's coverage", () => {
  it("lists each condition either side has, with its holds on each side", async () => {
    const { splitCoverage } = await import("./coverage");
    const rows = splitCoverage(
      [
        recording("a", { pinch: 20 }, { arm: "resting", wrist: "left" }),
        recording("b", { pinch: 10 }, { arm: "resting", wrist: "left" }),
        recording("c", { pinch: 5 }, { arm: "walking", wrist: "left" }),
      ],
      ["a"],
      ["b", "c"],
      "pinch",
    );
    expect(rows).toEqual([
      { arm: "resting", wrist: "left", train: 20, test: 10 },
      { arm: "walking", wrist: "left", train: 0, test: 5 },
    ]);
  });
});
