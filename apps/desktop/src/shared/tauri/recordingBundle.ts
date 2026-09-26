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
  /** Informational only: true for a recording imported via `import_recording_from_raw_csv`. Every bundle, imported or manually captured, is equally deletable via `deleteRecordingBundle`. */
  isImported: boolean;
};

/** Mirrors `recording_bundle::RecordingBundleDetail`: metadata plus annotations, no raw CSV. */
export type RecordingBundleDetail = {
  recording: RecordingMetadataPayload;
  annotations: AnnotationsFilePayload;
};

export type RecordingBundleResult<T> = { status: "ok"; value: T } | { status: "error"; message: string };

/**
 * Mirrors `recording_bundle::RAW_WINDOW_ALLOWED_COLUMNS` exactly: the subset
 * of raw.csv columns selectable as a raw-image-viewer channel. `timestamp_ns`
 * and `sequence` are excluded since they are exposed separately on every
 * window response, not as selectable channels.
 */
export const RAW_IMAGE_VIEWER_CHANNELS = [
  "ppg_green",
  "ppg_red",
  "ppg_ir",
  "accel_x",
  "accel_y",
  "accel_z",
  "gyro_x",
  "gyro_y",
  "gyro_z",
  "quat_w",
  "quat_x",
  "quat_y",
  "quat_z",
  "contact_quality",
] as const;

export type RawImageViewerChannel = (typeof RAW_IMAGE_VIEWER_CHANNELS)[number];

/** Mirrors `recording_bundle::RAW_GRID_SIZES`: the only square grid sizes the UI offers. */
export const RAW_GRID_SIZES = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64] as const;
export type RawGridSize = (typeof RAW_GRID_SIZES)[number];
/** Mirrors `recording_bundle::DEFAULT_RAW_GRID_SIZE`. */
export const DEFAULT_RAW_GRID_SIZE: RawGridSize = 64;
/** Mirrors `recording_bundle::RAW_WINDOW_MAX_VALUES`: the absolute upper bound (64x64) across every allowed grid size. */
export const RAW_WINDOW_MAX_VALUES = 4096;

/** For grid size N, the window is N*N values and the hop is N raw rows (one displayed grid row). */
export function rawWindowMaxValues(gridSize: RawGridSize): number {
  return gridSize * gridSize;
}
export function rawWindowRowHop(gridSize: RawGridSize): number {
  return gridSize;
}

export type RawRecordingWindowRequest = {
  recordingId: string;
  column: RawImageViewerChannel;
  startRawRow: number;
  gridSize: RawGridSize;
};

/** Mirrors `recording_bundle::RawRecordingWindow` field-for-field. */
export type RawRecordingWindow = {
  recordingId: string;
  column: string;
  gridSize: RawGridSize;
  totalRawRowCount: number;
  startRawRow: number;
  endRawRow: number;
  rowIndices: number[];
  timestampsNs: number[];
  values: (number | null)[];
  channelAvailable: boolean;
  recordingMin: number | null;
  recordingMax: number | null;
};

export type TimestampStatus = "ok" | "warning" | "insufficient_data";

/**
 * Mirrors `recording_bundle::RecordingQualitySummary` field-for-field:
 * derived-only, never persisted, and never a basis for rewriting either
 * `raw.csv` or `annotations.json`.
 */
export type RecordingQualitySummary = {
  recordingId: string;
  rowCount: number;
  timeSpanMs: number;
  timestampStatus: TimestampStatus;
  nonMonotonicRowCount: number;
  effectiveSampleRateHz: number | null;
  missingValueCounts: Record<string, number>;
  missingChannels: string[];
  intervalCount: number;
  labeledRowCount: number;
  unlabeledRowCount: number;
  shortLabelIntervalIds: string[];
  shortLabelThresholdMs: number;
  warnings: string[];
};

/** Mirrors `recording_bundle::DerivativeFilterConfig`: the fixed, versioned M2 filter contract. */
export type DerivativeFilterConfig = {
  method: string;
  polynomialOrder: number;
  windowSize: number;
  version: string;
};

/**
 * Mirrors `recording_bundle::RawRecordingDerivativeWindow` field-for-field.
 * This is an **offline, saved-data** analysis of the selected channel — a
 * signed rate-of-change (Savitzky–Golay first derivative with respect to
 * time, not row-to-row differencing) — computed fresh on every call. It is
 * never a live/Watch signal, never a training transformation, and never
 * written back into `raw.csv` or any other bundle file.
 */
