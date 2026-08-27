import { quaternionToEulerDegrees } from "../../../shared/protocol/events";
import type {
  HeadPosePayload,
  HeadTrackerStatus,
  WatchEdaBatch,
  WatchHeartRateBatch,
  WatchOrientationSample,
  WatchPpgBatch,
  WatchSkinTemperatureBatch,
  WatchStatus,
} from "../../../shared/protocol/events";

export type SeriesPoint = { at: number; values: number[] };
export type CsvRow = {
  recordedAt: string;
  source: "headphone" | "watch";
  sourceTimestampNs: string;
  sequence: string;
  values: Record<string, number | null>;
};

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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  getHeadStatus(): HeadTrackerStatus | null {
    return this.headStatus;
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
    this.schedulePublish();
  }

  ingestPpgBatch(batch: WatchPpgBatch): void {
    this.ingestTimestampedBatch(batch.timestampsNs, (timestampNs, index, at) => {
      this.series.get("ppg")?.push({ at, values: [batch.green[index] ?? 0, batch.red[index] ?? 0, batch.ir[index] ?? 0] });
      if (this.canRecord("ppg", at)) this.rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(timestampNs), sequence: String(batch.sequence),
        values: { ppgGreen: batch.green[index] ?? null, ppgRed: batch.red[index] ?? null, ppgIr: batch.ir[index] ?? null },
      });
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
    this.watchStatus = EMPTY_WATCH_STATUS;
    this.recording = false;
    this.savedCount = 0;
    this.lastWatchOrientationSequence = null;
    this.lastSpo2TimestampNs = null;
    this.lastEcgTimestampNs = null;
    this.lastRecordedAtByChannel.clear();
    this.lastAcceptedAtByChannel.clear();
    this.publishNow();
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
