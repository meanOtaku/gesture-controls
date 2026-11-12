import { invoke } from "@tauri-apps/api/core";

/** Sent whenever a miss is saved, by the app's buttons or by the key that works in any app. */
export const MISS_SAVED_EVENT = "miss-saved";
/** A miss marked by the key could not be saved; the payload says why. */
export const MISS_FAILED_EVENT = "miss-failed";

/** What was wrong: a gesture that did nothing, an action nobody asked for, or not said (the key). */
export type MissKind = "missed" | "falseActivation" | "unspecified";

export interface MissLabelSummary {
  label: string;
  activation: number | null;
  scores: number;
  peak: number | null;
  peakMsBeforeMark: number | null;
  detected: number;
  acted: number;
  rejections: Record<string, number>;
}

export interface MissStreamSummary {
  samples: number;
  seconds: number;
  gaps: number;
  longestGapMs: number;
}

export interface MissSaved {
  /** The recording it became, in Datasets under "Misses". */
  datasetId: string;
  name: string;
  kind: MissKind;
  summary: {
    motion: MissStreamSummary;
    pulse: MissStreamSummary;
    labels: MissLabelSummary[];
    /** What the models did in the saved seconds, in sentences. */
    lines: string[];
  };
}

/** Saves the last 45 seconds of the watch's signals, and what the models made of them, as a recording. */
export function markMiss(kind: MissKind, note?: string): Promise<MissSaved> {
  return invoke<MissSaved>("mark_miss", { kind, note: note ?? null });
}
