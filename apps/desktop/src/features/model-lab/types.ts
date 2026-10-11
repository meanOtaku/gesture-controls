/** What Model Lab knows about recorded sessions. The per-label model types are in `labelModels.ts`. */

/** Mirrors `DatasetSummary` in src-tauri/src/model_lab.rs (serde camelCase). */
export interface DatasetSummary {
  id: string;
  originalFilename: string;
  importedAt: string;
  /** Display text only; a multi-label (Timeline Capture) dataset joins its labels. Use `datasetLabels`. */
  label: string;
  /** Every distinct label on the dataset's rows. Empty or absent for a dataset imported before multi-label support. */
  labels?: string[];
  rowCount: number;
  /** Where it came in the order recordings were imported (1 is the first); never reused after a delete. */
  sequence?: number;
  /** The Recorder recording this was added from, if it was added directly. */
  sourceRecordingId?: string;
}

/** The labels a dataset trains on: what coverage and training-role checks apply to. */
export function datasetLabels(dataset: Pick<DatasetSummary, "label" | "labels">): string[] {
  return dataset.labels && dataset.labels.length > 0 ? dataset.labels : [dataset.label];
}

/** Mirrors `DatasetLabel` in src-tauri/src/label_registry.rs. */
export interface DatasetLabel {
  id: string;
  displayName: string;
  description: string;
  color: string;
  role: "positiveGesture" | "negativeBackground" | "calibrationOnly";
  archivedAt: string | null;
  /** What archiving this label everywhere switched off, for restoring it. */
  archiveLog?: { disabledRecipes: string[]; archivedModels: string[] } | null;
}

/** The recordings in the order they were imported: oldest first. Without a sequence they keep the order they came in. */
export function inImportOrder<T extends Pick<DatasetSummary, "sequence">>(datasets: T[]): T[] {
  return datasets
    .map((dataset, position) => ({ dataset, position }))
    .sort((a, b) => (a.dataset.sequence ?? a.position + 1) - (b.dataset.sequence ?? b.position + 1) || a.position - b.position)
    .map(({ dataset }) => dataset);
}

/** "#3": which recording this is in the order they were imported, or nothing when it has no number. */
export function recordingNumber(dataset: Pick<DatasetSummary, "sequence">): string {
  return dataset.sequence ? `#${dataset.sequence}` : "";
}
