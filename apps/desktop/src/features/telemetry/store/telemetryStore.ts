import { quaternionToEulerDegrees } from "../../../shared/protocol/events";
import type {
  HeadPosePayload,
  HeadTrackerDiagnostic,
  HeadTrackerStatus,
  Quaternion,
  Vector3,
  WatchEdaBatch,
  WatchHeartRateBatch,
  WatchOrientationSample,
  WatchPpgBatch,
  WatchSkinTemperatureBatch,
  WatchStatus,
} from "../../../shared/protocol/events";
import type { RecordingBundlePayload, StopReason } from "../../../shared/tauri/recordingBundle";
import {
  hasOverlap,
  isDegenerate,
  splitInterval,
  toAnnotationInterval,
  type ClosedLiveInterval,
  type LiveInterval,
} from "../annotations/timeline";

export type SeriesPoint = { at: number; values: number[] };
export type CsvRow = {
  recordedAt: string;
  source: "headphone" | "watch";
  sourceTimestampNs: string;
  sequence: string;
  values: Record<string, number | null>;
};

/** Labels are user-owned stable slugs; no built-in templates. */
export type GestureDatasetLabel = string;

function normalizeDatasetLabel(label: string): GestureDatasetLabel | null {
  const normalized = label.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : null;
}

/** Captured once at `startDatasetRecording()` and never mutated by later label changes. */
export type DatasetRecordingState = "idle" | "arming" | "recording" | "saved" | "discarded";

/**
 * Quick Capture keeps the existing one-label-per-session behavior. Timeline
 * Capture shares the same recording engine/state machine but records zero or
 * more non-overlapping label intervals over one continuous raw stream,
 * leaving unlabeled stretches `unannotated` per the ADR.
 */
export type DatasetCaptureMode = "quick" | "timeline";

export type DatasetSessionMetadata = {
  label: GestureDatasetLabel;
  startedAtIso: string;
};

export type DatasetRow = {
  timestampNs: string;
  sequence: string;
  ppgGreen: number | null;
  ppgRed: number | null;
  ppgIr: number | null;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
  gyroX: number | null;
  gyroY: number | null;
  gyroZ: number | null;
  quatW: number | null;
  quatX: number | null;
  quatY: number | null;
  quatZ: number | null;
  contactQuality: number | null;
  label: GestureDatasetLabel;
};

export const DATASET_CSV_COLUMNS = [
  "timestamp_ns", "sequence", "ppg_green", "ppg_red", "ppg_ir",
  "accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z",
  "quat_w", "quat_x", "quat_y", "quat_z", "contact_quality", "label",
] as const;

/**
 * `raw.csv` columns for the immutable recording-bundle contract (see
 * `docs/decisions/2026-09-dataset-capture-recording-contract.md`): the same
 * fused sample shape as `DATASET_CSV_COLUMNS` minus `label`, since raw
 * capture evidence carries no label — labels live only in `annotations.json`.
 */
export const RAW_RECORDING_CSV_COLUMNS = DATASET_CSV_COLUMNS.filter((column) => column !== "label");

/** Resolution rule fixed by the ADR: start resolves to the first accepted sample, end to the last. */
const INTERVAL_RESOLUTION_RULE_VERSION = 1;
const RECORDING_BUNDLE_FORMAT_VERSION = 1;

function datasetCsvValue(value: number | null): string {
  return value == null ? "" : String(value);
}

export type TelemetrySeries =
  | "head"
  | "watchOrientation"
  | "ppg"
  | "heartRate"
  | "ibi"
  | "temperature"
  | "eda"
  | "spo2"
  | "ecg";

export const MAX_VISIBLE_SAMPLES = 600;
export const MAX_CSV_ROWS = 200_000;
export const ESTIMATED_BYTES_PER_CSV_ROW = 200;
const DEFAULT_PUBLISH_INTERVAL_MS = 66;
const DEFAULT_RECORDING_RATE_HZ = 30;

export const EMPTY_HEAD_STATUS: HeadTrackerStatus = {
  connected: false,
  device: null,
  quaternion: [1, 0, 0, 0],
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  gyroscope: null,
  packetsPerSecond: 0,
  receiveLatencyMs: -1,
  resetCounter: 0,
};

export const EMPTY_WATCH_STATUS: WatchStatus = {
  connected: false,
  lastOrientation: null,
  lastHeartbeat: null,
  clockOffsetNs: null,
  roundTripNs: null,
  ppgState: null,
  ppgLastSample: null,
  ppgRateHz: null,
  lastButtonState: null,
  medicalStatus: {},
  sensorStatus: {},
  heartRateLast: null,
  heartRateRateHz: null,
  skinTemperatureLast: null,
  skinTemperatureRateHz: null,
  edaLast: null,
  edaRateHz: null,
  spo2Last: null,
  ecgLast: null,
  biaLast: null,
  sweatLossLast: null,
};

class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.slots = new Array(capacity);
  }

  push(item: T): void {
    const index = (this.start + this.count) % this.capacity;
    this.slots[index] = item;
    if (this.count < this.capacity) this.count += 1;
    else this.start = (this.start + 1) % this.capacity;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  toArray(): T[] {
    const out = new Array<T>(this.count);
    for (let index = 0; index < this.count; index += 1) {
      out[index] = this.slots[(this.start + index) % this.capacity] as T;
    }
    return out;
  }

  get length(): number {
    return this.count;
  }
}

