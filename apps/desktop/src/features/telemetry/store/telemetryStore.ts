import { quaternionToEulerDegrees } from "../../../shared/protocol/events";
import { AngleUnwrapper } from "./angleUnwrap";
import type {
  HeadPosePayload,
  HeadTrackerDiagnostic,
  HeadTrackerStatus,
  WatchEdaBatch,
  WatchHeartRateBatch,
  WatchOrientationSample,
  WatchPpgBatch,
  WatchSkinTemperatureBatch,
  WatchStatus,
} from "../../../shared/protocol/events";
import type { AnnotationInterval, RecordingBundlePayload, RecordingEvidence, StopReason } from "../../../shared/tauri/recordingBundle";
import { clockSync } from "../../camera/clockSync";
import {
  hasOverlap,
  isDegenerate,
  reindexIntervalsAfterInsert,
  splitInterval,
  toAnnotationInterval,
  type ClosedLiveInterval,
  type LiveInterval,
} from "../annotations/timeline";
import { RingBuffer } from "./ringBuffer";
import { SourceClockMap } from "./sourceClock";

export type SeriesPoint = { at: number; values: number[] };
export type CsvRow = {
  recordedAt: string;
  source: "headphone" | "watch";
  sourceTimestampNs: string;
  sequence: string;
  values: Record<string, number | null>;
  /** Snapshot of the applied ordinary-capture label at push time; `DEFAULT_ORDINARY_LABEL` when none is applied. */
  label: string;
};

/** Default label for ordinary CSV rows when no ordinary-capture label is applied. Not a user-chosen label. */
export const DEFAULT_ORDINARY_LABEL = "NA";

/** Labels are user-owned stable slugs; no built-in templates. */
export type GestureDatasetLabel = string;

