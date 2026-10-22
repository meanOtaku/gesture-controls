import type { DatasetSummary } from "./types";
import { datasetLabels } from "./types";

/** Training a label's model (see `label_training.rs`). There is one kind of model to train: the PPG + IMU pinch-start model. */

export type OtherRole = "negative" | "exclude";

export const LABEL_TRAINING_EVENT = "label-training-event";

/** The one model the app trains: what it reads, the steps it takes, and what the research measured for it. */
export const PULSE_MODEL = {
  name: "PPG + IMU pinch-start model",
  summary:
    "Reads the watch's pulse sensor and its accelerometer and gyroscope, and fires about 0.9 s after a gesture starts. The pulse is compared with the 1, 2 and 4 seconds before it, the motion is summarised over the last 0.3 to 1.3 s, and 300 randomised decision trees decide whether a gesture has just begun. It fires at the top of the trees' rising vote, at a cut-off that keeps false alarms under about 2 a minute on training recordings it did not see.",
  stages: [
    { title: "Pulse sensor", detail: "Green, red and infrared light, 25 times a second" },
    { title: "Compared with the recent past", detail: "Each channel z-scored against the previous 1 s, 2 s and 4 s" },
    { title: "How it changes", detail: "Slope, curvature and jerk of each, from the previous 9 samples: 1,701 inputs" },
    { title: "Motion", detail: "Accelerometer and gyroscope, 50 times a second, summarised over 0.3, 0.6 and 1.3 s: 1,032 inputs" },
    { title: "ExtraTrees", detail: "300 randomised trees vote on “a gesture just started”" },
    { title: "Peak trigger", detail: "Fires when the vote falls back after reaching the cut-off" },
  ],
  inputs: 2733,
  /** What the app's model scored on 37 recordings and 20 recording-disjoint splits, firing on the peak at a cut-off of 0.8
   * (docs/research/artifacts/ppg-benchmark-2026-10/ppg-imu-fusion/app-definition-check.json). */
  research: { worstAuc: 0.853, meanAuc: 0.898, recall: 0.372, falsePerMinute: 1.5 },
} as const;

export interface TrainRequest {
  label: string;
  datasetIds: string[];
  negatives: string[];
  excludes: string[];
  /** Also retrain on less data and on all but one recording, to see how far the score can be trusted (slower). */
  research?: boolean;
  /** Moves every label later in time by this many milliseconds (earlier when negative); absent leaves them as recorded. */
  labelOffsetMs?: number;
}

/** The most the labels may be moved in time, either way (the desktop's limit). */
export const MAX_LABEL_OFFSET_MS = 1500;

/** How well recordings separate the gesture's starts from the rest at one label offset (see `OffsetScore` in label_training.rs). */
export interface OffsetScore {
  offsetMs: number;
  auc: number | null;
  windows: number;
  positives: number;
}

export interface TrainPlan {
  train: string[];
  evaluation: string[];
  /** Why this cannot be trained, in words; null when it can. */
  problem: string | null;
  /** How many inputs the model reads. */
  inputs: number;
}

export interface TrainerEnvironment {
  available: boolean;
  detail: string;
}

export interface TrainingMetrics {
  /** The held-out moments the model was scored on: starts of the gesture, and other moments. */
  windows: number;
  positiveWindows: number;
  negativeWindows: number;
  precision: number;
  recall: number;
  f1: number;
  falseActivationRate: number;
  /** 0.5 is chance; under 0.5 the model ranks the gesture's starts below the rest. */
  rocAuc: number;
  activationThreshold: number;
  balancedAccuracy?: number;
  /** Where the cut-off came from. */
  thresholdSource?: "trainingRecordings" | "evaluationRecordings" | "default";
  thresholdChosenOnEvaluationRecordings?: boolean;
  /** The model replayed as a detector over the whole held-out recordings. */
  events?: EventMetrics;
}

export interface EventMetrics {
  recordings: number;
  gestures: number;
  caught: number;
  gestureRecall: number | null;
  repeats: number;
  medianLatencyMs: number | null;
  falseActivations: number;
  negativeSeconds: number;
  falseActivationsPerHour: number | null;
}

