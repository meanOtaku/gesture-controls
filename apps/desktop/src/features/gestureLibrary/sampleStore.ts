import type { MeasureSample } from "./calibration";
import { MEASURE_NAMES, type GestureDefinition, type HandChoice } from "./definition";
import type { SampleSet } from "./gestureLibraryApi";

/** The most frames kept of one gesture: enough to describe it, little enough to keep a few dozen gestures cheap. */
export const MAX_KEPT_FRAMES = 300;

/** The frames to keep: spread evenly over the recording (not just its start), the numbers rounded to four places. */
export function toSampleSet(samples: MeasureSample[]): SampleSet {
  const step = Math.max(1, samples.length / MAX_KEPT_FRAMES);
  const kept: MeasureSample[] = [];
  for (let at = 0; at < samples.length && kept.length < MAX_KEPT_FRAMES; at += step) kept.push(samples[Math.floor(at)]);
  const round = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null);
  return { measures: [...MEASURE_NAMES], rows: kept.map((sample) => MEASURE_NAMES.map((name) => round(sample[name]))) };
}

/** Frames read back. A measurement this version does not know is ignored; one the saved frames lack reads as missing. */
export function fromSampleSet(set: SampleSet): MeasureSample[] {
  const names = new Set<string>(MEASURE_NAMES);
  return set.rows.map((row) => {
    const sample: MeasureSample = {};
    set.measures.forEach((name, index) => {
      if (names.has(name)) sample[name as keyof MeasureSample] = row[index] ?? null;
    });
    return sample;
  });
}

/** Whether two gestures could be shown by the same hand at once, and so could be mistaken for each other. */
export const handsOverlap = (a: HandChoice, b: HandChoice): boolean => a === "either" || b === "either" || a === b;

export interface OtherGesture {
  id: string;
  name: string;
  hand: HandChoice;
  samples: MeasureSample[];
}

/** The library's other gestures that have saved frames, to check a gesture against. */
export function othersWithSamples(definitions: GestureDefinition[], saved: Record<string, MeasureSample[]>, exceptId: string): OtherGesture[] {
  return definitions
    .filter((d) => d.id !== exceptId && (saved[d.id]?.length ?? 0) > 0)
    .map((d) => ({ id: d.id, name: d.name, hand: d.hand, samples: saved[d.id] }));
}
