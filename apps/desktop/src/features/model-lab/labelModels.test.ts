import { describe, expect, it } from "vitest";
import { MAX_ACTIVITY, actionsFor, appendActivity, bestState, describeReport, groupByLabel, type DetectionReport, type LabelModel } from "./labelModels";

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

describe("activity lines", () => {
  const report = (over: Partial<DetectionReport>): DetectionReport => ({ events: [], conflicts: [], rejections: [], ...over });

  it("describes starts, releases and problems in plain words, and leaves ongoing detections out", () => {
    const lines = describeReport(report({
      events: [
        { kind: "rising", label: "snap", confidence: 0.912, timestampNs: 1 },
        { kind: "active", label: "snap", confidence: 0.95, timestampNs: 2 },
        { kind: "falling", label: "snap", timestampNs: 3, reason: "scoreBelowRelease" },
        { kind: "falling", label: "fist", timestampNs: 4, reason: "rejected: stale input" },
        { kind: "falling", label: "wave", timestampNs: 5, reason: "modelChanged" },
      ],
      conflicts: [["swipe_left", "swipe_right"]],
      rejections: ["snap: too few samples"],
    }));
    expect(lines.map((l) => l.text)).toEqual([
      "snap detected (91%)",
      "snap released: ended normally",
      "fist released: stopped: stale input",
      "wave released: its model was changed",
      "swipe_left and swipe_right were detected together, so both were held off",
      "Skipped a window for snap: too few samples",
    ]);
    expect(lines.map((l) => l.tone)).toEqual(["detected", "released", "warning", "warning", "warning", "warning"]);
  });

  it("lists newest first, counts an identical repeat, and caps the list", () => {
    let id = 0;
    const next = () => id++;
    const warn = { tone: "warning" as const, text: "Skipped a window for snap: stale" };
    let list = appendActivity([], [warn, warn, warn], next);
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(3);
    list = appendActivity(list, [{ tone: "detected", text: "snap detected (90%)" }], next);
    expect(list.map((e) => e.text)).toEqual(["snap detected (90%)", warn.text]);
    const many = appendActivity([], Array.from({ length: 50 }, (_, i) => ({ tone: "detected" as const, text: `d${i}` })), next);
    expect(many).toHaveLength(MAX_ACTIVITY);
    expect(many[0].text).toBe("d49");
  });
});

describe("bestState", () => {
  it("is the furthest-along state, or null with no models", () => {
    expect(bestState([])).toBeNull();
    expect(bestState([{ state: "draft" }, { state: "approved" }, { state: "archived" }])).toBe("approved");
    expect(bestState([{ state: "approved" }, { state: "active" }])).toBe("active");
  });
});
