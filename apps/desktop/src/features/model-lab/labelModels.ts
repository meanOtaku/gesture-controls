/** The per-label model runtime and registry, as the desktop reports them (see `label_runtime.rs`). */

export type LabelModelState = "draft" | "evaluated" | "approved" | "active" | "archived";
export type LabelRuntimeMode = "off" | "monitor" | "live";

export interface LabelModel {
  id: string;
  label: string;
  /** The name the user gave it; shown in place of the id. */
  name?: string | null;
  state: LabelModelState;
  deployable: boolean;
  /** It did not pass the checks for going live: it can be approved and activated, but it only ever reports (Monitor). */
  monitorOnly?: boolean;
  imported: boolean;
  modelSha256: string | null;
  createdAt: string;
  active: boolean;
  /** The score a detection starts at. */
  activation?: number;
  /** The score a detection ends at. */
  release?: number;
  /** Each change of its thresholds since it was made, oldest first. */
  thresholdChanges?: ThresholdChange[];
  /** How it did on its held-out recordings, from its manifest; null when the manifest says nothing. */
  evaluation?: ModelEvaluation | null;
  /** For a model trained as a multi-gesture network: every gesture it learnt. */
  gestures?: string[];
  /** A multi-gesture model's outputs (one model, an output per gesture), its own first; absent for one gesture. */
  outputs?: ModelOutputView[];
}

/** Mirrors `model_lab_core::ThresholdChange`. */
export interface ThresholdChange {
  fromActivation: number;
  fromRelease: number;
  toActivation: number;
  toRelease: number;
  at: string;
  /** For a multi-gesture model: the output (gesture) whose thresholds changed. */
  output?: string | null;
  /** How it did at the new threshold, when the Threshold card measured it as it was set. */
  figures?: { recall: number | null; falseActivationsPerHour: number | null; recordings: number } | null;
}

/** Mirrors `ModelEvaluationView` in `label_runtime.rs`. */
/** Mirrors `ModelOutputView` in `label_runtime.rs`: one output of a multi-gesture model. */
export interface ModelOutputView {
  label: string;
  activation: number;
  release: number;
  /** It is its gesture's active model now. */
  active: boolean;
  evaluation: ModelEvaluation | null;
}

export interface ModelEvaluation {
  /** The share of gesture starts it caught, 0 to 1. */
  recall: number | null;
  falseActivationsPerHour: number | null;
  /** The threshold they were measured at. */
  atThreshold?: number | null;
  /** `training`: from training, at the threshold it chose; `thresholdCard`: replayed at the threshold set on the Threshold card. */
  measured?: "training" | "thresholdCard";
}

/** The longest name a model may be given (the registry's `MAX_MODEL_NAME_CHARS`). */
export const MAX_MODEL_NAME = 60;

/** A moment as this computer's local time, day first with a 12-hour clock: "02/11/2026 07:36 PM". Text that is not a
 * date is returned as it is. */
export function formatTime(iso: string): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  const hour = at.getHours() % 12 || 12;
  return `${two(at.getDate())}/${two(at.getMonth() + 1)}/${at.getFullYear()} ${two(hour)}:${two(at.getMinutes())} ${at.getHours() < 12 ? "AM" : "PM"}`;
}

/** The models, the most recently added first. */
export function newestFirst<T extends Pick<LabelModel, "createdAt">>(models: T[]): T[] {
  return [...models].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.createdAt.localeCompare(a.createdAt));
}

/** What to call a model: the name the user gave it, or else its id. */
export function modelName(model: Pick<LabelModel, "id" | "name">): string {
  return model.name?.trim() || model.id;
}

export interface LabelRuntimeStatus {
  mode: LabelRuntimeMode;
  loadedLabels: string[];
  loadFailures: { label: string; version: string; detail: string }[];
  quarantined: { id: string; diagnostic: string }[];
  registryError: string | null;
  activeDetections: string[];
  lastScores: Record<string, number>;
  /** Models being given inputs far outside what they were trained on (absent from an older desktop). */
  inputWarnings?: InputWarning[];
}

