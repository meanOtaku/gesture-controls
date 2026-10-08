import { useEffect, useRef, useSyncExternalStore } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { useTelemetryExport } from "../hooks/useTelemetryExport";
import { telemetryStore } from "../store/telemetryStore";
import { timedCapture } from "./timedCapture";

/**
 * Stops a timed capture when its time is up, and exports it. Headless and mounted for the whole app, so switching from
 * the recorder to the live charts while a capture runs does not cancel the timer.
 *
 * Timeline Capture is a timed recorder: the timer starts once the first sample actually lands (recording state, not
 * arming), and at timeout stops the session once and, if any rows were captured, exports the CSV straight to the chosen
 * folder. The effect's own cleanup, which runs on every dependency change (including the state leaving "recording" by a
 * manual stop or a discard), cancels any pending timer, so it is never armed twice or left running past its session.
 */
export function RecordingTimer() {
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const { exportDatasetCsv } = useTelemetryExport();
  const state = telemetryStore.getDatasetRecordingState();
  const mode = telemetryStore.getDatasetCaptureMode();

  // A ref, so the effect below does not re-run (and cancel its timer) each time the export closure is new.
  const exportRef = useRef(exportDatasetCsv);
  exportRef.current = exportDatasetCsv;

  useEffect(() => {
    if (mode !== "timeline" || state !== "recording") return;
    const seconds = timedCapture.take();
    if (seconds === null) return;
    const timer = setTimeout(() => {
      telemetryStore.stopDatasetRecording();
      if (telemetryStore.getDatasetRowCount() > 0) void exportRef.current();
      else OperationFeedback.error("Export dataset CSV", "No samples were captured — nothing to export.");
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [mode, state]);

  return null;
}
