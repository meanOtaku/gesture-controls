import type { DatasetSummary } from "./types";
import { datasetLabels } from "./types";

/** Training a model for one label (see `label_training.rs`). */

export type TrainMethod = "logreg" | "mlp" | "torch-mlp" | "cnn1d";
export type DataStream = "watchOrientation" | "watchAcceleration" | "watchGyroscope" | "watchPpg";
export type OtherRole = "negative" | "exclude";

export const LABEL_TRAINING_EVENT = "label-training-event";

export const METHODS: ReadonlyArray<{ value: TrainMethod; label: string; summary: string }> = [
  { value: "logreg", label: "Logistic regression", summary: "Fast and simple. A good first try, and easy to trust." },
  { value: "mlp", label: "Small neural network (scikit-learn)", summary: "Can learn more complicated patterns than logistic regression." },
  { value: "torch-mlp", label: "Small neural network (PyTorch)", summary: "The same idea in PyTorch. The first run downloads PyTorch, which is large." },
  { value: "cnn1d", label: "1D convolutional network (PyTorch)", summary: "Reads the window itself, as each channel over time, instead of statistics of it, and finds the patterns. Needs more recordings than the others, and a longer window helps. The first run downloads PyTorch, which is large." },
];

/** How long a window of data a model reads, in milliseconds. Longer shows a slower or longer event, with fewer windows per recording. */
/** How far back the pulse sensor's level can be compared with (the desktop's `BASELINE_CHOICES_MS`). */
export const BASELINE_CHOICES: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: "None (the window on its own)" },
  { value: 2000, label: "The last 2 s" },
  { value: 4000, label: "The last 4 s" },
  { value: 8000, label: "The last 8 s" },
];

export const WINDOW_LENGTHS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 500, label: "0.5 s (default)" },
  { value: 750, label: "0.75 s" },
  { value: 1000, label: "1 s" },
  { value: 1500, label: "1.5 s" },
  { value: 2000, label: "2 s" },
];
export const DEFAULT_WINDOW_MS = 500;

export const STREAMS: ReadonlyArray<{ value: DataStream; label: string; summary: string }> = [
  { value: "watchAcceleration", label: "Acceleration", summary: "How hard and in which direction the watch is pushed. Most gestures need this." },
  { value: "watchGyroscope", label: "Gyroscope", summary: "How fast the watch is turning." },
  { value: "watchOrientation", label: "Orientation", summary: "Which way the watch is pointing." },
  { value: "watchPpg", label: "Pulse sensor (PPG)", summary: "The light sensor on the back of the watch, used for finger and hand gestures. Needs good skin contact." },
];

/** The ways of pulling spikes out of the pulse sensor, as the trainer and the live runtime know them. */
export const SPIKE_METHODS = [
  { value: "none", label: "None (statistics only)", summary: "The model reads only the usual statistics of each window: averages, spread, minimum, maximum." },
  { value: "straight_line_baseline", label: "Straight-line baseline removed", summary: "Fits a straight line through the 500 ms window and takes it away, so drift and skin contact leave nothing but the changes. A good first choice for a pinch." },
  { value: "first_derivative", label: "First derivative", summary: "The change from each pulse sample to the next: sharp events stand out, and anything slow disappears." },
  { value: "rolling_median_residual", label: "Rolling median residual", summary: "Each value minus the median of its neighbours: a short spike survives, a slow drift does not." },
  { value: "morphological_top_hat", label: "Morphological top-hat", summary: "Each value minus the lowest-then-highest envelope of its neighbours: keeps short upward spikes, near zero on a flat or drifting baseline." },
  { value: "butterworth_high_pass", label: "Butterworth high-pass", summary: "A smooth filter that lets fast changes through and blocks slow ones. In a short window its first and last samples are less reliable." },
  { value: "savitzky_golay_residual", label: "Savitzky–Golay residual", summary: "Each value minus a smooth curve fitted to its neighbours: what the smooth curve cannot follow." },
  { value: "haar_wavelet_detail", label: "Haar wavelet detail", summary: "The difference between the average just before each sample and just after it: finds steps and short bursts." },
] as const;

export type SpikeMethodId = (typeof SPIKE_METHODS)[number]["value"];

