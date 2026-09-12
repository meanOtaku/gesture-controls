import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTelemetry } from "./LiveTelemetry";
import { telemetryStore } from "../store/telemetryStore";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => { telemetryStore.reset(); invoke.mockReset(); });
afterEach(() => { cleanup(); telemetryStore.reset(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

describe("Live telemetry", () => {
  it("retains a custom label visibly in the selector and recording session", () => {
    render(<LiveTelemetry />);
    fireEvent.change(screen.getByLabelText("Custom dataset label"), { target: { value: "wrist_flick" } });
    fireEvent.click(screen.getByRole("button", { name: "Use custom label" }));
    expect(screen.getByLabelText("Dataset label")).toHaveValue("wrist_flick");
    fireEvent.click(screen.getByRole("button", { name: "Start dataset capture" }));
    expect(telemetryStore.getDatasetSession()?.label).toBe("wrist_flick");
    expect(screen.getByLabelText("Dataset label")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop dataset capture" }));
  });

  it("switches between motion and optical charts", () => {
    render(<LiveTelemetry />);
    fireEvent.click(screen.getByRole("button", { name: "Optical" }));
    expect(screen.queryByRole("region", { name: "Headphone orientation" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Raw PPG" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All signals" }));
    expect(screen.getByRole("region", { name: "Headphone orientation" })).toBeInTheDocument();
  });

  it("reports a failed measurement request and re-enables its control", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    telemetryStore.ingestWatchStatus({ ...telemetryStore.getWatchStatus(), connected: true, medicalStatus: { spo2_on_demand: "idle" } });
    invoke.mockRejectedValue(new Error("Watch unavailable"));
    render(<LiveTelemetry />);
    fireEvent.click(screen.getByText("Wellness signals & on-demand captures"));
    const start = screen.getByRole("button", { name: "Blood oxygen · Start" });
    fireEvent.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent("Watch unavailable");
    await waitFor(() => expect(start).toBeEnabled());
  });
});
