import { useEffect, useRef, useSyncExternalStore, memo } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { useTelemetryExport } from "../hooks/useTelemetryExport";
import { telemetryStore } from "../store/telemetryStore";
import { timedCapture } from "./timedCapture";
import { isTauriDesktop } from "../../../shared/tauri/exportCsv";
import { exportFolderStore } from "../store/exportFolderStore";

/**
 * Stops a timed capture when its time is up, and exports it. Headless and mounted for the whole app, so switching from
 * the recorder to the live charts while a capture runs does not cancel the timer.
 *
 * Timeline Capture is a timed recorder: the timer starts once the first sample actually lands (recording state, not
 * arming), and at timeout stops the session once and, if any rows were captured, exports it straight to the chosen
 * folder in the form the export settings say (one CSV in the browser preview, which cannot write
 * a folder). The effect's own cleanup, which runs on every dependency change (including the state leaving "recording" by a
 * manual stop or a discard), cancels any pending timer, so it is never armed twice or left running past its session.
 */
function RecordingTimerView() {
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const { exportDataset, saveDatasetRecording } = useTelemetryExport();
  const state = telemetryStore.getDatasetRecordingState();
  const mode = telemetryStore.getDatasetCaptureMode();

  // A ref, so the effect below does not re-run (and cancel its timer) each time the export closure is new.
  const exportRef = useRef(exportDataset);
  exportRef.current = exportDataset;
  const saveRef = useRef(saveDatasetRecording);
  saveRef.current = saveDatasetRecording;

  useEffect(() => {
    if (mode !== "timeline" || state !== "recording") return;
    const seconds = timedCapture.take();
    if (seconds === null) return;
    timedCapture.setRunning({ deadlineMs: Date.now() + seconds * 1000, totalSeconds: seconds });
    const timer = setTimeout(() => {
      timedCapture.setRunning(null);
      telemetryStore.stopDatasetRecording();
      // As with a manual stop, the session is also kept as a recording bundle (with the camera's landmarks, if any).
      void saveRef.current("timer_elapsed");
      // The recording is saved in the app either way; it is exported too only where an export folder was chosen (the
      // Labelling page's export settings), or downloaded as one CSV in the browser preview.
      if (telemetryStore.getDatasetRowCount() === 0) OperationFeedback.error("Export dataset", "No samples were captured — nothing to export.");
      else if (!isTauriDesktop() || exportFolderStore.get()) void exportRef.current();
    }, seconds * 1000);
    return () => {
      clearTimeout(timer);
      timedCapture.setRunning(null);
    };
  }, [mode, state]);

  return null;
}

/** Memoized: the app re-renders on every telemetry publish (~15 a second), and this shows nothing from it. */
export const RecordingTimer = memo(RecordingTimerView);
