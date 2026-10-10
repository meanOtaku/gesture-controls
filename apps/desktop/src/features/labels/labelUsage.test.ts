import { describe, expect, it } from "vitest";
import { usageCount, usageOf } from "./labelUsage";

const sources = {
  bundles: [{ recordingId: "r1", labelIds: ["pinch"] }, { recordingId: "r2", labelIds: ["fist"] }],
  datasets: [{ id: "d1", originalFilename: "a.csv", importedAt: "", label: "pinch, fist", labels: ["fist", "pinch"], rowCount: 5 }, { id: "d2", originalFilename: "b.csv", importedAt: "", label: "idle", rowCount: 3 }],
  gestures: [{ id: "g1", name: "Pinch", labelId: "pinch" }, { id: "g2", name: "Loose", labelId: null }],
  models: [{ id: "m1", label: "pinch", state: "active" as const }],
  recipes: [{ id: "x", name: "Pinch pause", stages: [{ kind: "model", label: "pinch" }] }, { id: "y", name: "Camera", stages: [{ kind: "camera" }] }],
};

describe("usageOf", () => {
  it("finds every place a label is used, and only that label's", () => {
    const usage = usageOf("pinch", sources);
    expect(usage.recordings).toEqual([{ id: "r1" }]);
    expect(usage.trainingRecordings).toEqual([{ id: "d1", name: "a.csv" }]);
    expect(usage.gestures).toEqual([{ id: "g1", name: "Pinch" }]);
    expect(usage.models).toEqual([{ id: "m1", state: "active" }]);
    expect(usage.recipes).toEqual([{ id: "x", name: "Pinch pause" }]);
    expect(usageCount(usage)).toBe(5);
  });
  it("counts nothing for an unused label", () => expect(usageCount(usageOf("unused", sources))).toBe(0));
});
