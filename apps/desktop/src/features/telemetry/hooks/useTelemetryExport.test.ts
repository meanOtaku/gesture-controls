import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTelemetryExport } from "./useTelemetryExport";
import { telemetryStore } from "../store/telemetryStore";
import { resetFeedbackForTests } from "../../../components/app/OperationFeedback";

const { exportCsv } = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock("../../../shared/tauri/exportCsv", () => ({ exportCsv }));

beforeEach(() => { telemetryStore.reset(); exportCsv.mockReset(); resetFeedbackForTests(); });

describe("useTelemetryExport", () => {
  it("saves the buffered rows as CSV and records the saved count on success", async () => {
    telemetryStore.toggleRecording();
    telemetryStore.ingestHeadPose({
      device: "sony-test", quaternion: [1, 0, 0, 0], yawDeg: 1, pitchDeg: 2, rollDeg: 3,
      gyroscope: [0, 0, 0], packetsPerSecond: 60, receiveLatencyMs: 5, resetCounter: 0,
    });
    exportCsv.mockResolvedValue({ status: "saved", path: "/tmp/out.csv" });

    const { saveCsv } = useTelemetryExport();
    await saveCsv();

    expect(exportCsv).toHaveBeenCalledTimes(1);
    const call = exportCsv.mock.calls[0][0];
    expect(call.title).toBe("Save CSV");
    expect(call.content.split("\n")[0]).toBe(
      "recorded_at_iso,source,source_timestamp_ns,sequence,yaw_deg,pitch_deg,roll_deg,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,ppg_green,ppg_red,ppg_ir,heart_rate_bpm,ibi_ms,skin_temperature_celsius,ambient_temperature_celsius,eda_microsiemens,spo2_percent,spo2_heart_rate_bpm,ecg_millivolts,bia_progress_percent,sweat_loss_milliliters",
    );
    expect(call.content).toContain("1,2,3");
    expect(telemetryStore.getSavedCount()).toBe(1);
  });

  it("does not record a saved count when the save is cancelled", async () => {
    telemetryStore.toggleRecording();
    telemetryStore.ingestHeadPose({
      device: "sony-test", quaternion: [1, 0, 0, 0], yawDeg: 1, pitchDeg: 2, rollDeg: 3,
      gyroscope: [0, 0, 0], packetsPerSecond: 60, receiveLatencyMs: 5, resetCounter: 0,
    });
    exportCsv.mockResolvedValue({ status: "cancelled" });

    const { saveCsv } = useTelemetryExport();
    await saveCsv();

    expect(telemetryStore.getSavedCount()).toBe(0);
  });

  it("exports the labeled dataset CSV using the active session label in the suggested filename", async () => {
    telemetryStore.startDatasetRecording();
    exportCsv.mockResolvedValue({ status: "error", message: "disk full" });

    const { exportDatasetCsv } = useTelemetryExport();
    await exportDatasetCsv();

    expect(exportCsv).toHaveBeenCalledTimes(1);
    const call = exportCsv.mock.calls[0][0];
    expect(call.title).toBe("Export dataset CSV");
    expect(call.suggestedName).toContain(`gesture-dataset-${telemetryStore.getDatasetSession()?.label}-`);
  });
});
