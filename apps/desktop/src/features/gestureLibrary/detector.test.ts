import { describe, expect, it } from "vitest";
import { GestureDetector, handMatches } from "./detector";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const pinch = (over: Partial<GestureDefinition> = {}): GestureDefinition => ({
  ...blankDefinition(), id: "pinch", name: "Pinch", minHoldMs: 100, releaseGraceMs: 120,
  conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }], ...over,
});
const open = makeHand({ pinch: 1.2 });
const pinched = makeHand({ pinch: 0.1 });
const between = makeHand({ pinch: 0.4 }); // not enough to start, still enough to stay

/** Frames at 30 per second, from `startMs`, one hand each. */
function run(detector: GestureDetector, frames: (typeof open | null)[], startMs = 1000) {
  return frames.flatMap((hand, i) => detector.update(startMs + i * 33, hand ? [hand] : []).map((event) => ({ ...event, atMs: Math.round(event.atMs) })));
}

describe("handMatches", () => {
  it("uses the start threshold to begin and the looser end threshold to stay", () => {
    expect(handMatches(pinch(), pinched, "enter")).toBe(true);
    expect(handMatches(pinch(), between, "enter")).toBe(false);
    expect(handMatches(pinch(), between, "exit")).toBe(true);
    expect(handMatches(pinch(), open, "exit")).toBe(false);
  });

  it("applies the hand choice to the physical hand, not MediaPipe's mirrored label", () => {
    const rawLeftLabel = makeHand({ pinch: 0.1, modelHandedness: "Left" }); // a physical right hand
    expect(handMatches(pinch({ hand: "right" }), rawLeftLabel, "enter")).toBe(true);
    expect(handMatches(pinch({ hand: "left" }), rawLeftLabel, "enter")).toBe(false);
    expect(handMatches(pinch({ hand: "either" }), rawLeftLabel, "enter")).toBe(true);
  });

  it("never matches without a rule, or when a measure cannot be read", () => {
    expect(handMatches(pinch({ conditions: [] }), pinched, "enter")).toBe(false);
    const collapsed = makeHand();
    collapsed.world = collapsed.world.map(() => ({ x: 0, y: 0, z: 0 }));
    expect(handMatches(pinch(), collapsed, "enter")).toBe(false);
  });
});

describe("GestureDetector", () => {
  it("starts after the hold time, stamped with when the pose began, and ends once it has been lost for the grace time", () => {
    const detector = new GestureDetector([pinch()]);
    const events = run(detector, [open, open, pinched, pinched, pinched, pinched, pinched, open, open, open, open, open]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ gestureId: "pinch", kind: "onset", atMs: 1000 + 2 * 33 });
    // Lost at frame 7 (when the hand opened), and gone for longer than 120 ms by frame 11.
    expect(events[1]).toMatchObject({ kind: "release", atMs: 1000 + 7 * 33 });
    expect(events[1].heldMs).toBe(5 * 33);
  });

  it("does not start for a pose that is gone before the hold time", () => {
    const detector = new GestureDetector([pinch({ minHoldMs: 200 })]);
    expect(run(detector, [open, pinched, pinched, open, open, open])).toEqual([]);
    expect(detector.states().get("pinch")).toMatchObject({ held: false, count: 0 });
  });

  it("does not end for a brief loss, so a wobbling hand does not flicker", () => {
    const detector = new GestureDetector([pinch()]);
    const events = run(detector, [pinched, pinched, pinched, pinched, pinched, open, pinched, pinched, pinched]);
    expect(events.map((e) => e.kind)).toEqual(["onset"]);
    expect(detector.states().get("pinch")?.held).toBe(true);
  });

  it("stays on while the hand drifts between the start and end thresholds", () => {
    const detector = new GestureDetector([pinch()]);
    const events = run(detector, [pinched, pinched, pinched, pinched, pinched, between, between, between, between, between, between]);
    expect(events.map((e) => e.kind)).toEqual(["onset"]);
  });

  it("ends when the hand leaves the picture", () => {
    const detector = new GestureDetector([pinch()]);
    const events = run(detector, [pinched, pinched, pinched, pinched, pinched, null, null, null, null, null]);
    expect(events.map((e) => e.kind)).toEqual(["onset", "release"]);
  });

  it("counts each start and can start again", () => {
    const detector = new GestureDetector([pinch()]);
    run(detector, [pinched, pinched, pinched, pinched, pinched, open, open, open, open, open, pinched, pinched, pinched, pinched, pinched]);
    expect(detector.states().get("pinch")).toMatchObject({ held: true, count: 2 });
  });

  it("follows several gestures at once, and forgets one that is removed", () => {
    const pinkyOut = pinch({ id: "other", conditions: [{ measure: "extension.index", direction: "below", enter: 0.7, exit: 0.9 }] });
    const detector = new GestureDetector([pinch(), pinkyOut]);
    const curled = makeHand({ pinch: 1.2, curl: { index: 1 } });
    run(detector, [curled, curled, curled, curled, curled]);
    expect(detector.states().get("other")?.held).toBe(true);
    expect(detector.states().get("pinch")?.held).toBe(false);
    detector.setDefinitions([pinch()]);
    expect([...detector.states().keys()]).toEqual(["pinch"]);
  });

  it("can be reset", () => {
    const detector = new GestureDetector([pinch()]);
    run(detector, [pinched, pinched, pinched, pinched, pinched]);
    detector.reset();
    expect(detector.states().get("pinch")).toMatchObject({ held: false, count: 0 });
  });
});
