import type { Point3, TrackedHand } from "./handTypes";

/** MediaPipe's landmark numbering. */
export const WRIST = 0;
export const THUMB = { cmc: 1, mcp: 2, ip: 3, tip: 4 } as const;
export const FINGERS = {
  index: { mcp: 5, pip: 6, dip: 7, tip: 8 },
  middle: { mcp: 9, pip: 10, dip: 11, tip: 12 },
  ring: { mcp: 13, pip: 14, dip: 15, tip: 16 },
  pinky: { mcp: 17, pip: 18, dip: 19, tip: 20 },
} as const;
export type FingerName = keyof typeof FINGERS;

export const distance = (a: Point3, b: Point3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The size of a hand: the wrist to the base of the middle finger, in metres. Dividing by it makes a measure independent of the hand's size and distance. */
export function handSize(world: Point3[]): number {
  return distance(world[WRIST], world[FINGERS.middle.mcp]);
}

/**
 * How far apart a fingertip and the thumb tip are, in hand sizes. About 0 is a firm pinch; an open hand is well over 1.
 * Null when the hand is too small to measure (a bad detection) rather than a number that looks real.
 */
export function pinchDistance(world: Point3[], finger: FingerName = "index"): number | null {
  const size = handSize(world);
  if (!(size > 1e-6)) return null;
  return distance(world[THUMB.tip], world[FINGERS[finger].tip]) / size;
}

/**
 * How straight a finger is: the straight-line distance from its base to its tip divided by the length of its bones.
 * 1 is fully straight and a curled finger is much lower. The thumb uses its own chain.
 */
export function fingerExtension(world: Point3[], finger: FingerName | "thumb"): number | null {
  const chain = finger === "thumb"
    ? [THUMB.cmc, THUMB.mcp, THUMB.ip, THUMB.tip]
    : [FINGERS[finger].mcp, FINGERS[finger].pip, FINGERS[finger].dip, FINGERS[finger].tip];
  let bones = 0;
  for (let i = 1; i < chain.length; i += 1) bones += distance(world[chain[i - 1]], world[chain[i]]);
  if (!(bones > 1e-6)) return null;
  return Math.min(1, distance(world[chain[0]], world[chain[chain.length - 1]]) / bones);
}

export interface HandMeasures {
  /** Metres. */
  handSize: number;
  /** Thumb tip to each fingertip, in hand sizes. */
  pinch: Record<FingerName, number | null>;
  /** 0 to 1, 1 straight. */
  extension: Record<FingerName | "thumb", number | null>;
}

/** The numbers a gesture rule is made of, computed from a hand's world landmarks. */
export function measureHand(hand: Pick<TrackedHand, "world">): HandMeasures | null {
  if (hand.world.length < 21) return null;
  const size = handSize(hand.world);
  if (!(size > 1e-6)) return null;
  const names = Object.keys(FINGERS) as FingerName[];
  return {
    handSize: size,
    pinch: Object.fromEntries(names.map((name) => [name, pinchDistance(hand.world, name)])) as HandMeasures["pinch"],
    extension: Object.fromEntries([...names, "thumb" as const].map((name) => [name, fingerExtension(hand.world, name)])) as HandMeasures["extension"],
  };
}
