import { invoke } from "@tauri-apps/api/core";
import { lastRecording } from "../recording/lastRecording";
import { useSyncExternalStore } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { chooseExportFolder, exportCsvToFolder, isTauriDesktop, type ExportCsvResult } from "../../../shared/tauri/exportCsv";
import { saveRecordingBundle, type SaveRecordingBundleResult, type StopReason } from "../../../shared/tauri/recordingBundle";
import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import { exportFolderStore } from "../store/exportFolderStore";
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
  // One setting for every export, shared and remembered (see `exportFolderStore`).
  const datasetExportFolder = useSyncExternalStore(exportFolderStore.subscribe, exportFolderStore.get, exportFolderStore.get);
  const datasetExportFormat = useSyncExternalStore(exportFolderStore.subscribe, exportFolderStore.getFormat, exportFolderStore.getFormat);

  const chooseDatasetExportFolder = async () => {
    const folder = await chooseExportFolder("Choose dataset export folder");
    if (folder) exportFolderStore.set(folder);
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
   * Exports the session as a folder of two dense files, `ppg.csv` and `imu.csv`, into the chosen export folder. This is the
   * dataset format Model Lab imports as one folder and the trainer reads, with no blank cells in either file.
   */
  const exportDatasetFolder = async () => {
    const operation = "Export dataset folder";
    if (!isTauriDesktop()) {
      OperationFeedback.error(operation, "Exporting a folder needs the desktop app. The browser preview can export one CSV file.");
      return;
    }
    if (!datasetExportFolder) {
      OperationFeedback.error(operation, "Choose an output folder first.");
      return;
    }
    const label = telemetryStore.getDatasetSession()?.label || telemetryStore.getSelectedLabel() || "unlabeled";
    const name = `gesture-dataset-${label}-${new Date().toISOString().replaceAll(":", "-")}`;
    const files = telemetryStore.generateDatasetFolderFiles();
    try {
      const written = await invoke<string>("export_dataset_folder", { parent: datasetExportFolder, name, ppgCsv: files.ppgCsv, imuCsv: files.imuCsv, ppgClockCsv: files.ppgClockCsv });
      OperationFeedback.success(operation, `Saved ${basename(written)} (${files.ppgRows.toLocaleString()} pulse rows, ${files.imuRows.toLocaleString()} motion rows)`);
    } catch (error) {
      OperationFeedback.error(operation, `Could not save: ${String(error)}`);
    }
  };

  /**
   * Exports the session as the export setting says: a folder of two files, or one CSV. The browser preview, which cannot
   * write a folder, always downloads one CSV.
   */
  const exportDataset = async () => {
    if (!isTauriDesktop() || exportFolderStore.getFormat() === "csv") return exportDatasetCsv();
    return exportDatasetFolder();
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
  const saveDatasetRecording = async (stopReason: StopReason = "manual_stop") => {
    const payload = telemetryStore.buildRecordingBundlePayload(stopReason);
    if (!payload) return cameraAssist.disarm();
    const result = await saveRecordingBundle(payload);
    reportRecordingBundleOutcome(result);
    if (result.status === "saved") {
      cameraAssist.finish();
      lastRecording.set({ recordingId: result.recordingId, rowCount: result.rowCount, intervalCount: result.intervalCount, savedAt: Date.now() });
    }
    else cameraAssist.disarm();
    return result;
  };

  return { exportDataset, exportDatasetCsv, exportDatasetFolder, saveDatasetRecording, datasetExportFolder, datasetExportFormat, chooseDatasetExportFolder };
}
