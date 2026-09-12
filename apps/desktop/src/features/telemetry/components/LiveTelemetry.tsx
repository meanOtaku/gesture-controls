import { invoke } from "@tauri-apps/api/core";
import { useState, useSyncExternalStore } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { CsvCaptureCard } from "./CsvCaptureCard";
import { DatasetCaptureCard } from "./DatasetCaptureCard";
import { SignalMonitor, type SignalView } from "./SignalMonitor";
import { WellnessCapturePanel } from "./WellnessCapturePanel";
import { useTelemetryExport } from "../hooks/useTelemetryExport";
import {
  ESTIMATED_BYTES_PER_CSV_ROW,
  MAX_CSV_ROWS,
  MAX_VISIBLE_SAMPLES,
  telemetryStore,
} from "../store/telemetryStore";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LiveTelemetry() {
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [pendingMeasurement, setPendingMeasurement] = useState<string | null>(null);
  const [signalView, setSignalView] = useState<SignalView>("all");
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const { saveCsv, exportDatasetCsv } = useTelemetryExport();

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
  const rowCount = telemetryStore.getRowCount();

  const selectedLabel = telemetryStore.getSelectedLabel();
  const datasetRecording = telemetryStore.getDatasetRecording();
  const datasetSession = telemetryStore.getDatasetSession();
  const datasetRowCount = telemetryStore.getDatasetRowCount();

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
      OperationFeedback.success("Wellness measurement", `${measuring ? "Stopped" : "Started"} ${tracker.replaceAll("_", " ")}.`);
    } catch (error) {
      setMeasurementError(`Could not ${measuring ? "stop" : "start"} the measurement: ${String(error)}`);
      OperationFeedback.error("Wellness measurement", String(error));
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
      <CsvCaptureCard
        recording={recording}
        rowCount={rowCount}
        savedCount={savedCount}
        onToggleRecording={() => telemetryStore.toggleRecording()}
        onSaveCsv={saveCsv}
      />
      <DatasetCaptureCard
        selectedLabel={selectedLabel}
        datasetRecording={datasetRecording}
        datasetSession={datasetSession}
        datasetRowCount={datasetRowCount}
        onSelectLabel={(label) => telemetryStore.selectDatasetLabel(label)}
        onStart={() => telemetryStore.startDatasetRecording()}
        onStop={() => telemetryStore.stopDatasetRecording()}
        onDiscard={() => telemetryStore.discardDatasetRecording()}
        onExport={exportDatasetCsv}
      />
    </div>
    <SignalMonitor
      signalView={signalView}
      onSignalViewChange={setSignalView}
      orientationEnabled={orientationEnabled}
      headPoints={headPoints}
      watchOrientationPoints={watchOrientationPoints}
      ppgPoints={ppgPoints}
    />
    <WellnessCapturePanel
      desktopAvailable={desktopAvailable}
      watchStatus={watchStatus}
      heartRateStreaming={heartRateStreaming}
      skinTemperatureStreaming={skinTemperatureStreaming}
      edaStreaming={edaStreaming}
      heartRatePoints={heartRatePoints}
      ibiPoints={ibiPoints}
      temperaturePoints={temperaturePoints}
      edaPoints={edaPoints}
      spo2Points={spo2Points}
      ecgPoints={ecgPoints}
      pendingMeasurement={pendingMeasurement}
      measurementError={measurementError}
      onRequestMeasurement={(tracker, measuring) => { void requestMeasurement(tracker, measuring); }}
    />
    <p className="hint telemetry-note">Graphs retain the latest {MAX_VISIBLE_SAMPLES} points. CSV recording is bounded to the most recent {MAX_CSV_ROWS.toLocaleString()} rows (~{formatBytes(MAX_CSV_ROWS * ESTIMATED_BYTES_PER_CSV_ROW)} max); files save through your operating system's native save dialog.</p>
  </main>;
}
