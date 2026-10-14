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

/** Frames of something the gesture must not be taken for: another gesture in the library, recorded when it was made. */
export interface NegativeGroup {
  name: string;
  samples: MeasureSample[];
}

/** How often the finished rule fires on one kind of frame it should not fire on. */
export interface Confusion {
  name: string;
  /** 0 to 1: the share of that group's frames the rule would take for the gesture. */
  firesOn: number;
}

/** A rule that fires on more than this share of another gesture's frames is worth a warning. */
export const CONFUSION_WARN = 0.1;
/** ...and on more than this share it is not usable. */
export const CONFUSION_BAD = 0.3;

export interface Analysis {
  stats: MeasureStats[];
  /** The proposed rule: the measurements that best tell the gesture from everything else, with start and end thresholds. */
  conditions: Condition[];
  /** How well the whole rule finds the gesture frames and rejects the others, on the frames recorded. */
  balancedAccuracy: number;
  positiveFrames: number;
  negativeFrames: number;
  /** How the rule does on each other gesture's frames, worst first; empty when there are none to check against. */
  confusions: Confusion[];
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

type Rule = { measure: MeasureName; direction: "below" | "above"; threshold: number }[];

/**
 * How well a rule does: the share of gesture frames it finds, averaged with how well it rejects the rest. The rest is
 * the general "everything else" recording plus each other gesture on its own, so a rule that fires on all of one similar
 * gesture cannot hide behind a large background. Rejection counts the average over the groups and the worst group equally.
 */
function scoreGroups(positive: MeasureSample[], rest: MeasureSample[], others: NegativeGroup[], rule: Rule): number {
  const rejects = [rest, ...others.map((group) => group.samples)].map((samples) => 1 - rate(samples, rule));
  const mean = rejects.reduce((sum, value) => sum + value, 0) / rejects.length;
  return (rate(positive, rule) + 0.5 * mean + 0.5 * Math.min(...rejects)) / 2;
}

/** Candidate cut-offs: halfway between neighbouring recorded values (thinned if there are very many). */
function candidates(a: number[], b: number[]): number[] {
  const all = [...new Set([...a, ...b])].sort((x, y) => x - y);
  const step = Math.max(1, Math.floor(all.length / 200));
  const out: number[] = [];
  for (let i = 0; i + step < all.length; i += step) out.push((all[i] + all[i + step]) / 2);
  return out;
}

function bestCut(positive: MeasureSample[], negative: MeasureSample[], others: NegativeGroup[], measure: MeasureName, direction: "below" | "above", base: Rule = []) {
  const cuts = candidates(values(positive, measure), [...values(negative, measure), ...others.flatMap((group) => values(group.samples, measure))]);
  let best = { threshold: NaN, accuracy: -1 };
  for (const threshold of cuts) {
    const accuracy = scoreGroups(positive, negative, others, [...base, { measure, direction, threshold }]);
    if (accuracy > best.accuracy) best = { threshold, accuracy };
  }
  return best;
}

/**
 * Looks at frames recorded while doing the gesture and frames recorded while not, and proposes a rule: the
 * measurements that best tell them apart, each with a start and an end threshold. It is explainable: you can read every
 * number and change it.
 */
export function analyse(positive: MeasureSample[], negative: MeasureSample[], others: NegativeGroup[] = []): Analysis {
  const stats: MeasureStats[] = [];
  for (const measure of MEASURE_NAMES) {
    const p = values(positive, measure);
    const n = values(negative, measure);
    if (p.length < 2 || n.length < 2) continue;
    // Both ways round are tried against the other gestures too: a thumb that points up is "above" the background but
    // "below" nothing, while the other gesture may only differ in the opposite direction.
    const candidatesDirections: ("below" | "above")[] = mean(p) <= mean(n) ? ["below", "above"] : ["above", "below"];
    const tried = candidatesDirections.map((direction) => ({ direction, cut: bestCut(positive, negative, others, measure, direction) }));
    const best = tried.reduce((a, b) => (b.cut.accuracy > a.cut.accuracy ? b : a));
    const direction = best.direction;
    const cut = best.cut;
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
    while (chosen.length < MAX_CONDITIONS) {
      let next: { stat: MeasureStats; threshold: number; accuracy: number } | null = null;
      for (const stat of stats) {
        if (chosen.some((c) => c.measure === stat.measure)) continue;
        const cut = bestCut(positive, negative, others, stat.measure, stat.direction, rule);
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

  const startRule: Rule = conditions.map((c) => ({ measure: c.measure, direction: c.direction, threshold: c.enter }));
  const confusions: Confusion[] = conditions.length === 0 ? [] : others.map((group) => ({ name: group.name, firesOn: rate(group.samples, startRule) })).sort((a, b) => b.firesOn - a.firesOn);
  const worst = confusions[0];

  let verdict: Analysis["verdict"];
  let advice: string | null = null;
  if (positive.length < MIN_FRAMES || negative.length < MIN_FRAMES) {
    verdict = "needsMoreFrames";
    advice = `Record at least ${MIN_FRAMES} frames of the gesture and ${MIN_FRAMES} of everything else (about a second each). You have ${positive.length} and ${negative.length}.`;
  } else if (conditions.length > 0 && worst && worst.firesOn >= CONFUSION_BAD) {
    verdict = "weak";
    advice = `The rule would also fire on ${percentText(worst.firesOn)} of the “${worst.name}” frames, so the two would be mixed up. Record this gesture again so it differs from “${worst.name}” more (a different thumb position or hand angle), or change one of the two.`;
  } else if (conditions.length === 0 || accuracy < 0.8) {
    verdict = "weak";
    advice = "The camera cannot reliably tell this gesture from the rest on these recordings. Record it again with the hand clearly in view, make the difference between the gesture and the rest bigger, or choose a gesture that changes the hand's shape more.";
  } else if (worst && worst.firesOn >= CONFUSION_WARN) {
    verdict = "okay";
    advice = `Usable, but the rule also fires on ${percentText(worst.firesOn)} of the “${worst.name}” frames. Record more of both, in different positions, to separate them.`;
  } else if (accuracy < 0.9) {
    verdict = "okay";
    advice = "Usable, but it will sometimes miss or false-start. More recordings, in different positions, will tighten it.";
  } else {
    verdict = "good";
  }
  return { stats, conditions, balancedAccuracy: accuracy, positiveFrames: positive.length, negativeFrames: negative.length, confusions, verdict, advice };
}

const percentText = (share: number) => `${Math.round(share * 100)}%`;

/** How well a rule (with its start thresholds) does on recorded frames: for showing the effect of editing a threshold. */
export function scoreRule(conditions: Condition[], positive: MeasureSample[], negative: MeasureSample[], others: NegativeGroup[] = []): number {
  return scoreGroups(positive, negative, others, conditions.map((c) => ({ measure: c.measure, direction: c.direction, threshold: c.enter })));
}

/** The share of `samples` a rule's start thresholds would take for the gesture (0 to 1). */
export function firingRate(conditions: Condition[], samples: MeasureSample[]): number {
  if (conditions.length === 0) return 0;
  return rate(samples, conditions.map((c) => ({ measure: c.measure, direction: c.direction, threshold: c.enter })));
}
