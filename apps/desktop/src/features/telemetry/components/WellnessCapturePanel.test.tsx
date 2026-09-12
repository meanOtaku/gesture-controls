import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WellnessCapturePanel } from "./WellnessCapturePanel";
import { TooltipProvider } from "../../../components/ui/tooltip";
import { EMPTY_WATCH_STATUS } from "../store/telemetryStore";

afterEach(() => cleanup());

function renderPanel(overrides: Partial<React.ComponentProps<typeof WellnessCapturePanel>> = {}) {
  const props: React.ComponentProps<typeof WellnessCapturePanel> = {
    desktopAvailable: true,
    watchStatus: EMPTY_WATCH_STATUS,
    heartRateStreaming: false,
    skinTemperatureStreaming: false,
    edaStreaming: false,
    heartRatePoints: [],
    ibiPoints: [],
    temperaturePoints: [],
    edaPoints: [],
    spo2Points: [],
    ecgPoints: [],
    pendingMeasurement: null,
    measurementError: null,
    onRequestMeasurement: vi.fn(),
    ...overrides,
  };
  render(<TooltipProvider><WellnessCapturePanel {...props} /></TooltipProvider>);
  return props;
}

describe("WellnessCapturePanel", () => {
  it("reveals on-demand measurement controls when expanded", async () => {
    renderPanel({ watchStatus: { ...EMPTY_WATCH_STATUS, connected: true, medicalStatus: { spo2_on_demand: "idle" } } });
    expect(screen.queryByRole("button", { name: "Blood oxygen · Start" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Wellness signals & on-demand captures"));
    expect(await screen.findByRole("button", { name: "Blood oxygen · Start" })).toBeInTheDocument();
  });

  it("disables a measurement control while another measurement is active", async () => {
    renderPanel({
      watchStatus: {
        ...EMPTY_WATCH_STATUS,
        connected: true,
        medicalStatus: { spo2_on_demand: "idle", ecg_on_demand: "measuring" },
      },
    });
    fireEvent.click(screen.getByText("Wellness signals & on-demand captures"));
    expect(await screen.findByRole("button", { name: "Blood oxygen · Start" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop ECG" })).toBeEnabled();
  });

  it("shows a requesting label for the pending tracker only", async () => {
    renderPanel({
      pendingMeasurement: "spo2_on_demand",
      watchStatus: { ...EMPTY_WATCH_STATUS, connected: true, medicalStatus: { spo2_on_demand: "idle", ecg_on_demand: "idle" } },
    });
    fireEvent.click(screen.getByText("Wellness signals & on-demand captures"));
    expect(await screen.findByRole("button", { name: "Requesting…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ECG · Start" })).toBeDisabled();
  });

  it("surfaces a measurement error as an alert", async () => {
    renderPanel({ measurementError: "Could not start the measurement: Watch unavailable" });
    fireEvent.click(screen.getByText("Wellness signals & on-demand captures"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Watch unavailable");
  });

  it("invokes the callback with the tracker id and current measuring state", async () => {
    const onRequestMeasurement = vi.fn();
    renderPanel({
      onRequestMeasurement,
      watchStatus: { ...EMPTY_WATCH_STATUS, connected: true, medicalStatus: { spo2_on_demand: "idle" } },
    });
    fireEvent.click(screen.getByText("Wellness signals & on-demand captures"));
    fireEvent.click(await screen.findByRole("button", { name: "Blood oxygen · Start" }));
    expect(onRequestMeasurement).toHaveBeenCalledWith("spo2_on_demand", false);
    await waitFor(() => expect(onRequestMeasurement).toHaveBeenCalledTimes(1));
  });
});
