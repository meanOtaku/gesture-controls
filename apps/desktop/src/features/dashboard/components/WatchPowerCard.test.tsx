import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
import { watchPower, type PowerRates, type WatchPowerView } from "../../../shared/tauri/watchPower";
import { describeRates, WatchPowerCard } from "./WatchPowerCard";

const rates: PowerRates = {
  seconds: 60,
  batteryPercentPerHour: 6,
  averageDrawMa: 58.4,
  cpuPercent: 3.2,
  sensorDeliveriesPerSecond: 148,
  sensors: [
    { id: "acceleration", name: "Linear Acceleration", registered: true, requestedHz: 50, achievedHz: 49.6, fifoMaxEvents: 450 },
    { id: "gyroscope", name: "Gyroscope", registered: false, requestedHz: null, achievedHz: 0, fifoMaxEvents: 0 },
  ],
  ppgHz: 25,
  ppgDeliveriesPerSecond: 10,
  messagesPerSecond: 22,
  bytesPerSecond: 4096,
  droppedMessages: 0,
  refusedSends: 0,
  charging: false,
  temperatureC: 31.5,
};

afterEach(() => {
  cleanup();
  invoke.mockReset();
  watchPower.reset();
});

describe("the watch power card", () => {
  it("puts each figure in words, with only the sensors that run", () => {
    const rows = describeRates(rates);
    expect(rows.find((row) => row.title === "Average draw")?.value).toBe("58.4 mA");
    expect(rows.find((row) => row.title === "Acceleration")?.value).toBe("50 Hz of 50 asked");
    expect(rows.find((row) => row.title === "Acceleration")?.hint).toContain("Batching buffer: 450 events");
    expect(rows.some((row) => row.title === "Gyroscope")).toBe(false);
    expect(rows.find((row) => row.title === "Link")?.value).toBe("22 messages, 4.0 KB a second");
  });

  it("says when the watch does not report, then shows the last minute and runs a measurement", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const empty: WatchPowerView = { live: null, reporting: false, run: null };
    invoke.mockImplementation(async (command: string) => {
      if (command === "get_watch_power") return empty;
      if (command === "list_watch_measurements") return [];
      if (command === "start_watch_measurement") return { live: rates, reporting: true, run: { label: "desk, batching off", startedAt: "", rates: null } };
      if (command === "stop_watch_measurement") return {};
      return null;
    });
    render(<WatchPowerCard />);
    expect(await screen.findByText(/has not reported its power use/)).toBeInTheDocument();
    act(() => watchPower.set({ live: rates, reporting: true, run: null }));
    expect(screen.getByText("Over the last 1 min 0 s:")).toBeInTheDocument();
    expect(screen.getByText("58.4 mA")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Measurement name"), { target: { value: "desk, batching off" } });
    fireEvent.click(screen.getByRole("button", { name: "Start measuring" }));
    await screen.findByText(/waiting for the watch's next report/);
    expect(invoke).toHaveBeenCalledWith("start_watch_measurement", { label: "desk, batching off" });

    invoke.mockImplementation(async (command: string) =>
      command === "list_watch_measurements"
        ? [{ id: "m1", label: "desk, batching off", startedAt: "2026-10-25T10:00:00Z", endedAt: "", rates: { ...rates, seconds: 1800 }, delayP50Ms: 52, delayP95Ms: 110, notes: [] }]
        : {},
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop and keep" }));
    const table = await screen.findByRole("table", { name: "Measurements" });
    await waitFor(() => expect(within(table).getByText("30 min 0 s")).toBeInTheDocument());
    expect(within(table).getByText("52 / 110 ms")).toBeInTheDocument();
  });
});
