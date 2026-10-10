import type { LabelModel } from "../model-lab/labelModels";
import { datasetLabels, type DatasetSummary } from "../model-lab/types";

/** Where a label is used, by tab, so the Labels tab can list it and jump there. */
export interface LabelUsage {
  /** Saved Recorder recordings with an interval of this label. */
  recordings: { id: string }[];
  /** Recordings in the training data that carry it. */
  trainingRecordings: { id: string; name: string }[];
  /** Gesture library gestures linked to it. */
  gestures: { id: string; name: string }[];
  /** Models trained for it. */
  models: { id: string; state: string }[];
  /** Recipes with a model step for it. */
  recipes: { id: string; name: string }[];
  /** The model registry's training history for it: projects, runs and sealed snapshots, which outlive a deleted model. */
  trainingHistory: { projects: number; runs: number; snapshots: number };
  /** Other labels whose training history refers to this one (as "not the gesture", say). */
  mentionedInTrainingOf: string[];
}

export interface RegistryUsage {
  projects: number;
  runs: number;
  snapshots: number;
  mappedIn: string[];
}

export interface UsageSources {
  bundles: { recordingId: string; labelIds: string[] }[];
  datasets: DatasetSummary[];
  gestures: { id: string; name: string; labelId: string | null }[];
  models: Pick<LabelModel, "id" | "label" | "state">[];
  /** What the model registry holds about each label, from the desktop. */
  registry?: Record<string, RegistryUsage>;
  recipes: { id: string; name: string; enabled?: boolean; stages: { kind: string; label?: string; gesture?: string }[] }[];
}

/** Recipes with a model step for the label, or a camera step for one of the label's gestures. */
export function recipesUsing(labelId: string, sources: Pick<UsageSources, "gestures" | "recipes">) {
  const gestureIds = new Set(sources.gestures.filter((gesture) => gesture.labelId === labelId).map((gesture) => gesture.id));
  return sources.recipes.filter((recipe) =>
    recipe.stages.some((stage) => (stage.kind === "model" && stage.label === labelId) || (stage.kind === "camera" && stage.gesture !== undefined && gestureIds.has(stage.gesture))),
  );
}

export function usageOf(labelId: string, sources: UsageSources): LabelUsage {
  return {
    recordings: sources.bundles.filter((bundle) => bundle.labelIds.includes(labelId)).map((bundle) => ({ id: bundle.recordingId })),
    trainingRecordings: sources.datasets.filter((dataset) => datasetLabels(dataset).includes(labelId)).map((dataset) => ({ id: dataset.id, name: dataset.originalFilename })),
    gestures: sources.gestures.filter((gesture) => gesture.labelId === labelId).map(({ id, name }) => ({ id, name })),
    models: sources.models.filter((model) => model.label === labelId).map(({ id, state }) => ({ id, state })),
    recipes: recipesUsing(labelId, sources).map(({ id, name }) => ({ id, name })),
    trainingHistory: { projects: sources.registry?.[labelId]?.projects ?? 0, runs: sources.registry?.[labelId]?.runs ?? 0, snapshots: sources.registry?.[labelId]?.snapshots ?? 0 },
    mentionedInTrainingOf: sources.registry?.[labelId]?.mappedIn ?? [],
  };
}

export const usageCount = (usage: LabelUsage): number =>
  usage.recordings.length + usage.trainingRecordings.length + usage.gestures.length + usage.models.length + usage.recipes.length + usage.trainingHistory.projects + usage.mentionedInTrainingOf.length;
