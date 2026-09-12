import type { GestureDatasetLabel } from "../telemetry/store/telemetryStore";

export type LabelRole = "positive" | "hold" | "negative";

export const POSITIVE_LABELS: readonly GestureDatasetLabel[] = ["pinch_start", "pinch_release"];
export const HOLD_LABEL: GestureDatasetLabel = "pinch_hold";

export function roleFor(label: GestureDatasetLabel): LabelRole {
  if (POSITIVE_LABELS.includes(label)) return "positive";
  if (label === HOLD_LABEL) return "hold";
  return "negative";
}

export const ROLE_COPY: Record<LabelRole, string> = {
  positive: "Trained class",
  hold: "Optional (--hold-handling)",
  negative: "Negative / background",
};

/** Mirrors `DatasetSummary` in src-tauri/src/model_lab.rs (serde camelCase). */
export interface DatasetSummary {
  id: string;
  originalFilename: string;
  importedAt: string;
  label: string;
  rowCount: number;
}

/** Mirrors `DatasetLabel` in src-tauri/src/label_registry.rs. */
export interface DatasetLabel {
  id: string;
  displayName: string;
  description: string;
  color: string;
  role: "positiveGesture" | "negativeBackground" | "calibrationOnly";
  archivedAt: string | null;
}

/** Mirrors `EnvironmentDiagnostic` in src-tauri/src/environment.rs (serde camelCase). */
export interface EnvironmentDiagnostic {
  id: string;
  title: string;
  status: "ready" | "attention";
  detail: string;
  action: string | null;
}

/** Mirrors `TrainingBackend` in src-tauri/src/model_lab.rs (serde camelCase, unit variants). */
export type TrainingBackend = "sklearn" | "tflite";

export const TRAINING_BACKEND_COPY: Record<TrainingBackend, { label: string; hint: string }> = {
  tflite: {
    label: "TFLite (deployable)",
    hint: "Produces a validated LiteRT bundle that can be bound, approved, and activated for desktop inference.",
  },
  sklearn: {
    label: "scikit-learn (baseline only)",
    hint: "A quick RandomForest baseline for offline evaluation only. It has no LiteRT bundle, so it can never " +
      "be bound to intents or activated on this desktop.",
  },
};

/** Mirrors `TrainingStatus` in src-tauri/src/model_lab.rs (serde tag "phase", camelCase). */
export type TrainingStatus =
  | { phase: "idle" }
  | { phase: "running"; jobId: string; datasetIds: string[]; backend: TrainingBackend; startedAt: string }
  | { phase: "completed"; jobId: string; modelId: string; backend: TrainingBackend; modelCard: ModelCard }
  | { phase: "failed"; jobId: string; message: string };

/** Mirrors `TrainingEvent` in src-tauri/src/model_lab.rs (serde tag "kind", camelCase). */
export type TrainingEventPayload =
  | { kind: "started"; jobId: string; datasetIds: string[]; backend: TrainingBackend }
  | { kind: "log"; jobId: string; message: string }
  | { kind: "completed"; jobId: string; modelId: string; backend: TrainingBackend; modelCard: ModelCard }
  | { kind: "failed"; jobId: string; message: string }
  | { kind: "cancelled"; jobId: string };

/** Loose shape of model_card.json, written by tools/pinch-classifier/src/pinch_classifier/train.py. */
export interface ModelCard {
  created_at?: string;
  classes?: string[];
  n_windows_train?: number;
  n_windows_test?: number;
  metrics?: {
    accuracy?: number;
    macro_f1?: number;
    false_activation_count?: number;
    false_activation_total_negative_windows?: number;
    false_activation_rate?: number | null;
  };
}

/** Mirrors `TrainedModelSummary` in src-tauri/src/model_lab.rs (serde camelCase). */
export interface TrainedModelSummary {
  id: string;
  backend: TrainingBackend;
  modelCard: ModelCard;
}

export type InferenceMode = "off" | "monitor" | "live";

export interface ModelRegistryView {
  models: ModelRegistryModel[];
  activeModelId: string | null;
  previousActiveModelId: string | null;
  inferenceMode: InferenceMode;
}

export type ModelLifecycleState = "draft" | "evaluated" | "approved" | "active" | "archived";

/** Mirrors `GestureIntent` in crates/interaction-engine/src/gesture_policy.rs (serde camelCase). */
export type GestureIntent =
  | "noAction"
  | "volumeGrab"
  | "volumeRelease"
  | "mute"
  | "playPause"
  | "previousTrack"
  | "nextTrack";