/** `monitorOnly`: trained, but it did not pass the checks for going live, so it can only run in Monitor. */
export type TrainingOutcome = "deployable" | "monitorOnly" | "failed" | "cancelled";

export type TrainingEvent =
  | { kind: "started"; runId: string; label: string; backend: string }
  | { kind: "log"; runId: string; message: string }
  | { kind: "finished"; runId: string; label: string; outcome: TrainingOutcome; message: string; versionId: string | null; metrics: TrainingMetrics | null };

export interface TrainingStatus {
  running: { runId: string; label: string } | null;
  last: TrainingEvent | null;
}

/** The labels on the chosen recordings other than the one being trained: each needs a role. */
export function otherLabels(datasets: DatasetSummary[], selectedIds: ReadonlySet<string>, target: string): string[] {
  const labels = new Set<string>();
  for (const dataset of datasets) {
    if (!selectedIds.has(dataset.id)) continue;
    for (const label of datasetLabels(dataset)) if (label !== target) labels.add(label);
  }
  return [...labels].sort();
}

/** Recordings that have the label, so a person can see what they are choosing between. */
export function hasLabel(dataset: DatasetSummary, label: string): boolean {
  return datasetLabels(dataset).includes(label);
}

export function buildRequest(input: {
  label: string;
  datasetIds: string[];
  others: string[];
  roles: Record<string, OtherRole>;
  research?: boolean;
  labelOffsetMs?: number;
}): TrainRequest {
  const role = (label: string): OtherRole => input.roles[label] ?? "negative";
  return {
    label: input.label,
    datasetIds: [...input.datasetIds],
    negatives: input.others.filter((label) => role(label) === "negative"),
    excludes: input.others.filter((label) => role(label) === "exclude"),
    ...(input.research ? { research: true } : {}),
    ...(input.labelOffsetMs ? { labelOffsetMs: input.labelOffsetMs } : {}),
  };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** The numbers that matter, in words. */
export function describeMetrics(metrics: TrainingMetrics): string {
  return `On recordings it never saw: it found ${pct(metrics.recall)} of the ${metrics.positiveWindows} gesture starts, ${pct(metrics.precision)} of what it flagged was right, and it wrongly flagged ${pct(metrics.falseActivationRate)} of the ${metrics.negativeWindows} other moments.`;
}

/** The replay over whole held-out recordings, in words: what a person using it would notice. */
export function describeEvents(events: EventMetrics): string {
  const minutes = events.negativeSeconds / 60;
  const time = minutes >= 1 ? `${minutes.toFixed(1)} minutes` : `${Math.round(events.negativeSeconds)} seconds`;
  const caught = events.gestures > 0
    ? `it caught ${events.caught} of ${events.gestures} gestures${events.medianLatencyMs !== null ? `, typically ${Math.round(events.medianLatencyMs)} ms after each began` : ""}, and `
    : "";
  const perHour = events.falseActivationsPerHour !== null ? ` (about ${Math.round(events.falseActivationsPerHour)} an hour)` : "";
  return `Played through the test recordings as it would run live, ${caught}it went off ${events.falseActivations} times in ${time} without the gesture${perHour}.`;
}

/** Where the cut-off for “detected” came from, and so how far the test numbers can be trusted. */
export function thresholdNote(metrics: TrainingMetrics): string {
  switch (metrics.thresholdChosenOnEvaluationRecordings === false ? metrics.thresholdSource : "evaluationRecordings") {
    case "trainingRecordings":
      return "The cut-off for “detected” was chosen on the training recordings, so the test numbers are fair. Still try the model in Monitor before Live.";
    case "default":
      return "There were too few training recordings to choose a cut-off for “detected”, so the default is used. Try it in Monitor before Live.";
    default:
      return "The cut-off for “detected” was chosen using those same test recordings, so these numbers are a little optimistic. Try the model in Monitor before trusting it.";
  }
}

/** How many of the recordings in `ids` have the label: a model needs several to learn the gesture rather than a session. */
export function recordingsWithLabel(datasets: DatasetSummary[], ids: string[], label: string): number {
  return ids.filter((id) => datasets.some((dataset) => dataset.id === id && hasLabel(dataset, label))).length;
}

export const MAX_LOG_LINES = 200;

export function appendLog(previous: string[], message: string): string[] {
  const next = [...previous, message];
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
}