export type RawRecordingDerivativeWindow = {
  recordingId: string;
  column: string;
  gridSize: RawGridSize;
  totalRawRowCount: number;
  startRawRow: number;
  endRawRow: number;
  rowIndices: number[];
  timestampsNs: number[];
  /** One entry per `rowIndices` entry; `null` where that specific row has no derivative (window-edge or a missing/nonfinite value in its local window), independent of `available`. */
  derivativeValues: (number | null)[];
  /** False when the whole recording's timestamp cadence failed the M2 regularity check; every `derivativeValues` entry is then `null` and `unavailableReason` explains why. */
  available: boolean;
  unavailableReason: string | null;
  effectiveSampleRateHz: number | null;
  filterConfig: DerivativeFilterConfig;
  /** `"time"` (default) or `"sample_order"` (GC-032 opt-in legacy preview). */
  mode: "time" | "sample_order";
  /** `"per_second"` in `"time"` mode, `"per_sample"` in `"sample_order"` mode — the two are not comparable. */
  units: "per_second" | "per_sample";
  /** Only meaningful in `"time"` mode: true when unavailable solely because of a timestamp/cadence irregularity (not too few rows) — exactly when the sample-order preview fallback may be offered. */
  unavailableIsCadenceIssue: boolean;
  /** Maximum absolute finite derivative value over the entire selected recording/channel (not just this sliced display window) — the fixed, zero-centred scale `"recording"`-mode normalization uses. `null` when unavailable or no derivative could be computed anywhere. */
  recordingMaxAbsDerivative: number | null;
};

/**
 * Mirrors `recording_bundle::CompactObservationWindow` field-for-field: a
 * bounded window of one channel's own **observed** (finite, present) samples
 * only, ordered by source row/timestamp — never a raw-row window. Pixel `i`
 * is compact sample `startSampleIndex + i`, not raw row `startSampleIndex +
 * i`, so `sourceRawRowIndices[i]`/`timestampsNs[i]` must be used to recover
 * where sample `i` actually came from. `values` is never null: an
 * absent/non-finite source field is filtered out server-side and never
 * appears here as a fabricated or placeholder entry. This is a read-only
 * visual-inspection view; it never writes `raw.csv` or any other bundle file
 * and is independent of `RawRecordingWindow`'s null-preserving raw-row
 * contract.
 */
export type RawRecordingCompactWindow = {
  recordingId: string;
  column: string;
  gridSize: RawGridSize;
  totalObservedSampleCount: number;
  startSampleIndex: number;
  endSampleIndex: number;
  sourceRawRowIndices: number[];
  timestampsNs: number[];
  values: number[];
  /** The timestamp of the observed sample immediately before `startSampleIndex`
   * in this channel's own sample sequence, or `null` when `startSampleIndex`
   * is 0 (the very first observed sample of the whole recording has no
   * predecessor). Lets the viewer compute pixel 0's gap even though that
   * predecessor sample lies outside this bounded window. */
  precedingTimestampNs: number | null;
  recordingMin: number | null;
  recordingMax: number | null;
};

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

export type ImportRawCsvResult =
  | { status: "imported"; recordingId: string; rowCount: number }
  | { status: "error"; message: string };

/**
 * Imports a Timeline Capture `raw.csv` document (the app's exact
 * `RAW_CSV_HEADER` schema only — no arbitrary-CSV mapping) as a new,
 * immutable, read-only recording bundle via `import_recording_from_raw_csv`.
 * All recording metadata is generated server-side from the CSV; this only
 * ever sends the raw CSV text itself. The result has no annotations and is
 * not wired into training.
 */
