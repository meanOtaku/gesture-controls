import { describe, expect, it } from "vitest";
import { SourceClockMap } from "./sourceClock";

const ms = 1_000_000;

describe("SourceClockMap", () => {
  it("knows nothing before the first observation", () => {
    expect(new SourceClockMap().map(5 * ms)).toBeNull();
  });

  it("keeps the smallest delivery gap, so a batch that waited longer does not move", () => {
    const clock = new SourceClockMap();
    clock.observe(100 * ms, 1_110 * ms); // waited 10 ms
    clock.observe(200 * ms, 1_250 * ms); // waited 50 ms
    expect(clock.offsetNs()).toBe(1_010 * ms);
    expect(clock.map(200 * ms)).toBe(1_210 * ms);
  });

  it("follows a faster delivery at once", () => {
    const clock = new SourceClockMap();
    clock.observe(100 * ms, 1_150 * ms);
    clock.observe(200 * ms, 1_202 * ms);
    expect(clock.offsetNs()).toBe(1_002 * ms);
  });

  it("forgets a minimum older than 30 seconds, so a slow drift is followed", () => {
    const clock = new SourceClockMap();
    clock.observe(0, 1_000 * ms);
    clock.observe(31_000 * ms, 32_005 * ms);
    expect(clock.offsetNs()).toBe(1_005 * ms);
  });

  it("starts again when the source clock jumps back", () => {
    const clock = new SourceClockMap();
    clock.observe(10_000 * ms, 11_000 * ms);
    clock.observe(5_000 * ms, 11_100 * ms); // the source clock went back 5 s
    expect(clock.offsetNs()).toBe(6_100 * ms);
  });

  it("spaces a batch's samples by their own times", () => {
    const clock = new SourceClockMap();
    clock.observe(140 * ms, 2_150 * ms);
    expect([100, 140].map((t) => clock.map(t * ms))).toEqual([2_110 * ms, 2_150 * ms]);
  });
});
