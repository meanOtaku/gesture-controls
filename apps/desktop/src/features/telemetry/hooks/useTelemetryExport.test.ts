import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTelemetryExport } from "./useTelemetryExport";
import { telemetryStore } from "../store/telemetryStore";
import { resetFeedbackForTests } from "../../../components/app/OperationFeedback";

const { exportCsvToFolder, chooseExportFolder, isTauriDesktop } = vi.hoisted(() => ({
  exportCsvToFolder: vi.fn(),
  chooseExportFolder: vi.fn(),
  isTauriDesktop: vi.fn(() => false),
}));
vi.mock("../../../shared/tauri/exportCsv", () => ({ exportCsvToFolder, chooseExportFolder, isTauriDesktop }));

beforeEach(() => {
  telemetryStore.reset();
  exportCsvToFolder.mockReset();
  chooseExportFolder.mockReset();
  isTauriDesktop.mockReturnValue(false);
  resetFeedbackForTests();
});

describe("useTelemetryExport", () => {
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
