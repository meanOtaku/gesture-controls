import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTelemetry } from "./LiveTelemetry";
import { telemetryStore } from "../store/telemetryStore";
import { Toaster } from "../../../components/ui/sonner";
import { resetFeedbackForTests } from "../../../components/app/OperationFeedback";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { exportCsv } = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock("../../../shared/tauri/exportCsv", () => ({ exportCsv }));

beforeEach(() => { telemetryStore.reset(); invoke.mockReset(); exportCsv.mockReset(); resetFeedbackForTests(); });
afterEach(() => { cleanup(); telemetryStore.reset(); resetFeedbackForTests(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

describe("Live telemetry", () => {
  it("composes the capture, signal monitor, and wellness sections", () => {
    render(<LiveTelemetry />);
    expect(screen.getByRole("region", { name: "CSV capture" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Labeled dataset recorder" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Signal monitor" })).toBeInTheDocument();
    expect(screen.getByText("Wellness signals & on-demand captures")).toBeInTheDocument();
  });

  it("reports saved feedback and records the saved row count when Save CSV succeeds", async () => {
    telemetryStore.toggleRecording();
    telemetryStore.ingestHeadPose({
      device: "sony-test",
      quaternion: [1, 0, 0, 0],
      yawDeg: 1,
      pitchDeg: 2,
      rollDeg: 3,
      gyroscope: [0, 0, 0],
      packetsPerSecond: 60,
      receiveLatencyMs: 5,
      resetCounter: 0,
    });
    exportCsv.mockResolvedValue({ status: "saved", path: "/Users/test/Desktop/gesture-telemetry.csv" });
    render(<><Toaster /><LiveTelemetry /></>);

    const button = screen.getByRole("button", { name: "Save CSV" });
    fireEvent.click(button);

    expect(await screen.findByText("Saved to gesture-telemetry.csv")).toBeInTheDocument();
    expect(telemetryStore.getSavedCount()).toBe(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save CSV" })).toBeEnabled());
  });

  it("reports cancellation without recording a saved count when Save CSV is cancelled", async () => {
    telemetryStore.toggleRecording();
    telemetryStore.ingestHeadPose({
      device: "sony-test",
      quaternion: [1, 0, 0, 0],
      yawDeg: 1,
      pitchDeg: 2,
      rollDeg: 3,
      gyroscope: [0, 0, 0],
      packetsPerSecond: 60,
      receiveLatencyMs: 5,
      resetCounter: 0,
    });
    exportCsv.mockResolvedValue({ status: "cancelled" });
    render(<><Toaster /><LiveTelemetry /></>);

    fireEvent.click(screen.getByRole("button", { name: "Save CSV" }));

    expect(await screen.findByText("Save cancelled")).toBeInTheDocument();
    expect(telemetryStore.getSavedCount()).toBe(0);
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
    exportCsv.mockResolvedValue({ status: "error", message: "disk full" });
    render(<><Toaster /><LiveTelemetry /></>);

    const button = screen.getByRole("button", { name: "Export Dataset CSV" });
    fireEvent.click(button);

    expect(await screen.findByText("Could not save: disk full")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Export Dataset CSV" })).toBeEnabled());
  });
});
