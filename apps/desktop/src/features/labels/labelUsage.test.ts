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
  it("includes the registry's training history and where a label is mentioned in another's", () => {
    const usage = usageOf("fist", { ...sources, registry: { fist: { projects: 0, runs: 0, snapshots: 0, mappedIn: ["pinch"] }, pinch: { projects: 1, runs: 2, snapshots: 2, mappedIn: [] } } });
    expect(usage.mentionedInTrainingOf).toEqual(["pinch"]);
    expect(usageOf("pinch", { ...sources, registry: { pinch: { projects: 1, runs: 2, snapshots: 2, mappedIn: [] } } }).trainingHistory).toEqual({ projects: 1, runs: 2, snapshots: 2 });
    // History alone counts as a use, which is why a label with nothing else listed can still refuse to delete.
    expect(usageCount(usageOf("history_only", { ...sources, registry: { history_only: { projects: 1, runs: 1, snapshots: 1, mappedIn: [] } } }))).toBe(1);
  });
  it("counts nothing for an unused label", () => expect(usageCount(usageOf("unused", sources))).toBe(0));
});
