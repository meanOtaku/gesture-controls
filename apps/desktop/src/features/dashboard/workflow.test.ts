import { describe, expect, it } from "vitest";
import type { DatasetSummary } from "../model-lab/types";
import { workflowSteps } from "./workflow";

const dataset = (id: string, over: Partial<DatasetSummary> = {}): DatasetSummary => ({ id, originalFilename: id, importedAt: "", label: "pinch", rowCount: 1, contentSha: id, ...over });

describe("the steps of making a model", () => {
  it("says where each stands", () => {
    const steps = workflowSteps({
      recorderRecordings: 6,
      datasets: [dataset("a", { review: { status: "reviewed", at: "" } }), dataset("b", { review: { status: "needs_work", at: "" } }), dataset("c", { contentSha: "a" }), dataset("d", { sealed: true })],
      models: 0,
      finalTests: 0,
    });
    expect(steps.map((step) => [step.key, step.complete])).toEqual([["record", true], ["label", false], ["clean", false], ["train", false], ["test", false]]);
    expect(steps[1].status).toBe("1 of 4 reviewed, 1 need work.");
    expect(steps[2].status).toMatch(/^2 recordings have something to fix/);
    expect(steps[4].status).toBe("1 sealed recording, 0 tests so far.");
  });
});
