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
}
