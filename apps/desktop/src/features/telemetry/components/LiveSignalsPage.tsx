import { invoke } from "@tauri-apps/api/core";
import { useState, useSyncExternalStore } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { SignalMonitor, type SignalView } from "./SignalMonitor";
import { StreamStatus } from "./StreamStatus";
import { WellnessCapturePanel } from "./WellnessCapturePanel";
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

/** The live charts: what the sensors are sending right now. For checking a stream, not for recording one. */
export function LiveSignalsPage() {
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [pendingMeasurement, setPendingMeasurement] = useState<string | null>(null);
  const [signalView, setSignalView] = useState<SignalView>("all");
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);

  const watchStatus = telemetryStore.getWatchStatus();
  const headPoints = telemetryStore.getSeries("head");
  const watchOrientationPoints = telemetryStore.getSeries("watchOrientation");
  const ppgPoints = telemetryStore.getSeries("ppg");
  const watchAccelerationPoints = telemetryStore.getSeries("watchAcceleration");
  const heartRatePoints = telemetryStore.getSeries("heartRate");
  const ibiPoints = telemetryStore.getSeries("ibi");
  const temperaturePoints = telemetryStore.getSeries("temperature");
  const edaPoints = telemetryStore.getSeries("eda");
  const spo2Points = telemetryStore.getSeries("spo2");
  const ecgPoints = telemetryStore.getSeries("ecg");
  const datasetRecording = telemetryStore.getDatasetRecording();

  // Mirrors Dashboard.tsx's IMU_SENSOR_IDS default-enabled read and the
  // continuous-tracker "idle means disabled" convention.
  const orientationEnabled = watchStatus?.sensorStatus?.orientation ?? true;
  // Distinguishes why the chart has no samples once it's plausible the Watch
  // is meant to be streaming: disconnected, connected but nothing has ever
  // arrived (transport rejected it or the Watch never sent one), or the
  // backend already has a sample the UI store isn't reflecting (GC-035
  // regression triage: "Watch IMU data is no longer loading").
  const watchPaused = telemetryStore.getWatchPaused();
  const WATCH_OFF_WRIST_HINT = "Watch is off your wrist — sensors are paused to save battery. Put it on to resume.";
  const watchOrientationHint = watchPaused
    ? WATCH_OFF_WRIST_HINT
    : !watchStatus?.connected
    ? "Watch is disconnected — reconnect to resume orientation data."
    : watchOrientationPoints.length === 0 && watchStatus.lastOrientation
      ? "The Watch reports live orientation, but it isn't reaching this chart — this looks like a UI issue, please report it."
      : watchOrientationPoints.length === 0
        ? "Connected, but no orientation samples have arrived yet — check the Watch transport or pairing."
        : undefined;
  const accelerationEnabled = watchStatus?.sensorStatus?.acceleration ?? true;
  const watchAccelerationHint = watchPaused
    ? WATCH_OFF_WRIST_HINT
    : !watchStatus?.connected
      ? "Watch is disconnected — reconnect to resume acceleration data."
      : watchAccelerationPoints.length === 0
        ? "Connected, but no acceleration samples have arrived yet — they arrive with each orientation sample."
        : undefined;
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
      <div><p className="eyebrow">Spatial Gesture Control</p><h1>Live signals</h1><p className="subtitle">Watch what your sensors are sending right now. To record a session, use the Recorder.</p></div>
      <div className={`connection ${datasetRecording ? "online" : "offline"}`}><span className="pulse" />{datasetRecording ? "Recording" : "Not recording"}</div>
    </header>
    <StreamStatus />
    <div className="card-stack">
      <SignalMonitor
        signalView={signalView}
        onSignalViewChange={setSignalView}
        orientationEnabled={orientationEnabled}
        headPoints={headPoints}
        watchOrientationPoints={watchOrientationPoints}
        watchAccelerationPoints={watchAccelerationPoints}
        accelerationEnabled={accelerationEnabled}
        watchAccelerationHint={watchAccelerationHint}
        ppgPoints={ppgPoints}
        watchOrientationHint={watchOrientationHint}
        ppgHint={watchPaused ? WATCH_OFF_WRIST_HINT : undefined}
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
      <p className="hint telemetry-note">Graphs retain the latest {MAX_VISIBLE_SAMPLES} points. Timeline recording is bounded to the most recent {MAX_CSV_ROWS.toLocaleString()} rows (~{formatBytes(MAX_CSV_ROWS * ESTIMATED_BYTES_PER_CSV_ROW)} max).</p>
    </div>
  </main>;
}
