import type { DatasetSummary } from "./types";
import { datasetLabels } from "./types";

/** Training a model for one label (see `label_training.rs`). */

export type TrainMethod = "logreg" | "mlp" | "torch-mlp";
export type DataStream = "watchOrientation" | "watchAcceleration" | "watchGyroscope" | "watchPpg";
export type OtherRole = "negative" | "exclude";

export const LABEL_TRAINING_EVENT = "label-training-event";

export const METHODS: ReadonlyArray<{ value: TrainMethod; label: string; summary: string }> = [
  { value: "logreg", label: "Logistic regression", summary: "Fast and simple. A good first try, and easy to trust." },
  { value: "mlp", label: "Small neural network (scikit-learn)", summary: "Can learn more complicated patterns than logistic regression." },
  { value: "torch-mlp", label: "Small neural network (PyTorch)", summary: "The same idea in PyTorch. The first run downloads PyTorch, which is large." },
];

export const STREAMS: ReadonlyArray<{ value: DataStream; label: string; summary: string }> = [
  { value: "watchAcceleration", label: "Acceleration", summary: "How hard and in which direction the watch is pushed. Most gestures need this." },
  { value: "watchGyroscope", label: "Gyroscope", summary: "How fast the watch is turning." },
  { value: "watchOrientation", label: "Orientation", summary: "Which way the watch is pointing." },
  { value: "watchPpg", label: "Pulse sensor (PPG)", summary: "The light sensor on the back of the watch, used for finger and hand gestures. Needs good skin contact." },
];

export const DEFAULT_STREAMS: DataStream[] = ["watchAcceleration", "watchGyroscope"];

export interface TrainRequest {
  label: string;
  datasetIds: string[];
  negatives: string[];
  excludes: string[];
  backend: TrainMethod;
  sources: DataStream[];
  /** Only features about how things change, not their absolute levels. */
  movementOnly: boolean;
}

export interface TrainPlan {
  train: string[];
  evaluation: string[];
  /** Why this cannot be trained, in words; null when it can. */
  problem: string | null;
}

export interface TrainerEnvironment {
  available: boolean;
  detail: string;
}

export interface TrainingMetrics {
  windows: number;
  positiveWindows: number;
  negativeWindows: number;
  precision: number;
  recall: number;
  f1: number;
  falseActivationRate: number;
  /** 0.5 is chance; under 0.5 the model ranks the gesture's windows below the rest. */
  rocAuc: number;
  activationThreshold: number;
}

export type TrainingEvent =
  | { kind: "started"; runId: string; label: string; backend: string }
  | { kind: "log"; runId: string; message: string }
  | { kind: "finished"; runId: string; label: string; outcome: "deployable" | "evaluationOnly" | "failed" | "cancelled"; message: string; versionId: string | null; metrics: TrainingMetrics | null };

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
  method: TrainMethod;
  sources: DataStream[];
  movementOnly?: boolean;
}): TrainRequest {
  const role = (label: string): OtherRole => input.roles[label] ?? "negative";
  return {
    label: input.label,
    datasetIds: [...input.datasetIds],
    negatives: input.others.filter((label) => role(label) === "negative"),
    excludes: input.others.filter((label) => role(label) === "exclude"),
    backend: input.method,
    sources: [...input.sources],
    movementOnly: input.movementOnly ?? false,
  };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** The numbers that matter, in words. */
export function describeMetrics(metrics: TrainingMetrics): string {
  return `On recordings it never saw: it found ${pct(metrics.recall)} of the ${metrics.positiveWindows} windows of the gesture, ${pct(metrics.precision)} of what it flagged was right, and it wrongly flagged ${pct(metrics.falseActivationRate)} of the ${metrics.negativeWindows} windows of something else.`;
}

/** The caveat that goes with those numbers: the cut-off was fitted on the same recordings. */
export const THRESHOLD_CAVEAT = "The cut-off for “detected” was chosen using those same test recordings, so these numbers are a little optimistic. Try the model in Monitor before trusting it.";

/** How many of the recordings in `ids` have the label: a model needs several to learn the gesture rather than a session. */
export function recordingsWithLabel(datasets: DatasetSummary[], ids: string[], label: string): number {
  return ids.filter((id) => datasets.some((dataset) => dataset.id === id && hasLabel(dataset, label))).length;
}

export const MAX_LOG_LINES = 200;

export function appendLog(previous: string[], message: string): string[] {
  const next = [...previous, message];
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
}
