/** The per-label model runtime and registry, as the desktop reports them (see `label_runtime.rs`). */

export type LabelModelState = "draft" | "evaluated" | "approved" | "active" | "archived";
export type LabelRuntimeMode = "off" | "monitor" | "live";

export interface LabelModel {
  id: string;
  label: string;
  state: LabelModelState;
  deployable: boolean;
  imported: boolean;
  modelSha256: string | null;
  createdAt: string;
  active: boolean;
}

export interface LabelRuntimeStatus {
  mode: LabelRuntimeMode;
  loadedLabels: string[];
  loadFailures: { label: string; version: string; detail: string }[];
  quarantined: { id: string; diagnostic: string }[];
  registryError: string | null;
  activeDetections: string[];
  lastScores: Record<string, number>;
}

export interface ImportedLabelModel {
  id: string;
  label: string;
  modelSha256: string;
  projectCreated: boolean;
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
export function actionsFor(model: Pick<LabelModel, "state" | "deployable">): ModelAction[] {
  switch (model.state) {
    case "draft":
      return [{ kind: "state", to: "evaluated", label: "Mark as evaluated" }];
    case "evaluated":
      return [
        ...(model.deployable ? [{ kind: "state", to: "approved", label: "Approve" } as const] : []),
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
export function groupByLabel(models: LabelModel[]): { label: string; models: LabelModel[] }[] {
  const groups = new Map<string, LabelModel[]>();
  for (const model of models) groups.set(model.label, [...(groups.get(model.label) ?? []), model]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => ({ label, models: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
}

export const LABEL_DETECTIONS_EVENT = "label-detections";

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
  for (const rejection of report.rejections) lines.push({ tone: "warning", text: `Skipped a window for ${rejection}` });
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
