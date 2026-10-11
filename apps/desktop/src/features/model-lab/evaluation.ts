/**
 * How well a model does on windows it never trained on, computed from its scores (`evaluation` in an inspection): curves,
 * rates at any cut-off, and a breakdown by recording. Plain functions of the scores and the true labels, so every chart
 * and every exported number can be reproduced from the exported scores.
 */

export interface Scored {
  probabilities: number[];
  /** 1 for a window of the gesture, 0 for anything else. */
  labels: number[];
  recordings: string[];
}

export interface Point {
  x: number;
  y: number;
}

export const counts = (labels: number[]): { positives: number; negatives: number } => {
  const positives = labels.reduce((sum, label) => sum + (label === 1 ? 1 : 0), 0);
  return { positives, negatives: labels.length - positives };
};

/** Windows with a score at or above `threshold` are called the gesture. */
export function confusionAt(probabilities: number[], labels: number[], threshold: number) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  probabilities.forEach((p, i) => {
    const called = p >= threshold;
    if (labels[i] === 1) called ? (tp += 1) : (fn += 1);
    else called ? (fp += 1) : (tn += 1);
  });
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    tp, fp, fn, tn, precision, recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    falseAlarmRate: fp + tn > 0 ? fp / (fp + tn) : 0,
    accuracy: labels.length > 0 ? (tp + tn) / labels.length : 0,
  };
}

/** The ROC curve: false alarm rate (x) against recall (y), one point per distinct score, from (0,0) to (1,1). */
export function rocCurve(probabilities: number[], labels: number[]): Point[] {
  const { positives, negatives } = counts(labels);
  const order = probabilities.map((p, i) => i).sort((a, b) => probabilities[b] - probabilities[a]);
  const points: Point[] = [{ x: 0, y: 0 }];
  let tp = 0;
  let fp = 0;
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k];
    if (labels[i] === 1) tp += 1;
    else fp += 1;
    const last = k === order.length - 1 || probabilities[order[k + 1]] !== probabilities[i];
    if (last) points.push({ x: negatives > 0 ? fp / negatives : 0, y: positives > 0 ? tp / positives : 0 });
  }
  return points;
}

/** Area under a curve of points sorted by x (trapezoids). */
export function area(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += ((points[i].y + points[i - 1].y) / 2) * (points[i].x - points[i - 1].x);
  return total;
}

export const rocAuc = (probabilities: number[], labels: number[]): number => area(rocCurve(probabilities, labels));

/** The precision-recall curve: recall (x) against precision (y), and the average precision (sum of precision times each step in recall). */
export function prCurve(probabilities: number[], labels: number[]): { points: Point[]; averagePrecision: number } {
  const { positives } = counts(labels);
  const order = probabilities.map((p, i) => i).sort((a, b) => probabilities[b] - probabilities[a]);
  const points: Point[] = [];
  let tp = 0;
  let fp = 0;
  let previousRecall = 0;
  let averagePrecision = 0;
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k];
    if (labels[i] === 1) tp += 1;
    else fp += 1;
    const last = k === order.length - 1 || probabilities[order[k + 1]] !== probabilities[i];
    if (!last) continue;
    const recall = positives > 0 ? tp / positives : 0;
    const precision = tp / (tp + fp);
    points.push({ x: recall, y: precision });
    averagePrecision += (recall - previousRecall) * precision;
    previousRecall = recall;
  }
  return { points, averagePrecision };
}

/** Precision, recall, F1 and false alarm rate at every cut-off from 0.05 to 0.95. */
export function thresholdSweep(probabilities: number[], labels: number[]) {
  const rows = [];
  for (let step = 5; step <= 95; step += 1) {
    const threshold = step / 100;
    rows.push({ threshold, ...confusionAt(probabilities, labels, threshold) });
  }
  return rows;
}

/** How many windows of each kind scored in each of `bins` equal slices of 0 to 1. */
export function histogram(probabilities: number[], labels: number[], bins = 20) {
  const gesture = new Array<number>(bins).fill(0);
  const other = new Array<number>(bins).fill(0);
  probabilities.forEach((p, i) => {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    if (labels[i] === 1) gesture[bin] += 1;
    else other[bin] += 1;
  });
  return { gesture, other, bins };
}

