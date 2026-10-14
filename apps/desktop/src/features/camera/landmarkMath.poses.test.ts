import { describe, expect, it } from "vitest";
import { makeHand } from "../gestureLibrary/testHands";
import { measureHand } from "./landmarkMath";
import { measureValue } from "../gestureLibrary/definition";

const fingersCurled = { index: 1, middle: 1, ring: 1, pinky: 1 };
const read = (spec: Parameters<typeof makeHand>[0], name: Parameters<typeof measureValue>[1]) => measureValue(measureHand(makeHand(spec))!, name);

/** A fist with the thumb held out, turned so the thumb points up (thumbs up) or down (thumbs down). */
const thumbsUp = { curl: fingersCurled, thumb: "out" as const, turnDeg: -90 };
const thumbsDown = { curl: fingersCurled, thumb: "out" as const, turnDeg: 90 };
const fist = { curl: fingersCurled, thumb: "tucked" as const, turnDeg: -90 };

describe("the thumb measures", () => {
  it("tell a thumbs up from a thumbs down, which no finger measure can", () => {
    expect(read(thumbsUp, "thumb.up")!).toBeGreaterThan(0.8);
    expect(read(thumbsDown, "thumb.up")!).toBeLessThan(-0.8);
    // Everything the old measures read is the same for both.
    for (const name of ["extension.index", "extension.middle", "extension.fingers", "thumb.out"] as const) {
      expect(read(thumbsUp, name)!).toBeCloseTo(read(thumbsDown, name)!, 6);
    }
  });

  it("tell a thumbs up from a fist by how far the thumb is from the palm", () => {
    expect(read(thumbsUp, "thumb.out")!).toBeGreaterThan(1.2);
    expect(read(fist, "thumb.out")!).toBeLessThan(0.8);
  });

  it("read a closed hand as low on four-finger straightness and an open one as high", () => {
    expect(read(fist, "extension.fingers")!).toBeLessThan(0.6);
    expect(read({}, "extension.fingers")!).toBeGreaterThan(0.95);
  });

  it("say which way the hand and the index finger point, in any turn of the hand", () => {
    expect(read({}, "hand.up")!).toBeGreaterThan(0.95);
    expect(read({ turnDeg: 180 }, "hand.up")!).toBeLessThan(-0.95);
    expect(Math.abs(read({ turnDeg: 90 }, "hand.up")!)).toBeLessThan(0.15);
    expect(read({}, "index.up")!).toBeGreaterThan(0.95);
    expect(read({ turnDeg: 180 }, "index.up")!).toBeLessThan(-0.95);
  });

  it("do not depend on the size of the hand or which hand it is", () => {
    const base = makeHand(thumbsUp);
    const scaled = { ...base, world: base.world.map((p) => ({ x: p.x * 1.3, y: p.y * 1.3, z: p.z * 1.3 })) };
    const mirrored = { ...base, modelHandedness: "Right" as const, world: base.world.map((p) => ({ ...p, x: -p.x })) };
    for (const name of ["thumb.up", "thumb.out", "hand.up", "extension.fingers"] as const) {
      const reference = measureValue(measureHand(base)!, name)!;
      expect(measureValue(measureHand(scaled)!, name)!).toBeCloseTo(reference, 6);
      expect(measureValue(measureHand(mirrored)!, name)!).toBeCloseTo(reference, 6);
    }
  });
});