class TelemetryStore {
  private readonly listeners = new Set<() => void>();
  private readonly series = new Map<TelemetrySeries, RingBuffer<SeriesPoint>>(
    (["head", "watchOrientation", "ppg", "heartRate", "ibi", "temperature", "eda", "spo2", "ecg"] as const)
      .map((name) => [name, new RingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES)]),
  );
  private readonly rows = new RingBuffer<CsvRow>(MAX_CSV_ROWS);
  private version = 0;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private headStatus: HeadTrackerStatus | null = null;
  private headDiagnostic: HeadTrackerDiagnostic | null = null;
  private headTrackerProvider: "native" | "external" | null = null;
  private watchStatus: WatchStatus = EMPTY_WATCH_STATUS;
  private recording = false;
  private savedCount = 0;
  private lastWatchOrientationSequence: number | null = null;
  private lastSpo2TimestampNs: number | null = null;
  private lastEcgTimestampNs: number | null = null;
  // "Graph refresh rate" setting: how often listeners are notified, not a
  // data-loss gate — the series ring buffers still receive every accepted
  // sample immediately, independent of this timer.
  private publishIntervalMs = DEFAULT_PUBLISH_INTERVAL_MS;
  // "Recording rate" setting: an independent per-channel throttle on what
  // gets pushed into the CSV `rows` buffer, applied on top of `recording`.
  private recordingMinIntervalMs = 1000 / DEFAULT_RECORDING_RATE_HZ;
  private readonly lastRecordedAtByChannel = new Map<string, number>();
  private readonly healthAcceptanceMinIntervalMs = new Map<string, number>();
  private readonly lastAcceptedAtByChannel = new Map<string, number>();

  // Labeled gesture dataset recorder: independent of `recording`/`rows` above,
  // built on the same raw watch ingest path but fused into one row per
  // accepted sample, carrying forward the other channel's last known values.
  private selectedLabel: GestureDatasetLabel | null = null;
  private readonly sessionLabels = new Set<GestureDatasetLabel>();
  private datasetRecordingState: DatasetRecordingState = "idle";
  private datasetRecording = false;
  private datasetSession: DatasetSessionMetadata | null = null;
  private datasetRecordingStartedAtMs: number | null = null;
  // Recording-bundle timing: `requestedStartAtIso` is captured on Start
  // (Arming); the monotonic/wall-clock pair is captured on the first
  // accepted sample (actual_start) and again on stop (actual_end), per the
  // ADR's clock-domain rule. `performance.now()` (not `Date.now()`) backs the
  // monotonic field so it cannot be skewed by a wall-clock adjustment mid-session.
  private datasetRequestedStartAtIso: string | null = null;
  private datasetActualStartAtIso: string | null = null;
  private datasetActualStartMonotonicMs: number | null = null;
  private readonly datasetRows = new RingBuffer<DatasetRow>(MAX_CSV_ROWS);

  // Timeline Capture: live/edited intervals for the current session. Cleared
  // on start/discard, closed out on stop, and freely editable while
  // `datasetRecordingState === "saved"` (post-capture editing).
  private datasetCaptureMode: DatasetCaptureMode = "quick";
  private timelineIntervals: LiveInterval[] = [];
  private activeTimelineIntervalId: string | null = null;
  private lastKnownOrientationSample: { accel: Vector3 | null; gyro: Vector3 | null; quat: Quaternion | null } = {
    accel: null,
    gyro: null,
    quat: null,
  };
  private lastKnownPpgSample: { green: number | null; red: number | null; ir: number | null; contactQuality: number | null } = {
    green: null,
    red: null,
    ir: null,
    contactQuality: null,
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  getHeadStatus(): HeadTrackerStatus | null {
    return this.headStatus;
  }

  getHeadDiagnostic(): HeadTrackerDiagnostic | null {
    return this.headDiagnostic;
  }

  setHeadDiagnostic(diagnostic: HeadTrackerDiagnostic | null): void {
    this.headDiagnostic = diagnostic;
    this.schedulePublish();
  }

  getHeadTrackerProvider(): "native" | "external" | null {
    return this.headTrackerProvider;
  }

  setHeadTrackerProvider(provider: "native" | "external"): void {
    this.headTrackerProvider = provider;
    this.publishNow();
  }

  getWatchStatus(): WatchStatus {
    return this.watchStatus;
  }

  getSeries(name: TelemetrySeries): SeriesPoint[] {
    return this.series.get(name)?.toArray() ?? [];
  }

  getRecording(): boolean {
    return this.recording;
  }

  getRowCount(): number {
    return this.rows.length;
  }

  getSavedCount(): number {
    return this.savedCount;
  }

  getRows(): CsvRow[] {
    return this.rows.toArray();
  }

  setSavedCount(count: number): void {
    this.savedCount = count;
    this.publishNow();
  }

  toggleRecording(): void {
    if (!this.recording) {
      this.rows.clear();
      this.savedCount = 0;
      this.lastRecordedAtByChannel.clear();
    }
    this.recording = !this.recording;
    this.publishNow();
  }

  getSelectedLabel(): GestureDatasetLabel | null {
    return this.selectedLabel;
  }

  getSessionLabels(): GestureDatasetLabel[] {
    return Array.from(this.sessionLabels);
  }

  selectDatasetLabel(label: GestureDatasetLabel): boolean {
    const normalized = normalizeDatasetLabel(label);
    if (!normalized) return false;
    this.selectedLabel = normalized;
    this.sessionLabels.add(normalized);
    this.publishNow();
    return true;
  }

  /** Null when `label` can be safely removed; otherwise the reason it can't, for the dataset recorder UI to surface. */
  labelRemovalBlockedReason(label: GestureDatasetLabel): string | null {
    if (this.timelineIntervals.some((interval) => interval.labelId === label)) {
      return "Used by a timeline interval in this session — relabel or delete that interval first.";
    }
    return null;
  }

  /** Removes a previously used label, unless a timeline interval still references it (see `labelRemovalBlockedReason`). Clears the selected label if it was the one removed — always safe, since a referenced label is never removable and thus never reaches this point while active. */
  removeSessionLabel(label: GestureDatasetLabel): boolean {
    if (!this.sessionLabels.has(label) || this.labelRemovalBlockedReason(label) !== null) return false;
    this.sessionLabels.delete(label);
    if (this.selectedLabel === label) this.selectedLabel = null;
    this.publishNow();
    return true;
  }

  getDatasetRecordingState(): DatasetRecordingState {
    return this.datasetRecordingState;
  }

  getDatasetRecording(): boolean {
    return this.datasetRecording;
  }

  getDatasetSession(): DatasetSessionMetadata | null {
    return this.datasetSession;
  }

  getDatasetRecordingElapsedMs(): number {
    if (this.datasetRecordingStartedAtMs === null) return 0;
    return Date.now() - this.datasetRecordingStartedAtMs;
  }

  getDatasetRowCount(): number {
    return this.datasetRows.length;
  }

  getDatasetRows(): DatasetRow[] {
    return this.datasetRows.toArray();
  }

  getDatasetCaptureMode(): DatasetCaptureMode {
    return this.datasetCaptureMode;
  }

  /** Only changeable while idle: switching mode mid-session would leave a partially-labeled buffer in an ambiguous shape. */
  setDatasetCaptureMode(mode: DatasetCaptureMode): boolean {
    if (this.datasetRecording) return false;
    this.datasetCaptureMode = mode;
    this.publishNow();
    return true;
  }

  /** Snapshot of this session's intervals, live (still recording) or saved (ready for post-capture editing). */
  getTimelineIntervals(): LiveInterval[] {
    return [...this.timelineIntervals];
  }

  getActiveTimelineLabel(): GestureDatasetLabel | null {
    return this.timelineIntervals.find((interval) => interval.intervalId === this.activeTimelineIntervalId)
      ?.labelId ?? null;
  }

  /**
   * Starts a new session. Enters Arming state, waiting for the first
   * accepted sample. Quick Capture snapshots `selectedLabel` immutably for
   * the session's lifetime and requires one to be selected first; Timeline
   * Capture needs no upfront label — intervals are opened live via
   * `setTimelineLabel()` once recording starts.
   */
  startDatasetRecording(): boolean {
    if (this.datasetRecording) return false;
    if (this.datasetCaptureMode === "quick" && !this.selectedLabel) return false;
    this.datasetRows.clear();
    this.datasetSession = {
      label: this.datasetCaptureMode === "quick" ? (this.selectedLabel as GestureDatasetLabel) : "",
      startedAtIso: new Date().toISOString(),
    };
    this.datasetRecordingState = "arming";
    this.datasetRecording = true;
    this.datasetRecordingStartedAtMs = null;
    this.datasetRequestedStartAtIso = new Date().toISOString();
    this.datasetActualStartAtIso = null;
    this.datasetActualStartMonotonicMs = null;
    this.timelineIntervals = [];
    this.activeTimelineIntervalId = null;
    this.publishNow();
    return true;
  }

  /**
   * Timeline Capture only: opens a new label interval, first closing whichever
   * interval is currently active (so intervals never overlap). Passing `null`
   * closes the active interval without opening a new one, leaving a gap that
   * stays `unannotated`. Only valid while a timeline session is `recording`.
   * `mechanism` distinguishes hold-to-label from press-to-toggle for audit.
   */
  setTimelineLabel(label: GestureDatasetLabel | null, mechanism: "hotkey_hold" | "hotkey_toggle" = "hotkey_toggle"): boolean {
    if (this.datasetCaptureMode !== "timeline") return false;
    if (this.datasetRecordingState !== "recording") return false;
    const normalized = label === null ? null : normalizeDatasetLabel(label);
    if (label !== null && !normalized) return false;
    if (normalized !== null && normalized === this.getActiveTimelineLabel()) return true;

    const nowMonotonicNs = Math.round(performance.now() * 1_000_000);
    const nowIso = new Date().toISOString();
    const currentRowCount = this.datasetRows.length;
    this.closeActiveTimelineInterval(nowMonotonicNs, currentRowCount);

    if (normalized) {
      this.sessionLabels.add(normalized);
      const interval: LiveInterval = {
        intervalId: crypto.randomUUID(),
        labelId: normalized,
        startMonotonicNs: nowMonotonicNs,
        endMonotonicNs: null,
        startRawRow: currentRowCount,
        endRawRow: null,
        creationMechanism: mechanism,
        curationStatus: "unreviewed",
        createdAt: nowIso,
        revision: 1,
      };
      this.timelineIntervals.push(interval);
      this.activeTimelineIntervalId = interval.intervalId;
    }
    this.publishNow();
    return true;
  }

  /** Post-capture editing (only while `saved`): rename a label without moving boundaries. Bumps revision for audit. */
  relabelTimelineInterval(intervalId: string, label: GestureDatasetLabel): boolean {
    if (this.datasetRecordingState !== "saved") return false;
    const normalized = normalizeDatasetLabel(label);
    if (!normalized) return false;
    const interval = this.timelineIntervals.find((entry) => entry.intervalId === intervalId);
    if (!interval) return false;
    interval.labelId = normalized;
    interval.revision += 1;
    this.sessionLabels.add(normalized);
    this.publishNow();
    return true;
  }

  /** Post-capture editing: sets curation state (`unreviewed`/`approved`/`excluded`) without touching boundaries or raw data. */
  setTimelineIntervalCurationStatus(intervalId: string, status: "unreviewed" | "approved" | "excluded"): boolean {
    if (this.datasetRecordingState !== "saved") return false;
    const interval = this.timelineIntervals.find((entry) => entry.intervalId === intervalId);
    if (!interval) return false;
    interval.curationStatus = status;
    interval.revision += 1;
    this.publishNow();
    return true;
  }

  /**
   * Post-capture editing: moves one boundary of a closed interval to
   * `newRawRow`, rejecting the edit if it would create overlap with another
   * interval, invert the interval, or move outside the captured row range.
   */
  moveTimelineIntervalBoundary(intervalId: string, edge: "start" | "end", newRawRow: number): boolean {
    if (this.datasetRecordingState !== "saved") return false;
    const interval = this.timelineIntervals.find((entry) => entry.intervalId === intervalId);
    if (!interval || interval.endRawRow === null) return false;
    if (newRawRow < 0 || newRawRow > this.datasetRows.length) return false;

    const candidate: LiveInterval = edge === "start"
      ? { ...interval, startRawRow: newRawRow }
      : { ...interval, endRawRow: newRawRow };
    if (candidate.endRawRow === null || candidate.startRawRow >= candidate.endRawRow) return false;
    if (hasOverlap(candidate, this.timelineIntervals)) return false;

    interval.startRawRow = candidate.startRawRow;
    interval.endRawRow = candidate.endRawRow;
    interval.revision += 1;
    this.publishNow();
    return true;
  }

  /** Post-capture editing: splits a closed interval into two adjacent same-label intervals at `atRawRow`. */
  splitTimelineInterval(intervalId: string, atRawRow: number): boolean {
    if (this.datasetRecordingState !== "saved") return false;
    const index = this.timelineIntervals.findIndex((entry) => entry.intervalId === intervalId);
    if (index === -1) return false;
    const interval = this.timelineIntervals[index];
    if (interval.endRawRow === null) return false;
    const halves = splitInterval(interval as ClosedLiveInterval, atRawRow, crypto.randomUUID(), new Date().toISOString());
    if (!halves) return false;
    this.timelineIntervals.splice(index, 1, ...halves);
    this.publishNow();
    return true;
  }

  /**
   * Post-capture editing: fills a currently-unannotated gap with a new
   * interval. Rejects the request if it overlaps any existing interval or
   * falls outside the captured row range.
   */
  createTimelineInterval(label: GestureDatasetLabel, startRawRow: number, endRawRow: number): boolean {
    if (this.datasetRecordingState !== "saved") return false;
    const normalized = normalizeDatasetLabel(label);
    if (!normalized) return false;
    if (startRawRow < 0 || endRawRow > this.datasetRows.length || startRawRow >= endRawRow) return false;

    const candidate: LiveInterval = {
      intervalId: crypto.randomUUID(),
      labelId: normalized,
      startMonotonicNs: 0,
      endMonotonicNs: 0,
      startRawRow,
      endRawRow,
      creationMechanism: "timeline_edit",
      curationStatus: "unreviewed",
      createdAt: new Date().toISOString(),
      revision: 1,
    };
    if (hasOverlap(candidate, this.timelineIntervals)) return false;

    this.sessionLabels.add(normalized);
    this.timelineIntervals.push(candidate);
    this.publishNow();
    return true;
  }

  /** Post-capture editing: removes an interval entirely, returning its rows to `unannotated`. Raw data is untouched. */
  deleteTimelineInterval(intervalId: string): boolean {
    if (this.datasetRecordingState !== "saved") return false;
    const before = this.timelineIntervals.length;
    this.timelineIntervals = this.timelineIntervals.filter((entry) => entry.intervalId !== intervalId);
    if (this.timelineIntervals.length === before) return false;
    this.publishNow();
    return true;
  }

  /** Stops accepting new rows but keeps the buffered session so it can still be exported. Transitions to Saved state. */
  stopDatasetRecording(): void {
    if (!this.datasetRecording) return;
    if (this.datasetCaptureMode === "timeline") {
      this.closeActiveTimelineInterval(Math.round(performance.now() * 1_000_000), this.datasetRows.length);
    }
    this.datasetRecording = false;
    this.datasetRecordingState = "saved";
    this.publishNow();
  }

  /** Abandons the current session: stops recording and drops buffered rows/metadata. Transitions to Discarded state. */
  discardDatasetRecording(): void {
    this.datasetRecording = false;
    this.datasetRecordingState = "discarded";
    this.datasetSession = null;
    this.datasetRequestedStartAtIso = null;
    this.datasetActualStartAtIso = null;
    this.datasetActualStartMonotonicMs = null;
    this.datasetRows.clear();
    this.timelineIntervals = [];
    this.activeTimelineIntervalId = null;
    this.publishNow();
  }

  /** Renders the buffered labeled session as CSV text: leading `#` metadata comment lines, then the header, then rows. */
  generateDatasetCsv(): string {
    const session = this.datasetSession;
    const rows = this.datasetRows.toArray();
    const metadataLines = [
      "# gesture-dataset-export: 1",
      `# label: ${session?.label ?? ""}`,
      `# started_at: ${session?.startedAtIso ?? ""}`,
      `# row_count: ${rows.length}`,
    ];
    const dataLines = rows.map((row) => [
      row.timestampNs,
      row.sequence,
      datasetCsvValue(row.ppgGreen),
      datasetCsvValue(row.ppgRed),
      datasetCsvValue(row.ppgIr),
      datasetCsvValue(row.accelX),
      datasetCsvValue(row.accelY),
      datasetCsvValue(row.accelZ),
      datasetCsvValue(row.gyroX),
      datasetCsvValue(row.gyroY),
      datasetCsvValue(row.gyroZ),
      datasetCsvValue(row.quatW),
      datasetCsvValue(row.quatX),
      datasetCsvValue(row.quatY),
      datasetCsvValue(row.quatZ),
      datasetCsvValue(row.contactQuality),
      row.label,
    ].join(","));
    return [...metadataLines, DATASET_CSV_COLUMNS.join(","), ...dataLines].join("\n");
  }

  /**
   * Builds the immutable recording-bundle payload (raw CSV + recording +
   * annotations metadata) for the current buffered session, as a one-label
   * "quick capture" full-span interval per the ADR. Returns `null` when there
   * is no session or no accepted samples — an armed/empty session must never
   * produce a persisted `raw.csv` (`cancelled_before_first_sample`), matching
   * the state-machine contract.
   */
  buildRecordingBundlePayload(stopReason: StopReason = "manual_stop"): RecordingBundlePayload | null {
    const session = this.datasetSession;
    const rows = this.datasetRows.toArray();
    if (!session || rows.length === 0) return null;

    const recordingId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const actualStartIso = this.datasetActualStartAtIso ?? session.startedAtIso;
    const actualStartMonotonicNs = Math.round((this.datasetActualStartMonotonicMs ?? performance.now()) * 1_000_000);
    const actualEndMonotonicNs = Math.round(performance.now() * 1_000_000);
    const actualDurationMs = this.datasetRecordingStartedAtMs !== null ? Date.now() - this.datasetRecordingStartedAtMs : 0;

    const rawCsv = [
      RAW_RECORDING_CSV_COLUMNS.join(","),
      ...rows.map((row) => [
        row.timestampNs,
        row.sequence,
        datasetCsvValue(row.ppgGreen),
        datasetCsvValue(row.ppgRed),
        datasetCsvValue(row.ppgIr),
        datasetCsvValue(row.accelX),
        datasetCsvValue(row.accelY),
        datasetCsvValue(row.accelZ),
        datasetCsvValue(row.gyroX),
        datasetCsvValue(row.gyroY),
        datasetCsvValue(row.gyroZ),
        datasetCsvValue(row.quatW),
        datasetCsvValue(row.quatX),
        datasetCsvValue(row.quatY),
        datasetCsvValue(row.quatZ),
        datasetCsvValue(row.contactQuality),
      ].join(",")),
    ].join("\n");

    return {
      rawCsv,
      recording: {
        format_version: RECORDING_BUNDLE_FORMAT_VERSION,
        recording_id: recordingId,
        requested_start_at: this.datasetRequestedStartAtIso ?? session.startedAtIso,
        actual_start: { monotonic_ns: actualStartMonotonicNs, wall_clock_at: actualStartIso },
        actual_end: { monotonic_ns: actualEndMonotonicNs, wall_clock_at: nowIso },
        requested_duration_ms: null,
        actual_duration_ms: actualDurationMs,
        stop_reason: stopReason,
        sources: [{ source_id: "watch", configuration: {} }],
        raw_row_count: rows.length,
        raw_source_row_counts: { watch: rows.length },
      },
      annotations: {
        format_version: RECORDING_BUNDLE_FORMAT_VERSION,
        recording_id: recordingId,
        intervals: this.datasetCaptureMode === "timeline"
          ? this.timelineIntervals
              .filter((interval): interval is ClosedLiveInterval => interval.endRawRow !== null && !isDegenerate(interval))
              .map((interval) => toAnnotationInterval(interval, rows, INTERVAL_RESOLUTION_RULE_VERSION))
          : [{
              interval_id: crypto.randomUUID(),
              label_id: session.label,
              requested_start_monotonic_ns: actualStartMonotonicNs,
              requested_end_monotonic_ns: actualEndMonotonicNs,
              resolved_start: { raw_row: 0, source_timestamp_ns: Number(rows[0].timestampNs) },
              resolved_end: { raw_row: rows.length - 1, source_timestamp_ns: Number(rows[rows.length - 1].timestampNs) },
              resolution_rule_version: INTERVAL_RESOLUTION_RULE_VERSION,
              creation_mechanism: "quick_capture",
              curation_status: "unreviewed",
              created_at: nowIso,
              revision: 1,
            }],
      },
    };
  }

  /** Graph refresh rate: how often subscribers are notified of new samples. */
  setGraphRefreshRateHz(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0) return;
    this.publishIntervalMs = 1000 / hz;
  }

  /** Recording rate: max per-channel frequency at which accepted samples are written to the CSV rows buffer. */
  setRecordingRateHz(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0) return;
    this.recordingMinIntervalMs = 1000 / hz;
  }

  /**
   * Desktop acceptance rates for Samsung SDK-controlled continuous streams.
   * Every callback/sample reaches this store first; these values only gate
   * graph/CSV acceptance and never claim to change physical tracker cadence.
   */
  setHealthAcceptanceRatesHz(rates: {
    heartRate: number;
    temperature: number;
    eda: number;
  }): void {
    Object.entries(rates).forEach(([channel, hz]) => {
      if (Number.isFinite(hz) && hz > 0) this.healthAcceptanceMinIntervalMs.set(channel, 1000 / hz);
    });
  }

  ingestHeadPose(payload: HeadPosePayload): void {
    const status = { ...payload, connected: true };
    this.headStatus = status;
    const at = Date.now();
    this.series.get("head")?.push({ at, values: [status.yawDeg, status.pitchDeg, status.rollDeg] });
    if (this.canRecord("head", at)) this.rows.push({
      recordedAt: new Date(at).toISOString(),
      source: "headphone",
      sourceTimestampNs: "",
      sequence: "",
      values: {
        yawDeg: status.yawDeg,
        pitchDeg: status.pitchDeg,
        rollDeg: status.rollDeg,
        gyroX: status.gyroscope?.[0] ?? null,
        gyroY: status.gyroscope?.[1] ?? null,
        gyroZ: status.gyroscope?.[2] ?? null,
      },
    });
    this.schedulePublish();
  }

  setHeadConnected(connected: boolean): void {
    this.headStatus = { ...(this.headStatus ?? EMPTY_HEAD_STATUS), connected };
    this.schedulePublish();
  }

  ingestWatchStatus(status: WatchStatus): void {
    this.watchStatus = status;
    const orientation = status.lastOrientation;
    if (status.connected && orientation) this.ingestWatchOrientation(orientation);
    this.ingestOnDemand(status);
    this.schedulePublish();
  }

  ingestWatchOrientation(orientation: WatchOrientationSample): void {
    if (orientation.sequence === this.lastWatchOrientationSequence) return;
    this.lastWatchOrientationSequence = orientation.sequence;
    const at = Date.now();
    const euler = quaternionToEulerDegrees(orientation.quaternion);
    this.series.get("watchOrientation")?.push({ at, values: euler });
    if (this.canRecord("watchOrientation", at)) this.rows.push({
      recordedAt: new Date(at).toISOString(),
      source: "watch",
      sourceTimestampNs: String(orientation.timestampNs),
      sequence: String(orientation.sequence),
      values: {
        yawDeg: euler[0],
        pitchDeg: euler[1],
        rollDeg: euler[2],
        accelX: orientation.accelerometer?.[0] ?? null,
        accelY: orientation.accelerometer?.[1] ?? null,
        accelZ: orientation.accelerometer?.[2] ?? null,
        gyroX: orientation.gyroscope?.[0] ?? null,
        gyroY: orientation.gyroscope?.[1] ?? null,
        gyroZ: orientation.gyroscope?.[2] ?? null,
      },
    });
    this.lastKnownOrientationSample = {
      accel: orientation.accelerometer,
      gyro: orientation.gyroscope,
      quat: orientation.quaternion,
    };
    if (this.datasetRecording && this.datasetSession) {
      this.transitionDatasetFromArmingIfNeeded();
      this.datasetRows.push({
        timestampNs: String(orientation.timestampNs),
        sequence: String(orientation.sequence),
        ppgGreen: this.lastKnownPpgSample.green,
        ppgRed: this.lastKnownPpgSample.red,
        ppgIr: this.lastKnownPpgSample.ir,
        accelX: orientation.accelerometer?.[0] ?? null,
        accelY: orientation.accelerometer?.[1] ?? null,
        accelZ: orientation.accelerometer?.[2] ?? null,
        gyroX: orientation.gyroscope?.[0] ?? null,
        gyroY: orientation.gyroscope?.[1] ?? null,
        gyroZ: orientation.gyroscope?.[2] ?? null,
        quatW: orientation.quaternion[0],
        quatX: orientation.quaternion[1],
        quatY: orientation.quaternion[2],
        quatZ: orientation.quaternion[3],
        contactQuality: this.lastKnownPpgSample.contactQuality,
        label: this.currentDatasetRowLabel(),
      });
    }
    this.schedulePublish();
  }

  ingestPpgBatch(batch: WatchPpgBatch): void {
    this.ingestTimestampedBatch(batch.timestampsNs, (timestampNs, index, at) => {
      this.series.get("ppg")?.push({ at, values: [batch.green[index] ?? 0, batch.red[index] ?? 0, batch.ir[index] ?? 0] });
      if (this.canRecord("ppg", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(timestampNs), sequence: String(batch.sequence),
        values: { ppgGreen: batch.green[index] ?? null, ppgRed: batch.red[index] ?? null, ppgIr: batch.ir[index] ?? null },
      });
      const green = batch.green[index] ?? null;
      const red = batch.red[index] ?? null;
      const ir = batch.ir[index] ?? null;
      const contactQuality = Math.max(
        batch.greenStatus?.[index] ?? 0,
        batch.redStatus?.[index] ?? 0,
        batch.irStatus?.[index] ?? 0,
      );
      this.lastKnownPpgSample = { green, red, ir, contactQuality };
      if (this.datasetRecording && this.datasetSession) {
        this.transitionDatasetFromArmingIfNeeded();
        this.datasetRows.push({
          timestampNs: String(timestampNs),
          sequence: String(batch.sequence),
          ppgGreen: green,
          ppgRed: red,
          ppgIr: ir,
          accelX: this.lastKnownOrientationSample.accel?.[0] ?? null,
          accelY: this.lastKnownOrientationSample.accel?.[1] ?? null,
          accelZ: this.lastKnownOrientationSample.accel?.[2] ?? null,
          gyroX: this.lastKnownOrientationSample.gyro?.[0] ?? null,
          gyroY: this.lastKnownOrientationSample.gyro?.[1] ?? null,
          gyroZ: this.lastKnownOrientationSample.gyro?.[2] ?? null,
          quatW: this.lastKnownOrientationSample.quat?.[0] ?? null,
          quatX: this.lastKnownOrientationSample.quat?.[1] ?? null,
          quatY: this.lastKnownOrientationSample.quat?.[2] ?? null,
          quatZ: this.lastKnownOrientationSample.quat?.[3] ?? null,
          contactQuality,
          label: this.currentDatasetRowLabel(),
        });
      }
    });
  }

  ingestHeartRateBatch(batch: WatchHeartRateBatch): void {
    this.ingestTimestampedBatch(batch.timestampsNs, (timestampNs, index, at) => {
      if (!this.canAcceptHealth("heartRate", at)) return;
      this.series.get("heartRate")?.push({ at, values: [batch.heartRate[index] ?? 0] });
      (batch.ibiMs[index] ?? []).forEach((ibiMs) => this.series.get("ibi")?.push({ at, values: [ibiMs] }));
      if (this.canRecord("heartRate", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(timestampNs), sequence: String(batch.sequence),
        values: { heartRateBpm: batch.heartRate[index] ?? null, ibiMs: batch.ibiMs[index]?.[0] ?? null },
      });
    });
  }

  ingestSkinTemperatureBatch(batch: WatchSkinTemperatureBatch): void {
    this.ingestTimestampedBatch(batch.timestampsNs, (timestampNs, index, at) => {
      if (!this.canAcceptHealth("temperature", at)) return;
      this.series.get("temperature")?.push({ at, values: [batch.objectTemperatureCelsius[index] ?? 0, batch.ambientTemperatureCelsius[index] ?? 0] });
      if (this.canRecord("temperature", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(timestampNs), sequence: String(batch.sequence),
        values: {
          skinTemperatureCelsius: batch.objectTemperatureCelsius[index] ?? null,
          ambientTemperatureCelsius: batch.ambientTemperatureCelsius[index] ?? null,
        },
      });
    });
  }

  ingestEdaBatch(batch: WatchEdaBatch): void {
    this.ingestTimestampedBatch(batch.timestampsNs, (timestampNs, index, at) => {
      if (!this.canAcceptHealth("eda", at)) return;
      this.series.get("eda")?.push({ at, values: [batch.skinConductanceMicrosiemens[index] ?? 0] });
      if (this.canRecord("eda", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(timestampNs), sequence: String(batch.sequence),
        values: { edaMicrosiemens: batch.skinConductanceMicrosiemens[index] ?? null },
      });
    });
  }

  reset(): void {
    if (this.publishTimer !== null) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.series.forEach((buffer) => buffer.clear());
    this.rows.clear();
    this.headStatus = null;
    this.headDiagnostic = null;
    this.watchStatus = EMPTY_WATCH_STATUS;
    this.recording = false;
    this.savedCount = 0;
    this.lastWatchOrientationSequence = null;
    this.lastSpo2TimestampNs = null;
    this.lastEcgTimestampNs = null;
    this.lastRecordedAtByChannel.clear();
    this.lastAcceptedAtByChannel.clear();
    this.selectedLabel = null;
    this.sessionLabels.clear();
    this.datasetRecordingState = "idle";
    this.datasetRecording = false;
    this.datasetSession = null;
    this.datasetRecordingStartedAtMs = null;
    this.datasetRequestedStartAtIso = null;
    this.datasetActualStartAtIso = null;
    this.datasetActualStartMonotonicMs = null;
    this.datasetRows.clear();
    this.datasetCaptureMode = "quick";
    this.timelineIntervals = [];
    this.activeTimelineIntervalId = null;
    this.lastKnownOrientationSample = { accel: null, gyro: null, quat: null };
    this.lastKnownPpgSample = { green: null, red: null, ir: null, contactQuality: null };
    this.publishNow();
  }

  /** Closes the currently active timeline interval, if any, at `endRawRow`; discards it instead if it captured zero rows. */
  private closeActiveTimelineInterval(endMonotonicNs: number, endRawRow: number): void {
    const interval = this.timelineIntervals.find((entry) => entry.intervalId === this.activeTimelineIntervalId);
    this.activeTimelineIntervalId = null;
    if (!interval) return;
    interval.endMonotonicNs = endMonotonicNs;
    interval.endRawRow = endRawRow;
    if (isDegenerate(interval)) {
      this.timelineIntervals = this.timelineIntervals.filter((entry) => entry.intervalId !== interval.intervalId);
    }
  }

  /**
   * The label a just-appended row should carry for legacy fused-CSV export.
   * Quick Capture always uses the whole session's one label; Timeline
   * Capture uses whatever label is currently active live, or `""` while a
   * gap is unannotated — this row-level label is a compatibility view only,
   * the intervals list is the authoritative annotation record.
   */
  private currentDatasetRowLabel(): GestureDatasetLabel {
    if (this.datasetCaptureMode === "timeline") return this.getActiveTimelineLabel() ?? "";
    return this.datasetSession?.label ?? "";
  }

  private transitionDatasetFromArmingIfNeeded(): void {
    if (this.datasetRecordingState === "arming") {
      this.datasetRecordingState = "recording";
      this.datasetRecordingStartedAtMs = Date.now();
      this.datasetActualStartAtIso = new Date().toISOString();
      this.datasetActualStartMonotonicMs = performance.now();
    }
  }

  private canAcceptHealth(channel: string, at: number): boolean {
    const minIntervalMs = this.healthAcceptanceMinIntervalMs.get(channel);
    if (minIntervalMs === undefined) return true;
    const last = this.lastAcceptedAtByChannel.get(channel);
    if (last !== undefined && at - last < minIntervalMs) return false;
    this.lastAcceptedAtByChannel.set(channel, at);
    return true;
  }

  /** True (and records `at` as the channel's last-recorded time) if `channel` may write a row now: recording is on and the configured recording rate's interval has elapsed for that channel. */
  private canRecord(channel: string, at: number): boolean {
    if (!this.recording) return false;
    const last = this.lastRecordedAtByChannel.get(channel);
    if (last !== undefined && at - last < this.recordingMinIntervalMs) return false;
    this.lastRecordedAtByChannel.set(channel, at);
    return true;
  }

  private ingestTimestampedBatch(
    timestampsNs: number[],
    ingest: (timestampNs: number, index: number, receivedAt: number) => void,
  ): void {
    if (timestampsNs.length === 0) return;
    const lastTimestampNs = timestampsNs[timestampsNs.length - 1];
    const receivedAt = Date.now();
    timestampsNs.forEach((timestampNs, index) => {
      ingest(timestampNs, index, receivedAt - (lastTimestampNs - timestampNs) / 1_000_000);
    });
    this.schedulePublish();
  }

  private ingestOnDemand(status: WatchStatus): void {
    const at = Date.now();
    const spo2 = status.spo2Last;
    if (spo2 && spo2.timestampNs !== this.lastSpo2TimestampNs) {
      this.lastSpo2TimestampNs = spo2.timestampNs;
      this.series.get("spo2")?.push({ at, values: [spo2.spo2, spo2.heartRate] });
      if (this.canRecord("spo2", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(spo2.timestampNs), sequence: "",
        values: { spo2Percent: spo2.spo2, spo2HeartRateBpm: spo2.heartRate },
      });
    }
    const ecg = status.ecgLast;
    if (ecg && ecg.timestampNs !== this.lastEcgTimestampNs) {
      this.lastEcgTimestampNs = ecg.timestampNs;
      this.series.get("ecg")?.push({ at, values: [ecg.ecgMillivolts] });
      if (this.canRecord("ecg", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(ecg.timestampNs), sequence: "",
        values: {
          ecgMillivolts: ecg.ecgMillivolts,
          biaProgressPercent: status.biaLast?.progressPercent ?? null,
          sweatLossMilliliters: status.sweatLossLast?.sweatLossMilliliters ?? null,
        },
      });
    }
  }

  private schedulePublish(): void {
    if (this.publishTimer !== null) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
    }, this.publishIntervalMs);
  }

  private publishNow(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export const telemetryStore = new TelemetryStore();