/** One model whose live inputs are unlike its training ones (see `InputWarningView` in label_runtime.rs). */
export interface InputWarning {
  label: string;
  modelId: string;
  /** The share of the last few seconds' windows that were unfamiliar, 0 to 1. */
  unfamiliarShare: number;
  worst: { name: string; value: number; low: number; high: number }[];
}

export interface ImportedLabelModel {
  id: string;
  label: string;
  modelSha256: string;
  projectCreated: boolean;
}

/** What a model being compared beside the active ones detects (see `ShadowReport` in label_runtime.rs). */
export const LABEL_SHADOW_EVENT = "label-shadow-detections";
export interface ShadowReport {
  modelId: string;
  label: string;
  events: DetectionReport["events"];
}

export const LABEL_MODELS_EVENT = "label-models-changed";

/** The figures shown beside a model: its threshold and, when its manifest has them, its held-out results. */
export function modelStats(model: Pick<LabelModel, "activation" | "evaluation">): { term: string; value: string; note?: string }[] {
  const facts: { term: string; value: string; note?: string }[] = [];
  if (model.activation != null) facts.push({ term: "Threshold", value: model.activation.toFixed(2) });
  const at = model.evaluation?.atThreshold;
  // Figures measured at another threshold than the one it runs at say which, so they are not taken for its own.
  const elsewhere = at != null && model.activation != null && Math.abs(at - model.activation) > 1e-9;
  // Said on a line of its own under the figure, so the columns stay the same width for every model.
  const note = elsewhere ? `at ${at.toFixed(2)}${model.evaluation?.measured === "training" ? ", when trained" : ""}` : undefined;
  if (model.evaluation?.recall != null) facts.push({ term: "Held-out recall", value: `${Math.round(model.evaluation.recall * 100)}%`, ...(note ? { note } : {}) });
  const perHour = model.evaluation?.falseActivationsPerHour;
  if (perHour != null) facts.push({ term: "False / hour", value: perHour.toFixed(perHour < 10 ? 1 : 0), ...(note ? { note } : {}) });
  return facts;
}

/** One line on what the runtime is doing with the models it has: which labels it scores and whether anything acts. */
export function runtimeSummary(mode: LabelRuntimeMode, groups: { label: string; models: Pick<LabelModel, "active">[] }[]): string {
  const total = groups.length;
  const running = groups.filter((group) => group.models.some((model) => model.active)).length;
  if (mode === "off") return "No model runs.";
  if (total === 0) return "No label models yet.";
  if (running === 0) return `No label has an active model, so nothing is scored${mode === "live" ? " and nothing can act" : ""}.`;
  const scoring = `Scoring ${running} of ${total} label${total === 1 ? "" : "s"}.`;
  return mode === "live" ? `${scoring} Their detections can start recipes.` : `${scoring} Nothing acts on them.`;
}

export const MODE_OPTIONS: ReadonlyArray<{ value: LabelRuntimeMode; label: string; summary: string }> = [
  { value: "off", label: "Off", summary: "No model runs." },
  { value: "monitor", label: "Monitor", summary: "Models run and their scores show here, but nothing acts on them." },
  { value: "live", label: "Live", summary: "Detections from active models can start recipes that use a model label." },
];

export type ModelAction =
  | { kind: "state"; to: "evaluated" | "approved" | "archived" | "draft"; label: string }
  /** `via`: the lifecycle steps taken first, in order, so one click goes from Draft or Evaluated to Active. */
  | { kind: "activate"; label: string; via?: readonly ("evaluated" | "approved")[] }
  | { kind: "deactivate"; label: string };

/**
 * What a person can do next with a model in each state, the first being its next step. Becoming active is only ever
 * through activation, and the registry still records every step (evaluated, approved, active). A model trained here
 * (already tested on recordings it never saw) and any evaluated one that may be approved offer Activate at once, taking
 * those steps in one go; the single steps stay behind it. An imported draft is walked through one step at a time.
 */
