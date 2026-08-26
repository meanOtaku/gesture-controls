import { invoke } from "@tauri-apps/api/core";
import { useEffect, useReducer, useRef, useState } from "react";
import { quaternionToEulerDegrees } from "../protocol/events";
import type { HeadTrackerStatus, WatchPpgBatch, WatchStatus } from "../protocol/events";

type SeriesPoint = { at: number; values: number[] };
type CsvRow = {
  recordedAt: string;
  source: "headphone" | "watch";
  sourceTimestampNs: string;
  sequence: string;
  values: Record<string, number | null>;
};

const MAX_VISIBLE_SAMPLES = 600;
const MAX_CSV_ROWS = 200_000;
const ESTIMATED_BYTES_PER_CSV_ROW = 200;

/**
 * Fixed-capacity circular buffer. Bounds memory to `capacity` items and pushes
 * in O(1) without reallocating/copying the whole backing array, unlike
 * `[...arr, item].slice(-n)`.
 */
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
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  toArray(): T[] {
    const out = new Array<T>(this.count);
    for (let i = 0; i < this.count; i += 1) out[i] = this.slots[(this.start + i) % this.capacity] as T;
    return out;
  }

  get length(): number {
    return this.count;
  }
}

function useRingBuffer<T>(capacity: number): RingBuffer<T> {
  const ref = useRef<RingBuffer<T> | undefined>(undefined);
  if (!ref.current) ref.current = new RingBuffer<T>(capacity);
  return ref.current;
}

