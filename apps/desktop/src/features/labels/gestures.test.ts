import { describe, expect, it } from "vitest";
import type { DatasetLabel } from "../model-lab/types";
import { gestureGroups, gestureOf, inTreeOrder, isHeld, recordedLabels } from "./gestures";

const label = (id: string, over: Partial<DatasetLabel> = {}): DatasetLabel => ({ id, displayName: id, description: "", color: "#000000", role: "positiveGesture", archivedAt: null, ...over });
const labels = [
  label("everyday_noise", { role: "negativeBackground", standard: true }),
  label("fist"),
  label("pinch"),
  label("pinch_in", { parent: "pinch", phase: "start" }),
  label("pinch_hold", { parent: "pinch", phase: "hold" }),
  label("pinch_out", { parent: "pinch", phase: "end" }),
  label("tap"),
];

describe("gestures", () => {
  it("groups each gesture with its phases: held with a start and an end, momentary without", () => {
    const groups = gestureGroups(labels);
    expect(groups.map((group) => group.gesture.id)).toEqual(["fist", "pinch", "tap"]);
    const pinch = groups.find((group) => group.gesture.id === "pinch")!;
    expect(isHeld(pinch)).toBe(true);
    expect(recordedLabels(pinch)).toEqual(["pinch_in", "pinch_hold", "pinch_out"]);
    const tap = groups.find((group) => group.gesture.id === "tap")!;
    expect(isHeld(tap)).toBe(false);
    expect(recordedLabels(tap)).toEqual(["tap"]);
    expect(gestureOf(labels, "pinch_out")).toBe("pinch");
    expect(gestureOf(labels, "tap")).toBe("tap");
  });

  it("puts each gesture's phases under it, in order", () => {
    expect(inTreeOrder(labels).map(({ label: l, depth }) => `${"  ".repeat(depth)}${l.id}`)).toEqual([
      "everyday_noise", "fist", "pinch", "  pinch_in", "  pinch_hold", "  pinch_out", "tap",
    ]);
  });
});