export function actionsFor(model: Pick<LabelModel, "state" | "deployable" | "monitorOnly"> & { imported?: boolean }): ModelAction[] {
  const approvable = model.deployable || model.monitorOnly;
  const activateLabel = model.deployable ? "Activate" : "Activate for Monitor";
  switch (model.state) {
    case "draft":
      return [
        ...(approvable && model.imported === false ? [{ kind: "activate", label: activateLabel, via: ["evaluated", "approved"] } as const] : []),
        { kind: "state", to: "evaluated", label: "Mark as evaluated" },
      ];
    case "evaluated":
      return [
        ...(approvable ? [{ kind: "activate", label: activateLabel, via: ["approved"] } as const] : []),
        ...(approvable ? [{ kind: "state", to: "approved", label: model.deployable ? "Approve" : "Approve for Monitor" } as const] : []),
        { kind: "state", to: "archived", label: "Archive" },
      ];
    case "approved":
      return [
        { kind: "activate", label: "Activate" },
        { kind: "state", to: "evaluated", label: "Back to evaluated" },
        { kind: "state", to: "archived", label: "Archive" },
      ];
    case "active":
      return [{ kind: "deactivate", label: "Deactivate" }];
    case "archived":
      return [{ kind: "state", to: "draft", label: "Restore as draft" }];
  }
}

/** Models grouped by label, labels in order, newest model first within each. */
/** The models by label, newest first: the label with the most recently added model leads, and each label's models go
 * from newest to oldest. */
export function groupByLabel(models: LabelModel[]): { label: string; models: LabelModel[] }[] {
  const groups = new Map<string, LabelModel[]>();
  // A multi-gesture model is listed on its own (`multiGestureNetworks`), not under one of its gestures.
  for (const model of newestFirst(models)) {
    if ((model.outputs?.length ?? 0) > 1) continue;
    groups.set(model.label, [...(groups.get(model.label) ?? []), model]);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, models: list }));
}

/**
 * The multi-gesture networks among `models`: each gesture's models of one network (the same model file), in the order
 * the network learnt them, newest network first. Archived models are left out.
 */
