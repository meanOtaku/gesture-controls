import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveGraphs } from "./LiveGraphs";
import { RecorderPage } from "./RecorderPage";
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
afterEach(() => { cleanup(); window.localStorage.clear(); telemetryStore.reset(); resetFeedbackForTests(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

describe("Live telemetry", () => {
  it("shows the signal monitor in the live graphs, without the wellness captures", () => {
    render(<LiveGraphs />);
    expect(screen.getByRole("region", { name: "Signal monitor" })).toBeInTheDocument();
    expect(screen.queryByText("Wellness signals & on-demand captures")).not.toBeInTheDocument();
  });

  it("keeps the live graphs folded under the Recorder until asked for", async () => {
    render(<RecorderPage />);
    expect(screen.queryByRole("region", { name: "Signal monitor" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Live graphs", { selector: ".advanced-title" }));
    expect(await screen.findByRole("region", { name: "Signal monitor" })).toBeInTheDocument();
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

  it("shows whether the headphones and the watch are connected on the pages that need them", () => {
    render(<RecorderPage />);
    expect(screen.getByLabelText("Sensor connections")).toHaveTextContent("Watch · Disconnected");
  });
});
