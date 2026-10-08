import type { Point3, TrackedHand } from "../camera/handTypes";

/**
 * Synthetic hands for tests: a flat open hand whose thumb-to-index distance and finger curl can be set. Not a model of
 * a real hand, only enough geometry for the measures to read what the test says.
 */
export interface HandSpec {
  /** Thumb tip to index tip, in hand sizes. */
  pinch?: number;
  /** 0 straight to 1 fully curled, per finger. */
  curl?: Partial<Record<"index" | "middle" | "ring" | "pinky", number>>;
  /** MediaPipe's own label (the opposite of the physical hand in a raw picture). */
  modelHandedness?: "Left" | "Right";
}

const MIDDLE_MCP_Y = -0.09; // so a hand size is about 0.0905 m

export function makeHand(spec: HandSpec = {}): TrackedHand {
  const world: Point3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const bones = [0.04, 0.025, 0.02];
  const fingers: [string, number, number][] = [["index", 5, -0.03], ["middle", 9, -0.01], ["ring", 13, 0.01], ["pinky", 17, 0.03]];
  for (const [name, mcp, x] of fingers) {
    const curl = spec.curl?.[name as "index"] ?? 0;
    world[mcp] = { x, y: MIDDLE_MCP_Y, z: 0 };
    // Each joint turns by up to 100 degrees toward the palm (z) as the finger curls.
    let angle = 0;
    let { y, z } = world[mcp];
    for (let k = 0; k < 3; k += 1) {
      angle += curl * (Math.PI * 0.55);
      y -= bones[k] * Math.cos(angle);
      z += bones[k] * Math.sin(angle);
      world[mcp + 1 + k] = { x, y, z };
    }
  }
  const size = Math.hypot(0.01, 0.09);
  world[1] = { x: 0.03, y: -0.02, z: 0 };
  world[2] = { x: 0.05, y: -0.035, z: 0 };
  world[3] = { x: 0.065, y: -0.05, z: 0 };
  const index = world[8];
  const gap = (spec.pinch ?? 1.2) * size;
  world[4] = { x: index.x + gap, y: index.y, z: index.z };
  const image = world.map((p) => ({ x: 0.5 + p.x * 3, y: 0.5 + p.y * 3, z: p.z }));
  return { modelHandedness: spec.modelHandedness ?? "Left", score: 0.95, image, world };
}
