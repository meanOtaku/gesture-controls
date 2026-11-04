import { describe, expect, it } from "vitest";
import type { HandFrame } from "../camera/handTypes";
import type { MarkingCamera } from "./cameraMarker";
import { JOIN_MS, MARK_MS, PINCH_HOLD, PINCH_IN, PINCH_OUT, type Pinch, PinchDips, startPinchEdgeMarking, wantsPinchEdges } from "./pinchEdgeMarker";
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
  const store = {
    accepting,
    addTimelineInterval(label: string, fromMs: number, toMs: number) {
      if (!store.accepting) return false;
      calls.push(`${label} ${fromMs}-${toMs}`);
      return true;
    },
  };
  return { store, calls };
}

/** Pushes one frame every 33 ms from `start`, at each distance in turn. */
function play(push: (ms: number, pinch: number | null) => void, start: number, distances: (number | null)[]) {
  distances.forEach((distance, i) => push(start + i * 33, distance));
}

const open = (frames: number) => Array<number>(frames).fill(1.0);
/** A second of open hand, so the next frame is at 1320 when `play` starts at 0. */
const SETTLED = open(40);

function feed(dips: PinchDips, distances: (number | null)[]): (Pinch | null)[] {
  return distances.map((distance, i) => dips.update(i * 33, distance));
}

describe("PinchDips", () => {
  it("times the touch and release at the first and last frames near the closest distance, once the pinch is over", () => {
    const found = feed(new PinchDips(), [...SETTLED, 0.8, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.4, 0.5, 0.8, ...open(20)]);
    expect(found.filter(Boolean)).toEqual([{ touchMs: 42 * 33, releaseMs: 47 * 33 }]);
    // Not at the release: only after the fingers have stayed open.
    expect(found.findIndex(Boolean) * 33).toBeGreaterThanOrEqual(48 * 33 + JOIN_MS);
  });

  it("finds a pinch on a hand whose fingers look far apart even when touching", () => {
    // Closed at 0.45 hand sizes: above the old fixed 0.35, so that rule never saw it.
    const dip = [0.6, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.6];
    const found = feed(new PinchDips(), [...SETTLED, ...dip, ...open(20), ...dip, ...open(20)]);
    expect(found.filter(Boolean)).toHaveLength(2);
  });

  it("ignores a stretch too short to be a pinch", () => {
    const found = feed(new PinchDips(), [...SETTLED, 0.2, 0.2, ...open(30)]);
    expect(found.filter(Boolean)).toEqual([]);
  });

  it("joins closed frames across a moment of lost hand, and splits pinches further apart", () => {
    const hold = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
    const joined = feed(new PinchDips(), [...SETTLED, ...hold, null, null, ...hold, ...open(20)]);
    expect(joined.filter(Boolean)).toEqual([{ touchMs: 40 * 33, releaseMs: 53 * 33 }]);
    const apart = feed(new PinchDips(), [...SETTLED, ...hold, ...open(20), ...hold, ...open(20)]);
    expect(apart.filter(Boolean)).toHaveLength(2);
  });

  it("does not take the first moments of a recording, before the open hand is known, as a pinch", () => {
    const found = feed(new PinchDips(), [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, ...open(40)]);
    expect(found.filter(Boolean)).toEqual([]);
  });
});

describe("startPinchEdgeMarking", () => {
  const start = (withHold: boolean, accepting = true) => {
    const primary = fakeCamera();
    const secondary = fakeCamera();
    const { store, calls } = fakeStore(accepting);
    const stop = startPinchEdgeMarking(store, (slot) => (slot === "primary" ? primary.camera : secondary.camera), withHold);
    return { primary, secondary, store, calls, stop };
  };
  const pinch = (frames: number) => Array<number>(frames).fill(0.2);

  it("marks pinch in from the touch and pinch out from the release, each for a short stretch", () => {
    const { primary, calls } = start(false);
    play(primary.push, 0, [...SETTLED, ...pinch(16), ...open(20)]);
    const touch = 40 * 33;
    const release = 55 * 33;
    expect(calls).toEqual([`${PINCH_IN} ${touch}-${touch + MARK_MS}`, `${PINCH_OUT} ${release}-${release + MARK_MS}`]);
  });

  it("with the hold, labels the time between pinch in and pinch out as pinch hold", () => {
    const { primary, calls } = start(true);
    play(primary.push, 0, [...SETTLED, ...pinch(16), ...open(20)]);
    const touch = 40 * 33;
    const release = 55 * 33;
    expect(calls).toEqual([`${PINCH_IN} ${touch}-${touch + MARK_MS}`, `${PINCH_HOLD} ${touch + MARK_MS}-${release}`, `${PINCH_OUT} ${release}-${release + MARK_MS}`]);
  });

  it("cuts pinch in short when the fingers part sooner, with no hold", () => {
    const { primary, calls } = start(true);
    play(primary.push, 0, [...SETTLED, ...pinch(6), ...open(20)]);
    const touch = 40 * 33;
    const release = 45 * 33;
    expect(calls).toEqual([`${PINCH_IN} ${touch}-${release}`, `${PINCH_OUT} ${release}-${release + MARK_MS}`]);
  });

  it("stops listening when stopped", () => {
    const { primary, secondary, stop } = start(false);
    stop();
    expect(primary.listeners()).toBe(0);
    expect(secondary.listeners()).toBe(0);
  });

  it("takes the closer hand of two cameras", () => {
    const { primary, secondary, calls } = start(false);
    const distances = [...SETTLED, ...pinch(16), ...open(20)];
    distances.forEach((distance, i) => {
      primary.push(i * 33, 1.0);
      secondary.push(i * 33, distance);
    });
    expect(calls).toHaveLength(2);
  });

  it("leaves a pinch unmarked while the recording is still arming, and marks the next one", () => {
    const { primary, store, calls } = start(false, false);
    play(primary.push, 0, [...SETTLED, ...pinch(16), ...open(20)]);
    expect(calls).toEqual([]);
    store.accepting = true;
    play(primary.push, 76 * 33, [...pinch(16), ...open(20)]);
    expect(calls).toHaveLength(2);
  });

  it("is asked for only when both labels are in the recording", () => {
    expect(wantsPinchEdges([PINCH_IN, PINCH_OUT])).toBe(true);
    expect(wantsPinchEdges([PINCH_IN])).toBe(false);
    expect(wantsPinchEdges(["pinch"])).toBe(false);
  });
});
