import { invoke } from "@tauri-apps/api/core";

export type MonotonicWallClock = { monotonic_ns: number; wall_clock_at: string };
export type StopReason =
  | "timer_elapsed"
  | "manual_stop"
  | "source_unavailable"
  | "cancelled_before_first_sample";
export type RecordingSource = { source_id: string; configuration: Record<string, unknown> };

/** Mirrors `recording_bundle::RecordingMetadata` and the ADR's `recording.json` fixture field-for-field. */
export type RecordingMetadataPayload = {
  format_version: number;
  recording_id: string;
  requested_start_at: string;
  actual_start: MonotonicWallClock;
  actual_end: MonotonicWallClock;
  requested_duration_ms: number | null;
  actual_duration_ms: number;
  stop_reason: StopReason;
  sources: RecordingSource[];
  raw_row_count: number;
  raw_source_row_counts: Record<string, number>;
};

export type ResolvedBoundary = { raw_row: number; source_timestamp_ns: number };
export type CreationMechanism = "quick_capture" | "hotkey_hold" | "hotkey_toggle" | "timeline_edit";
export type CurationStatus = "unreviewed" | "approved" | "excluded";

/** Mirrors `recording_bundle::AnnotationInterval` and the ADR's `annotations.json` fixture. */
export type AnnotationInterval = {
  interval_id: string;
  label_id: string;
  requested_start_monotonic_ns: number;
  requested_end_monotonic_ns: number;
  resolved_start: ResolvedBoundary;
  resolved_end: ResolvedBoundary;
  resolution_rule_version: number;
  creation_mechanism: CreationMechanism;
  curation_status: CurationStatus;
  created_at: string;
  revision: number;
};

export type AnnotationsFilePayload = {
  format_version: number;
  recording_id: string;
  intervals: AnnotationInterval[];
};

export type RecordingBundlePayload = {
  rawCsv: string;
  recording: RecordingMetadataPayload;
  annotations: AnnotationsFilePayload;
};

export type SaveRecordingBundleResult =
  | { status: "saved"; recordingId: string; rowCount: number; intervalCount: number }
  | { status: "error"; message: string };

/** Mirrors `recording_bundle::RecordingBundleSummary`. */
export type RecordingBundleSummary = {
  recordingId: string;
  rawRowCount: number;
  intervalCount: number;
  actualDurationMs: number;
  stopReason: StopReason;
  labelIds: string[];
  unreviewedCount: number;
  approvedCount: number;
  excludedCount: number;
};

/** Mirrors `recording_bundle::RecordingBundleDetail`: metadata plus annotations, no raw CSV. */
export type RecordingBundleDetail = {
  recording: RecordingMetadataPayload;
  annotations: AnnotationsFilePayload;
};

export type RecordingBundleResult<T> = { status: "ok"; value: T } | { status: "error"; message: string };

function toResult<T>(promise: Promise<T>): Promise<RecordingBundleResult<T>> {
  return promise
    .then((value) => ({ status: "ok" as const, value }))
    .catch((error) => ({
      status: "error" as const,
      message: error instanceof Error ? error.message : String(error),
    }));
}

function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Persists an immutable recording bundle (raw.csv + recording.json +
 * annotations.json) through the native `save_recording_bundle` command. There
 * is no browser-preview fallback: without a Tauri runtime there is no app
 * data directory to write a bundle into, so this reports an error instead of
 * silently pretending to have saved.
 */
export async function saveRecordingBundle(payload: RecordingBundlePayload): Promise<SaveRecordingBundleResult> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  try {
    const summary = await invoke<{ recordingId: string; rawRowCount: number; intervalCount: number }>(
      "save_recording_bundle",
      { rawCsv: payload.rawCsv, recording: payload.recording, annotations: payload.annotations },
    );
    return {
      status: "saved",
      recordingId: summary.recordingId,
      rowCount: summary.rawRowCount,
      intervalCount: summary.intervalCount,
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Lists every saved recording bundle for curation review. */
export async function listRecordingBundles(): Promise<RecordingBundleResult<RecordingBundleSummary[]>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(invoke<RecordingBundleSummary[]>("list_recording_bundles"));
}

/** Loads one bundle's metadata and annotations (not its raw CSV) for curation review. */
export async function loadRecordingBundle(
  recordingId: string,
): Promise<RecordingBundleResult<RecordingBundleDetail>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(invoke<RecordingBundleDetail>("load_recording_bundle", { recordingId }));
}

/**
 * Sets one interval's curation status after a bundle has been saved. This
 * only rewrites `annotations.json`; raw sensor data is never touched.
 */
export async function setIntervalCurationStatus(
  recordingId: string,
  intervalId: string,
  curationStatus: CurationStatus,
): Promise<RecordingBundleResult<AnnotationInterval>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(
    invoke<AnnotationInterval>("set_interval_curation_status", {
      recordingId,
      intervalId,
      curationStatus,
    }),
  );
}
