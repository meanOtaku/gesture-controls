import { describe, expect, it } from "vitest";
import { dragLabel } from "./EditableLabelRail";

const spans = [{ startMs: 10, endMs: 20, label: "pinch" }, { startMs: 40, endMs: 60, label: "fist" }];
describe("manual label dragging", () => {
  it("moves without changing duration and stops before neighbours", () => {
    const moved = dragLabel(spans, 0, "move", 100, 100);
    expect(moved.endMs).toBeLessThan(40);
    expect(moved.endMs - moved.startMs).toBeCloseTo(10);
    expect(dragLabel(spans, 0, "move", -100, 100).startMs).toBe(0);
  });
  it("resizes either edge without crossing the other edge or neighbours", () => {
    expect(dragLabel(spans, 1, "start", -100, 100).startMs).toBeGreaterThan(20);
    expect(dragLabel(spans, 0, "start", 100, 100).startMs).toBe(19);
    expect(dragLabel(spans, 1, "end", 100, 100).endMs).toBe(100);
    expect(dragLabel(spans, 1, "end", -100, 100).endMs).toBe(41);
    expect(spans[0]).toEqual({ startMs: 10, endMs: 20, label: "pinch" });
  });
});
