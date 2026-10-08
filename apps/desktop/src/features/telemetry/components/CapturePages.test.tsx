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

const { exportCsvToFolder } = vi.hoisted(() => ({ exportCsvToFolder: vi.fn() }));
vi.mock("../../../shared/tauri/exportCsv", () => ({
  exportCsvToFolder,
  chooseExportFolder: vi.fn(),
  isTauriDesktop: vi.fn(() => false),
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

    const button = screen.getByRole("button", { name: "Export Dataset CSV" });
    fireEvent.click(button);

    // One buffered row trips M1's "insufficient_data" quality warning, so the
    // pre-export review gate requires an explicit "Export anyway" here.
    fireEvent.click(await screen.findByRole("button", { name: "Export anyway" }));

    expect(await screen.findByText("Could not save: disk full")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Export Dataset CSV" })).toBeEnabled());
  });
});
