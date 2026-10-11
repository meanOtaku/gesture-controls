import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSignalsPage } from "./LiveSignalsPage";
import { RecorderPage } from "./RecorderPage";
import { RecordingsPage } from "./RecordingsPage";
import { telemetryStore } from "../store/telemetryStore";
import { Toaster } from "../../../components/ui/sonner";
import { resetFeedbackForTests } from "../../../components/app/OperationFeedback";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { exportCsvToFolder, isTauriDesktop } = vi.hoisted(() => ({ exportCsvToFolder: vi.fn(), isTauriDesktop: vi.fn(() => false) }));
vi.mock("../../../shared/tauri/exportCsv", () => ({
  exportCsvToFolder,
  chooseExportFolder: vi.fn(),
  isTauriDesktop,
}));

beforeEach(() => { telemetryStore.reset(); invoke.mockReset(); exportCsvToFolder.mockReset(); resetFeedbackForTests(); });
afterEach(() => { cleanup(); telemetryStore.reset(); resetFeedbackForTests(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

describe("Live telemetry", () => {
  it("shows the signal monitor and wellness sections on Live signals, and not the recorder", () => {
    render(<LiveSignalsPage />);
    expect(screen.getByRole("heading", { name: "Live signals" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Signal monitor" })).toBeInTheDocument();
    expect(screen.getByText("Wellness signals & on-demand captures")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Timeline recorder" })).not.toBeInTheDocument();
  });

  it("shows only the recorder on the Recorder page", () => {
    render(<RecorderPage />);
    expect(screen.getByRole("heading", { name: "Recorder" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Timeline recorder" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Signal monitor" })).not.toBeInTheDocument();
  });

  it("explains that saved recordings need the desktop app, in browser preview", () => {
    render(<RecordingsPage />);
    expect(screen.getByRole("heading", { name: "Recordings" })).toBeInTheDocument();
    expect(screen.getByText(/unavailable in browser preview/)).toBeInTheDocument();
  });

  it("shows whether the headphones and the watch are connected on the pages that need them", () => {
    render(<RecorderPage />);
    expect(screen.getByLabelText("Sensor connections")).toHaveTextContent("Watch · Disconnected");
  });

  it("reports a failed dataset export via toast and re-enables the control", async () => {
    telemetryStore.startDatasetRecording();
    telemetryStore.ingestWatchOrientation({
      deviceId: "watch-test",
      sequence: 1,
      timestampNs: 123,
      quaternion: [1, 0, 0, 0],
      accelerometer: [0, 0, 0],
      gyroscope: [0, 0, 0],
    });
    exportCsvToFolder.mockResolvedValue({ status: "error", message: "disk full" });
    render(<><Toaster /><RecorderPage /></>);

    fireEvent.click(screen.getByRole("button", { name: "Export one CSV (older format)" }));

    expect(await screen.findByText("Could not save: disk full")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Export one CSV (older format)" })).toBeEnabled());
  });

  it("exports the dataset as a folder of two files, and reports a failed one via toast", async () => {
    isTauriDesktop.mockReturnValue(true);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { exportFolderStore } = await import("../store/exportFolderStore");
    exportFolderStore.set("/exports");
    telemetryStore.startDatasetRecording();
    telemetryStore.ingestWatchOrientation({ deviceId: "watch-test", sequence: 1, timestampNs: 123, quaternion: [1, 0, 0, 0], accelerometer: [0, 0, 0], gyroscope: [0, 0, 0] });
    invoke.mockImplementation(async (command: string) => {
      if (command === "export_dataset_folder") throw "disk full";
      return undefined;
    });
    render(<><Toaster /><RecorderPage /></>);

    fireEvent.click(screen.getByRole("button", { name: "Export dataset folder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Export anyway" })); // one row trips the quality review
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_dataset_folder", expect.objectContaining({ parent: "/exports", ppgCsv: expect.stringContaining("ppg_green"), imuCsv: expect.stringContaining("quat_w") })));
    expect(await screen.findByText("Could not save: disk full")).toBeInTheDocument();
    isTauriDesktop.mockReturnValue(false);
    exportFolderStore.set(null);
  });
});