export async function importRecordingFromRawCsv(csvText: string): Promise<ImportRawCsvResult> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  try {
    const summary = await invoke<{ recordingId: string; rawRowCount: number }>(
      "import_recording_from_raw_csv",
      { csvText },
    );
    return { status: "imported", recordingId: summary.recordingId, rowCount: summary.rawRowCount };
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
 * Permanently deletes one saved recording bundle through
 * `delete_recording_bundle` — manually captured and imported bundles alike.
 * The backend re-validates the id and loads the bundle from disk before
 * removing it; this is not enforced by the UI alone. There is no undo.
 */
export async function deleteRecordingBundle(recordingId: string): Promise<RecordingBundleResult<void>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(invoke<void>("delete_recording_bundle", { recordingId }));
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

/**
 * Fetches a bounded, read-only window of one numeric raw.csv column through
 * the dedicated `get_raw_recording_window` command. This is the only path
 * that reads raw sample data for inspection; it never writes any bundle file
 * and is otherwise unrelated to `save_recording_bundle`/annotation curation.
 */
export async function getRawRecordingWindow(
  request: RawRecordingWindowRequest,
): Promise<RecordingBundleResult<RawRecordingWindow>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(
    invoke<RawRecordingWindow>("get_raw_recording_window", {
      recordingId: request.recordingId,
      column: request.column,
      startRawRow: request.startRawRow,
      gridSize: request.gridSize,
    }),
  );
}

/** Request shape for `getCompactObservationWindow`: `startSampleIndex` names
 * an observed-sample-sequence position, never a raw row — kept as its own
 * type (distinct from `RawRecordingWindowRequest`) so the two navigation
 * units can never be mixed up at a call site. */
export type CompactObservationWindowRequest = {
  recordingId: string;
  column: RawImageViewerChannel;
  startSampleIndex: number;
  gridSize: RawGridSize;
};

/**
 * Fetches a bounded, read-only window of one channel's own observed (finite)
 * samples in source order through the dedicated `get_compact_observation_window`
 * command — the compact sample-order image viewer's only data path. Distinct
 * from `getRawRecordingWindow`: navigation here is in observed *sample*
 * positions, not raw rows, per the identical N-sample hop convention. Never
 * writes any bundle file.
 */
export async function getCompactObservationWindow(
  request: CompactObservationWindowRequest,
): Promise<RecordingBundleResult<RawRecordingCompactWindow>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(
    invoke<RawRecordingCompactWindow>("get_compact_observation_window", {
      recordingId: request.recordingId,
      column: request.column,
      startSampleIndex: request.startSampleIndex,
      gridSize: request.gridSize,
    }),
  );
}

/**
 * Fetches the offline Savitzky–Golay first-derivative window (M2) for one
 * numeric raw.csv column through `get_raw_recording_derivative_window`,
 * aligned row-for-row with `getRawRecordingWindow` for the same recording,
 * channel, grid size, and start row. This is a saved-data analysis view of
 * the selected channel's signed rate of change over time — never a live
 * signal, never used for inference or training, and never written into
 * `raw.csv` or any other bundle file. See `RawRecordingDerivativeWindow`'s
 * docs for the per-row/whole-recording availability contract.
 *
 * `previewBySampleOrder` (GC-032, default `false`): an explicit, caller-opted-in
 * request for the legacy visual-preview fallback for recordings whose saved
 * timestamps are too irregular for the time-based derivative — the same
 * filter run in raw row/sample order, in "per sample" (not "per second")
 * units. Callers must only pass `true` once a prior `false`-mode response
 * came back with `unavailableIsCadenceIssue: true`; this function never
 * enables it on its own, and the result must never be used for model
 * training, export, or inference.
 */
export async function getRawRecordingDerivativeWindow(
  request: RawRecordingWindowRequest,
  previewBySampleOrder = false,
): Promise<RecordingBundleResult<RawRecordingDerivativeWindow>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(
    invoke<RawRecordingDerivativeWindow>("get_raw_recording_derivative_window", {
      recordingId: request.recordingId,
      column: request.column,
      startRawRow: request.startRawRow,
      gridSize: request.gridSize,
      previewBySampleOrder,
    }),
  );
}

/**
 * Fetches a derived-only recording/collection quality summary (M1) through
 * `get_recording_quality_summary`: row count, timestamp monotonicity and
 * effective sample rate, per-channel missing values, and label
 * coverage/short-label warnings. Never writes any bundle file.
 */
export async function getRecordingQualitySummary(
  recordingId: string,
): Promise<RecordingBundleResult<RecordingQualitySummary>> {
  if (!isTauriDesktop()) {
    return { status: "error", message: "Recording bundle persistence requires the desktop app" };
  }
  return toResult(invoke<RecordingQualitySummary>("get_recording_quality_summary", { recordingId }));
}
