import type { MeasureSample, NegativeGroup } from "./calibration";
import type { MeasureName } from "./definition";

/**
 * A relaxed open hand: the pose a hand is in most of the time it is not making a gesture. A recording of "everything
 * else" may happen to leave it out, and then calibration can rest a rule on something that only looked different in
 * that recording (a pinch told apart by a straight little finger), which every open hand then sets off. So every
 * calibration is also checked against this.
 *
 * The frames are made from the ranges real camera readings of an open hand fall in, not from a model of a hand, and
 * are held at every angle, since which way a hand points says nothing about its shape.
 */
export const OPEN_HAND_NAME = "relaxed open hand";

const FRAMES = 48;
const RANGES: Partial<Record<MeasureName, [number, number]>> = {
  "pinch.index": [0.8, 1.3],
  "pinch.middle": [1.0, 1.5],
  "pinch.ring": [1.1, 1.6],
  "pinch.pinky": [1.2, 1.7],
  "extension.thumb": [0.9, 1.0],
  "extension.index": [0.93, 1.0],
  "extension.middle": [0.93, 1.0],
  "extension.ring": [0.93, 1.0],
  "extension.pinky": [0.93, 1.0],
  "thumb.out": [0.8, 1.2],
};

/** A deterministic, evenly spread share from 0 to 1 for frame `i` of measure `k`. */
const spread = (i: number, k: number) => (((i + 0.5) * 0.6180339887 + k * 0.3819660113) % 1 + 1) % 1;

function openHandFrames(): MeasureSample[] {
  return Array.from({ length: FRAMES }, (_, i) => {
    const sample: MeasureSample = {};
    Object.entries(RANGES).forEach(([name, [low, high]], k) => {
      sample[name as MeasureName] = low + (high - low) * spread(i, k);
    });
    const fingers = (["extension.index", "extension.middle", "extension.ring", "extension.pinky"] as const).map((name) => sample[name] as number);
    sample["extension.fingers"] = fingers.reduce((sum, value) => sum + value, 0) / fingers.length;
    // Turned through a full circle: the fingers point the hand's way, the thumb about 35 degrees off it.
    const angle = (2 * Math.PI * i) / FRAMES;
    sample["hand.up"] = Math.cos(angle);
    sample["index.up"] = Math.cos(angle + 0.1);
    sample["thumb.up"] = Math.cos(angle - 0.6);
    return sample;
  });
}

export const OPEN_HAND_FRAMES: readonly MeasureSample[] = openHandFrames();

/** Whether one frame shows an open hand: the fingers straight and the thumb well away from the index tip. */
const looksOpen = (sample: MeasureSample) =>
  (sample["extension.fingers"] ?? 0) > 0.9 && (sample["pinch.index"] ?? 0) > 0.7;

/**
 * The open-hand frames to check a recording against, or none when the gesture itself is an open hand (most of its
 * frames look like one): an open palm must not be held against looking like an open palm.
 */
export function openHandGroup(positive: MeasureSample[]): NegativeGroup[] {
  if (positive.length > 0 && positive.filter(looksOpen).length / positive.length >= 0.5) return [];
  return [{ name: OPEN_HAND_NAME, samples: [...OPEN_HAND_FRAMES] }];
}
