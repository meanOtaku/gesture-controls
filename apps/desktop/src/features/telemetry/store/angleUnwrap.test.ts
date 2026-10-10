import { describe, expect, it } from "vitest";
import { AngleUnwrapper } from "./angleUnwrap";

const run = (angles: number[]) => {
  const u = new AngleUnwrapper();
  return angles.map((a) => u.next([a])[0]);
};

describe("AngleUnwrapper", () => {
  it("leaves a slow change that never crosses ±180 as it is", () => {
    expect(run([10, 20, 35, 30, -20, -90])).toEqual([10, 20, 35, 30, -20, -90]);
  });

  it("removes the jump when the angle crosses from -180 to +180 and back, so it is a small change, not a spike", () => {
    // Yaw drifting slowly across the back of the circle: -176, -179, then +179 (really -181), +176...
    const out = run([-176, -179, 179, 176, 179, -179, -176]);
    expect(out).toEqual([-176, -179, -181, -184, -181, -179, -176]);
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThanOrEqual(5);
  });

  it("keeps counting turns when it goes round and round", () => {
    const out = run([0, 90, 180, -90, 0, 90]);
    expect(out).toEqual([0, 90, 180, 270, 360, 450]);
  });

  it("follows each component on its own, passes a gap through, and starts again after a reset", () => {
    const u = new AngleUnwrapper();
    expect(u.next([170, 10, 0])).toEqual([170, 10, 0]);
    expect(u.next([-170, 12, Number.NaN])).toEqual([190, 12, Number.NaN]);
    u.reset();
    expect(u.next([-170, 12, 0])).toEqual([-170, 12, 0]);
  });
});
