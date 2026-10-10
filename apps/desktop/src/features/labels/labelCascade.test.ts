import { describe, expect, it, vi } from "vitest";
import { executePlan, planCascade, type CascadeSources } from "./labelCascade";

const sources = (over: Partial<CascadeSources> = {}): CascadeSources => ({
  bundles: [{ recordingId: "r1", labelIds: ["pinch", "fist"] }, { recordingId: "r2", labelIds: ["fist"] }],
  datasets: [
    { id: "d1", originalFilename: "only.csv", importedAt: "", label: "pinch", labels: ["pinch"], rowCount: 5 },
    { id: "d2", originalFilename: "both.csv", importedAt: "", label: "pinch, fist", labels: ["fist", "pinch"], rowCount: 5 },
  ],
  gestures: [{ id: "g1", name: "Pinch", labelId: "pinch" }, { id: "g2", name: "Fist", labelId: "fist" }],
  models: [
    { id: "m1", label: "pinch", state: "active" },
    { id: "m2", label: "pinch", state: "draft" },
    { id: "m3", label: "pinch", state: "archived" },
    { id: "m9", label: "fist", state: "active" },
  ],
  recipes: [
    { id: "x", name: "Model pause", enabled: true, stages: [{ kind: "model", label: "pinch" }] },
    { id: "y", name: "Camera pause", enabled: true, stages: [{ kind: "camera", gesture: "g1" }] },
    { id: "z", name: "Off one", enabled: false, stages: [{ kind: "model", label: "pinch" }] },
    { id: "w", name: "Other", enabled: true, stages: [{ kind: "model", label: "fist" }] },
  ],
  ...over,
});

describe("archive plan", () => {
  it("switches off only the enabled recipes that use the label's model, archives its models by the allowed moves, then the label", () => {
    const plan = planCascade("archive", "pinch", sources());
    expect(plan.blockers).toEqual([]);
    expect(plan.steps).toEqual([
      { kind: "disableRecipe", id: "x", name: "Model pause" },
      { kind: "deactivateModel", label: "pinch" },
      { kind: "setModelState", id: "m1", to: "archived" },
      { kind: "setModelState", id: "m2", to: "evaluated" },
      { kind: "setModelState", id: "m2", to: "archived" },
      { kind: "archiveLabel", log: { disabledRecipes: ["x"], archivedModels: ["m1", "m2"] } },
    ]);
    expect(plan.lines.join(" ")).toMatch(/Kept as they are: 1 gesture, 1 Recorder recording, 2 training recordings/);
  });
});

describe("delete plan", () => {
  it("deletes recipes first, then gestures, models, single-label training recordings, marks and finally the label; multi-label recordings block it", () => {
    const plan = planCascade("delete", "pinch", sources());
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain("both.csv");
    const kinds = plan.steps.map((step) => step.kind);
    expect(kinds.slice(0, 3)).toEqual(["deleteRecipe", "deleteRecipe", "deleteRecipe"]); // x, y (via its gesture), z
    expect(kinds.indexOf("deleteGesture")).toBeGreaterThan(kinds.lastIndexOf("deleteRecipe"));
    expect(kinds.indexOf("deleteModel")).toBeGreaterThan(kinds.indexOf("deleteGesture"));
    expect(kinds[kinds.length - 1]).toBe("deleteLabel");
    expect(plan.steps.filter((s) => s.kind === "deleteDataset")).toEqual([{ kind: "deleteDataset", id: "d1", name: "only.csv" }]);
    expect(plan.steps.filter((s) => s.kind === "removeIntervals")).toEqual([{ kind: "removeIntervals", recordingId: "r1" }]);
    expect(plan.steps.filter((s) => s.kind === "deleteRecipe").map((s) => (s as { id: string }).id).sort()).toEqual(["x", "y", "z"]);
    expect(plan.steps.some((step) => step.kind === "deleteGesture" && step.id === "g2")).toBe(false);
  });

  it("has no blockers when every training recording holds only this label", () => {
    const plan = planCascade("delete", "pinch", sources({ datasets: [{ id: "d1", originalFilename: "only.csv", importedAt: "", label: "pinch", labels: ["pinch"], rowCount: 5 }] }));
    expect(plan.blockers).toEqual([]);
  });
});

describe("restore plan", () => {
  it("switches back on what archiving switched off, returns its models to draft, and restores the label", () => {
    const plan = planCascade("restore", "pinch", sources({ archiveLog: { disabledRecipes: ["x", "gone"], archivedModels: ["m1", "m3"] } }));
    expect(plan.steps).toEqual([
      { kind: "enableRecipe", id: "x", name: "Model pause" },
      { kind: "setModelState", id: "m3", to: "draft" },
      { kind: "restoreLabel" },
    ]);
  });
});

describe("executePlan", () => {
  it("runs each step through the right desktop command, in order, and reports progress", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const progress = vi.fn();
    const plan = planCascade("archive", "pinch", sources());
    const result = await executePlan(plan, run, progress);
    expect(result).toEqual({ ok: true, done: plan.steps.length });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      "set_recipe_enabled", "deactivate_label_model", "set_label_model_state", "set_label_model_state", "set_label_model_state", "set_model_label_archived", "save_label_archive_log",
    ]);
    expect(run).toHaveBeenCalledWith("save_label_archive_log", { id: "pinch", log: { disabledRecipes: ["x"], archivedModels: ["m1", "m2"] } });
    expect(progress).toHaveBeenLastCalledWith(plan.steps.length, plan.steps.length);
  });

  it("stops at the first failure and says what was done and what failed", async () => {
    const run = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce("the model is busy");
    const result = await executePlan(planCascade("archive", "pinch", sources()), run);
    expect(result).toMatchObject({ ok: false, done: 1, failedStep: { kind: "deactivateModel" } });
    expect((result as { message: string }).message).toContain("the model is busy");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refuses to run a plan that has blockers, running nothing", async () => {
    const run = vi.fn();
    const result = await executePlan(planCascade("delete", "pinch", sources()), run);
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("sends the label id with each recording's mark removal and with the final delete", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await executePlan(planCascade("delete", "pinch", sources({ datasets: [] })), run);
    expect(run).toHaveBeenCalledWith("remove_label_from_recording", { recordingId: "r1", labelId: "pinch" });
    expect(run).toHaveBeenLastCalledWith("delete_model_label", { id: "pinch" });
  });
});