export function multiGestureNetworks(models: LabelModel[]): { key: string; gestures: string[]; createdAt: string; models: LabelModel[] }[] {
  const networks = new Map<string, LabelModel[]>();
  for (const model of models) {
    // Copies registered one per gesture, as runs did before a multi-gesture model was one model.
    if ((model.gestures?.length ?? 0) < 2 || (model.outputs?.length ?? 0) > 1 || model.state === "archived") continue;
    const key = model.modelSha256 ?? `${model.gestures!.join(",")}:${model.id.split("-").at(-1)}`;
    networks.set(key, [...(networks.get(key) ?? []), model]);
  }
  return [...networks.entries()]
    .map(([key, members]) => {
      const gestures = members[0].gestures!;
      const ordered = [...members].sort((a, b) => gestures.indexOf(a.label) - gestures.indexOf(b.label));
      const createdAt = members.map((m) => m.createdAt).sort().at(-1) ?? "";
      return { key, gestures, createdAt, models: ordered };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const LABEL_DETECTIONS_EVENT = "label-detections";
export const HAND_STEADINESS_EVENT = "hand-steadiness";

/** Mirrors `HandSteadinessView` in `label_runtime.rs`: whether the hand is still right now, from the watch's motion. */
export interface HandSteadiness {
  state: "still" | "moving" | "unknown" | "offWrist";
  accelSpread: number | null;
  turning: number | null;
  tiltChangeDeg: number | null;
}

/** The badge for the hand's state: a gesture may only start while the hand was still just before it. */
export function describeSteadiness(steadiness: HandSteadiness | null): { text: string; variant: "default" | "secondary" | "outline" } {
  if (steadiness?.state === "still") return { text: "Hand still", variant: "default" };
  if (steadiness?.state === "moving") return { text: "Hand moving", variant: "secondary" };
  if (steadiness?.state === "offWrist") return { text: "Watch off wrist", variant: "outline" };
  return { text: "No motion data", variant: "outline" };
}

/** Whether a rejection is a start held back because the hand was moving (or could not be judged), not a skipped window. */
function isNotStill(reason: string): boolean {
  return reason.startsWith("the hand was not still") || reason.startsWith("no motion data to tell");
}

/** Mirrors `DetectionReport` in `label_runtime.rs`. */
export type DetectionEvent =
  | { kind: "rising" | "active"; label: string; confidence: number; timestampNs: number }
  | { kind: "falling"; label: string; timestampNs: number; reason: string };

export interface DetectionReport {
  events: DetectionEvent[];
  conflicts: string[][];
  rejections: string[];
}

export type ActivityTone = "detected" | "released" | "warning";

export interface ActivityEntry {
  id: number;
  tone: ActivityTone;
  text: string;
  /** How many identical entries in a row this stands for. */
  count: number;
}

export const MAX_ACTIVITY = 30;

/** Plain words for why a detection ended. */
export function describeReason(reason: string): string {
  if (reason === "scoreBelowRelease") return "ended normally";
  if (reason === "conflict") return "held off: it was detected together with a label it cannot coexist with";
  if (reason === "modelChanged") return "its model was changed";
  return reason.replace(/^(rejected|runtime): /, "stopped: ");
}

/** The lines worth showing for one report. Ongoing detections are left out: they repeat with every score. */
export function describeReport(report: DetectionReport): Omit<ActivityEntry, "id" | "count">[] {
  const lines: Omit<ActivityEntry, "id" | "count">[] = [];
  for (const event of report.events) {
    if (event.kind === "rising") {
      lines.push({ tone: "detected", text: `${event.label} detected (${Math.round(event.confidence * 100)}%)` });
    } else if (event.kind === "falling") {
      lines.push({ tone: event.reason === "scoreBelowRelease" ? "released" : "warning", text: `${event.label} released: ${describeReason(event.reason)}` });
    }
  }
  for (const labels of report.conflicts) {
    lines.push({ tone: "warning", text: `${labels.join(" and ")} were detected together, so both were held off` });
  }
  for (const rejection of report.rejections) {
    // Each is "label: reason" (`label_runtime.rs`).
    const split = rejection.indexOf(": ");
    const label = split > 0 ? rejection.slice(0, split) : "";
    const reason = split > 0 ? rejection.slice(split + 2) : rejection;
    lines.push({ tone: "warning", text: isNotStill(reason) ? `${label} not started: ${reason}` : `Skipped a window for ${rejection}` });
  }
  return lines;
}

/** Newest first, capped; an identical line repeating is counted rather than listed again. */
export function appendActivity(previous: ActivityEntry[], lines: Omit<ActivityEntry, "id" | "count">[], nextId: () => number): ActivityEntry[] {
  let list = previous;
  for (const line of lines) {
    const top = list[0];
    list = top && top.text === line.text && top.tone === line.tone
      ? [{ ...top, count: top.count + 1 }, ...list.slice(1)]
      : [{ ...line, id: nextId(), count: 1 }, ...list];
  }
  return list.slice(0, MAX_ACTIVITY);
}

const STATE_RANK: LabelModelState[] = ["active", "approved", "evaluated", "draft", "archived"];

/** The furthest-along model a label has, or null if it has none. */
export function bestState(models: Pick<LabelModel, "state">[]): LabelModelState | null {
  return STATE_RANK.find((state) => models.some((model) => model.state === state)) ?? null;
}

export const MAX_LABEL_CHARS = 48;

/** The id a label name turns into: lower case, anything else becomes `_`. Null when nothing usable is left. */
export function labelIdFromName(name: string): string | null {
  const slug = name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "").slice(0, MAX_LABEL_CHARS).replaceAll(/_+$/g, "");
  if (slug === "") return null;
  return /^[a-z]/.test(slug) ? slug : `l_${slug}`.slice(0, MAX_LABEL_CHARS);
}