/** Reliability: in each slice of scores, the average score and the share of windows that really were the gesture. Empty slices are left out. */
export function calibration(probabilities: number[], labels: number[], bins = 10) {
  const rows: { low: number; high: number; meanScore: number; shareGesture: number; windows: number }[] = [];
  for (let b = 0; b < bins; b += 1) {
    const low = b / bins;
    const high = (b + 1) / bins;
    const inside = probabilities.map((p, i) => i).filter((i) => probabilities[i] >= low && (probabilities[i] < high || (b === bins - 1 && probabilities[i] <= high)));
    if (inside.length === 0) continue;
    rows.push({
      low, high, windows: inside.length,
      meanScore: inside.reduce((sum, i) => sum + probabilities[i], 0) / inside.length,
      shareGesture: inside.reduce((sum, i) => sum + labels[i], 0) / inside.length,
    });
  }
  return rows;
}

export interface RecordingRow {
  recording: string;
  windows: number;
  gestureWindows: number;
  otherWindows: number;
  meanScore: number;
  /** Undefined when the recording has windows of only one kind. */
  auc?: number;
  recall?: number;
  falseAlarmRate?: number;
}

/** The held-out recordings one by one: a model that does well overall can do badly on one of them. */
export function perRecording({ probabilities, labels, recordings }: Scored, threshold: number): RecordingRow[] {
  const ids = [...new Set(recordings)];
  return ids.map((recording) => {
    const index = recordings.map((r, i) => i).filter((i) => recordings[i] === recording);
    const p = index.map((i) => probabilities[i]);
    const y = index.map((i) => labels[i]);
    const { positives, negatives } = counts(y);
    const at = confusionAt(p, y, threshold);
    return {
      recording,
      windows: index.length,
      gestureWindows: positives,
      otherWindows: negatives,
      meanScore: p.reduce((sum, v) => sum + v, 0) / Math.max(p.length, 1),
      auc: positives > 0 && negatives > 0 ? rocAuc(p, y) : undefined,
      recall: positives > 0 ? at.recall : undefined,
      falseAlarmRate: negatives > 0 ? at.falseAlarmRate : undefined,
    };
  });
}

const csvCell = (value: string | number | undefined): string => {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export const toCsv = (header: string[], rows: (string | number | undefined)[][]): string => [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";

/** Every held-out window with its true label and score, for anyone who wants to make their own chart. */
export const scoresCsv = ({ probabilities, labels, recordings }: Scored): string =>
  toCsv(["recording", "is_gesture", "score"], probabilities.map((p, i) => [recordings[i], labels[i], p]));

/** The curves behind the charts, as one table: which curve, then its two coordinates (and the cut-off where there is one). */
export function curvesCsv({ probabilities, labels }: Scored): string {
  const roc = rocCurve(probabilities, labels).map((p) => ["roc", p.x, p.y, ""]);
  const pr = prCurve(probabilities, labels).points.map((p) => ["precision_recall", p.x, p.y, ""]);
  const sweep = thresholdSweep(probabilities, labels).flatMap((row) => [
    ["sweep_precision", row.threshold, row.precision, row.threshold],
    ["sweep_recall", row.threshold, row.recall, row.threshold],
    ["sweep_f1", row.threshold, row.f1, row.threshold],
    ["sweep_false_alarm_rate", row.threshold, row.falseAlarmRate, row.threshold],
  ]);
  return toCsv(["curve", "x", "y", "threshold"], [...roc, ...pr, ...sweep]);
}

export const recordingsCsv = (scored: Scored, threshold: number): string =>
  toCsv(
    ["recording", "windows", "gesture_windows", "other_windows", "mean_score", "roc_auc", "recall", "false_alarm_rate"],
    perRecording(scored, threshold).map((r) => [r.recording, r.windows, r.gestureWindows, r.otherWindows, r.meanScore, r.auc, r.recall, r.falseAlarmRate]),
  );
