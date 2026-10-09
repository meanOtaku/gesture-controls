import { describe, expect, it } from "vitest";
import { blankDefinition, type GestureDefinition } from "./definition";
import { CameraGestureReporter, HEARTBEAT_MS, type CameraReport } from "./cameraGestureReporter";
import { makeHand } from "./testHands";

const pinch: GestureDefinition = { ...blankDefinition(), id: "gesture-1", name: "Pinch", labelId: "pinch", conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }], minHoldMs: 100, releaseGraceMs: 100 };
const noRule: GestureDefinition = { ...blankDefinition(), id: "gesture-2", name: "Empty" };

function setup() {
  const sent: CameraReport[] = [];
  let now = 0;
  const reporter = new CameraGestureReporter((report) => sent.push(report), () => now);
  let frame = 0;
  const feed = (pinchValue: number, advanceMs = 33) => {
    now += advanceMs;
    reporter.onFrame({ frameIndex: frame++, captureMs: now, hands: [makeHand({ pinch: pinchValue })] });
  };
  return { reporter, sent, feed, advance: (ms: number) => { now += ms; } };
}

describe("CameraGestureReporter", () => {
  it("says nothing until the camera is on, then reports the gestures it runs, ignoring ones with no rule", () => {
    const { reporter, sent, feed } = setup();
    reporter.setDefinitions([pinch, noRule]);
    feed(0.1);
    expect(sent).toEqual([]);
    reporter.setCameraOn(true);
    feed(1.2);
    expect(sent[0]).toEqual({ known: ["gesture-1"], held: [], risen: [] });
  });

  it("reports a gesture rising once, keeps it held, and reports it let go", () => {
    const { reporter, sent, feed } = setup();
    reporter.setDefinitions([pinch]);
    reporter.setCameraOn(true);
    for (let i = 0; i < 8; i++) feed(0.1);
    const risen = sent.filter((r) => r.risen.length > 0);
    expect(risen).toHaveLength(1);
    expect(risen[0]).toMatchObject({ held: ["gesture-1"], risen: ["gesture-1"] });
    for (let i = 0; i < 8; i++) feed(1.2);
    expect(sent[sent.length - 1].held).toEqual([]);
  });

  it("sends a heartbeat even when nothing changes, and not on every frame", () => {
    const { reporter, sent, feed } = setup();
    reporter.setDefinitions([pinch]);
    reporter.setCameraOn(true);
    for (let i = 0; i < 20; i++) feed(1.2); // about 660 ms at 30 fps
    const heartbeats = sent.length;
    expect(heartbeats).toBeGreaterThanOrEqual(2);
    expect(heartbeats).toBeLessThanOrEqual(Math.ceil(660 / HEARTBEAT_MS) + 1);
  });

  it("tells the desktop at once when the camera goes off, and not again", () => {
    const { reporter, sent, feed } = setup();
    reporter.setDefinitions([pinch]);
    reporter.setCameraOn(true);
    feed(0.1);
    reporter.setCameraOn(false);
    expect(sent[sent.length - 1]).toEqual({ known: [], held: [], risen: [] });
    const count = sent.length;
    reporter.setCameraOn(false);
    feed(0.1);
    expect(sent).toHaveLength(count);
  });

  it("reports a changed library straight away", () => {
    const { reporter, sent } = setup();
    reporter.setCameraOn(true);
    reporter.setDefinitions([pinch]);
    expect(sent[sent.length - 1]).toEqual({ known: ["gesture-1"], held: [], risen: [] });
  });
});
