import { CONFUSION_BAD, CONFUSION_WARN, firingRate } from "./calibration";
import type { GestureDefinition } from "./definition";
import type { MeasureSample } from "./calibration";
import { handsOverlap } from "./sampleStore";

export interface ConfusionPair {
  /** The gesture whose rule fires. */
  rule: GestureDefinition;
  /** The gesture whose recorded frames it fires on. */
  on: GestureDefinition;
  /** 0 to 1. */
  firesOn: number;
  severity: "bad" | "warn";
}

export interface LibraryCheck {
  /** Rule A firing on gesture B's frames, at or above the warning level, worst first. */
  pairs: ConfusionPair[];
  /** For each gesture with frames: the share of its own frames its rule finds. */
  recall: { gesture: GestureDefinition; finds: number }[];
  /** Gestures with a rule but no saved frames, so they could not be checked: record them again to include them. */
  unchecked: GestureDefinition[];
  /** How many gestures were compared against each other. */
  checked: number;
}

/**
 * Compares every gesture's rule with every other gesture's recorded frames. A rule that fires on another gesture's frames
 * will fire when that gesture is made, so the two will be mixed up.
 */
export function checkLibrary(definitions: GestureDefinition[], saved: Record<string, MeasureSample[]>): LibraryCheck {
  const withFrames = definitions.filter((d) => (saved[d.id]?.length ?? 0) > 0 && d.conditions.length > 0);
  const pairs: ConfusionPair[] = [];
  for (const rule of withFrames) {
    for (const on of withFrames) {
      if (rule.id === on.id || !handsOverlap(rule.hand, on.hand)) continue;
      const firesOn = firingRate(rule.conditions, saved[on.id]);
      if (firesOn >= CONFUSION_WARN) pairs.push({ rule, on, firesOn, severity: firesOn >= CONFUSION_BAD ? "bad" : "warn" });
    }
  }
  pairs.sort((a, b) => b.firesOn - a.firesOn);
  return {
    pairs,
    recall: withFrames.map((gesture) => ({ gesture, finds: firingRate(gesture.conditions, saved[gesture.id]) })),
    unchecked: definitions.filter((d) => d.conditions.length > 0 && (saved[d.id]?.length ?? 0) === 0),
    checked: withFrames.length,
  };
}
