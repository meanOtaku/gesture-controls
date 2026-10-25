import { invoke } from "@tauri-apps/api/core";
import type { DatasetSummary } from "../model-lab/types";
import type { Span } from "./labellingModel";

/** What is open for labelling: a recording in Model Lab, or a dataset folder or CSV file on disk (`labelling.rs`). */
export type LabellingSource = { kind: "dataset"; id: string } | { kind: "file"; path: string };

export interface LabellingColumn {
  name: string;
  /** One value per row; null where the cell was blank. */
  values: (number | null)[];
}

/** One sensor's rows: when each was taken (ms after the recording's first sample) and its columns. */
export interface LabellingStream {
  timesMs: number[];
  columns: LabellingColumn[];
}

export interface LabellingRecording {
  name: string;
  source: LabellingSource;
  durationMs: number;
  /** The first sample's timestamp (watch clock, ns), the zero of every time here; a string, as it is too large to be exact. */
  originNs: string;
  ppg: LabellingStream;
  imu: LabellingStream;
  /** The spans of each label the recorder or camera gave. */
  labelIntervals: Span[];
  /** The spans of each hand label already in the files. */
  manualIntervals: Span[];
  /** How the session was recorded (the Recorder's session details), if the files say. */
  context?: Record<string, string>;
}

export type ExportTarget = { kind: "folder"; parent: string; name: string } | { kind: "csv"; path: string };

const toIntervals = (spans: Span[]) => spans.map(({ startMs, endMs, label }) => ({ startMs, endMs, label }));

export function openLabellingRecording(source: LabellingSource): Promise<LabellingRecording> {
  return invoke<LabellingRecording>("open_labelling_recording", { source });
}

/** Saves the hand labels as a new recording in Model Lab; the source is left as it was. */
export function saveLabellingVersion(source: LabellingSource, spans: Span[]): Promise<DatasetSummary> {
  return invoke<DatasetSummary>("save_labelling_version", { source, intervals: toIntervals(spans) });
}

/** Exports the recording with the hand labels; returns where it was written. */
export function exportLabellingRecording(source: LabellingSource, spans: Span[], target: ExportTarget): Promise<string> {
  return invoke<string>("export_labelling_recording", { source, intervals: toIntervals(spans), target });
}

/** One active model run over the recording as the app runs it live (`labelling.rs`). */
export interface ModelReplay {
  label: string;
  version: string;
  threshold: number;
  timesMs: number[];
  scores: number[];
  detections: Span[];
  rejections: string[];
  /** Where detections would start at other thresholds (the same scores through the same rule). */
  sweep?: { threshold: number; risesMs: number[] }[];
}

/** Runs every active model over the recording, in Monitor; read-only. */
export function replayActiveModels(source: LabellingSource): Promise<ModelReplay[]> {
  return invoke<ModelReplay[]>("labelling_model_replay", { source });
}
