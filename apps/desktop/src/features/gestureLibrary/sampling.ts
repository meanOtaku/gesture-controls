import { physicalHand, type HandFrame } from "../camera/handTypes";
import { measureHand } from "../camera/landmarkMath";
import type { MeasureSample } from "./calibration";
import { MEASURE_NAMES, measureValue, type HandChoice } from "./definition";

/** The measurements of the hand a gesture is about in one camera frame, or null when that hand is not in view. */
export function sampleFrame(frame: HandFrame, hand: HandChoice): MeasureSample | null {
  for (const tracked of frame.hands) {
    if (hand !== "either" && physicalHand(tracked).toLowerCase() !== hand) continue;
    const measures = measureHand(tracked);
    if (!measures) continue;
    return Object.fromEntries(MEASURE_NAMES.map((name) => [name, measureValue(measures, name)]));
  }
  return null;
}
