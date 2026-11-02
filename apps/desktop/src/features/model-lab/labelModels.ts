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

export const MODE_OPTIONS: ReadonlyArray<{ value: LabelRuntimeMode; label: string; summary: string }> = [
  { value: "off", label: "Off", summary: "No model runs." },
  { value: "monitor", label: "Monitor", summary: "Models run and their scores show here, but nothing acts on them." },
  { value: "live", label: "Live", summary: "Detections from active models can start recipes that use a model label." },
];

export type ModelAction =
  | { kind: "state"; to: "evaluated" | "approved" | "archived" | "draft"; label: string }
  | { kind: "activate"; label: string }
  | { kind: "deactivate"; label: string };

/** What a person can do next with a model in each state. Becoming active is only ever through activation. */
export function actionsFor(model: Pick<LabelModel, "state" | "deployable" | "monitorOnly">): ModelAction[] {
  switch (model.state) {
    case "draft":
      return [{ kind: "state", to: "evaluated", label: "Mark as evaluated" }];
    case "evaluated":
      return [
        ...(model.deployable || model.monitorOnly ? [{ kind: "state", to: "approved", label: model.deployable ? "Approve" : "Approve for Monitor" } as const] : []),
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
  for (const model of newestFirst(models)) groups.set(model.label, [...(groups.get(model.label) ?? []), model]);
  return [...groups.entries()].map(([label, list]) => ({ label, models: list }));
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
