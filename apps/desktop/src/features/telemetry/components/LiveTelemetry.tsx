import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { DatasetCaptureCard } from "./DatasetCaptureCard";
import { RawImageViewerPanel } from "./RawImageViewerPanel";
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
  const { exportDatasetCsv, saveDatasetRecording, datasetExportFolder, chooseDatasetExportFolder } = useTelemetryExport();

  const watchStatus = telemetryStore.getWatchStatus();
  const headConnected = telemetryStore.getHeadStatus()?.connected === true;
  const headPoints = telemetryStore.getSeries("head");
  const watchOrientationPoints = telemetryStore.getSeries("watchOrientation");
  const ppgPoints = telemetryStore.getSeries("ppg");
  const heartRatePoints = telemetryStore.getSeries("heartRate");
  const ibiPoints = telemetryStore.getSeries("ibi");
  const temperaturePoints = telemetryStore.getSeries("temperature");
  const edaPoints = telemetryStore.getSeries("eda");
  const spo2Points = telemetryStore.getSeries("spo2");
  const ecgPoints = telemetryStore.getSeries("ecg");

  const selectedLabel = telemetryStore.getSelectedLabel();
  const sessionLabels = telemetryStore.getSessionLabels();
  const datasetRecording = telemetryStore.getDatasetRecording();
  const datasetRecordingState = telemetryStore.getDatasetRecordingState();
  const datasetSession = telemetryStore.getDatasetSession();
  const datasetRowCount = telemetryStore.getDatasetRowCount();
  const datasetElapsedMs = telemetryStore.getDatasetRecordingElapsedMs();
  const captureMode = telemetryStore.getDatasetCaptureMode();
  const activeMarkerLabel = telemetryStore.getActiveTimelineLabel();

  // Mirrors Dashboard.tsx's IMU_SENSOR_IDS default-enabled read and the
  // continuous-tracker "idle means disabled" convention.
  const orientationEnabled = watchStatus?.sensorStatus?.orientation ?? true;
  const heartRateStreaming = watchStatus?.medicalStatus?.heart_rate_continuous === "streaming";
  const skinTemperatureStreaming = watchStatus?.medicalStatus?.skin_temperature_continuous === "streaming";
  const edaStreaming = watchStatus?.medicalStatus?.eda_continuous === "streaming";

  // Kept as a ref (not a dependency) so the timed-capture effect below doesn't
  // re-run — and clear its pending timeout — on every render caused by
  // useTelemetryExport() returning a fresh exportDatasetCsv closure.
  const exportDatasetCsvRef = useRef(exportDatasetCsv);
  exportDatasetCsvRef.current = exportDatasetCsv;

  const pendingTimelineDurationSecondsRef = useRef<number | null>(null);
  const timelineTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Timeline Capture is a timed recorder: the timer starts once the first sample actually
  // lands (recording state, not arming), and at timeout stops the session once and, if any
  // rows were captured, auto-exports the CSV straight to the selected export folder. The
  // effect's own cleanup — which fires on every dependency change, including the state
  // leaving "recording" via manual stop/discard, a mode switch, or unmount — cancels any
  // pending timer, so it's never armed twice or left running past its owning session.
  useEffect(() => {
    if (captureMode === "timeline" && datasetRecordingState === "recording" && pendingTimelineDurationSecondsRef.current !== null) {
      const seconds = pendingTimelineDurationSecondsRef.current;
      pendingTimelineDurationSecondsRef.current = null;
      timelineTimeoutRef.current = setTimeout(() => {
        timelineTimeoutRef.current = null;
        telemetryStore.stopDatasetRecording();
        if (telemetryStore.getDatasetRowCount() > 0) {
          void exportDatasetCsvRef.current();
        } else {
          OperationFeedback.error("Export dataset CSV", "No samples were captured — nothing to export.");
        }
      }, seconds * 1000);
    }
    return () => {
      if (timelineTimeoutRef.current !== null) {
        clearTimeout(timelineTimeoutRef.current);
        timelineTimeoutRef.current = null;
      }
    };
  }, [captureMode, datasetRecordingState]);

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
      <div className={`connection ${datasetRecording ? "online" : "offline"}`}><span className="pulse" />{datasetRecording ? "Recording" : "Not recording"}</div>
    </header>
    <div className="stream-status" aria-label="Sensor connections">
      <span><i className={headConnected ? "connected" : ""} />Headphones · {headConnected ? "Connected" : "Disconnected"}</span>
      <span><i className={watchStatus?.connected ? "connected" : ""} />Watch · {watchStatus?.connected ? "Connected" : "Disconnected"}</span>
      {!desktopAvailable && <span className="preview-label">Browser preview · connect devices in the desktop app</span>}
    </div>
    <Tabs defaultValue="live">
      <TabsList>
        <TabsTrigger value="live">Live</TabsTrigger>
        <TabsTrigger value="rawViewer">Raw image viewer</TabsTrigger>
      </TabsList>
      <TabsContent value="live" className="card-stack">
        <DatasetCaptureCard
          selectedLabel={selectedLabel}
          sessionLabels={sessionLabels}
          onRemoveLabel={(label) => telemetryStore.removeSessionLabel(label)}
          getLabelRemovalBlockedReason={(label) => telemetryStore.labelRemovalBlockedReason(label)}
          desktopAvailable={desktopAvailable}
          datasetExportFolder={datasetExportFolder}
          onChooseExportFolder={async () => { await chooseDatasetExportFolder(); }}
          datasetRecording={datasetRecording}
          datasetRecordingState={datasetRecordingState}
          datasetSession={datasetSession}
          datasetRowCount={datasetRowCount}
          datasetElapsedMs={datasetElapsedMs}
          onSelectLabel={(label) => telemetryStore.selectDatasetLabel(label)}
          activeMarkerLabel={activeMarkerLabel}
          onMarkStart={() => {
            if (!selectedLabel) return;
            telemetryStore.setTimelineLabel(selectedLabel, "hotkey_hold");
          }}
          onMarkEnd={() => telemetryStore.setTimelineLabel(null)}
          onStart={(timelineDurationSeconds) => {
            pendingTimelineDurationSecondsRef.current = timelineDurationSeconds;
            telemetryStore.startDatasetRecording();
          }}
          onStop={() => {
            telemetryStore.stopDatasetRecording();
            void saveDatasetRecording();
          }}
          onDiscard={() => telemetryStore.discardDatasetRecording()}
          onExport={exportDatasetCsv}
        />
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
        <p className="hint telemetry-note">Graphs retain the latest {MAX_VISIBLE_SAMPLES} points. Timeline recording is bounded to the most recent {MAX_CSV_ROWS.toLocaleString()} rows (~{formatBytes(MAX_CSV_ROWS * ESTIMATED_BYTES_PER_CSV_ROW)} max).</p>
      </TabsContent>
      <TabsContent value="rawViewer">
        {desktopAvailable ? (
          <RawImageViewerPanel />
        ) : (
          <p className="hint">The raw image viewer reads saved recording bundles from the desktop app's data directory and is unavailable in browser preview.</p>
        )}
      </TabsContent>
    </Tabs>
  </main>;
}
