import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSignalsPage } from "./LiveSignalsPage";
import { RecorderPage } from "./RecorderPage";
import { RecordingsPage } from "./RecordingsPage";
import { telemetryStore } from "../store/telemetryStore";
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
    expect(screen.queryByRole("region", { name: "Record a gesture" })).not.toBeInTheDocument();
  });

  it("shows only the recorder on the Recorder page: the sessions, with the camera beside them", () => {
    render(<RecorderPage />);
    expect(screen.getByRole("heading", { name: "Recorder" })).toBeInTheDocument();
    for (const card of ["Pinch in / out session", "Everyday noise session", "Record a gesture", "Session details"]) {
      expect(screen.getByRole("region", { name: card })).toBeInTheDocument();
    }
    expect(within(screen.getByRole("complementary", { name: "Camera" })).getByRole("region", { name: "Camera hand tracking" })).toBeInTheDocument();
    // What these replaced is gone.
    for (const gone of ["Timeline recorder", "Guided session", "Exports", "Signal monitor"]) {
      expect(screen.queryByRole("region", { name: gone })).not.toBeInTheDocument();
    }
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
});
