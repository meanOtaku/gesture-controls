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
 * How far apart a fingertip and the thumb tip are, in hand sizes. Touching tips read about 0.15 to 0.35 (the landmarks
 * sit at the very tips, not the pads, so a pinch never reaches 0); an open hand is about 1 or more.
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

/**
 * Which way a part of the hand points, up or down: the vertical share of the straight line from `from` to `to`, +1 for
 * straight up, -1 for straight down, 0 for level. World landmarks follow the picture's axes (y down), so this is up and
 * down as the camera sees it, which is what tells a thumbs up from a thumbs down however the hand is turned. Null when
 * the two points coincide.
 */
export function verticalDirection(world: Point3[], from: number, to: number): number | null {
  const length = distance(world[from], world[to]);
  if (!(length > 1e-6)) return null;
  return -(world[to].y - world[from].y) / length;
}

/** How far the thumb tip is from the base of the index finger, in hand sizes: small with the thumb tucked against the palm (a fist), large with it held out. */
export function thumbOut(world: Point3[]): number | null {
  const size = handSize(world);
  if (!(size > 1e-6)) return null;
  return distance(world[THUMB.tip], world[FINGERS.index.mcp]) / size;
}

export interface HandMeasures {
  /** Metres. */
  handSize: number;
  /** Thumb tip to each fingertip, in hand sizes. */
  pinch: Record<FingerName, number | null>;
  /** 0 to 1, 1 straight. `fingers` is the average of the four fingers (not the thumb). */
  extension: Record<FingerName | "thumb" | "fingers", number | null>;
  /** Direction and position measures, by their full names (`thumb.up`, `thumb.out`, `index.up`, `hand.up`). */
  extra: Record<string, number | null>;
}

/** The numbers a gesture rule is made of, computed from a hand's world landmarks. */
export function measureHand(hand: Pick<TrackedHand, "world">): HandMeasures | null {
  if (hand.world.length < 21) return null;
  const size = handSize(hand.world);
  if (!(size > 1e-6)) return null;
  const names = Object.keys(FINGERS) as FingerName[];
  const extension = Object.fromEntries([...names, "thumb" as const].map((name) => [name, fingerExtension(hand.world, name)])) as Record<FingerName | "thumb", number | null>;
  const straight = names.map((name) => extension[name]).filter((value): value is number => value !== null);
  return {
    handSize: size,
    pinch: Object.fromEntries(names.map((name) => [name, pinchDistance(hand.world, name)])) as HandMeasures["pinch"],
    extension: { ...extension, fingers: straight.length === names.length ? straight.reduce((sum, value) => sum + value, 0) / straight.length : null },
    extra: {
      "thumb.up": verticalDirection(hand.world, THUMB.mcp, THUMB.tip),
      "thumb.out": thumbOut(hand.world),
      "index.up": verticalDirection(hand.world, FINGERS.index.mcp, FINGERS.index.tip),
      "hand.up": verticalDirection(hand.world, WRIST, FINGERS.middle.mcp),
    },
  };
}
