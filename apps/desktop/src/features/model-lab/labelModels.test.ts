import { describe, expect, it } from "vitest";
import { actionsFor, groupByLabel, type LabelModel } from "./labelModels";

const model = (over: Partial<LabelModel>): LabelModel => ({
  id: "m", label: "snap", state: "draft", deployable: true, imported: true, modelSha256: null, createdAt: "2026-10-01T00:00:00Z", active: false, ...over,
});

describe("actionsFor", () => {
  it("only offers the next safe move, and activation only from Approved", () => {
    expect(actionsFor({ state: "draft", deployable: true }).map((a) => a.label)).toEqual(["Mark as evaluated"]);
    expect(actionsFor({ state: "evaluated", deployable: true }).map((a) => a.label)).toEqual(["Approve", "Archive"]);
    expect(actionsFor({ state: "approved", deployable: true }).map((a) => a.kind)).toContain("activate");
    for (const state of ["draft", "evaluated", "archived", "active"] as const) {
      expect(actionsFor({ state, deployable: true }).some((a) => a.kind === "activate")).toBe(false);
    }
    expect(actionsFor({ state: "active", deployable: true }).map((a) => a.kind)).toEqual(["deactivate"]);
  });

  it("never offers approval for a model that cannot be deployed", () => {
    expect(actionsFor({ state: "evaluated", deployable: false }).map((a) => a.label)).toEqual(["Archive"]);
  });
});

describe("groupByLabel", () => {
  it("groups by label alphabetically, newest first", () => {
    const groups = groupByLabel([
      model({ id: "b1", label: "b", createdAt: "2026-10-01" }),
      model({ id: "a-old", label: "a", createdAt: "2026-09-01" }),
      model({ id: "a-new", label: "a", createdAt: "2026-10-02" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["a", "b"]);
    expect(groups[0].models.map((m) => m.id)).toEqual(["a-new", "a-old"]);
  });
});
