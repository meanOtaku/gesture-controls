import { describe, expect, it } from "vitest";
import type { HandFrame } from "../camera/handTypes";
import { startCameraMarking, type MarkingCamera, type MarkingTarget } from "./cameraMarker";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const pinch: GestureDefinition = { ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch", conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }], minHoldMs: 100, releaseGraceMs: 100 };
const pinching = [makeHand({ pinch: 0.1 })];
const open = [makeHand({ pinch: 1.2 })];

/** A camera whose frames the test pushes by hand. */
function fakeCamera(status = "on") {
  const frames = new Set<(frame: HandFrame) => void>();
  let index = 0;
  const camera = {
    getSnapshot: () => ({ status }),
    subscribe: () => () => undefined,
    subscribeFrames: (listener: (frame: HandFrame) => void) => {
      frames.add(listener);
      return () => frames.delete(listener);
    },
  } as unknown as MarkingCamera;
  const push = (captureMs: number, hands = pinching) => frames.forEach((listener) => listener({ frameIndex: index++, captureMs, hands }));
  return { camera, push, listeners: () => frames.size };
}

/** A store that records what the marker asked of it; `accepting` stands for "the recording is under way". */
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

/** Pushes `count` frames 33 ms apart. */
function frames(push: (ms: number, hands?: typeof pinching) => void, start: number, count: number, hands = pinching) {
  for (let i = 0; i < count; i++) push(start + i * 33, hands);
}

describe("startCameraMarking", () => {
  it("opens the label where the gesture began and closes it where the gesture ended, not where the camera noticed", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const { store, calls } = fakeStore();
    startCameraMarking("pinch", [pinch], store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    frames(primary.push, 1000, 8);
    frames(primary.push, 1264, 10, open);
    expect(calls).toEqual(["open pinch at 1000", "close pinch at 1264"]);
  });

  it("keeps marking with no page mounted, and stops listening only when stopped", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const { store, calls } = fakeStore();
    const stop = startCameraMarking("pinch", [pinch], store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    // Nothing of React is involved: the marker hears the camera directly.
    frames(primary.push, 1000, 8);
    expect(calls).toEqual(["open pinch at 1000"]);
    stop();
    expect(primary.listeners()).toBe(0);
    frames(primary.push, 2000, 10, open);
    expect(calls).toEqual(["open pinch at 1000"]);
  });

  it("marks only the gestures it started with", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const definitions = [pinch];
    const { store, calls } = fakeStore();
    startCameraMarking("pinch", definitions, store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    // A page changing its own list later (another label chosen) does not reach the marker.
    definitions.splice(0, 1, { ...pinch, id: "g2", labelId: "fist", conditions: [] });
    frames(primary.push, 1000, 8);
    expect(calls).toEqual(["open pinch at 1000"]);
  });

  it("retries a mark the store refused while the recording was still arming", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const { store, calls } = fakeStore(false);
    startCameraMarking("pinch", [pinch], store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    frames(primary.push, 1000, 8);
    expect(calls).toEqual([]);
    store.accepting = true;
    frames(primary.push, 1264, 2);
    expect(calls).toEqual(["open pinch at 1000"]);
  });

  it("does nothing for a label with no gesture", () => {
    const primary = fakeCamera();
    const { store, calls } = fakeStore();
    startCameraMarking("pinch", [], store, () => primary.camera);
    frames(primary.push, 1000, 8);
    expect(calls).toEqual([]);
    expect(primary.listeners()).toBe(0);
  });
});

describe("startCameraMarking with several labels", () => {
  const fist: GestureDefinition = { ...blankDefinition(), id: "g2", name: "Fist", labelId: "fist", conditions: [{ measure: "pinch.index", direction: "above", enter: 1.0, exit: 0.8 }], minHoldMs: 100, releaseGraceMs: 100 };
  const run = () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const { store, calls } = fakeStore();
    const stop = startCameraMarking(["pinch", "fist"], [pinch, fist], store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    return { primary, calls, stop };
  };

  it("marks each label where its own gesture is held, one after the other", () => {
    const { primary, calls } = run();
    frames(primary.push, 1000, 8); // pinching
    frames(primary.push, 1264, 10, open); // open hand holds the second gesture
    expect(calls[0]).toBe("open pinch at 1000");
    expect(calls.some((call) => call.startsWith("open fist"))).toBe(true);
  });

  it("ignores gestures whose label was not chosen", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const { store, calls } = fakeStore();
    startCameraMarking(["fist"], [pinch, fist], store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    frames(primary.push, 1000, 8); // pinching only
    expect(calls).toEqual([]);
  });

  it("does not close a mark it did not make", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const { store, calls } = fakeStore();
    store.setTimelineLabel("other", "camera_proposal");
    calls.length = 0;
    startCameraMarking(["pinch", "fist"], [pinch, fist], store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    frames(primary.push, 1000, 3, open);
    frames(primary.push, 1100, 10, [makeHand({ pinch: 0.6 })]);
    expect(calls.filter((call) => call.startsWith("close other"))).toEqual([]);
  });
});

describe("startCameraMarking when two labels' gestures overlap", () => {
  const curl: GestureDefinition = { ...blankDefinition(), id: "g3", name: "Pinky curl", labelId: "pinky", conditions: [{ measure: "extension.pinky", direction: "below", enter: 0.5, exit: 0.7 }], minHoldMs: 100, releaseGraceMs: 100 };
  const pinchOnly = [makeHand({ pinch: 0.1 })];
  const both = [makeHand({ pinch: 0.1, curl: { pinky: 1 } })];

  it("hands over to the label that began last, and back when it ends while the first is still held", () => {
    const primary = fakeCamera();
    const secondary = fakeCamera("off");
    const { store, calls } = fakeStore();
    startCameraMarking(["pinch", "pinky"], [pinch, curl], store, (slot) => (slot === "primary" ? primary.camera : secondary.camera));
    frames(primary.push, 1000, 8, pinchOnly);
    frames(primary.push, 1264, 8, both);
    frames(primary.push, 1528, 8, pinchOnly);
    frames(primary.push, 1792, 10, open);
    const labelsInOrder = calls.map((call) => call.split(" ").slice(0, 2).join(" "));
    expect(labelsInOrder).toEqual(["open pinch", "open pinky", "open pinch", "close pinch"]);
    // The handed-back mark starts at or after the moment the pinky gesture ended, never earlier.
    const resumedAt = Number(calls[2].split(" at ")[1]);
    expect(resumedAt).toBeGreaterThanOrEqual(1264);
  });
});
