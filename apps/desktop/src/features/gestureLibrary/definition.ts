import type { HandMeasures } from "../camera/landmarkMath";
import { PRETRAINED_IDS, pretrainedLabel, type PretrainedGestureId } from "../camera/pretrained";

/**
 * A gesture the camera can recognise: a hand pose described by a few measurements, with the thresholds that say when it
 * starts and when it ends. Everything a person can read and edit; there is no hidden model.
 */

export type MeasureName =
  | "pinch.index" | "pinch.middle" | "pinch.ring" | "pinch.pinky"
  | "extension.thumb" | "extension.index" | "extension.middle" | "extension.ring" | "extension.pinky"
  | "extension.fingers"
  | "thumb.up" | "thumb.out" | "index.up" | "hand.up";

export const MEASURES: ReadonlyArray<{ name: MeasureName; label: string; unit: string; hint: string }> = [
  { name: "pinch.index", label: "Thumb to index tip", unit: "hand sizes", hint: "About 0 is touching; an open hand is well over 1." },
  { name: "pinch.middle", label: "Thumb to middle tip", unit: "hand sizes", hint: "About 0 is touching." },
  { name: "pinch.ring", label: "Thumb to ring tip", unit: "hand sizes", hint: "About 0 is touching." },
  { name: "pinch.pinky", label: "Thumb to little tip", unit: "hand sizes", hint: "About 0 is touching." },
  { name: "extension.thumb", label: "Thumb straightness", unit: "0 to 1", hint: "1 is straight; lower is bent." },
  { name: "extension.index", label: "Index straightness", unit: "0 to 1", hint: "1 is straight; lower is curled." },
  { name: "extension.middle", label: "Middle straightness", unit: "0 to 1", hint: "1 is straight; lower is curled." },
  { name: "extension.ring", label: "Ring straightness", unit: "0 to 1", hint: "1 is straight; lower is curled." },
  { name: "extension.pinky", label: "Little straightness", unit: "0 to 1", hint: "1 is straight; lower is curled." },
  { name: "extension.fingers", label: "Four fingers straightness", unit: "0 to 1", hint: "The average of the index, middle, ring and little fingers: 1 is an open hand, low is a fist." },
  { name: "thumb.up", label: "Thumb pointing up", unit: "-1 to 1", hint: "1 is the thumb straight up, -1 straight down, 0 level. Up and down as the camera sees it." },
  { name: "thumb.out", label: "Thumb away from the palm", unit: "hand sizes", hint: "Thumb tip to the base of the index finger. Small with the thumb tucked in (a fist), large with it held out." },
  { name: "index.up", label: "Index finger pointing up", unit: "-1 to 1", hint: "1 is the index finger straight up, -1 straight down, 0 level." },
  { name: "hand.up", label: "Hand pointing up", unit: "-1 to 1", hint: "Wrist to the base of the middle finger: 1 is the hand upright, -1 upside down, 0 held level." },
];

export const MEASURE_NAMES: readonly MeasureName[] = MEASURES.map((measure) => measure.name);

export type HandChoice = "either" | "left" | "right";

export interface Condition {
  measure: MeasureName;
  /** `below`: the measurement must be under the threshold; `above`: over it. */
  direction: "below" | "above";
  /** The measurement must pass this to start the gesture. */
  enter: number;
  /** Once started, the measurement may drift as far as this before the gesture ends: looser than `enter`, so it does not flicker. */
  exit: number;
}

export interface CalibrationSummary {
  positiveFrames: number;
  negativeFrames: number;
  /** Mean of "found it" and "correctly not found it" over the recorded frames, 0 to 1. */
  balancedAccuracy: number;
  calibratedAt: string;
}

export interface GestureDefinition {
  id: string;
  name: string;
  /** The label (from the label catalogue) this gesture will be recorded as, or null until one is chosen. */
  labelId: string | null;
  /** Which physical hand it applies to. */
  hand: HandChoice;
  /** All of these must hold. */
  conditions: Condition[];
  /** Optional: the pretrained gesture recogniser must also say this (it can replace the conditions, or sharpen them). */
  pretrained?: PretrainedGestureId | null;
  /** The pose must hold this long before the gesture counts as started (its start time is still when it began). */
  minHoldMs: number;
  /** The pose may be lost this long without ending the gesture. */
  releaseGraceMs: number;
  calibration: CalibrationSummary | null;
}

/** The gestures a recording of `label` is about: those whose label it is. */
export function definitionsForLabel(definitions: GestureDefinition[], label: string | null): GestureDefinition[] {
  return label === null ? [] : definitions.filter((d) => d.labelId === label);
}

