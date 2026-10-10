import { describe, expect, it } from "vitest";
import { CalibrationSession, COUNTDOWN_MS, NEGATIVE_MS, POSITIVE_MS } from "./calibrationSession";
import { makeHand } from "./testHands";

const frame = (frameIndex: number, hands = [makeHand({ pinch: 0.1 })]) => ({ frameIndex, captureMs: frameIndex * 33, hands });

describe("CalibrationSession", () => {
  it("counts down, records the gesture, counts down again, records the rest, then finishes", () => {
    const session = new CalibrationSession("either");
    expect(session.snapshot(0).step).toBe("ready");
    session.start(0);
    expect(session.snapshot(0).step).toBe("getReady");
    session.onFrame(frame(0));
    expect(session.snapshot(0).positive).toHaveLength(0);
    session.tick(COUNTDOWN_MS);
    expect(session.snapshot(COUNTDOWN_MS).step).toBe("positive");
    session.onFrame(frame(1));
    session.onFrame(frame(2));
    session.tick(COUNTDOWN_MS + POSITIVE_MS);
    expect(session.snapshot(COUNTDOWN_MS + POSITIVE_MS).step).toBe("getReadyNegative");
    session.tick(2 * COUNTDOWN_MS + POSITIVE_MS);
    session.onFrame(frame(3, [makeHand({ pinch: 1 })]));
    session.tick(2 * COUNTDOWN_MS + POSITIVE_MS + NEGATIVE_MS);
    const done = session.snapshot(2 * COUNTDOWN_MS + POSITIVE_MS + NEGATIVE_MS);
    expect(done.step).toBe("done");
    expect([done.positive.length, done.negative.length]).toEqual([2, 1]);
  });

  it("does not count a frame twice, and counts frames with no hand as missed, not kept", () => {
    const session = new CalibrationSession("either");
    session.start(0);
    session.tick(COUNTDOWN_MS);
    session.onFrame(frame(1));
    session.onFrame(frame(1));
    session.onFrame(frame(2, []));
    const snapshot = session.snapshot(COUNTDOWN_MS);
    expect([snapshot.positive.length, snapshot.missedFrames]).toEqual([1, 1]);
  });

  it("ignores the other hand when one is chosen", () => {
    const session = new CalibrationSession("left");
    session.start(0);
    session.tick(COUNTDOWN_MS);
    session.onFrame(frame(1, [makeHand({ pinch: 0.1, modelHandedness: "Right" })]));
    session.onFrame(frame(2, [makeHand({ pinch: 0.1, modelHandedness: "Left" })]));
    expect(session.snapshot(COUNTDOWN_MS).positive).toHaveLength(1);
  });

  it("can be reset to start again", () => {
    const session = new CalibrationSession("either");
    session.start(0);
    session.reset();
    expect(session.snapshot(1).step).toBe("ready");
  });
});

describe("CalibrationSession skipped frames", () => {
  it("says why frames were skipped: no hand, the other hand, or unmeasurable", () => {
    const session = new CalibrationSession("left");
    session.start(0);
    session.tick(COUNTDOWN_MS);
    session.onFrame(frame(1, []));
    session.onFrame(frame(2, [makeHand({ pinch: 0.1, modelHandedness: "Right" })])); // the other hand
    const flat = makeHand({ pinch: 0.1, modelHandedness: "Left" });
    flat.world = flat.world.map(() => ({ x: 0, y: 0, z: 0 }));
    session.onFrame(frame(3, [flat]));
    expect(session.snapshot(COUNTDOWN_MS).skipped).toEqual({ noHand: 1, otherHand: 1, unmeasurable: 1 });
  });
});

describe("CalibrationSession with longer recordings", () => {
  it("records for the lengths chosen, not the defaults", () => {
    const session = new CalibrationSession("either", { positiveMs: 15_000, negativeMs: 30_000 });
    session.start(0);
    session.tick(COUNTDOWN_MS);
    expect(session.snapshot(COUNTDOWN_MS).step).toBe("positive");
    session.tick(COUNTDOWN_MS + POSITIVE_MS); // the default length is not enough
    expect(session.snapshot(COUNTDOWN_MS + POSITIVE_MS).step).toBe("positive");
    expect(session.snapshot(COUNTDOWN_MS + POSITIVE_MS).remainingMs).toBe(11_000);
    session.tick(COUNTDOWN_MS + 15_000);
    expect(session.snapshot(COUNTDOWN_MS + 15_000).step).toBe("getReadyNegative");
    const start = 2 * COUNTDOWN_MS + 15_000;
    session.tick(start);
    session.tick(start + NEGATIVE_MS);
    expect(session.snapshot(start + NEGATIVE_MS).step).toBe("negative");
    session.tick(start + 30_000);
    expect(session.snapshot(start + 30_000).step).toBe("done");
  });
});

describe("CalibrationSession with two cameras", () => {
  it("pools frames from both cameras, counting each camera's frame numbers on its own", () => {
    const session = new CalibrationSession("either");
    session.start(0);
    session.tick(COUNTDOWN_MS);
    session.onFrame(frame(1), "primary");
    session.onFrame(frame(1), "secondary"); // the same number from the other camera is a different frame
    session.onFrame(frame(1), "secondary"); // but a repeat from the same camera is not
    session.onFrame(frame(2, []), "secondary");
    const snapshot = session.snapshot(COUNTDOWN_MS);
    expect(snapshot.positive).toHaveLength(2);
    expect(snapshot.skipped.noHand).toBe(1);
  });
});
