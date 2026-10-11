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
  /** Where it came in the order recordings were imported (1 is the first); no gaps, so a delete moves the later ones up. */
  sequence?: number;
  /** Stored as a folder of two dense files (`ppg.csv` and `imu.csv`) rather than one file with blank cells. */
  twoFiles?: boolean;
  /** How dense each stream is: where it went quiet and for how long (see `dataset_files.rs`). */
  gaps?: DatasetGaps;
  /** The Recorder recording this was added from, if it was added directly. */
  sourceRecordingId?: string;
}

/** How dense one stream of a recording is. */
export interface StreamGaps {
  samples: number;
  durationS: number;
  /** Samples per second over the stretches without a gap. */
  rateHz: number;
  /** How many times it went quiet for longer than a quarter of a second. */
  gaps: number;
  longestGapS: number;
  /** The share of the recording spent in those gaps, 0 to 1. */
  shareInGaps: number;
}
export interface DatasetGaps {
  ppg: StreamGaps;
  imu: StreamGaps;
}

/** A stream that spent more than this share of the recording silent is worth a warning. */
export const STALL_WARNING_SHARE = 0.1;

/** One line about a recording's stalls, and whether it is bad enough to warn about; null when it has no gap report. */
export function describeGaps(gaps: DatasetGaps | undefined): { text: string; warn: boolean } | null {
  if (!gaps) return null;
  const part = (name: string, s: StreamGaps) =>
    s.gaps === 0 ? `${name} steady at ${s.rateHz.toFixed(0)} Hz` : `${name}: ${s.gaps} stall${s.gaps === 1 ? "" : "s"}, longest ${s.longestGapS.toFixed(1)} s, ${Math.round(s.shareInGaps * 100)}% of the time`;
  return { text: `${part("pulse", gaps.ppg)} · ${part("motion", gaps.imu)}`, warn: Math.max(gaps.ppg.shareInGaps, gaps.imu.shareInGaps) > STALL_WARNING_SHARE };
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