/** The gestures a recording of any of `labels` is about. */
export function definitionsForLabels(definitions: GestureDefinition[], labels: readonly string[]): GestureDefinition[] {
  return labels.length === 0 ? [] : definitions.filter((d) => d.labelId !== null && labels.includes(d.labelId));
}

export const MAX_CONDITIONS = 4;
export const MAX_NAME_CHARS = 40;
export const MIN_HOLD_RANGE = [0, 2000] as const;
export const RELEASE_GRACE_RANGE = [0, 2000] as const;
export const DEFAULT_MIN_HOLD_MS = 100;
export const DEFAULT_RELEASE_GRACE_MS = 120;

/** The reading of one measure, or null when it could not be measured. */
export function measureValue(measures: HandMeasures, name: MeasureName): number | null {
  const [group, key] = name.split(".") as ["pinch" | "extension" | "thumb" | "index" | "hand", string];
  if (group === "pinch" || group === "extension") return (measures[group] as Record<string, number | null>)[key] ?? null;
  return measures.extra?.[name] ?? null;
}

export function measureInfo(name: MeasureName) {
  return MEASURES.find((measure) => measure.name === name)!;
}

const trim = (value: number) => String(Number(value.toFixed(2)));

export function describeCondition(condition: Condition): string {
  const info = measureInfo(condition.measure);
  const word = condition.direction === "below" ? "below" : "above";
  const unit = info.unit === "hand sizes" ? " hand sizes" : "";
  return `${info.label.toLowerCase()} ${word} ${trim(condition.enter)}${unit}`;
}

export function describeRule(definition: Pick<GestureDefinition, "conditions" | "hand" | "pretrained">): string {
  if (definition.conditions.length === 0 && !definition.pretrained) return "No rule yet";
  const hand = definition.hand === "either" ? "" : ` (${definition.hand} hand only)`;
  const parts = definition.conditions.map(describeCondition);
  if (definition.pretrained) parts.unshift(`the pretrained model says “${pretrainedLabel(definition.pretrained)}”`);
  return parts.join(" and ") + hand;
}

/** Why a definition cannot be saved, in words, or null. The desktop checks the same things. */
export function definitionProblem(definition: GestureDefinition): string | null {
  const name = definition.name.trim();
  if (name === "") return "Give the gesture a name.";
  if ([...name].length > MAX_NAME_CHARS) return `The name can be at most ${MAX_NAME_CHARS} characters.`;
  if (definition.pretrained != null && !PRETRAINED_IDS.includes(definition.pretrained)) return "The pretrained gesture is not one the recogniser knows.";
  if (definition.conditions.length === 0 && !definition.pretrained) return "A gesture needs at least one condition, or a pretrained gesture. Calibrate it, add a condition, or choose a pretrained gesture.";
  if (definition.conditions.length > MAX_CONDITIONS) return `A gesture can have at most ${MAX_CONDITIONS} conditions.`;
  const seen = new Set<string>();
  for (const condition of definition.conditions) {
    if (!MEASURE_NAMES.includes(condition.measure)) return "A condition uses a measurement that does not exist.";
    if (seen.has(condition.measure)) return "Two conditions use the same measurement. Keep one.";
    seen.add(condition.measure);
    if (!Number.isFinite(condition.enter) || !Number.isFinite(condition.exit)) return "Every threshold must be a number.";
    const looser = condition.direction === "below" ? condition.exit >= condition.enter : condition.exit <= condition.enter;
    if (!looser) return `For "${measureInfo(condition.measure).label}", the end threshold must be looser than the start threshold, or the gesture would flicker.`;
  }
  if (definition.minHoldMs < MIN_HOLD_RANGE[0] || definition.minHoldMs > MIN_HOLD_RANGE[1]) return `The hold time must be from ${MIN_HOLD_RANGE[0]} to ${MIN_HOLD_RANGE[1]} ms.`;
  if (definition.releaseGraceMs < RELEASE_GRACE_RANGE[0] || definition.releaseGraceMs > RELEASE_GRACE_RANGE[1]) return `The release time must be from ${RELEASE_GRACE_RANGE[0]} to ${RELEASE_GRACE_RANGE[1]} ms.`;
  return null;
}

export function blankDefinition(): GestureDefinition {
  return {
    id: "",
    name: "",
    labelId: null,
    hand: "either",
    conditions: [],
    minHoldMs: DEFAULT_MIN_HOLD_MS,
    releaseGraceMs: DEFAULT_RELEASE_GRACE_MS,
    calibration: null,
  };
}
