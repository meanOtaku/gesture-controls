import { describe, expect, it } from "vitest";
import { ClockSync } from "./clockSync";

/** Watch samples at 50 Hz on a clock that is `offsetMs` behind the browser's, each delayed by `delay(i)` ms on the way. */
function feed(sync: ClockSync, count: number, offsetMs: number, delay: (i: number) => number, startMs = 1000) {
  for (let i = 0; i < count; i += 1) {
    const watchMs = i * 20;
    sync.observe(watchMs * 1e6, startMs + watchMs + offsetMs + delay(i));
  }
}

describe("ClockSync", () => {
  it("says nothing until it has enough samples to trust", () => {
    const sync = new ClockSync();
    feed(sync, 5, 500, () => 10);
    expect(sync.estimate()).toBeNull();
    expect(sync.toBrowserMs(1e9)).toBeNull();
  });

  it("finds the offset from the fastest sample and the jitter from the spread above it", () => {
    const sync = new ClockSync();
    // Delays of 5 ms to 45 ms: the offset is the 5 ms one, and the link is as jittery as the spread says.
    feed(sync, 200, 2500, (i) => 5 + (i % 11) * 4);
    const estimate = sync.estimate()!;
    expect(estimate.offsetMs).toBeCloseTo(1000 + 2500 + 5, 6);
    expect(estimate.samples).toBe(200);
    expect(estimate.jitterMs).toBeGreaterThan(30);
    expect(estimate.jitterMs).toBeLessThanOrEqual(40);
  });

  it("places a watch time on the browser's clock", () => {
    const sync = new ClockSync();
    feed(sync, 100, 0, () => 8);
    // Watch time 1 s is browser time 1 s + (start 1000 ms) + the 8 ms delay.
    expect(sync.toBrowserMs(1e9)).toBeCloseTo(1000 + 1000 + 8, 6);
  });

  it("follows a clock that drifts, because only the last thirty seconds count", () => {
    const sync = new ClockSync();
    feed(sync, 100, 100, () => 5);
    const early = sync.estimate()!.offsetMs;
    // A minute later the offset has grown by 40 ms.
    for (let i = 0; i < 100; i += 1) {
      const watchMs = 60_000 + i * 20;
      sync.observe(watchMs * 1e6, 1000 + watchMs + 140 + 5);
    }
    expect(sync.estimate()!.offsetMs - early).toBeCloseTo(40, 6);
  });

  it("ignores samples that are not numbers, and keeps one saved pair per interval", () => {
    const sync = new ClockSync();
    sync.observe(Number.NaN, 5);
    sync.observe(5, Number.POSITIVE_INFINITY);
    feed(sync, 500, 0, () => 5); // 10 seconds at 50 Hz
    const saved = sync.pairsBetween(0, 1e9);
    expect(saved.length).toBeGreaterThan(40);
    expect(saved.length).toBeLessThan(60); // about one per 200 ms, not one per sample
    expect(sync.pairsBetween(5000, 6000).every((p) => p.browserArrivalMs >= 5000 && p.browserArrivalMs <= 6000)).toBe(true);
  });

  it("can be cleared", () => {
    const sync = new ClockSync();
    feed(sync, 100, 0, () => 5);
    sync.reset();
    expect(sync.estimate()).toBeNull();
    expect(sync.pairsBetween(0, 1e9)).toEqual([]);
  });
});
