import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTelemetryExport } from "./useTelemetryExport";
import { telemetryStore } from "../store/telemetryStore";
import { resetFeedbackForTests } from "../../../components/app/OperationFeedback";

const { exportCsv, exportCsvToFolder, chooseExportFolder, isTauriDesktop } = vi.hoisted(() => ({
  exportCsv: vi.fn(),
  exportCsvToFolder: vi.fn(),
  chooseExportFolder: vi.fn(),
  isTauriDesktop: vi.fn(() => false),
}));
vi.mock("../../../shared/tauri/exportCsv", () => ({ exportCsv, exportCsvToFolder, chooseExportFolder, isTauriDesktop }));

beforeEach(() => {
  telemetryStore.reset();
  exportCsv.mockReset();
  exportCsvToFolder.mockReset();
  chooseExportFolder.mockReset();
  isTauriDesktop.mockReturnValue(false);
  resetFeedbackForTests();
});

describe("useTelemetryExport", () => {
  it("saves the buffered rows as CSV and records the saved count on success", async () => {
    telemetryStore.toggleRecording();
    telemetryStore.ingestHeadPose({
      device: "sony-test", quaternion: [1, 0, 0, 0], yawDeg: 1, pitchDeg: 2, rollDeg: 3,
      gyroscope: [0, 0, 0], packetsPerSecond: 60, receiveLatencyMs: 5, resetCounter: 0,
    });
    exportCsv.mockResolvedValue({ status: "saved", path: "/tmp/out.csv" });

    const { result } = renderHook(() => useTelemetryExport());
    await act(() => result.current.saveCsv());

    expect(exportCsv).toHaveBeenCalledTimes(1);
    const call = exportCsv.mock.calls[0][0];
    expect(call.title).toBe("Save CSV");
    expect(call.content.split("\n")[0]).toBe(
      "recorded_at_iso,source,source_timestamp_ns,sequence,yaw_deg,pitch_deg,roll_deg,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,ppg_green,ppg_red,ppg_ir,heart_rate_bpm,ibi_ms,skin_temperature_celsius,ambient_temperature_celsius,eda_microsiemens,spo2_percent,spo2_heart_rate_bpm,ecg_millivolts,bia_progress_percent,sweat_loss_milliliters,label",
    );
    expect(call.content).toContain("1,2,3");
    expect(call.content.split("\n")[1].endsWith(",")).toBe(true);
    expect(telemetryStore.getSavedCount()).toBe(1);
  });

  it("stamps the applied ordinary label onto rows captured after it was applied, and clears back to default", async () => {
    // Distinct timestamps so the per-channel recording-rate throttle doesn't
    // collapse these three same-millisecond ingests into fewer rows.
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    telemetryStore.toggleRecording();
    telemetryStore.ingestHeadPose({
      device: "sony-test", quaternion: [1, 0, 0, 0], yawDeg: 1, pitchDeg: 2, rollDeg: 3,
      gyroscope: [0, 0, 0], packetsPerSecond: 60, receiveLatencyMs: 5, resetCounter: 0,
    });
    expect(telemetryStore.applyOrdinaryLabel("  gesture_1  ")).toBe(true);
    expect(telemetryStore.getAppliedOrdinaryLabel()).toBe("gesture_1");
    now += 1000;
    telemetryStore.ingestHeadPose({
      device: "sony-test", quaternion: [1, 0, 0, 0], yawDeg: 4, pitchDeg: 5, rollDeg: 6,
      gyroscope: [0, 0, 0], packetsPerSecond: 60, receiveLatencyMs: 5, resetCounter: 0,
    });
    telemetryStore.clearOrdinaryLabel();
    now += 1000;
    telemetryStore.ingestHeadPose({
      device: "sony-test", quaternion: [1, 0, 0, 0], yawDeg: 7, pitchDeg: 8, rollDeg: 9,
      gyroscope: [0, 0, 0], packetsPerSecond: 60, receiveLatencyMs: 5, resetCounter: 0,
    });
    nowSpy.mockRestore();
    exportCsv.mockResolvedValue({ status: "saved", path: "/tmp/out.csv" });

    const { result } = renderHook(() => useTelemetryExport());
    await act(() => result.current.saveCsv());

    const lines = exportCsv.mock.calls[0][0].content.split("\n");
    expect(lines[1].endsWith(",")).toBe(true);
    expect(lines[2].endsWith(",gesture_1")).toBe(true);
    expect(lines[3].endsWith(",")).toBe(true);
  });

  it("rejects applying a whitespace-only label and leaves the previous applied label unchanged", () => {
    expect(telemetryStore.applyOrdinaryLabel("   ")).toBe(false);
    expect(telemetryStore.getAppliedOrdinaryLabel()).toBe("");
    telemetryStore.applyOrdinaryLabel("gesture_1");
    expect(telemetryStore.applyOrdinaryLabel("   ")).toBe(false);
    expect(telemetryStore.getAppliedOrdinaryLabel()).toBe("gesture_1");
  });

  it("does not record a saved count when the save is cancelled", async () => {
    telemetryStore.toggleRecording();
    telemetryStore.ingestHeadPose({
      device: "sony-test", quaternion: [1, 0, 0, 0], yawDeg: 1, pitchDeg: 2, rollDeg: 3,
      gyroscope: [0, 0, 0], packetsPerSecond: 60, receiveLatencyMs: 5, resetCounter: 0,
    });
    exportCsv.mockResolvedValue({ status: "cancelled" });

    const { result } = renderHook(() => useTelemetryExport());
    await act(() => result.current.saveCsv());

    expect(telemetryStore.getSavedCount()).toBe(0);
  });

  it("uses an unlabeled filename when no dataset label is available", async () => {
    telemetryStore.startDatasetRecording();
    exportCsvToFolder.mockResolvedValue({ status: "error", message: "disk full" });

    const { result } = renderHook(() => useTelemetryExport());
    await act(() => result.current.exportDatasetCsv());

    expect(exportCsvToFolder).toHaveBeenCalledTimes(1);
    const call = exportCsvToFolder.mock.calls[0][0];
    expect(call.fileName).toContain("gesture-dataset-unlabeled-");
  });

  it("requires an output folder before exporting in Tauri, never falling back to an arbitrary location", async () => {
    isTauriDesktop.mockReturnValue(true);
    telemetryStore.startDatasetRecording();

    const { result } = renderHook(() => useTelemetryExport());
    await act(() => result.current.exportDatasetCsv());

    expect(exportCsvToFolder).not.toHaveBeenCalled();
  });

  it("exports into the folder chosen via chooseDatasetExportFolder", async () => {
    isTauriDesktop.mockReturnValue(true);
    chooseExportFolder.mockResolvedValue("/Users/test/datasets");
    exportCsvToFolder.mockResolvedValue({ status: "saved", path: "/Users/test/datasets/out.csv" });
    telemetryStore.startDatasetRecording();

    const { result } = renderHook(() => useTelemetryExport());
    await act(() => result.current.chooseDatasetExportFolder());
    expect(result.current.datasetExportFolder).toBe("/Users/test/datasets");

    await act(() => result.current.exportDatasetCsv());
    expect(exportCsvToFolder).toHaveBeenCalledWith(expect.objectContaining({ folder: "/Users/test/datasets" }));
  });
});
