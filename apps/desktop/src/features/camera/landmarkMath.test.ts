import { describe, expect, it } from "vitest";
import type { Point3, TrackedHand } from "./handTypes";
import { fingerExtension, handSize, measureHand, pinchDistance } from "./landmarkMath";

/** A flat open hand, about 0.09 m from wrist to the base of the middle finger, fingers straight, thumb out to the side. */
function openHand(): Point3[] {
  const points: Point3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  points[0] = { x: 0, y: 0, z: 0 };
  const lengths = [0.04, 0.025, 0.02]; // proximal, middle, distal bones
  const fingers: [number, number][] = [[5, -0.03], [9, -0.01], [13, 0.01], [17, 0.03]];
  for (const [mcp, x] of fingers) {
    points[mcp] = { x, y: -0.09, z: 0 };
    let y = -0.09;
    for (let k = 0; k < 3; k += 1) {
      y -= lengths[k];
      points[mcp + 1 + k] = { x, y, z: 0 };
    }
  }
  points[1] = { x: 0.03, y: -0.02, z: 0 };
  points[2] = { x: 0.055, y: -0.04, z: 0 };
  points[3] = { x: 0.075, y: -0.055, z: 0 };
  points[4] = { x: 0.092, y: -0.07, z: 0 };
  return points;
}

const handOf = (world: Point3[]): Pick<TrackedHand, "world"> => ({ world });

describe("hand measures", () => {
  it("measures a hand's size from the wrist to the base of the middle finger", () => {
    expect(handSize(openHand())).toBeCloseTo(Math.hypot(0.01, 0.09), 8);
  });

  it("calls an open hand's thumb far from the index and a touching pair about zero", () => {
    const open = openHand();
    expect(pinchDistance(open)!).toBeGreaterThan(0.8);
    const pinched = openHand();
    pinched[4] = { ...pinched[8] };
    expect(pinchDistance(pinched)).toBeCloseTo(0, 6);
    // Halfway there is about halfway.
    const half = openHand();
    half[4] = { x: (open[4].x + open[8].x) / 2, y: (open[4].y + open[8].y) / 2, z: 0 };
    expect(pinchDistance(half)!).toBeCloseTo(pinchDistance(open)! / 2, 5);
  });

  it("does not change with the size of the hand", () => {
    const small = openHand();
    const big = openHand().map((p) => ({ x: p.x * 1.4, y: p.y * 1.4, z: p.z * 1.4 }));
    expect(pinchDistance(big)).toBeCloseTo(pinchDistance(small)!, 8);
    expect(fingerExtension(big, "index")).toBeCloseTo(fingerExtension(small, "index")!, 8);
  });

  it("tells a straight finger from a curled one", () => {
    const hand = openHand();
    expect(fingerExtension(hand, "index")).toBeCloseTo(1, 6);
    const curled = openHand();
    // Fold the index finger's last two joints back toward the palm.
    curled[7] = { x: -0.03, y: -0.12, z: 0.02 };
    curled[8] = { x: -0.03, y: -0.1, z: 0.04 };
    expect(fingerExtension(curled, "index")!).toBeLessThan(0.7);
    expect(fingerExtension(curled, "middle")).toBeCloseTo(1, 6);
  });

  it("gives null, never a made-up number, for a collapsed hand", () => {
    const collapsed = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    expect(pinchDistance(collapsed)).toBeNull();
    expect(fingerExtension(collapsed, "index")).toBeNull();
    expect(measureHand(handOf(collapsed))).toBeNull();
    expect(measureHand(handOf([]))).toBeNull();
  });

  it("measures every finger at once", () => {
    const measures = measureHand(handOf(openHand()))!;
    expect(Object.keys(measures.pinch)).toEqual(["index", "middle", "ring", "pinky"]);
    expect(Object.keys(measures.extension)).toEqual(["index", "middle", "ring", "pinky", "thumb"]);
    expect(measures.handSize).toBeCloseTo(Math.hypot(0.01, 0.09), 8);
  });
});
