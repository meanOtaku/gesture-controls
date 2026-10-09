import { useSyncExternalStore } from "react";
import { CameraCapturePanel } from "../../camera/components/CameraCapturePanel";
import { CameraAssistCard } from "../../gestureLibrary/CameraAssistCard";
import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import { DatasetCaptureCard } from "./DatasetCaptureCard";
import { StreamStatus } from "./StreamStatus";
import { useTelemetryExport } from "../hooks/useTelemetryExport";
import { timedCapture } from "../recording/timedCapture";
import { telemetryStore } from "../store/telemetryStore";

/**
 * Records a session: choose a label (or mark intervals on a timeline), start, perform the gesture, stop. A timed
 * capture is ended by `RecordingTimer`, which lives outside this page so leaving it does not cancel the timer.
 */
export function RecorderPage() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const { exportDatasetCsv, saveDatasetRecording, datasetExportFolder, chooseDatasetExportFolder } = useTelemetryExport();

  const selectedLabel = telemetryStore.getSelectedLabel();
  const sessionLabels = telemetryStore.getSessionLabels();
  const datasetRecording = telemetryStore.getDatasetRecording();
  const datasetRecordingState = telemetryStore.getDatasetRecordingState();
  const datasetSession = telemetryStore.getDatasetSession();
  const datasetRowCount = telemetryStore.getDatasetRowCount();
  const datasetElapsedMs = telemetryStore.getDatasetRecordingElapsedMs();
  const activeMarkerLabel = telemetryStore.getActiveTimelineLabel();

  return <main className="shell telemetry-shell">
    <header className="hero">
      <div><p className="eyebrow">Spatial Gesture Control</p><h1>Recorder</h1><p className="subtitle">Record a labelled session from the watch, then export it or import it into Model Lab.</p></div>
      <div className={`connection ${datasetRecording ? "online" : "offline"}`}><span className="pulse" />{datasetRecording ? "Recording" : "Not recording"}</div>
    </header>
    <StreamStatus />
    <div className="card-stack">
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
          // With camera marking on, the recording is a timeline with no manual marks; the camera adds them on stop.
          const assisted = cameraAssist.isEnabled() && selectedLabel !== null;
          if (assisted) telemetryStore.setDatasetCaptureMode("timeline");
          timedCapture.request(timelineDurationSeconds);
          if (telemetryStore.startDatasetRecording() && assisted) cameraAssist.arm(selectedLabel);
        }}
        onStop={() => {
          telemetryStore.stopDatasetRecording();
          void saveDatasetRecording();
        }}
        onDiscard={() => { cameraAssist.disarm(); telemetryStore.discardDatasetRecording(); }}
        onExport={exportDatasetCsv}
        getDatasetRows={() => telemetryStore.getDatasetRows()}
        timelineIntervals={telemetryStore.getTimelineIntervals()}
      />
      <CameraAssistCard selectedLabel={selectedLabel} recording={datasetRecording} desktopAvailable={desktopAvailable} />
      <CameraCapturePanel />
    </div>
  </main>;
}
