import { LEFT_OUT } from "../labelling/labellingModel";
import type { DatasetSummary } from "./types";
import { datasetLabels } from "./types";

/** Training a label's model (see `label_training.rs`): the PPG + IMU pinch-start trees, or the CNN. */

export type OtherRole = "negative" | "exclude";

export const LABEL_TRAINING_EVENT = "label-training-event";

/** The one model the app trains: what it reads, the steps it takes, and what the research measured for it. */
export interface ModelStage {
  title: string;
  detail: string;
}

/** How a kind of model works, in words. */
export interface ModelDescription {
  name: string;
  summary: string;
  stages: readonly ModelStage[];
}

export const PULSE_MODEL = {
  name: "PPG + IMU pinch-start model",
  summary:
    "Reads the watch's pulse sensor and its accelerometer and gyroscope, and fires about 0.9 s after a gesture starts. The pulse is compared with the 1, 2 and 4 seconds before it, the motion is summarised over the last 0.3 to 1.3 s, and 300 randomised decision trees decide whether a gesture has just begun. It fires at the top of the trees' rising vote, at a cut-off that keeps it within 5 false activations an hour on training recordings it did not see.",
  stages: [
    { title: "Pulse sensor", detail: "Green, red and infrared light, 25 times a second" },
    { title: "Compared with the recent past", detail: "Each channel z-scored against the previous 1 s, 2 s and 4 s" },
    { title: "How it changes", detail: "Slope, curvature and jerk of each, from the previous 9 samples: 1,701 inputs" },
    { title: "Motion", detail: "Accelerometer and gyroscope, 50 times a second, summarised over 0.3, 0.6 and 1.3 s: 1,032 inputs" },
    { title: "ExtraTrees", detail: "300 randomised trees vote on “a gesture just started”" },
    { title: "Peak trigger", detail: "Fires when the vote falls back after reaching the cut-off" },
  ],
  inputs: 2733,
  /** What the app's model scored on 37 recordings and 20 recording-disjoint splits, trained with moments just after each
   * start as negatives and firing on the peak at a cut-off of 0.65 (docs/research/artifacts/ppg-benchmark-2026-10/timing-negatives). */
  research: { worstAuc: 0.873, meanAuc: 0.906, recall: 0.462, falsePerMinute: 1.9 },
} as const;

/** The trainer backend: the trees (the default) or the CNN. */
export type TrainMethod = "ppg-onset-trees" | "ppg-imu-cnn";
export const TREES_METHOD: TrainMethod = "ppg-onset-trees";
export const CNN_METHOD: TrainMethod = "ppg-imu-cnn";

/** The CNN the app can train instead of the trees: what it reads, the steps it takes, and what the research measured. */
export const CNN_MODEL = {
  name: "CNN pinch-start model",
  summary:
    "Reads the last second of the watch's accelerometer, gyroscope and pulse sensor, each scaled by the median and spread of its last 11 seconds so that a burst of motion does not hide the next pinch, and fires about 0.5 s after a gesture starts, about 0.4 s sooner than the trees. Three small convolutional networks look at the shape of that second and their votes are averaged.",
  /** What to know before training one. */
  trainingNote:
    "Train it on your gesture sessions together with everyday-noise recordings, and leave Settings → Gestures → Still hand off: with that on it never sees the hand moving, so it cannot learn that movement is not the gesture. Training it needs PyTorch, which the trainer installs the first time (a large download).",
  stages: [
    { title: "Motion and pulse", detail: "Accelerometer and gyroscope, and green, red and infrared light, on one 50 Hz grid" },
    { title: "Scaled to its recent level", detail: "Each channel against the median and spread of its last 11 s, then squashed to 0-1" },
    { title: "The last second", detail: "9 channels x 50 ticks: 450 inputs" },
    { title: "CNN", detail: "Three dilated convolutions, max and mean over time, two dense layers; three networks averaged" },
    { title: "Peak trigger", detail: "Fires when the vote falls back after reaching the cut-off" },
  ],
  inputs: 450,
  networks: 3,
  /** Pinch ins caught with still hand, at most 1 false alarm a minute, on the current pinch model's split, measured with the
   * earlier rolling scaling
   * (docs/research/artifacts/double-pinch-2026-10/cnn-vs-trees): against 64% for the trees. */
  research: { recall: 0.69, falsePerMinute: 1.0, delayMs: 500 },
} as const;