/** The three lights of the watch's pulse sensor, each a channel of its own the model can be given or not. */
export const PPG_CHANNELS = [
  { value: "green", label: "Green", summary: "The strongest, cleanest pulse signal; the one most affected by motion." },
  { value: "red", label: "Red", summary: "Reaches a little deeper into the skin." },
  { value: "ir", label: "Infrared", summary: "Deepest and steadiest; the least bothered by ambient light." },
] as const;
export type PpgChannel = (typeof PPG_CHANNELS)[number]["value"];
export const ALL_PPG_CHANNELS: PpgChannel[] = PPG_CHANNELS.map((channel) => channel.value);

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
  /** How long a window of data the model reads, in milliseconds. */
  windowMs: number;
  /** Exactly which inputs the model reads, by name; left out means all the streams provide. */
  features?: string[];
  /** The shape of a neural network and how it is trained; left out means the method's default. */
  network?: Record<string, unknown>;
  /** Also retrain on less data and on all but one recording, to see how far the score can be trusted (slower). */
  research?: boolean;
  /** `raw`: the dataset's own columns, each at each step, one input neuron apiece (dense methods). Absent: statistics of each window. */
  inputMode?: "raw";
  /** Steps each column is laid onto: for the convolutional method, or for raw columns. */
  gridSteps?: number;
  /** Which of the pulse sensor's light channels the model may read (only matters when the pulse sensor is a stream). */
  ppgChannels: PpgChannel[];
  /** How the pulse sensor's spikes are pulled out before the model reads their features; "none" reads no spike features. */
  spikeMethod: SpikeMethodId;
}

export interface TrainPlan {
  train: string[];
  evaluation: string[];
  /** Why this cannot be trained, in words; null when it can. */
  problem: string | null;
  /** Every input the chosen streams and settings provide, and the ones the model will read. */
  available: string[];
  features: string[];
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
  spikeMethod?: SpikeMethodId;
  ppgChannels?: PpgChannel[];
  windowMs?: number;
  features?: string[] | null;
  network?: Record<string, unknown>;
  research?: boolean;
  inputMode?: "raw";
  gridSteps?: number;
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
    spikeMethod: input.spikeMethod ?? "none",
    ppgChannels: [...(input.ppgChannels ?? ALL_PPG_CHANNELS)],
    windowMs: input.windowMs ?? DEFAULT_WINDOW_MS,
    ...(input.features && input.features.length > 0 ? { features: [...input.features] } : {}),
    ...(input.network ? { network: input.network } : {}),
    ...(input.research ? { research: true } : {}),
    ...(input.inputMode ? { inputMode: input.inputMode } : {}),
    ...(input.gridSteps ? { gridSteps: input.gridSteps } : {}),
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

/** The columns of a recording's data, in the order of the dataset's header, and which stream each comes from. */
export const DATASET_COLUMNS: ReadonlyArray<{ name: string; stream: DataStream }> = [
  { name: "ppg_green", stream: "watchPpg" }, { name: "ppg_red", stream: "watchPpg" }, { name: "ppg_ir", stream: "watchPpg" },
  { name: "accel_x", stream: "watchAcceleration" }, { name: "accel_y", stream: "watchAcceleration" }, { name: "accel_z", stream: "watchAcceleration" },
  { name: "gyro_x", stream: "watchGyroscope" }, { name: "gyro_y", stream: "watchGyroscope" }, { name: "gyro_z", stream: "watchGyroscope" },
  { name: "quat_w", stream: "watchOrientation" }, { name: "quat_x", stream: "watchOrientation" }, { name: "quat_y", stream: "watchOrientation" }, { name: "quat_z", stream: "watchOrientation" },
];
export const ALL_COLUMNS: string[] = DATASET_COLUMNS.map((column) => column.name);

/** The streams (and, for the pulse sensor, lights) that a choice of columns needs. */
export function needsOf(columns: string[]): { sources: DataStream[]; lights: PpgChannel[] } {
  const chosen = DATASET_COLUMNS.filter((column) => columns.includes(column.name));
  const sources = [...new Set(chosen.map((column) => column.stream))];
  const lights = ALL_PPG_CHANNELS.filter((light) => columns.includes(`ppg_${light}`));
  return { sources, lights };
}

/** Steps per column the person can choose: 1 is the latest reading of each column, like one row of the dataset. */
export const RAW_STEPS = [1, 2, 4, 8, 16, 32, 64] as const;
export const CNN_STEPS = [8, 16, 32, 64, 128] as const;
