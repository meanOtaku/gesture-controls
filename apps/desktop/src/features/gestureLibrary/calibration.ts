import { type Condition, type MeasureName, MAX_CONDITIONS, MEASURE_NAMES } from "./definition";

/** One recorded frame's measurements; a measure that could not be read is null. */
export type MeasureSample = Partial<Record<MeasureName, number | null>>;

export interface MeasureStats {
  measure: MeasureName;
  positiveMean: number;
  positiveSd: number;
  negativeMean: number;
  negativeSd: number;
  /** The direction in which "the gesture" lies. */
  direction: "below" | "above";
  /** The best single cut-off between the two groups, and how well it separates them (0.5 is chance, 1 is perfect). */
  threshold: number;
  balancedAccuracy: number;
}

export interface Analysis {
  stats: MeasureStats[];
  /** The proposed rule: the measurements that best tell the gesture from everything else, with start and end thresholds. */
  conditions: Condition[];
  /** How well the whole rule finds the gesture frames and rejects the others, on the frames recorded. */
  balancedAccuracy: number;
  positiveFrames: number;
  negativeFrames: number;
  verdict: "good" | "okay" | "weak" | "needsMoreFrames";
  /** In words: what to do about it, when it is not "good". */
  advice: string | null;
}

/** Fewest frames of each kind worth analysing. */
export const MIN_FRAMES = 30;
/** How much better a second or third condition must make things to be added. */
const MIN_GAIN = 0.02;
/** Start thresholds sit this far from the best cut-off toward the gesture; end thresholds this far toward "not the gesture". */
const MARGIN = 0.25;

const values = (samples: MeasureSample[], measure: MeasureName): number[] =>
  samples.map((sample) => sample[measure]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));

const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
const sd = (list: number[]) => {
  const m = mean(list);
  return Math.sqrt(list.reduce((sum, value) => sum + (value - m) ** 2, 0) / list.length);
};

function passes(value: number | null | undefined, direction: "below" | "above", threshold: number): boolean {
  return typeof value === "number" && (direction === "below" ? value < threshold : value > threshold);
}

/** Of the frames, the share the rule says are the gesture. A frame where a needed measure is missing says no. */
function rate(samples: MeasureSample[], rule: { measure: MeasureName; direction: "below" | "above"; threshold: number }[]): number {
  if (samples.length === 0) return 0;
  return samples.filter((sample) => rule.every((part) => passes(sample[part.measure], part.direction, part.threshold))).length / samples.length;
}

function balanced(positive: MeasureSample[], negative: MeasureSample[], rule: { measure: MeasureName; direction: "below" | "above"; threshold: number }[]): number {
  return (rate(positive, rule) + (1 - rate(negative, rule))) / 2;
}

/** Candidate cut-offs: halfway between neighbouring recorded values (thinned if there are very many). */
function candidates(a: number[], b: number[]): number[] {
  const all = [...new Set([...a, ...b])].sort((x, y) => x - y);
  const step = Math.max(1, Math.floor(all.length / 200));
  const out: number[] = [];
  for (let i = 0; i + step < all.length; i += step) out.push((all[i] + all[i + step]) / 2);
  return out;
}

function bestCut(positive: MeasureSample[], negative: MeasureSample[], measure: MeasureName, direction: "below" | "above", base: { measure: MeasureName; direction: "below" | "above"; threshold: number }[] = []) {
  const cuts = candidates(values(positive, measure), values(negative, measure));
  let best = { threshold: NaN, accuracy: -1 };
  for (const threshold of cuts) {
    const accuracy = balanced(positive, negative, [...base, { measure, direction, threshold }]);
    if (accuracy > best.accuracy) best = { threshold, accuracy };
  }
  return best;
}

/**
 * Looks at frames recorded while doing the gesture and frames recorded while not, and proposes a rule: the
 * measurements that best tell them apart, each with a start and an end threshold. It is explainable: you can read every
 * number and change it.
 */
export function analyse(positive: MeasureSample[], negative: MeasureSample[]): Analysis {
  const stats: MeasureStats[] = [];
  for (const measure of MEASURE_NAMES) {
    const p = values(positive, measure);
    const n = values(negative, measure);
    if (p.length < 2 || n.length < 2) continue;
    const direction = mean(p) <= mean(n) ? "below" : "above";
    const cut = bestCut(positive, negative, measure, direction);
    if (!Number.isFinite(cut.threshold)) continue;
    stats.push({
      measure, direction, threshold: cut.threshold, balancedAccuracy: cut.accuracy,
      positiveMean: mean(p), positiveSd: sd(p), negativeMean: mean(n), negativeSd: sd(n),
    });
  }
  stats.sort((a, b) => b.balancedAccuracy - a.balancedAccuracy);

  // Add measurements one at a time while each makes the rule clearly better.
  const chosen: MeasureStats[] = [];
  let rule: { measure: MeasureName; direction: "below" | "above"; threshold: number }[] = [];
  let accuracy = 0.5;
  if (stats.length > 0) {
    chosen.push(stats[0]);
    rule = [{ measure: stats[0].measure, direction: stats[0].direction, threshold: stats[0].threshold }];
    accuracy = stats[0].balancedAccuracy;
    while (chosen.length < Math.min(MAX_CONDITIONS, 3)) {
      let next: { stat: MeasureStats; threshold: number; accuracy: number } | null = null;
      for (const stat of stats) {
        if (chosen.some((c) => c.measure === stat.measure)) continue;
        const cut = bestCut(positive, negative, stat.measure, stat.direction, rule);
        if (cut.accuracy > accuracy + MIN_GAIN && (!next || cut.accuracy > next.accuracy)) next = { stat, threshold: cut.threshold, accuracy: cut.accuracy };
      }
      if (!next) break;
      chosen.push({ ...next.stat, threshold: next.threshold });
      rule = [...rule, { measure: next.stat.measure, direction: next.stat.direction, threshold: next.threshold }];
      accuracy = next.accuracy;
    }
  }

  const conditions: Condition[] = chosen.map((stat) => ({
    measure: stat.measure,
    direction: stat.direction,
    enter: stat.threshold + MARGIN * (stat.positiveMean - stat.threshold),
    exit: stat.threshold + MARGIN * (stat.negativeMean - stat.threshold),
  }));

  let verdict: Analysis["verdict"];
  let advice: string | null = null;
  if (positive.length < MIN_FRAMES || negative.length < MIN_FRAMES) {
    verdict = "needsMoreFrames";
    advice = `Record at least ${MIN_FRAMES} frames of the gesture and ${MIN_FRAMES} of everything else (about a second each). You have ${positive.length} and ${negative.length}.`;
  } else if (conditions.length === 0 || accuracy < 0.8) {
    verdict = "weak";
    advice = "The camera cannot reliably tell this gesture from the rest on these recordings. Record it again with the hand clearly in view, make the difference between the gesture and the rest bigger, or choose a gesture that changes the hand's shape more.";
  } else if (accuracy < 0.9) {
    verdict = "okay";
    advice = "Usable, but it will sometimes miss or false-start. More recordings, in different positions, will tighten it.";
  } else {
    verdict = "good";
  }
  return { stats, conditions, balancedAccuracy: accuracy, positiveFrames: positive.length, negativeFrames: negative.length, verdict, advice };
}

/** How well a rule (with its start thresholds) does on recorded frames: for showing the effect of editing a threshold. */
export function scoreRule(conditions: Condition[], positive: MeasureSample[], negative: MeasureSample[]): number {
  return balanced(positive, negative, conditions.map((c) => ({ measure: c.measure, direction: c.direction, threshold: c.enter })));
}