/** The CNN as it was first trained: the same network, scaled by a rolling mean and deviation, which motion upsets. */
const ROLLING_CNN_MODEL: ModelDescription = {
  name: "CNN pinch-start model (rolling scaling)",
  summary:
    "An earlier CNN. It reads the same second of motion and pulse, but each tick is scaled by the 10 seconds before it, so a burst of motion hides pinches until it has left those 10 seconds. Train a new CNN to replace it.",
  stages: CNN_MODEL.stages.map((stage, index) => (index === 1 ? { ...stage, detail: "Each tick z-scored against the 10 s before it, then squashed to 0-1" } : stage)),
};

/** The earlier model of the pulse sensor alone. */
const PULSE_ONLY_MODEL: ModelDescription = {
  name: "PPG pinch-start model",
  summary: "An earlier model. It reads the pulse sensor alone, compares it with the 1, 2 and 4 seconds before it, and randomised decision trees decide whether a gesture has just begun, firing as the vote crosses the cut-off.",
  stages: [
    ...PULSE_MODEL.stages.slice(0, 3),
    PULSE_MODEL.stages[4],
    { title: "Edge trigger", detail: "Fires when the vote crosses the cut-off" },
  ],
};

/** How the model of a bundle's preprocessing kind works (`ModelKind` in inputs.rs); null for a kind this app does not know. */
export function modelDescription(kind: unknown): ModelDescription | null {
  switch (kind) {
    case "ppg_imu_onset": return PULSE_MODEL;
    case "ppg_multiscale_onset": return PULSE_ONLY_MODEL;
    case "ppg_imu_cnn_median": return CNN_MODEL;
    case "ppg_imu_cnn": return ROLLING_CNN_MODEL;
    default: return null;
  }
}

export interface TrainRequest {
  label: string;
  datasetIds: string[];
  negatives: string[];
  excludes: string[];
  /** Also retrain on less data and on all but one recording, to see how far the score can be trusted (slower). */
  research?: boolean;
  /** Moves every label later in time by this many milliseconds (earlier when negative); absent leaves them as recorded. */
  labelOffsetMs?: number;
  /** Which model to train; absent trains the trees. */
  method?: TrainMethod;
  /** Train again with the moments it fired by mistake on its training recordings (`reinforce` in the trainer). */
  hardNegatives?: boolean;
  /** A training plan for the CNN: it trains through these in order. Absent trains on everything at once. */
  stages?: StageRequest[];
}

/** Mirrors `StageRequest` in `label_training.rs`: one step of a training plan. */
export interface StageRequest {
  name: string;
  datasetIds: string[];
  /** Also train on the starts and half the other moments of the stages before, so they are not forgotten. */
  rehearse: boolean;
  /** Passes over the stage; absent uses the trainer's default (CNN_DEFAULT_EPOCHS). */
  epochs?: number;
}

/** A stage being edited in the Train panel. */
export interface StageDraft {
  key: string;
  name: string;
  datasetIds: string[];
  rehearse: boolean;
  epochs: number | null;
}

/** The trainer's passes over the data when a stage does not say (`cnn.EPOCHS`), and the limits (`label_training.rs`). */
export const CNN_DEFAULT_EPOCHS = 12;
export const MAX_STAGES = 8;
export const MAX_STAGE_EPOCHS = 50;

let stageCount = 0;
/** A new, empty stage. */
export function newStage(name: string, datasetIds: string[] = []): StageDraft {
  stageCount += 1;
  return { key: `stage-${stageCount}`, name, datasetIds, rehearse: true, epochs: null };
}

/** A starting plan for `chosen` recordings: the ones with the label first, then everything else. */
export function defaultStages(chosen: string[], datasets: DatasetSummary[], label: string): StageDraft[] {
  const has = (id: string) => datasets.some((dataset) => dataset.id === id && hasLabel(dataset, label));
  const withLabel = chosen.filter(has);
  const rest = chosen.filter((id) => !has(id));
  return [
    ...(withLabel.length ? [newStage(`Recordings with ${label}`, withLabel)] : []),
    ...(rest.length ? [newStage("Everything else", rest)] : []),
  ];
}

/** The plan as the request carries it: each stage's chosen recordings only. */
export function stagesForRequest(drafts: StageDraft[], chosen: Set<string>): StageRequest[] {
  return drafts.map((draft) => ({
    name: draft.name.trim(),
    datasetIds: draft.datasetIds.filter((id) => chosen.has(id)),
    rehearse: draft.rehearse,
    ...(draft.epochs != null ? { epochs: draft.epochs } : {}),
  }));
}

