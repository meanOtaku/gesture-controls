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
