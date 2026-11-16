import type { DatasetLabel } from "../model-lab/types";

/**
 * Gestures and their phases (`label_registry::Phase`). A held gesture (pinch, fist) has a label for the moment it starts
 * (`pinch_in`), one while it is held (`pinch_hold`) and one for the moment it ends (`pinch_out`), each a label of its own
 * with the gesture as its parent; a momentary gesture (a tap, a flick) has none, its own label its start. The ids stay
 * flat, so recordings, models and recipes keep using them as they are: the structure is only which belongs to which.
 */
export type Phase = "start" | "hold" | "end";
export const PHASES: readonly Phase[] = ["start", "hold", "end"];
export const PHASE_NAMES: Record<Phase, string> = { start: "start", hold: "hold", end: "end" };

export interface GestureGroup {
  gesture: DatasetLabel;
  /** Its phases' labels, those it has. */
  phases: Partial<Record<Phase, DatasetLabel>>;
}

type Labelled = Pick<DatasetLabel, "id" | "role" | "archivedAt"> & Partial<Pick<DatasetLabel, "standard" | "parent" | "phase">>;

/** Whether a label is a gesture of its own (not a phase, not standard, a gesture's role). */
export function isGesture(label: Labelled): boolean {
  return label.role === "positiveGesture" && !label.standard && !label.parent;
}

/** Every gesture that is not archived, with the phases it has, in the catalogue's order. */
export function gestureGroups(labels: DatasetLabel[]): GestureGroup[] {
  return labels
    .filter((label) => label.archivedAt === null && isGesture(label))
    .map((gesture) => ({
      gesture,
      phases: Object.fromEntries(
        labels.filter((label) => label.parent === gesture.id && label.phase && label.archivedAt === null).map((label) => [label.phase, label]),
      ) as Partial<Record<Phase, DatasetLabel>>,
    }));
}

/** Whether a gesture is held: it has a start and an end phase. */
export function isHeld(group: GestureGroup): boolean {
  return group.phases.start !== undefined && group.phases.end !== undefined;
}

/** The labels a recording of the gesture carries: its phases in order (start, hold, end), or the gesture itself. */
export function recordedLabels(group: GestureGroup): string[] {
  const phases = PHASES.map((phase) => group.phases[phase]?.id).filter((id): id is string => id !== undefined);
  return phases.length > 0 ? phases : [group.gesture.id];
}

/** The gesture a label belongs to: its parent for a phase, else itself. */
export function gestureOf(labels: Pick<DatasetLabel, "id" | "parent">[], id: string): string {
  return labels.find((label) => label.id === id)?.parent ?? id;
}

/**
 * The labels in tree order: each gesture followed by its phases (start, hold, end), then everything else, each with how
 * deep it sits. Phases whose gesture is not in `labels` stay where they are, at the top level.
 */
export function inTreeOrder<T extends Pick<DatasetLabel, "id"> & Partial<Pick<DatasetLabel, "parent" | "phase">>>(labels: T[]): { label: T; depth: number }[] {
  const ids = new Set(labels.map((label) => label.id));
  const childrenOf = (id: string) =>
    labels
      .filter((label) => label.parent === id)
      .sort((a, b) => PHASES.indexOf(a.phase as Phase) - PHASES.indexOf(b.phase as Phase));
  const out: { label: T; depth: number }[] = [];
  for (const label of labels) {
    if (label.parent && ids.has(label.parent)) continue;
    out.push({ label, depth: 0 });
    for (const child of childrenOf(label.id)) out.push({ label: child, depth: 1 });
  }
  return out;
}