/**
 * For the stage at `index`: each recording the stages before it used, with the numbers (from 1) of those stages, in the
 * order they first appear. A rehearsing stage trains on part of these again; one that does not rehearse leaves them.
 */
export function earlierRecordings(drafts: Pick<StageDraft, "datasetIds">[], index: number): { id: string; stages: number[] }[] {
  const seen = new Map<string, number[]>();
  drafts.slice(0, Math.max(0, index)).forEach((draft, stage) => {
    for (const id of new Set(draft.datasetIds)) seen.set(id, [...(seen.get(id) ?? []), stage + 1]);
  });
  return [...seen.entries()].map(([id, stages]) => ({ id, stages }));
}

/** Chosen recordings that no stage trains on (the desktop refuses a plan that leaves one out). */
export function unstaged(drafts: StageDraft[], chosen: Set<string>): string[] {
  const staged = new Set(drafts.flatMap((draft) => draft.datasetIds));
  return [...chosen].filter((id) => !staged.has(id));
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
  /** With a training plan: per stage, what it trains on and what is held out for testing. */
  stages?: StagePlan[];
}

/** Mirrors `StagePlanView`. */
export interface StagePlan {
  name: string;
  train: string[];
  heldOut: string[];
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

/** The replay counted as `docs/research/gesture-detector-evaluation-metrics.md` counts it (`label_train.detections`). */
export interface EventMetrics {
  recordings: number;
  gestures: number;
  caught: number;
  gestureRecall: number | null;
  /** Fired again during a gesture it had caught. */
  repeats: number;
  /** Fired during a gesture it had not caught in time (that gesture counts as missed). */
  late?: number;
  repeatsPer100Gestures?: number | null;
  medianLatencyMs: number | null;
  /** Fired with no gesture under way. */
  falseActivations: number;
  negativeSeconds: number;
  falseActivationsPerHour: number | null;
  /** Which recordings these totals cover: the camera-timed ones when the test also had estimated timings, else all. */
  cohort?: "camera" | "all";
  /** The totals for each kind of label timing, when the recordings said. */
  byLabelTiming?: Partial<Record<"camera" | "estimated" | "unknown", EventMetrics>>;
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
    // Stretches left out on the Labelling page are always excluded (the desktop sees to it), so they need no role.
    for (const label of datasetLabels(dataset)) if (label !== target && label !== LEFT_OUT) labels.add(label);
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
  method?: TrainMethod;
  hardNegatives?: boolean;
  /** Only for the CNN: the plan to train through. */
  stages?: StageRequest[];
}): TrainRequest {
  const role = (label: string): OtherRole => input.roles[label] ?? "negative";
  return {
    label: input.label,
    datasetIds: [...input.datasetIds],
    negatives: input.others.filter((label) => role(label) === "negative"),
    excludes: input.others.filter((label) => role(label) === "exclude"),
    ...(input.research ? { research: true } : {}),
    ...(input.labelOffsetMs ? { labelOffsetMs: input.labelOffsetMs } : {}),
    ...(input.method === CNN_METHOD ? { method: CNN_METHOD } : {}),
    ...(input.hardNegatives ? { hardNegatives: true } : {}),
    ...(input.method === CNN_METHOD && input.stages?.length ? { stages: input.stages } : {}),
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
  const which = events.cohort === "camera" ? "the camera-timed test recordings" : "the test recordings";
  const during = [
    events.repeats > 0 ? `${events.repeats} more time${events.repeats === 1 ? "" : "s"} during gestures it had caught` : "",
    (events.late ?? 0) > 0 ? `${events.late} time${events.late === 1 ? "" : "s"} too late to catch one` : "",
  ].filter(Boolean);
  const estimated = events.cohort === "camera" ? events.byLabelTiming?.estimated : undefined;
  return [
    `Played through ${which} as it would run live, ${caught}it went off ${events.falseActivations} times in ${time} with no gesture under way${perHour}.`,
    during.length > 0 ? `It also went off ${during.join(" and ")}.` : "",
    estimated && estimated.gestures > 0
      ? `On the recordings with labels estimated from motion it caught ${estimated.caught} of ${estimated.gestures}: shown, but not judged on, as those timings are not exact.`
      : "",
  ].filter(Boolean).join(" ");
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