function number(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function chartPath(points: SeriesPoint[], index: number, width: number, height: number): string {
  const values = points.map((point) => point.values[index]).filter(Number.isFinite);
  if (values.length < 2 || points.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const start = points[0].at;
  const duration = Math.max(points[points.length - 1].at - start, 1);
  return points.map((point, pointIndex) => {
    const value = point.values[index];
    const x = ((point.at - start) / duration) * width;
    const y = height - ((value - min) / span) * height;
    return `${pointIndex === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function TimeChart({ title, points, labels, colors }: {
  title: string;
  points: SeriesPoint[];
  labels: string[];
  colors: string[];
}) {
  const width = 720;
  const height = 180;
  return <section className="telemetry-chart" aria-label={title}>
    <div className="telemetry-chart-heading">
      <div><span className="label">Live time series</span><h2>{title}</h2></div>
      <span className="telemetry-count">{points.length} samples</span>
    </div>
    <div className="telemetry-legend">
      {labels.map((label, index) => <span key={label}><i style={{ background: colors[index] }} />{label}</span>)}
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} live graph`} preserveAspectRatio="none">
      <path className="telemetry-grid-line" d={`M0,${height / 2}H${width}`} />
      {labels.map((_, index) => <path key={index} d={chartPath(points, index, width, height)} stroke={colors[index]} />)}
    </svg>
  </section>;
}

interface LiveTelemetryProps {
  status: HeadTrackerStatus | null;
  watchStatus: WatchStatus | null;
  ppgBatch: WatchPpgBatch | null;
}

export function LiveTelemetry({ status, watchStatus, ppgBatch }: LiveTelemetryProps) {
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0);

  const headPoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const watchPoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const watchOrientationPoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const ppgPoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const heartRatePoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const temperaturePoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const edaPoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const spo2Points = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const ecgPoints = useRingBuffer<SeriesPoint>(MAX_VISIBLE_SAMPLES);
  const rows = useRingBuffer<CsvRow>(MAX_CSV_ROWS);

  const [recording, setRecording] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  // Read inside data effects instead of depending on `recording` state, so
  // toggling recording doesn't re-run those effects and double-append the
  // latest sample to the graphs/CSV.
  const recordingRef = useRef(false);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    if (!status?.connected) return;
    const at = Date.now();
    headPoints.push({ at, values: [status.yawDeg, status.pitchDeg, status.rollDeg] });
    if (recordingRef.current) rows.push({
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
    forceRender();
  }, [status]);

  useEffect(() => {
    const orientation = watchStatus?.lastOrientation;
    if (!watchStatus?.connected || !orientation) return;
    const at = Date.now();
    const gyroscope = orientation.gyroscope;
    const euler = quaternionToEulerDegrees(orientation.quaternion);
    watchPoints.push({ at, values: gyroscope ?? [0, 0, 0] });
    watchOrientationPoints.push({ at, values: euler });
    if (recordingRef.current) rows.push({
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
        gyroX: gyroscope?.[0] ?? null,
        gyroY: gyroscope?.[1] ?? null,
        gyroZ: gyroscope?.[2] ?? null,
        ppgGreen: watchStatus.ppgLastSample?.green ?? null,
        ppgRed: watchStatus.ppgLastSample?.red ?? null,
        ppgIr: watchStatus.ppgLastSample?.ir ?? null,
      },
    });
    forceRender();
  }, [watchStatus]);

  useEffect(() => {
    if (!ppgBatch?.timestampsNs.length) return;
    const lastTimestampNs = ppgBatch.timestampsNs[ppgBatch.timestampsNs.length - 1];
    const receivedAt = Date.now();
    ppgBatch.timestampsNs.forEach((timestampNs, index) => {
      ppgPoints.push({
        at: receivedAt - (lastTimestampNs - timestampNs) / 1_000_000,
        values: [ppgBatch.green[index] ?? 0, ppgBatch.red[index] ?? 0, ppgBatch.ir[index] ?? 0],
      });
    });
    if (recordingRef.current) {
      ppgBatch.timestampsNs.forEach((timestampNs, index) => rows.push({
        recordedAt: new Date(receivedAt - (lastTimestampNs - timestampNs) / 1_000_000).toISOString(),
        source: "watch", sourceTimestampNs: String(timestampNs), sequence: String(ppgBatch.sequence),
        values: { ppgGreen: ppgBatch.green[index] ?? null, ppgRed: ppgBatch.red[index] ?? null, ppgIr: ppgBatch.ir[index] ?? null },
      }));
    }
    forceRender();
  }, [ppgBatch]);

  useEffect(() => {
    const at = Date.now();
    const heartRate = watchStatus?.heartRateLast;
    const temperature = watchStatus?.skinTemperatureLast;
    const eda = watchStatus?.edaLast;
    const spo2 = watchStatus?.spo2Last;
    const ecg = watchStatus?.ecgLast;
    if (heartRate) heartRatePoints.push({ at, values: [heartRate.heartRate] });
    if (temperature) temperaturePoints.push({ at, values: [temperature.objectTemperatureCelsius, temperature.ambientTemperatureCelsius] });
    if (eda) edaPoints.push({ at, values: [eda.skinConductanceMicrosiemens] });
    if (spo2) spo2Points.push({ at, values: [spo2.spo2, spo2.heartRate] });
    if (ecg) ecgPoints.push({ at, values: [ecg.ecgMillivolts] });
    if (recordingRef.current) {
      const sample = heartRate ?? temperature ?? eda ?? spo2 ?? ecg;
      if (sample) rows.push({
        recordedAt: new Date(at).toISOString(), source: "watch", sourceTimestampNs: String(sample.timestampNs), sequence: "",
        values: {
          heartRateBpm: heartRate?.heartRate ?? null, ibiMs: heartRate?.ibiMs[0] ?? null,
          skinTemperatureCelsius: temperature?.objectTemperatureCelsius ?? null, ambientTemperatureCelsius: temperature?.ambientTemperatureCelsius ?? null,
          edaMicrosiemens: eda?.skinConductanceMicrosiemens ?? null, spo2Percent: spo2?.spo2 ?? null,
          spo2HeartRateBpm: spo2?.heartRate ?? null, ecgMillivolts: ecg?.ecgMillivolts ?? null,
          biaProgressPercent: watchStatus?.biaLast?.progressPercent ?? null,
          sweatLossMilliliters: watchStatus?.sweatLossLast?.sweatLossMilliliters ?? null,
        },
      });
    }
    forceRender();
  }, [watchStatus]);

  const toggleRecording = () => {
    if (!recording) {
      rows.clear();
      setSavedCount(0);
    }
    setRecording((current) => !current);
  };

  const saveCsv = () => {
    const headers = [
      "recorded_at_iso", "source", "source_timestamp_ns", "sequence",
      "yaw_deg", "pitch_deg", "roll_deg", "accel_x", "accel_y", "accel_z",
      "gyro_x", "gyro_y", "gyro_z", "ppg_green", "ppg_red", "ppg_ir",
      "heart_rate_bpm", "ibi_ms", "skin_temperature_celsius", "ambient_temperature_celsius", "eda_microsiemens", "spo2_percent", "spo2_heart_rate_bpm", "ecg_millivolts", "bia_progress_percent", "sweat_loss_milliliters",
    ];
    const retained = rows.toArray();
    const csv = [headers.join(","), ...retained.map((row) => [
      row.recordedAt, row.source, row.sourceTimestampNs, row.sequence,
      number(row.values.yawDeg), number(row.values.pitchDeg), number(row.values.rollDeg),
      number(row.values.accelX), number(row.values.accelY), number(row.values.accelZ),
      number(row.values.gyroX), number(row.values.gyroY), number(row.values.gyroZ),
      number(row.values.ppgGreen), number(row.values.ppgRed), number(row.values.ppgIr),
      number(row.values.heartRateBpm), number(row.values.ibiMs), number(row.values.skinTemperatureCelsius), number(row.values.ambientTemperatureCelsius), number(row.values.edaMicrosiemens), number(row.values.spo2Percent), number(row.values.spo2HeartRateBpm), number(row.values.ecgMillivolts), number(row.values.biaProgressPercent), number(row.values.sweatLossMilliliters),
    ].map(csvEscape).join(","))].join("\n");
    const download = document.createElement("a");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    download.href = url;
    download.download = `gesture-telemetry-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    download.click();
    URL.revokeObjectURL(url);
    setSavedCount(retained.length);
  };

  const rowCount = rows.length;
  const bufferFull = rowCount >= MAX_CSV_ROWS;

  // Mirrors Dashboard.tsx's IMU_SENSOR_IDS default-enabled read and the
  // continuous-tracker "idle means disabled" convention.
  const orientationEnabled = watchStatus?.sensorStatus?.orientation ?? true;
  const gyroscopeEnabled = watchStatus?.sensorStatus?.gyroscope ?? true;
  const heartRateStreaming = watchStatus?.medicalStatus?.heart_rate_continuous === "streaming";
  const skinTemperatureStreaming = watchStatus?.medicalStatus?.skin_temperature_continuous === "streaming";
  const edaStreaming = watchStatus?.medicalStatus?.eda_continuous === "streaming";

  return <main className="shell telemetry-shell">
    <header className="hero">
      <div><p className="eyebrow">Spatial Gesture Control</p><h1>Live telemetry</h1><p className="subtitle">Raw motion samples from the Sony headphones and Galaxy Watch.</p></div>
      <div className={`connection ${recording ? "online" : "offline"}`}><span className="pulse" />{recording ? "Recording" : "Not recording"}</div>
    </header>
    <section className="recording-card">
      <div>
        <span className="label">CSV capture</span>
        <strong>{recording ? "Capturing incoming samples" : "Start a capture, then save it as a CSV"}</strong>
        <small>
          {rowCount.toLocaleString()} / {MAX_CSV_ROWS.toLocaleString()} rows buffered (~{formatBytes(rowCount * ESTIMATED_BYTES_PER_CSV_ROW)} est.)
          {bufferFull ? " · buffer full, oldest rows dropping" : ""}
          {savedCount ? ` · ${savedCount} rows last saved` : ""}
        </small>
      </div>
      <div className="recording-actions"><button className={recording ? "recording" : ""} onClick={toggleRecording}>{recording ? "Stop recording" : "Start recording"}</button><button disabled={rowCount === 0} onClick={saveCsv}>Save CSV</button></div>
    </section>
    <TimeChart title="Headphone orientation" points={headPoints.toArray()} labels={["Yaw", "Pitch", "Roll"]} colors={["#65e6ff", "#b88cff", "#ffb45d"]} />
    {orientationEnabled && <TimeChart title="Watch orientation" points={watchOrientationPoints.toArray()} labels={["Yaw", "Pitch", "Roll"]} colors={["#65e6ff", "#b88cff", "#ffb45d"]} />}
    {gyroscopeEnabled && <TimeChart title="Watch gyroscope" points={watchPoints.toArray()} labels={["X", "Y", "Z"]} colors={["#4ff0b7", "#65e6ff", "#ff7da5"]} />}
    <TimeChart title="Raw PPG" points={ppgPoints.toArray()} labels={["Green", "Red", "IR"]} colors={["#4ff0b7", "#ff7da5", "#b88cff"]} />
    {heartRateStreaming && <TimeChart title="Heart rate" points={heartRatePoints.toArray()} labels={["BPM"]} colors={["#ff7da5"]} />}
    {skinTemperatureStreaming && <TimeChart title="Skin temperature" points={temperaturePoints.toArray()} labels={["Object °C", "Ambient °C"]} colors={["#ffb45d", "#65e6ff"]} />}
    {edaStreaming && <TimeChart title="Electrodermal activity" points={edaPoints.toArray()} labels={["µS"]} colors={["#b88cff"]} />}
    <TimeChart title="Blood oxygen (on-demand)" points={spo2Points.toArray()} labels={["SpO₂ %", "HR BPM"]} colors={["#4ff0b7", "#ff7da5"]} />
    <TimeChart title="ECG (on-demand)" points={ecgPoints.toArray()} labels={["mV"]} colors={["#ffb45d"]} />
    <section className="recording-card medical-controls">
      <div><span className="label">On-demand wellness captures</span><strong>Foreground-only, one at a time, and limited by the Watch SDK</strong><small>Not diagnostic measurements.</small></div>
      <div className="recording-actions">
        {["spo2_on_demand", "ecg_on_demand", "bia_on_demand", "sweat_loss_on_demand", "ppg_on_demand"].map((tracker) => {
          const state = watchStatus?.medicalStatus?.[tracker] ?? "unavailable";
          const measuring = state === "measuring";
          const anotherMeasurementActive = Object.entries(watchStatus?.medicalStatus ?? {})
            .some(([id, trackerState]) => id !== tracker && trackerState === "measuring");
          return <button key={tracker} disabled={!watchStatus?.connected || anotherMeasurementActive || (state !== "idle" && !measuring)} onClick={() => void invoke(measuring ? "stop_measurement" : "start_measurement", { tracker })}>{measuring ? `Stop ${tracker.replaceAll("_", " ")}` : `Start ${tracker.replaceAll("_", " ")} (${state})`}</button>;
        })}
      </div>
    </section>
    <p className="hint telemetry-note">Graphs retain the latest {MAX_VISIBLE_SAMPLES} points. CSV recording is bounded to the most recent {MAX_CSV_ROWS.toLocaleString()} rows (~{formatBytes(MAX_CSV_ROWS * ESTIMATED_BYTES_PER_CSV_ROW)} max); files download through the desktop WebView.</p>
  </main>;
}
