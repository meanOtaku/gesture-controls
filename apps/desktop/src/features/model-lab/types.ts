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
  /** The recording this one is a new version of, when it was saved from the Labelling page. */
  derivedFrom?: string;
  /** How the session was recorded: the Recorder's session details (see `sessionContext.ts`). */
  context?: Record<string, string>;
  /** Kept for the final test: never trained on (see `sealed_test.rs`). */
  sealed?: boolean;
  /** What the recording holds: two with the same one hold the same data. */
  contentSha?: string;
  /** What to know about its data before training on it (see `dataset_files::Quality`). */
  quality?: DatasetQuality;
  /** Whether its labels were checked on the Labelling page; absent while nobody has. */
  review?: DatasetReview;
}

/** Mirrors `DatasetReview` in model_lab.rs. */
export interface DatasetReview {
  status: "reviewed" | "needs_work";
  note?: string;
  at: string;
}

export interface DatasetQuality {
  /** The share of pulse samples the sensor flagged, 0 to 1. */
  poorContactShare: number;
  /** Holds of each label that training uses. */
  holds: Record<string, number>;
  /** Holds too short for training (under 200 ms), which it ignores. */
  shortHolds: number;
}

/** A pulse sensor that flagged more than this share of its samples was not sitting well on the skin. */
export const POOR_CONTACT_WARNING = 0.1;

/** The quality of a recording in words, and whether any of it is worth a warning. */
export function describeQuality(quality: DatasetQuality | undefined): { text: string; warn: boolean } | null {
  if (!quality) return null;
  const parts = Object.entries(quality.holds).map(([label, count]) => `${count} ${label.replaceAll("_", " ")}`);
  if (parts.length === 0) parts.push("no hold long enough to train on");
  if (quality.shortHolds > 0) parts.push(`${quality.shortHolds} hold${quality.shortHolds === 1 ? "" : "s"} under 200 ms (ignored)`);
  const contact = quality.poorContactShare > 0 ? `pulse contact flagged on ${Math.round(quality.poorContactShare * 100)}% of samples` : "";
  if (contact) parts.push(contact);
  return { text: parts.join(" · "), warn: quality.poorContactShare > POOR_CONTACT_WARNING || quality.shortHolds > 0 || Object.keys(quality.holds).length === 0 };
}

/** The recordings that hold the same data as `dataset` (by `contentSha`), other than itself. */
export function sameDataAs(dataset: DatasetSummary, datasets: DatasetSummary[]): DatasetSummary[] {
  return dataset.contentSha ? datasets.filter((other) => other.id !== dataset.id && other.contentSha === dataset.contentSha) : [];
}

/** The day a recording was made ("2026-10-17"): from its name, as the Recorder names exports, else the day it was imported. */
export function recordingDay(dataset: Pick<DatasetSummary, "originalFilename" | "importedAt">): string {
  return /(\d{4}-\d{2}-\d{2})T\d{2}/.exec(dataset.originalFilename)?.[1] ?? dataset.importedAt.slice(0, 10);
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
