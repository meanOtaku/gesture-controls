import { describe, expect, it } from "vitest";
import { datasetLabels } from "./types";

describe("datasetLabels", () => {
  it("uses every row label of a multi-label (Timeline Capture) dataset", () => {
    expect(datasetLabels({ label: "idle, pinch_start", labels: ["idle", "pinch_start"] })).toEqual([
      "idle",
      "pinch_start",
    ]);
  });

  it("falls back to the single label for a dataset imported before multi-label support", () => {
    expect(datasetLabels({ label: "idle" })).toEqual(["idle"]);
    expect(datasetLabels({ label: "idle", labels: [] })).toEqual(["idle"]);
  });
});
