import { describe, expect, it } from "vitest";
import { assessHealth, SignalHealthTracker } from "./signalHealth";

describe("live signal health", () => {
  it("counts the samples of the last five seconds and how long since the last", () => {
    const tracker = new SignalHealthTracker();
    for (let t = 0; t < 10_000; t += 20) tracker.noteMotion(t); // 50 Hz
    for (let t = 0; t < 10_000; t += 40) tracker.notePulse(t, t >= 9000); // 25 Hz, the last second flagged
    const now = tracker.snapshot(10_000);
    expect(now.motionHz).toBeCloseTo(50, 0);
    expect(now.pulseHz).toBeCloseTo(25, 0);
    expect(now.pulseFlaggedShare).toBeCloseTo(0.2, 1);
    expect(now.msSinceMotion).toBe(20);
    expect(assessHealth(now).map((item) => item.level)).toEqual(["ok", "ok", "warn"]);
    // Ten seconds later, both have stopped.
    const later = tracker.snapshot(20_000);
    expect(later.motionHz).toBe(0);
    expect(later.msSinceMotion).toBe(10_020);
    expect(assessHealth(later).map((item) => [item.key, item.level])).toEqual([["motion", "bad"], ["pulse", "bad"], ["contact", "off"]]);
  });

  it("says nothing is wrong before anything arrives, only that nothing has", () => {
    expect(assessHealth(new SignalHealthTracker().snapshot(0)).map((item) => item.level)).toEqual(["off", "off", "off"]);
  });
});
