import { TimeChart } from "./TimeChart";
import { invoke } from "@tauri-apps/api/core";
import { useState, useSyncExternalStore } from "react";
import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { exportCsv, type ExportCsvResult } from "../../../shared/tauri/exportCsv";
import {
  ESTIMATED_BYTES_PER_CSV_ROW,
  GESTURE_DATASET_LABELS,
  MAX_CSV_ROWS,
  MAX_VISIBLE_SAMPLES,
  telemetryStore,
  type GestureDatasetLabel,
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

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function reportExportOutcome(operation: string, result: ExportCsvResult): void {
  if (result.status === "saved") {
    OperationFeedback.success(operation, `Saved to ${basename(result.path)}`);
  } else if (result.status === "cancelled") {
    OperationFeedback.info(operation, "Save cancelled");
  } else {
    OperationFeedback.error(operation, `Could not save: ${result.message}`);
  }
}

export function LiveTelemetry() {
  const [customLabel, setCustomLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [pendingMeasurement, setPendingMeasurement] = useState<string | null>(null);
  const [signalView, setSignalView] = useState<"all" | "motion" | "optical">("all");
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const watchStatus = telemetryStore.getWatchStatus();
  const headConnected = telemetryStore.getHeadStatus()?.connected === true;
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

  const saveCsv = async () => {
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
    const suggestedName = `gesture-telemetry-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    const result = await exportCsv({ content: csv, suggestedName, title: "Save CSV" });
    if (result.status === "saved") telemetryStore.setSavedCount(retained.length);
    reportExportOutcome("Save CSV", result);
  };

  const rowCount = telemetryStore.getRowCount();
  const bufferFull = rowCount >= MAX_CSV_ROWS;

  const selectedLabel = telemetryStore.getSelectedLabel();
  const datasetRecording = telemetryStore.getDatasetRecording();
  const datasetSession = telemetryStore.getDatasetSession();
  const datasetRowCount = telemetryStore.getDatasetRowCount();

  const exportDatasetCsv = async () => {
    const csv = telemetryStore.generateDatasetCsv();
    const label = datasetSession?.label ?? selectedLabel;
    const suggestedName = `gesture-dataset-${label}-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    const result = await exportCsv({ content: csv, suggestedName, title: "Export dataset CSV" });
    reportExportOutcome("Export dataset CSV", result);
  };

  // Mirrors Dashboard.tsx's IMU_SENSOR_IDS default-enabled read and the
  // continuous-tracker "idle means disabled" convention.
  const orientationEnabled = watchStatus?.sensorStatus?.orientation ?? true;
  const heartRateStreaming = watchStatus?.medicalStatus?.heart_rate_continuous === "streaming";
  const skinTemperatureStreaming = watchStatus?.medicalStatus?.skin_temperature_continuous === "streaming";
  const edaStreaming = watchStatus?.medicalStatus?.eda_continuous === "streaming";

  const requestMeasurement = async (tracker: string, measuring: boolean) => {
    if (!desktopAvailable || pendingMeasurement) return;
    setPendingMeasurement(tracker);
    setMeasurementError(null);
    try {
      await invoke(measuring ? "stop_measurement" : "start_measurement", { tracker });
    } catch (error) {
      setMeasurementError(`Could not ${measuring ? "stop" : "start"} the measurement: ${String(error)}`);
    } finally {
      setPendingMeasurement(null);
    }
  };

  return <main className="shell telemetry-shell">
    <header className="hero">
      <div><p className="eyebrow">Spatial Gesture Control</p><h1>Live telemetry</h1><p className="subtitle">Watch your sensor signals, capture a session, and build your gesture dataset.</p></div>
      <div className={`connection ${recording ? "online" : "offline"}`}><span className="pulse" />{recording ? "Recording" : "Not recording"}</div>
    </header>
    <div className="stream-status" aria-label="Sensor connections">
      <span><i className={headConnected ? "connected" : ""} />Headphones · {headConnected ? "Connected" : "Disconnected"}</span>
      <span><i className={watchStatus?.connected ? "connected" : ""} />Watch · {watchStatus?.connected ? "Connected" : "Disconnected"}</span>
      {!desktopAvailable && <span className="preview-label">Browser preview · connect devices in the desktop app</span>}
    </div>
    <div className="capture-grid">
    <section className="recording-card" aria-label="CSV capture">
      <div>
        <span className="label">CSV capture</span>
        <strong>{recording ? "Capturing incoming samples" : "Start a capture, then save it as a CSV"}</strong>
        <small>
          {rowCount.toLocaleString()} / {MAX_CSV_ROWS.toLocaleString()} rows buffered (~{formatBytes(rowCount * ESTIMATED_BYTES_PER_CSV_ROW)} est.)
          {bufferFull ? " · buffer full, oldest rows dropping" : ""}
          {savedCount ? ` · ${savedCount} rows last saved` : ""}
        </small>
      </div>
      <div className="recording-actions"><button className={recording ? "recording" : ""} onClick={toggleRecording}>{recording ? "Stop recording" : "Start recording"}</button><AsyncActionButton disabled={rowCount === 0} onPress={saveCsv} pendingLabel="Saving…">Save CSV</AsyncActionButton></div>
    </section>
    <section className="recording-card dataset-card" aria-label="Labeled dataset recorder">
      <div>
        <span className="label">Labeled dataset recorder</span>
        <strong>{datasetRecording ? `Recording "${datasetSession?.label}"` : "Select a label, then start a labeled capture"}</strong>
        <small>
          {datasetRowCount.toLocaleString()} rows buffered
          {datasetSession ? ` · session label: ${datasetSession.label}` : ""}
        </small>
      </div>
      <div className="recording-actions">
        <select
          aria-label="Dataset label"
          value={selectedLabel}
          disabled={datasetRecording}
          onChange={(event) => telemetryStore.selectDatasetLabel(event.target.value as GestureDatasetLabel)}
        >
          {!GESTURE_DATASET_LABELS.some((label) => label === selectedLabel) && <option value={selectedLabel}>{selectedLabel.replaceAll("_", " ")}</option>}
          {GESTURE_DATASET_LABELS.map((label) => <option key={label} value={label}>{label.replaceAll("_", " ")}</option>)}
        </select>
        <input
          aria-label="Custom dataset label"
          value={customLabel}
          disabled={datasetRecording}
          placeholder="Custom label"
          onChange={(event) => setCustomLabel(event.target.value)}
        />
        <button
          disabled={datasetRecording || customLabel.trim().length === 0}
          onClick={() => {
            if (telemetryStore.selectDatasetLabel(customLabel)) {
              setCustomLabel("");
              setLabelError(null);
            } else {
              setLabelError("Use a label beginning with a letter, followed by letters, numbers, or underscores (up to 64 characters).");
            }
          }}
        >Use custom label</button>
        <button className={datasetRecording ? "recording" : "primary-action"} onClick={() => datasetRecording ? telemetryStore.stopDatasetRecording() : telemetryStore.startDatasetRecording()}>{datasetRecording ? "Stop dataset capture" : "Start dataset capture"}</button>
        <button disabled={!datasetSession} onClick={() => telemetryStore.discardDatasetRecording()}>Discard</button>
        <AsyncActionButton disabled={datasetRowCount === 0} onPress={exportDatasetCsv} pendingLabel="Exporting…">Export Dataset CSV</AsyncActionButton>
      </div>
      {labelError && <p className="calibration-error" role="alert">{labelError}</p>}
    </section>
    </div>
    <div className="signal-heading"><div><p className="eyebrow">Signal monitor</p><h2>Incoming signals</h2></div>
      <div className="signal-filters" role="group" aria-label="Signal filters">{(["all", "motion", "optical"] as const).map((view) => <button key={view} aria-pressed={signalView === view} onClick={() => setSignalView(view)}>{view === "all" ? "All signals" : view === "motion" ? "Motion" : "Optical"}</button>)}</div>
    </div>
    <div className="signal-grid">
    {signalView !== "optical" && <TimeChart title="Headphone orientation" points={headPoints} labels={["Yaw", "Pitch", "Roll"]} unit="degrees" colors={["#65e6ff", "#b88cff", "#ffb45d"]} />}
    {signalView !== "optical" && orientationEnabled && <TimeChart title="Watch orientation" points={watchOrientationPoints} labels={["Yaw", "Pitch", "Roll"]} unit="degrees" colors={["#65e6ff", "#b88cff", "#ffb45d"]} />}
    {signalView !== "motion" && <TimeChart title="Raw PPG" points={ppgPoints} labels={["Green", "Red", "IR"]} unit="raw counts" emptyHint="Enable PPG on a supported Watch to see optical signals." colors={["#4ff0b7", "#ff7da5", "#b88cff"]} />}
    </div>
    <details className="wellness-panel"><summary>Wellness signals & on-demand captures</summary>
    <p className="hint">Additional Watch sensors depend on device support and permissions. These readings are not diagnostic measurements.</p>
    <div className="signal-grid">
    {(heartRateStreaming || heartRatePoints.length > 0) && <TimeChart title="Heart rate" points={heartRatePoints} labels={["BPM"]} colors={["#ff7da5"]} />}
    {(heartRateStreaming || ibiPoints.length > 0) && <TimeChart title="Heart rate IBI" points={ibiPoints} labels={["IBI ms"]} colors={["#4ff0b7"]} />}
    {(skinTemperatureStreaming || temperaturePoints.length > 0) && <TimeChart title="Skin temperature" points={temperaturePoints} labels={["Object °C", "Ambient °C"]} colors={["#ffb45d", "#65e6ff"]} />}
    {(edaStreaming || edaPoints.length > 0) && <TimeChart title="Electrodermal activity" points={edaPoints} labels={["µS"]} colors={["#b88cff"]} />}
    <TimeChart title="Blood oxygen (on-demand)" points={spo2Points} labels={["SpO₂ %"]} emptyHint="Start a supported blood oxygen capture below." colors={["#4ff0b7"]} />
    {spo2Points.length > 0 && <TimeChart title="Blood oxygen heart rate" points={spo2Points.map((point) => ({ ...point, values: [point.values[1]] }))} labels={["BPM"]} colors={["#ff7da5"]} />}
    <TimeChart title="ECG (on-demand)" points={ecgPoints} labels={["mV"]} emptyHint="Start a supported ECG capture below." colors={["#ffb45d"]} />
    </div>
    <section className="recording-card medical-controls">
      <div><span className="label">On-demand wellness captures</span><strong>Foreground-only, one at a time, and limited by the Watch SDK</strong><small>Not diagnostic measurements.</small></div>
      <div className="recording-actions">
        {["spo2_on_demand", "ecg_on_demand", "bia_on_demand", "sweat_loss_on_demand"].map((tracker) => {
          const state = watchStatus?.medicalStatus?.[tracker] ?? "unavailable";
          const measuring = state === "measuring";
          const anotherMeasurementActive = Object.entries(watchStatus?.medicalStatus ?? {})
            .some(([id, trackerState]) => id !== tracker && trackerState === "measuring");
          const label = ({ spo2_on_demand: "Blood oxygen", ecg_on_demand: "ECG", bia_on_demand: "Body composition", sweat_loss_on_demand: "Sweat loss" } as Record<string, string>)[tracker];
          return <button key={tracker} disabled={!desktopAvailable || pendingMeasurement !== null || !watchStatus?.connected || anotherMeasurementActive || (state !== "idle" && !measuring)} onClick={() => void requestMeasurement(tracker, measuring)}>{pendingMeasurement === tracker ? "Requesting…" : measuring ? `Stop ${label}` : `${label} · ${state === "idle" ? "Start" : state}`}</button>;
        })}
      </div>
    </section>
    {measurementError && <p className="calibration-error" role="alert">{measurementError}</p>}
    </details>
    <p className="hint telemetry-note">Graphs retain the latest {MAX_VISIBLE_SAMPLES} points. CSV recording is bounded to the most recent {MAX_CSV_ROWS.toLocaleString()} rows (~{formatBytes(MAX_CSV_ROWS * ESTIMATED_BYTES_PER_CSV_ROW)} max); files download through the desktop WebView.</p>
  </main>;
}
