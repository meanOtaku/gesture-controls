import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { exportCsv, type ExportCsvResult } from "../../../shared/tauri/exportCsv";
import { telemetryStore } from "../store/telemetryStore";

const CSV_HEADERS = [
  "recorded_at_iso", "source", "source_timestamp_ns", "sequence",
  "yaw_deg", "pitch_deg", "roll_deg", "accel_x", "accel_y", "accel_z",
  "gyro_x", "gyro_y", "gyro_z", "ppg_green", "ppg_red", "ppg_ir",
  "heart_rate_bpm", "ibi_ms", "skin_temperature_celsius", "ambient_temperature_celsius", "eda_microsiemens", "spo2_percent", "spo2_heart_rate_bpm", "ecg_millivolts", "bia_progress_percent", "sweat_loss_milliliters",
];

function number(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
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

/**
 * Owns the CSV serialization contract and native save/feedback behavior for
 * both the ordinary capture buffer and the labeled dataset recorder, so the
 * two capture cards only need to trigger these actions.
 */
export function useTelemetryExport() {
  const saveCsv = async () => {
    const retained = telemetryStore.getRows();
    const csv = [CSV_HEADERS.join(","), ...retained.map((row) => [
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

  const exportDatasetCsv = async () => {
    const csv = telemetryStore.generateDatasetCsv();
    const label = telemetryStore.getDatasetSession()?.label ?? telemetryStore.getSelectedLabel();
    const suggestedName = `gesture-dataset-${label}-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    const result = await exportCsv({ content: csv, suggestedName, title: "Export dataset CSV" });
    reportExportOutcome("Export dataset CSV", result);
  };

  return { saveCsv, exportDatasetCsv };
}
