import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import {
  ESTIMATED_BYTES_PER_CSV_ROW,
  MAX_CSV_ROWS,
  MAX_VISIBLE_SAMPLES,
  telemetryStore,
  type SeriesPoint,
} from "../store/telemetryStore";

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

export function LiveTelemetry() {
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const watchStatus = telemetryStore.getWatchStatus();
  const recording = telemetryStore.getRecording();
  const savedCount = telemetryStore.getSavedCount();
  const headPoints = telemetryStore.getSeries("head");
  const watchOrientationPoints = telemetryStore.getSeries("watchOrientation");
  const ppgPoints = telemetryStore.getSeries("ppg");
  const heartRatePoints = telemetryStore.getSeries("heartRate");
  const ibiPoints = telemetryStore.getSeries("ibi");
  const temperaturePoints = telemetryStore.getSeries("temperature");
  const edaPoints = telemetryStore.getSeries("eda");
  const spo2Points = telemetryStore.getSeries("spo2");
  const ecgPoints = telemetryStore.getSeries("ecg");

  const toggleRecording = () => telemetryStore.toggleRecording();

  const saveCsv = () => {
    const headers = [
      "recorded_at_iso", "source", "source_timestamp_ns", "sequence",
      "yaw_deg", "pitch_deg", "roll_deg", "accel_x", "accel_y", "accel_z",
      "gyro_x", "gyro_y", "gyro_z", "ppg_green", "ppg_red", "ppg_ir",
      "heart_rate_bpm", "ibi_ms", "skin_temperature_celsius", "ambient_temperature_celsius", "eda_microsiemens", "spo2_percent", "spo2_heart_rate_bpm", "ecg_millivolts", "bia_progress_percent", "sweat_loss_milliliters",
    ];
    const retained = telemetryStore.getRows();
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
    telemetryStore.setSavedCount(retained.length);
  };

  const rowCount = telemetryStore.getRowCount();
  const bufferFull = rowCount >= MAX_CSV_ROWS;

  // Mirrors Dashboard.tsx's IMU_SENSOR_IDS default-enabled read and the
  // continuous-tracker "idle means disabled" convention.
  const orientationEnabled = watchStatus?.sensorStatus?.orientation ?? true;
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
    <TimeChart title="Headphone orientation" points={headPoints} labels={["Yaw", "Pitch", "Roll"]} colors={["#65e6ff", "#b88cff", "#ffb45d"]} />
    {orientationEnabled && <TimeChart title="Watch orientation" points={watchOrientationPoints} labels={["Yaw", "Pitch", "Roll"]} colors={["#65e6ff", "#b88cff", "#ffb45d"]} />}
    <TimeChart title="Raw PPG" points={ppgPoints} labels={["Green", "Red", "IR"]} colors={["#4ff0b7", "#ff7da5", "#b88cff"]} />
    {heartRateStreaming && <TimeChart title="Heart rate" points={heartRatePoints} labels={["BPM"]} colors={["#ff7da5"]} />}
    {heartRateStreaming && <TimeChart title="Heart rate IBI" points={ibiPoints} labels={["IBI ms"]} colors={["#4ff0b7"]} />}
    {skinTemperatureStreaming && <TimeChart title="Skin temperature" points={temperaturePoints} labels={["Object °C", "Ambient °C"]} colors={["#ffb45d", "#65e6ff"]} />}
    {edaStreaming && <TimeChart title="Electrodermal activity" points={edaPoints} labels={["µS"]} colors={["#b88cff"]} />}
    <TimeChart title="Blood oxygen (on-demand)" points={spo2Points} labels={["SpO₂ %", "HR BPM"]} colors={["#4ff0b7", "#ff7da5"]} />
    <TimeChart title="ECG (on-demand)" points={ecgPoints} labels={["mV"]} colors={["#ffb45d"]} />
    <section className="recording-card medical-controls">
      <div><span className="label">On-demand wellness captures</span><strong>Foreground-only, one at a time, and limited by the Watch SDK</strong><small>Not diagnostic measurements.</small></div>
      <div className="recording-actions">
        {["spo2_on_demand", "ecg_on_demand", "bia_on_demand", "sweat_loss_on_demand"].map((tracker) => {
          const state = watchStatus?.medicalStatus?.[tracker] ?? "unavailable";
          const measuring = state === "measuring";
          const anotherMeasurementActive = Object.entries(watchStatus?.medicalStatus ?? {})
            .some(([id, trackerState]) => id !== tracker && trackerState === "measuring");
          const label = tracker.replaceAll("_", " ");
          return <button key={tracker} disabled={!watchStatus?.connected || anotherMeasurementActive || (state !== "idle" && !measuring)} onClick={() => void invoke(measuring ? "stop_measurement" : "start_measurement", { tracker })}>{measuring ? `Stop ${label}` : `Start ${label} (${state})`}</button>;
        })}
      </div>
    </section>
    <p className="hint telemetry-note">Graphs retain the latest {MAX_VISIBLE_SAMPLES} points. CSV recording is bounded to the most recent {MAX_CSV_ROWS.toLocaleString()} rows (~{formatBytes(MAX_CSV_ROWS * ESTIMATED_BYTES_PER_CSV_ROW)} max); files download through the desktop WebView.</p>
  </main>;
}