/** Mirrors `ModelIntentBinding` in src-tauri/src/model_registry.rs (serde camelCase). */
export interface ModelIntentBinding {
  classLabel: string;
  intent: GestureIntent;
}

export interface ModelRegistryModel {
  id: string;
  state: ModelLifecycleState;
  createdAt: string;
  intentBindings: ModelIntentBinding[];
}

/** The three deployable classes, in the order `model_registry.rs`'s `DEPLOYABLE_CLASS_LABELS` requires. */
export const DEPLOYABLE_CLASS_LABELS: readonly string[] = ["negative", "pinch_start", "pinch_release"];

/** Mirrors `allowed_intents_for_class` in src-tauri/src/model_registry.rs exactly: this is what "safe" means
 * per class, and the binding editor must never offer an intent outside this set. */
export const ALLOWED_INTENTS_FOR_CLASS: Record<string, readonly GestureIntent[]> = {
  pinch_start: ["volumeGrab", "noAction"],
  pinch_release: ["volumeRelease", "noAction"],
  negative: ["noAction"],
};

export const INTENT_COPY: Record<GestureIntent, string> = {
  noAction: "No action",
  volumeGrab: "Begin volume grab",
  volumeRelease: "End volume grab",
  mute: "Mute",
  playPause: "Play / pause",
  previousTrack: "Previous track",
  nextTrack: "Next track",
};

/** Mirrors `validate_intent_bindings` in src-tauri/src/model_registry.rs: every deployable class must have
 * exactly one binding, and it must be one of that class's safe intents. */
export function bindingsAreComplete(bindings: ModelIntentBinding[]): boolean {
  return DEPLOYABLE_CLASS_LABELS.every((classLabel) => {
    const binding = bindings.find((entry) => entry.classLabel === classLabel);
    return binding != null && ALLOWED_INTENTS_FOR_CLASS[classLabel]?.includes(binding.intent);
  });
}

export interface PpgWindowObservation {
  deviceId: string;
  sequence: number;
  timestampNs: number;
  sampleCount: number;
  contactQualityMean: number | null;
  activeModelId: string;
  outcome: { kind: string; [key: string]: unknown };
}

export interface GesturePolicyDecision {
  intent: string;
  live: boolean;
  reason: unknown;
}

export type RuntimeEvent =
  | { kind: "window"; observation: PpgWindowObservation }
  | { kind: "decision"; decision: GesturePolicyDecision };

export const MAX_RUNTIME_EVENTS = 20;

export function appendRuntimeEvent(previous: RuntimeEvent[], event: RuntimeEvent): RuntimeEvent[] {
  return [event, ...previous].slice(0, MAX_RUNTIME_EVENTS);
}

export function describeDiagnosticValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function describeWindow(observation: PpgWindowObservation): string {
  if (observation.outcome.kind === "accepted") {
    return `accepted ${observation.sampleCount} samples; contact quality ${observation.contactQualityMean ?? "unknown"}`;
  }
  if (observation.outcome.kind === "rejectedStaleOrOutOfOrder") {
    return `rejected stale/out-of-order (last ${describeDiagnosticValue(observation.outcome.lastTimestampNs)})`;
  }
  return `rejected by quality gate: ${describeDiagnosticValue(observation.outcome)}`;
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/** Mirrors the bounded offline replay report shape produced by
 * tools/pinch-classifier/src/pinch_classifier/replay.py and returned as-is by the
 * `replay_model_dataset` Tauri command. */
export interface ReplayOutcome {
  index: number;
  session_id: string;
  timestamp_ns: number;
  expected: string;
  predicted: string;
  matched: boolean;
  confidence: number;
}

export interface ReplayReport {
  model_sha256: string;
  window_count: number;
  matched_count: number;
  accuracy: number;
  predicted_counts: Record<string, number>;
  outcomes: ReplayOutcome[];
  outcomes_truncated: boolean;
}

/** This is a local development runner, not a packaged app feature: the desktop app shells
 * out to `uv run --project tools/pinch-classifier pinch-classifier-train`, so training only
 * works from a full repository checkout with uv (https://docs.astral.sh/uv/) on PATH. */
export const DEV_RUNNER_NOTICE =
  "Training runs through a local development runner: the desktop app shells out to " +
  "`uv run --project tools/pinch-classifier pinch-classifier-train`. It only works from a full " +
  "repository checkout with uv (https://docs.astral.sh/uv/) installed and on PATH.";
