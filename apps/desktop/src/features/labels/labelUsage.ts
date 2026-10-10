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
}

export interface UsageSources {
  bundles: { recordingId: string; labelIds: string[] }[];
  datasets: DatasetSummary[];
  gestures: { id: string; name: string; labelId: string | null }[];
  models: Pick<LabelModel, "id" | "label" | "state">[];
  recipes: { id: string; name: string; stages: { kind: string; label?: string }[] }[];
}

export function usageOf(labelId: string, sources: UsageSources): LabelUsage {
  return {
    recordings: sources.bundles.filter((bundle) => bundle.labelIds.includes(labelId)).map((bundle) => ({ id: bundle.recordingId })),
    trainingRecordings: sources.datasets.filter((dataset) => datasetLabels(dataset).includes(labelId)).map((dataset) => ({ id: dataset.id, name: dataset.originalFilename })),
    gestures: sources.gestures.filter((gesture) => gesture.labelId === labelId).map(({ id, name }) => ({ id, name })),
    models: sources.models.filter((model) => model.label === labelId).map(({ id, state }) => ({ id, state })),
    recipes: sources.recipes.filter((recipe) => recipe.stages.some((stage) => stage.kind === "model" && stage.label === labelId)).map(({ id, name }) => ({ id, name })),
  };
}

export const usageCount = (usage: LabelUsage): number =>
  usage.recordings.length + usage.trainingRecordings.length + usage.gestures.length + usage.models.length + usage.recipes.length;