/** The stored form of a typed label (lower-case, underscores for anything else), or null when no valid label can be made of it. */
export function normalizeDatasetLabel(label: string): GestureDatasetLabel | null {
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

/** The columns of `ppg.csv` and `imu.csv` in an exported dataset folder: the single file's, without the other sensor's. */
export const PPG_FILE_COLUMNS = ["timestamp_ns", "sequence", "ppg_green", "ppg_red", "ppg_ir", "contact_quality", "label"] as const;
export const IMU_FILE_COLUMNS = [
  "timestamp_ns", "sequence", "accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z",
  "quat_w", "quat_x", "quat_y", "quat_z", "label",
] as const;

/** The two dense files of an exported dataset folder (see `dataset_files.rs`). */
export interface DatasetFolderFiles {
  ppgCsv: string;
  imuCsv: string;
  ppgRows: number;
  imuRows: number;
}

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
  | "watchAcceleration"
  | "ppg"
  | "heartRate"
  | "ibi"
  | "temperature"
  | "eda"
  | "spo2"
  | "ecg";

/** How long the watch must be silent, after reporting it is off the wrist, before its charts are emptied. */
const WATCH_PAUSE_QUIET_MS = 1500;
/** A gap this long between two motion samples' own times means the watch clock restarted, not a pause. */
const MOTION_CLOCK_JUMP_MS = 5_000;
export const MAX_VISIBLE_SAMPLES = 600;
/**
 * The fast live charts show the same span of time, whatever their rate: 600 samples were 24 s of PPG at 25 Hz but a few
 * seconds of motion. The slow ones (heart rate, temperature, about one value a second) keep their last 600 values.
 */
export const LIVE_WINDOW_MS = 6_000;
const LIVE_WINDOW_SERIES: ReadonlySet<TelemetrySeries> = new Set(["head", "watchOrientation", "watchAcceleration", "ppg"]);
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
  worn: null,
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

/** How far back a camera mark can start: longer than any hold time. */
const ARRIVAL_TRAIL_MS = 5000;

class TelemetryStore {
  private readonly listeners = new Set<() => void>();
  private readonly series = new Map<TelemetrySeries, RingBuffer<SeriesPoint>>(
    (["head", "watchOrientation", "watchAcceleration", "ppg", "heartRate", "ibi", "temperature", "eda", "spo2", "ecg"] as const)
      .map((name) => [name, new RingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES)]),
  );
  // The charts plot the head and watch angles unwrapped, so a slow turn through ±180° is not drawn as a spike.
  private readonly headUnwrap = new AngleUnwrapper();
  private readonly watchUnwrap = new AngleUnwrapper();
  private readonly rows = new RingBuffer<CsvRow>(MAX_CSV_ROWS);
  private version = 0;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private headStatus: HeadTrackerStatus | null = null;
  private headDiagnostic: HeadTrackerDiagnostic | null = null;
  private headTrackerProvider: "native" | "external" | null = null;
  private watchStatus: WatchStatus = EMPTY_WATCH_STATUS;
  // The watch reports it is off the wrist and has stopped sending. Distinct from "worn is
  // false": with the watch's off-wrist streaming switch on it keeps sending, and its charts must
  // keep showing that data.
  private watchPaused = false;
  private lastWatchSampleAt = 0;
  private watchPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private recording = false;
  private savedCount = 0;
  // Ordinary CSV capture label: applied explicitly via `applyOrdinaryLabel`/
  // `clearOrdinaryLabel`, independent of any draft text the UI input holds —
  // editing the input alone must never change what gets stamped on rows.
  private appliedOrdinaryLabel: string = DEFAULT_ORDINARY_LABEL;
  /**
   * The last motion sample taken in, so the status poll's copy of it is not taken twice. Sequence and time together: the
   * samples of one combined `watch.sensor_batch` share their message's sequence.
   */
  private lastWatchOrientationKey: string | null = null;
  /** The pulse sensor's SDK clock, mapped onto the watch clock every other watch message uses. */
  private readonly ppgClock = new SourceClockMap();
  /**
   * The motion charts are drawn on the watch's own clock. Bluetooth delivers samples in bursts; drawn where they arrived,
   * a burst piles up at one moment and leaves a gap, which looks like the graph stalling on a sudden movement. Mapping
   * the watch clock onto this one first would need an estimate that settles only after a while (a late start made the
   * graph freeze until it did); the charts only need the spacing, which the watch clock has exactly.
   */
  private lastWatchMotionPlotAt: number | null = null;
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
  /**
   * When recent rows arrived (browser clock) and each one's own timestamp, to place a camera mark where the gesture began
   * or ended. A row index would go stale: a delayed sample is inserted in time order and moves every later row.
   */
  private arrivalTrail: { ms: number; timestampNs: number }[] = [];
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
  /** Adds optional evidence (such as camera landmarks) to a recording bundle; null when there is none. */
  private evidenceProvider: ((startMs: number, endMs: number) => RecordingEvidence | null) | null = null;
  private readonly datasetRows = new RingBuffer<DatasetRow>(MAX_CSV_ROWS);

  // Timeline Capture: live/edited intervals for the current session. Cleared
  // on start/discard, closed out on stop, and freely editable while
  // `datasetRecordingState === "saved"` (post-capture editing). Defaults to
  // "timeline" since GC-017 made it the screen's only recorder; "quick"
  // remains fully supported (and covered by its own tests) for the
  // recording-bundle contract's `quick_capture` shape, just unreachable from
  // the UI's default state.
  private datasetCaptureMode: DatasetCaptureMode = "timeline";
  private timelineIntervals: LiveInterval[] = [];
  private activeTimelineIntervalId: string | null = null;

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
    const points = this.series.get(name)?.toArray() ?? [];
    if (!LIVE_WINDOW_SERIES.has(name) || points.length === 0) return points;
    const newest = points[points.length - 1].at;
    const first = points.findIndex((point) => point.at >= newest - LIVE_WINDOW_MS);
    return first <= 0 ? points : points.slice(first);
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

  getAppliedOrdinaryLabel(): string {
    return this.appliedOrdinaryLabel;
  }

  /** Applies a trimmed non-empty label to future ordinary-capture rows; rejects whitespace-only/empty input. */
  applyOrdinaryLabel(label: string): boolean {
    const trimmed = label.trim();
    if (!trimmed) return false;
    this.appliedOrdinaryLabel = trimmed;
    this.publishNow();
    return true;
  }

  /** Deactivates the applied ordinary-capture label; future rows return to the default. */
  clearOrdinaryLabel(): void {
    this.appliedOrdinaryLabel = DEFAULT_ORDINARY_LABEL;
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
    this.arrivalTrail = [];
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
  setTimelineLabel(label: GestureDatasetLabel | null, mechanism: "hotkey_hold" | "hotkey_toggle" | "camera_proposal" = "hotkey_toggle", sinceMs?: number): boolean {
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
      // The camera only knows a gesture is held after its hold time, so it says when it began (`sinceMs`, the browser
      // clock) and the interval starts at the first row that arrived then, but never inside an earlier interval.
      const startRow = sinceMs === undefined ? currentRowCount : this.firstRowSince(sinceMs, currentRowCount);
      this.sessionLabels.add(normalized);
      const interval: LiveInterval = {
        intervalId: crypto.randomUUID(),
        labelId: normalized,
        startMonotonicNs: sinceMs === undefined ? nowMonotonicNs : Math.round(sinceMs * 1_000_000),
        endMonotonicNs: null,
        startRawRow: startRow,
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

  /**
   * Timeline Capture only: closes `label`'s active interval where the gesture actually ended (`atMs`, the browser clock),
   * not where the camera noticed, so the end is not stretched by the release grace or the detector's latency.
   */
  closeTimelineLabelAt(label: GestureDatasetLabel, atMs: number): boolean {
    if (this.datasetCaptureMode !== "timeline" || this.datasetRecordingState !== "recording") return false;
    if (this.getActiveTimelineLabel() !== normalizeDatasetLabel(label)) return false;
    const active = this.timelineIntervals.find((entry) => entry.intervalId === this.activeTimelineIntervalId);
    const currentRowCount = this.datasetRows.length;
    const endRow = Math.max(active?.startRawRow ?? 0, this.rowArrivedSince(atMs, currentRowCount));
    const endNs = Math.max(active?.startMonotonicNs ?? 0, Math.round(atMs * 1_000_000));
    this.closeActiveTimelineInterval(endNs, endRow);
    // Rows that arrived after the gesture ended were recorded while the label was still on; give them back.
    for (let index = endRow; index < currentRowCount; index += 1) {
      const row = this.datasetRows.get(index);
      if (row && row.label === active?.labelId) row.label = "";
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

  /**
   * Inserts a dataset row at its chronological position by `timestampNs`
   * (stable: equal timestamps keep arrival order), instead of always
   * appending in arrival order. Cross-batch/cross-sensor ingest can deliver a
   * sample whose source timestamp is earlier than one already buffered; a
   * plain append would leave `raw.csv` non-chronological (GC-029). Any
   * timeline interval boundary recorded at or after the insertion point is
   * shifted by one so it keeps pointing at the same logical rows.
   */
  private pushDatasetRowSorted(row: DatasetRow): void {
    const arrivedAt = performance.now();
    const timestampNs = Number(row.timestampNs);
    // A row without a usable timestamp is appended last, so it stands for "the end".
    this.arrivalTrail.push({ ms: arrivedAt, timestampNs: Number.isFinite(timestampNs) ? timestampNs : Infinity });
    while (this.arrivalTrail.length > 0 && arrivedAt - this.arrivalTrail[0].ms > ARRIVAL_TRAIL_MS) this.arrivalTrail.shift();
    const previousLength = this.datasetRows.length;
    const insertIndex = Number.isFinite(timestampNs)
      ? this.datasetRows.upperBound((existing) => Number(existing.timestampNs), timestampNs)
      : previousLength;
    // A full buffer drops its oldest row to make room (unless the new row is itself
    // older than everything retained, in which case it is the one dropped), which
    // moves every row one place earlier and every interval bound with it.
    const evictedOldest = previousLength >= MAX_CSV_ROWS && insertIndex > 0;
    this.datasetRows.insertAt(insertIndex, row);
    this.timelineIntervals = reindexIntervalsAfterInsert(
      this.timelineIntervals,
      insertIndex,
      previousLength,
      evictedOldest,
    );
  }

  /** The first row that arrived at or after `sinceMs`, not before the end of an interval already made. */
  private firstRowSince(sinceMs: number, currentRowCount: number): number {
    const floor = this.timelineIntervals.reduce((end, interval) => Math.max(end, interval.endRawRow ?? 0), 0);
    return Math.min(currentRowCount, Math.max(this.rowArrivedSince(sinceMs, currentRowCount), floor));
  }

  /** Where the row that arrived first at or after `atMs` sits now, found by its timestamp; `currentRowCount` if none has. */
  private rowArrivedSince(atMs: number, currentRowCount: number): number {
    const entry = this.arrivalTrail.find((item) => item.ms >= atMs);
    if (!entry || !Number.isFinite(entry.timestampNs)) return currentRowCount;
    return Math.min(currentRowCount, this.datasetRows.lowerBound((row) => Number(row.timestampNs), entry.timestampNs));
  }

  /** How many intervals the camera has marked in this session. */
  countCameraIntervals(): number {
    return this.timelineIntervals.filter((interval) => interval.creationMechanism === "camera_proposal" && interval.endRawRow !== null).length;
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
    const rows = this.datasetRows.toArray();
    const labels = this.datasetRowLabels(rows);
    const dataLines = rows.map((row, rowIndex) => [
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
      labels[rowIndex],
    ].join(","));
    return [...this.datasetMetadataLines(rows.length), DATASET_CSV_COLUMNS.join(","), ...dataLines].join("\n");
  }

  /**
   * The same session as two dense files: a pulse row for each row that carried a pulse sample and a motion row for each row
   * that carried a motion sample, each with every column filled (a row that somehow carried both is a row in each). The
   * labels are exactly the single file's. Together the files hold the same samples as `generateDatasetCsv`, without the
   * empty cells where the other sensor had nothing.
   */
  generateDatasetFolderFiles(): DatasetFolderFiles {
    const rows = this.datasetRows.toArray();
    const labels = this.datasetRowLabels(rows);
    const ppg: string[] = [];
    const imu: string[] = [];
    rows.forEach((row, index) => {
      if (row.ppgGreen != null || row.ppgRed != null || row.ppgIr != null) {
        ppg.push([row.timestampNs, row.sequence, datasetCsvValue(row.ppgGreen), datasetCsvValue(row.ppgRed), datasetCsvValue(row.ppgIr), datasetCsvValue(row.contactQuality), labels[index]].join(","));
      }
      const motion = [row.accelX, row.accelY, row.accelZ, row.gyroX, row.gyroY, row.gyroZ, row.quatW, row.quatX, row.quatY, row.quatZ];
      if (motion.some((value) => value != null)) {
        imu.push([row.timestampNs, row.sequence, ...motion.map(datasetCsvValue), labels[index]].join(","));
      }
    });
    const comments = this.datasetMetadataLines(rows.length);
    return {
      ppgCsv: [...comments, PPG_FILE_COLUMNS.join(","), ...ppg].join("\n") + "\n",
      imuCsv: [...comments, IMU_FILE_COLUMNS.join(","), ...imu].join("\n") + "\n",
      ppgRows: ppg.length,
      imuRows: imu.length,
    };
  }

  private datasetMetadataLines(rowCount: number): string[] {
    const session = this.datasetSession;
    return [
      "# gesture-dataset-export: 1",
      `# label: ${session?.label ?? ""}`,
      `# started_at: ${session?.startedAtIso ?? ""}`,
      `# row_count: ${rowCount}`,
    ];
  }

  /**
   * A row's label is the interval that covers it, so intervals edited or added after the recording (by hand, or by the
   * camera) are in the export; a row no interval covers keeps the label it was recorded with.
   */
  private datasetRowLabels(rows: DatasetRow[]): string[] {
    const intervalLabels: (string | null)[] = new Array(rows.length).fill(null);
    for (const interval of this.timelineIntervals) {
      if (interval.endRawRow === null) continue;
      for (let index = Math.max(0, interval.startRawRow); index < Math.min(rows.length, interval.endRawRow); index += 1) intervalLabels[index] = interval.labelId;
    }
    return rows.map((row, index) => intervalLabels[index] ?? row.label);
  }

  /**
   * Builds the immutable recording-bundle payload (raw CSV + recording +
   * annotations metadata) for the current buffered session, as a one-label
   * "quick capture" full-span interval per the ADR. Returns `null` when there
   * is no session or no accepted samples — an armed/empty session must never
   * produce a persisted `raw.csv` (`cancelled_before_first_sample`), matching
   * the state-machine contract.
   */
  setEvidenceProvider(provider: ((startMs: number, endMs: number) => RecordingEvidence | null) | null): void {
    this.evidenceProvider = provider;
  }

  /** When the first sample of the current recording was accepted, on the browser's monotonic clock (ms). */
  getDatasetActualStartMonotonicMs(): number | null {
    return this.datasetActualStartMonotonicMs;
  }

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

    const evidence = this.evidenceProvider?.(actualStartMonotonicNs / 1_000_000, actualEndMonotonicNs / 1_000_000) ?? null;

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
      ...(evidence ? { extraFiles: evidence.files } : {}),
      recording: {
        format_version: RECORDING_BUNDLE_FORMAT_VERSION,
        recording_id: recordingId,
        requested_start_at: this.datasetRequestedStartAtIso ?? session.startedAtIso,
        actual_start: { monotonic_ns: actualStartMonotonicNs, wall_clock_at: actualStartIso },
        actual_end: { monotonic_ns: actualEndMonotonicNs, wall_clock_at: nowIso },
        requested_duration_ms: null,
        actual_duration_ms: actualDurationMs,
        stop_reason: stopReason,
        // The camera is a source of its own evidence file, not of raw rows, so it is not in `raw_source_row_counts`.
        sources: [{ source_id: "watch", configuration: {} }, ...(evidence ? evidence.sources : [])],
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
    this.series.get("head")?.push({ at, values: this.headUnwrap.next([status.yawDeg, status.pitchDeg, status.rollDeg]) });
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
      label: this.appliedOrdinaryLabel,
    });
    this.schedulePublish();
  }

  setHeadConnected(connected: boolean): void {
    this.headStatus = { ...(this.headStatus ?? EMPTY_HEAD_STATUS), connected };
    this.schedulePublish();
  }

  /** True once the watch has said it is off the wrist and its samples have actually stopped. */
  getWatchPaused(): boolean {
    return this.watchPaused;
  }

  ingestWatchStatus(status: WatchStatus): void {
    this.watchStatus = status;
    if (status.worn === false) {
      this.armWatchPauseCheck();
    } else {
      this.cancelWatchPauseCheck();
      this.watchPaused = false;
    }
    const orientation = status.lastOrientation;
    if (status.connected && orientation) this.ingestWatchOrientation(orientation);
    this.ingestOnDemand(status);
    this.schedulePublish();
  }

  ingestWatchOrientation(orientation: WatchOrientationSample): void {
    // M1: reject an impossible/non-finite source timestamp outright rather
    // than accepting or inventing one for row-ordering/timing purposes.
    if (!Number.isFinite(orientation.timestampNs)) return;
    const key = `${orientation.sequence}:${orientation.timestampNs}`;
    if (key === this.lastWatchOrientationKey) return;
    this.lastWatchOrientationKey = key;
    this.noteWatchSample();
    // Lines the watch's clock up with the browser's, which camera frames are stamped with.
    clockSync.observe(orientation.timestampNs, performance.now());
    const at = Date.now();
    const plotAt = this.watchMotionPlotAt(orientation.timestampNs);
    const euler = quaternionToEulerDegrees(orientation.quaternion);
    this.series.get("watchOrientation")?.push({ at: plotAt, values: this.watchUnwrap.next(euler) });
    // Acceleration rides on each orientation sample and is absent when the watch's
    // acceleration sensor is off or its reading was stale; a missing reading is a gap in
    // the chart, never a plotted zero.
    if (orientation.accelerometer) this.series.get("watchAcceleration")?.push({ at: plotAt, values: [...orientation.accelerometer] });
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
      label: this.appliedOrdinaryLabel,
    });
    if (this.datasetRecording && this.datasetSession) {
      this.transitionDatasetFromArmingIfNeeded();
      // This row is a genuine orientation-channel sample: the PPG columns
      // are left `null` (absent) rather than carried forward from the last
      // PPG sample, so the derivative/cadence pipeline can later assess each
      // channel's own finite samples on its own time series instead of a
      // fused, cross-channel cadence (GC-030).
      this.pushDatasetRowSorted({
        timestampNs: String(orientation.timestampNs),
        sequence: String(orientation.sequence),
        ppgGreen: null,
        ppgRed: null,
        ppgIr: null,
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
        contactQuality: null,
        label: this.currentDatasetRowLabel(),
      });
    }
    this.schedulePublish();
  }

  /**
   * Where to draw a motion sample taken at `timestampNs` (watch clock, ns): its own time in milliseconds. A watch clock
   * that jumped (a restarted watch) starts the motion charts afresh rather than squeezing both runs into one.
   */
  private watchMotionPlotAt(timestampNs: number): number {
    const plotAt = timestampNs / 1_000_000;
    const last = this.lastWatchMotionPlotAt;
    if (last !== null && (plotAt < last || plotAt - last > MOTION_CLOCK_JUMP_MS)) {
      this.series.get("watchOrientation")?.clear();
      this.series.get("watchAcceleration")?.clear();
      this.watchUnwrap.reset();
    }
    this.lastWatchMotionPlotAt = plotAt;
    return plotAt;
  }

  ingestPpgBatch(batch: WatchPpgBatch): void {
    this.noteWatchSample();
    // The per-sample timestamps are on the Samsung SDK's own clock, which cannot be compared with the watch clock
    // orientation rows use. Put them on that clock before they reach row ordering or timing (see `SourceClockMap`).
    this.ppgClock.observe(batch.timestampsNs[batch.timestampsNs.length - 1], batch.timestampNs);
    const canonicalTimestampsNs = batch.timestampsNs.map((sdkTimestampNs) => this.ppgClock.map(sdkTimestampNs) ?? Number.NaN);
    this.ingestTimestampedBatch(canonicalTimestampsNs, (timestampNs, index, at) => {
      this.series.get("ppg")?.push({ at, values: [batch.green[index] ?? 0, batch.red[index] ?? 0, batch.ir[index] ?? 0] });
      if (this.canRecord("ppg", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(timestampNs), sequence: String(batch.sequence),
        values: { ppgGreen: batch.green[index] ?? null, ppgRed: batch.red[index] ?? null, ppgIr: batch.ir[index] ?? null },
        label: this.appliedOrdinaryLabel,
      });
      const green = batch.green[index] ?? null;
      const red = batch.red[index] ?? null;
      const ir = batch.ir[index] ?? null;
      const contactQuality = Math.max(
        batch.greenStatus?.[index] ?? 0,
        batch.redStatus?.[index] ?? 0,
        batch.irStatus?.[index] ?? 0,
      );
      if (this.datasetRecording && this.datasetSession) {
        this.transitionDatasetFromArmingIfNeeded();
        // Genuine PPG-channel sample: orientation columns are left `null`
        // (absent) rather than carried forward — see the note above.
        this.pushDatasetRowSorted({
          timestampNs: String(timestampNs),
          sequence: String(batch.sequence),
          ppgGreen: green,
          ppgRed: red,
          ppgIr: ir,
          accelX: null,
          accelY: null,
          accelZ: null,
          gyroX: null,
          gyroY: null,
          gyroZ: null,
          quatW: null,
          quatX: null,
          quatY: null,
          quatZ: null,
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
        label: this.appliedOrdinaryLabel,
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
        label: this.appliedOrdinaryLabel,
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
        label: this.appliedOrdinaryLabel,
      });
    });
  }

  reset(): void {
    if (this.publishTimer !== null) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.series.forEach((buffer) => buffer.clear());
    this.headUnwrap.reset();
    this.watchUnwrap.reset();
    this.rows.clear();
    this.headStatus = null;
    this.headDiagnostic = null;
    this.watchStatus = EMPTY_WATCH_STATUS;
    this.cancelWatchPauseCheck();
    this.watchPaused = false;
    this.lastWatchSampleAt = 0;
    this.recording = false;
    this.savedCount = 0;
    this.appliedOrdinaryLabel = DEFAULT_ORDINARY_LABEL;
    this.lastWatchOrientationKey = null;
    this.ppgClock.reset();
    this.lastWatchMotionPlotAt = null;
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
    this.datasetCaptureMode = "timeline";
    this.timelineIntervals = [];
    this.activeTimelineIntervalId = null;
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

  /**
   * Shared choke point for every batched watch channel (PPG, heart rate,
   * temperature, EDA). A non-finite source timestamp is an impossible
   * capture-time value (M1): that single sample is skipped rather than
   * accepted with a garbage timestamp or having one invented for it: every
   * other sample in the batch is still ingested normally.
   */
  private ingestTimestampedBatch(
    timestampsNs: number[],
    ingest: (timestampNs: number, index: number, receivedAt: number) => void,
  ): void {
    if (timestampsNs.length === 0) return;
    const lastTimestampNs = timestampsNs[timestampsNs.length - 1];
    const receivedAt = Date.now();
    timestampsNs.forEach((timestampNs, index) => {
      if (!Number.isFinite(timestampNs)) return;
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
        label: this.appliedOrdinaryLabel,
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
        label: this.appliedOrdinaryLabel,
      });
    }
  }

  private noteWatchSample(): void {
    this.lastWatchSampleAt = Date.now();
    this.watchPaused = false;
  }

  /**
   * Once the watch reports `worn: false`, waits for its samples to go quiet and then empties the
   * watch charts, so they return to their "waiting for samples" state instead of freezing on
   * the last readings. A watch that keeps streaming off-wrist never goes quiet, and keeps its charts.
   */
  private armWatchPauseCheck(): void {
    if (this.watchPauseTimer !== null || this.watchPaused) return;
    this.watchPauseTimer = setTimeout(() => {
      this.watchPauseTimer = null;
      if (this.watchStatus.worn !== false) return;
      if (Date.now() - this.lastWatchSampleAt < WATCH_PAUSE_QUIET_MS) {
        this.armWatchPauseCheck();
        return;
      }
      this.watchPaused = true;
      this.series.get("watchOrientation")?.clear();
      this.watchUnwrap.reset();
      this.series.get("watchAcceleration")?.clear();
      this.series.get("ppg")?.clear();
      this.schedulePublish();
    }, WATCH_PAUSE_QUIET_MS);
  }

  private cancelWatchPauseCheck(): void {
    if (this.watchPauseTimer !== null) clearTimeout(this.watchPauseTimer);
    this.watchPauseTimer = null;
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
