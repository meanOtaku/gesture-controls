import { describe, expect, it } from "vitest";
import type { HandFrame } from "../camera/handTypes";
import type { MarkingCamera, MarkingTarget } from "./cameraMarker";
import { MARK_MS, PINCH_HOLD, PINCH_IN, PINCH_OUT, PinchEdges, startPinchEdgeMarking, wantsPinchEdges } from "./pinchEdgeMarker";
import { makeHand } from "./testHands";

/** A camera whose frames the test pushes by hand, at a chosen thumb-to-index distance (null: no hand). */
function fakeCamera() {
  const frames = new Set<(frame: HandFrame) => void>();
  let index = 0;
  const camera = {
    getSnapshot: () => ({ status: "on" }),
    subscribe: () => () => undefined,
    subscribeFrames: (listener: (frame: HandFrame) => void) => {
      frames.add(listener);
      return () => frames.delete(listener);
    },
  } as unknown as MarkingCamera;
  const push = (captureMs: number, pinch: number | null) =>
    frames.forEach((listener) => listener({ frameIndex: index++, captureMs, hands: pinch === null ? [] : [makeHand({ pinch })] }));
  return { camera, push, listeners: () => frames.size };
}

function fakeStore(accepting = true) {
  const calls: string[] = [];
  let active: string | null = null;
  const store = {
    accepting,
    getActiveTimelineLabel: () => active,
    setTimelineLabel(label: string, _mechanism: string, sinceMs?: number) {
      if (!store.accepting) return false;
      active = label;
      calls.push(`open ${label} at ${sinceMs}`);
      return true;
    },
    closeTimelineLabelAt(label: string, atMs: number) {
      if (!store.accepting || active !== label) return false;
      active = null;
      calls.push(`close ${label} at ${atMs}`);
      return true;
    },
  };
  return { store: store as MarkingTarget & { accepting: boolean }, calls };
}

/** Pushes one frame every 33 ms from `start`, at each distance in turn. */
function play(push: (ms: number, pinch: number | null) => void, start: number, distances: (number | null)[]) {
  distances.forEach((distance, i) => push(start + i * 33, distance));
}

describe("PinchEdges", () => {
  it("finds the touch where the distance falls below the level and the release where it rose back past it", () => {
    const edges = new PinchEdges(0.35);
    const seen = [1.0, 0.8, 0.3, 0.1, 0.1, 0.38, 0.6, 1.0].map((d, i) => edges.update(i * 33, d)).filter(Boolean);
    expect(seen).toEqual([{ kind: "in", atMs: 66 }, { kind: "out", atMs: 165 }]);
  });

  it("does not mark a flurry when the distance hovers at the level, and starts afresh after losing the hand", () => {
    const edges = new PinchEdges(0.35);
    const hover = [1.0, 0.3, 0.37, 0.33, 0.4, 0.34, 1.0].map((d, i) => edges.update(i * 33, d)).filter(Boolean);
    expect(hover.map((e) => e?.kind)).toEqual(["in", "out"]);
    // The hand leaves while closed and comes back open: that is not a release anyone saw.
    const lost = new PinchEdges(0.35);
    lost.update(0, 1.0);
    lost.update(33, 0.1);
    for (let t = 66; t < 600; t += 33) lost.update(t, null);
    expect(lost.update(600, 1.0)).toBeNull();
    expect(lost.update(633, 0.1)).toEqual({ kind: "in", atMs: 633 });
  });
});

describe("startPinchEdgeMarking", () => {
  it("marks pinch in at the touch and pinch out at the release, each for a short stretch", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera();
    const { store, calls } = fakeStore();
    startPinchEdgeMarking(0.35, store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    // Open, touch at 1066, held, release rising past the level at 1561, open again; then quiet frames.
    play(primary.push, 1000, [1.0, 0.8, 0.2, ...Array(12).fill(0.1), 0.4, 0.7, 1.0, ...Array(12).fill(1.0)]);
    expect(calls).toEqual([
      `open ${PINCH_IN} at 1066`,
      `close ${PINCH_IN} at ${1066 + MARK_MS}`,
      `open ${PINCH_OUT} at 1495`,
      `close ${PINCH_OUT} at ${1495 + MARK_MS}`,
    ]);
  });

  it("with the hold, labels the time between pinch in and pinch out as pinch hold", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera();
    const { store, calls } = fakeStore();
    startPinchEdgeMarking(0.35, store, (slot) => (slot === "primary" ? primary.camera : secondary.camera), true);
    play(primary.push, 1000, [1.0, 0.8, 0.2, ...Array(12).fill(0.1), 0.4, 0.7, 1.0, ...Array(12).fill(1.0)]);
    expect(calls).toEqual([
      `open ${PINCH_IN} at 1066`,
      `close ${PINCH_IN} at ${1066 + MARK_MS}`,
      `open ${PINCH_HOLD} at ${1066 + MARK_MS}`,
      `close ${PINCH_HOLD} at 1495`,
      `open ${PINCH_OUT} at 1495`,
      `close ${PINCH_OUT} at ${1495 + MARK_MS}`,
    ]);
  });

  it("with the hold, a pinch shorter than pinch in has no hold, and a hand lost mid-hold ends it where last seen", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera();
    const short = fakeStore();
    startPinchEdgeMarking(0.35, short.store, (slot) => (slot === "primary" ? primary.camera : secondary.camera), true);
    play(primary.push, 0, [1.0, 0.1, 0.1, 0.5, 1.0, ...Array(12).fill(1.0)]);
    expect(short.calls.some((call) => call.includes(PINCH_HOLD))).toBe(false);

    const lost = fakeStore();
    const camera = fakeCamera();
    const other = fakeCamera();
    startPinchEdgeMarking(0.35, lost.store, (slot) => (slot === "primary" ? camera.camera : other.camera), true);
    play(camera.push, 0, [1.0, 0.1, ...Array(12).fill(0.1), ...Array(20).fill(null)]);
    expect(lost.calls).toEqual([`open ${PINCH_IN} at 33`, `close ${PINCH_IN} at ${33 + MARK_MS}`, `open ${PINCH_HOLD} at ${33 + MARK_MS}`, `close ${PINCH_HOLD} at ${13 * 33}`]);
  });

  it("cuts pinch in short when the release comes sooner, and stops listening when stopped", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera();
    const { store, calls } = fakeStore();
    const stop = startPinchEdgeMarking(0.35, store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    play(primary.push, 0, [1.0, 0.1, 0.1, 0.5, 1.0]);
    expect(calls.slice(0, 3)).toEqual([`open ${PINCH_IN} at 33`, `close ${PINCH_IN} at 99`, `open ${PINCH_OUT} at 99`]);
    stop();
    expect(primary.listeners()).toBe(0);
    expect(secondary.listeners()).toBe(0);
  });

  it("leaves a moment unmarked while the recording is still arming, and marks the next one", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera();
    const { store, calls } = fakeStore(false);
    startPinchEdgeMarking(0.35, store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    play(primary.push, 0, [1.0, 0.1]);
    store.accepting = true;
    play(primary.push, 66, [0.1, 1.0]);
    expect(calls).toEqual([`open ${PINCH_OUT} at 99`]);
  });

  it("is asked for only when both labels are in the recording", () => {
    expect(wantsPinchEdges([PINCH_IN, PINCH_OUT])).toBe(true);
    expect(wantsPinchEdges([PINCH_IN])).toBe(false);
    expect(wantsPinchEdges(["pinch"])).toBe(false);
  });
});
