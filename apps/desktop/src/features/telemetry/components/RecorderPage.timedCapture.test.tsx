import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderPage } from "./RecorderPage";
import { RecordingTimer } from "../recording/RecordingTimer";
import { timedCapture } from "../recording/timedCapture";
import { exportFolderStore } from "../store/exportFolderStore";
import { telemetryStore } from "../store/telemetryStore";
import { Toaster } from "../../../components/ui/sonner";
import { resetFeedbackForTests } from "../../../components/app/OperationFeedback";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// Isolated from LiveTelemetry.test.tsx's own mock of this module (which only
// stubs `exportCsv`) so the Timeline Capture auto-export path — which calls
// `exportCsvToFolder` — has a real, assertable mock rather than `undefined`.
const { exportCsvToFolder } = vi.hoisted(() => ({ exportCsvToFolder: vi.fn() }));
vi.mock("../../../shared/tauri/exportCsv", () => ({
  exportCsv: vi.fn(),
  exportCsvToFolder,
  chooseExportFolder: vi.fn(),
  isTauriDesktop: vi.fn(() => false),
}));

function startTimelineCapture(durationSeconds: number) {
  fireEvent.change(screen.getByLabelText("Recording duration"), { target: { value: String(durationSeconds) } });
  fireEvent.click(screen.getByRole("button", { name: "Start dataset capture" }));
}

// The store debounces its subscriber notification (`schedulePublish`), so the component
// only re-renders — and the "recording" effect only fires — after that timer elapses.
async function ingestOneSample() {
  telemetryStore.ingestWatchOrientation({
    deviceId: "watch-test",
    sequence: 1,
    timestampNs: 1,
    quaternion: [1, 0, 0, 0],
    accelerometer: [0, 0, 0],
    gyroscope: [0, 0, 0],
  });
  await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
  telemetryStore.reset();
  timedCapture.reset();
  exportFolderStore.reset();
  invoke.mockReset();
  exportCsvToFolder.mockReset();
  exportCsvToFolder.mockResolvedValue({ status: "saved", path: "/tmp/gesture-dataset.csv" });
  resetFeedbackForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  telemetryStore.reset();
  resetFeedbackForTests();
});

describe("Timeline Capture timed recording", () => {
  it("does not start the timer while merely arming, only once the first sample lands", async () => {
    render(<><RecordingTimer /><RecorderPage /></>);
    startTimelineCapture(5);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(exportCsvToFolder).not.toHaveBeenCalled();
    expect(telemetryStore.getDatasetRecordingState()).toBe("arming");
  });

  it("stops once and auto-exports once the chosen duration elapses after recording begins", async () => {
    render(<><Toaster /><RecordingTimer /><RecorderPage /></>);
    startTimelineCapture(5);
    await ingestOneSample();
    expect(telemetryStore.getDatasetRecordingState()).toBe("recording");

    // Comfortably short of the 5s duration (accounting for the store's own
    // ~66ms publish debounce before the timer actually starts).
    await vi.advanceTimersByTimeAsync(4_000);
    expect(telemetryStore.getDatasetRecordingState()).toBe("recording");
    expect(exportCsvToFolder).not.toHaveBeenCalled();

    // Comfortably past the 5s duration plus that same debounce.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(telemetryStore.getDatasetRecordingState()).toBe("saved");
    expect(exportCsvToFolder).toHaveBeenCalledTimes(1);

    // Completion must not re-arm or fire again.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(exportCsvToFolder).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending timer on manual stop, so no auto-export ever fires", async () => {
    render(<><RecordingTimer /><RecorderPage /></>);
    startTimelineCapture(10);
    await ingestOneSample();
    expect(telemetryStore.getDatasetRecordingState()).toBe("recording");

    fireEvent.click(screen.getByRole("button", { name: "Stop dataset capture" }));
    expect(telemetryStore.getDatasetRecordingState()).toBe("saved");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(exportCsvToFolder).not.toHaveBeenCalled();
  });

  it("does not auto-export when the session is discarded before the timer elapses", async () => {
    render(<><RecordingTimer /><RecorderPage /></>);
    startTimelineCapture(5);
    await ingestOneSample();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" }).at(-1) as HTMLElement);
    expect(telemetryStore.getDatasetRecordingState()).toBe("discarded");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(exportCsvToFolder).not.toHaveBeenCalled();
  });

  it("still stops and exports when the recorder page has been left, because the timer is not part of the page", async () => {
    render(<RecordingTimer />);
    const page = render(<RecorderPage />);
    startTimelineCapture(5);
    await ingestOneSample();
    expect(telemetryStore.getDatasetRecordingState()).toBe("recording");

    // Look at the live charts instead: the recorder page goes away, the capture carries on.
    page.unmount();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(telemetryStore.getDatasetRecordingState()).toBe("recording");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(telemetryStore.getDatasetRecordingState()).toBe("saved");
    expect(exportCsvToFolder).toHaveBeenCalledTimes(1);
  });
});
