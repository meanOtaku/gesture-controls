import { useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { chooseExportFolder, exportCsvToFolder, isTauriDesktop, type ExportCsvResult } from "../../../shared/tauri/exportCsv";
import { saveRecordingBundle, type SaveRecordingBundleResult } from "../../../shared/tauri/recordingBundle";
import { telemetryStore } from "../store/telemetryStore";

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

function reportRecordingBundleOutcome(result: SaveRecordingBundleResult): void {
  const operation = "Save recording";
  if (result.status === "saved") {
    OperationFeedback.success(operation, `Saved recording ${result.recordingId} (${result.rowCount} rows)`);
  } else {
    OperationFeedback.error(operation, `Could not save recording bundle: ${result.message}`);
  }
}

/**
 * Owns the CSV serialization contract and native save/feedback behavior for
 * the Timeline-oriented dataset recorder, so the capture card only needs to
 * trigger these actions.
 */
export function useTelemetryExport() {
  // Session-only: no established lightweight local-setting store exists yet
  // to persist this across app restarts (see settings.rs's heavier
  // validated-settings-blob pattern, which this single path isn't worth
  // wiring into) — the user re-picks the export folder each session.
  const [datasetExportFolder, setDatasetExportFolder] = useState<string | null>(null);

  const chooseDatasetExportFolder = async () => {
    const folder = await chooseExportFolder("Choose dataset export folder");
    if (folder) setDatasetExportFolder(folder);
    return folder;
  };

  const exportDatasetCsv = async () => {
    const csv = telemetryStore.generateDatasetCsv();
    // Timeline Capture's session label is always "" (its per-row labels live in
    // `timelineIntervals` instead), so an empty string must fall through here too,
    // not just a missing session/selected label.
    const label = telemetryStore.getDatasetSession()?.label || telemetryStore.getSelectedLabel() || "unlabeled";
    const fileName = `gesture-dataset-${label}-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    if (isTauriDesktop() && !datasetExportFolder) {
      // The UI disables Export until a folder is chosen; this only guards against that
      // invariant slipping, and must never fall back to an arbitrary save location.
      OperationFeedback.error("Export dataset CSV", "Choose an output folder first.");
      return;
    }
    const result = await exportCsvToFolder({ content: csv, folder: datasetExportFolder ?? "", fileName });
    reportExportOutcome("Export dataset CSV", result);
  };

  /**
   * Persists the recorded session as an immutable recording bundle (raw.csv +
   * recording.json + annotations.json) in the app's own data directory,
   * independent of the manual "Export Dataset CSV" folder export above.
   * Called right after a manual Stop, so it never races later interval
   * edits. A no-sample session (armed then stopped with nothing captured)
   * has no bundle to write and is silently skipped rather than reported as a
   * failure.
   */
  const saveDatasetRecording = async () => {
    const payload = telemetryStore.buildRecordingBundlePayload("manual_stop");
    if (!payload) return;
    const result = await saveRecordingBundle(payload);
    reportRecordingBundleOutcome(result);
  };

  return { exportDatasetCsv, saveDatasetRecording, datasetExportFolder, chooseDatasetExportFolder };
}
