import { describe, expect, it } from "vitest";
import { CombinedGestureDetector } from "./combinedDetector";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const pinch: GestureDefinition = { ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch", conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }], minHoldMs: 100, releaseGraceMs: 100 };
const pinching = [makeHand({ pinch: 0.1 })];
const open = [makeHand({ pinch: 1.2 })];

/** Feeds `frames` 33 ms apart to one camera. */
function feed(d: CombinedGestureDetector, slot: "primary" | "secondary", start: number, frames: number, hands = pinching) {
  const events = [];
  for (let i = 0; i < frames; i++) events.push(...d.update(slot, start + i * 33, hands));
  return events;
}

describe("CombinedGestureDetector", () => {
  it("in either mode starts when the first camera confirms it, and does not start again when the second one agrees", () => {
    const d = new CombinedGestureDetector([pinch]);
    d.setSlotRunning("secondary", true, 0);
    const first = feed(d, "primary", 1000, 8);
    expect(first.map((e) => e.kind)).toEqual(["onset"]);
    expect(first[0].atMs).toBe(1000);
    expect(feed(d, "secondary", 1100, 8)).toEqual([]);
    expect(d.states().get("g1")).toMatchObject({ held: true, count: 1 });
  });

  it("stays held while either camera still sees it, and ends when the last one lets go", () => {
    const d = new CombinedGestureDetector([pinch]);
    d.setSlotRunning("secondary", true, 0);
    feed(d, "primary", 1000, 8);
    feed(d, "secondary", 1000, 8);
    // The primary loses it; the second still sees it.
    expect(feed(d, "primary", 1300, 8, open)).toEqual([]);
    expect(d.states().get("g1")?.held).toBe(true);
    feed(d, "secondary", 1300, 3);
    const ended = feed(d, "secondary", 1400, 8, open);
    expect(ended.map((e) => e.kind)).toEqual(["release"]);
    expect(ended[0].heldMs).toBeGreaterThan(300);
    expect(d.states().get("g1")?.held).toBe(false);
  });

  it("in both mode needs every running camera, and ignores a camera that is not running", () => {
    const d = new CombinedGestureDetector([pinch], "both");
    // Only the primary is running, so it alone decides.
    expect(feed(d, "primary", 1000, 8).map((e) => e.kind)).toEqual(["onset"]);
    d.reset();
    d.setSlotRunning("secondary", true, 2000);
    expect(feed(d, "primary", 2000, 8)).toEqual([]); // the second camera does not see it yet
    expect(d.states().get("g1")?.held).toBe(false);
    const both = feed(d, "secondary", 2100, 8);
    expect(both.map((e) => e.kind)).toEqual(["onset"]);
    expect(both[0].atMs).toBe(2100); // when the last of them began
  });

  it("lets go of what a camera held when that camera stops, which can end the merged gesture", () => {
    const d = new CombinedGestureDetector([pinch]);
    d.setSlotRunning("secondary", true, 0);
    feed(d, "secondary", 1000, 8);
    expect(d.states().get("g1")?.held).toBe(true);
    const events = d.setSlotRunning("secondary", false, 1400);
    expect(events.map((e) => e.kind)).toEqual(["release"]);
    expect(d.states().get("g1")?.held).toBe(false);
  });

  it("changing the mode re-merges what is held now", () => {
    const d = new CombinedGestureDetector([pinch]);
    d.setSlotRunning("secondary", true, 0);
    feed(d, "primary", 1000, 8);
    expect(d.states().get("g1")?.held).toBe(true);
    const events = d.setMode("both"); // the second camera does not see it
    expect(events.map((e) => e.kind)).toEqual(["release"]);
  });

  it("drops a deleted gesture and keeps counts per gesture", () => {
    const other = { ...pinch, id: "g2", name: "Other" };
    const d = new CombinedGestureDetector([pinch, other]);
    feed(d, "primary", 1000, 8);
    d.setDefinitions([other]);
    expect([...d.states().keys()]).toEqual(["g2"]);
  });
});
