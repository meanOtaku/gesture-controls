import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeadTrackerStatus, WatchStatus } from "../../../shared/protocol/events";
import { NervTelemetryPanel } from "./NervTelemetryPanel";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "nerv");
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

const head = (over: Partial<HeadTrackerStatus> = {}): HeadTrackerStatus => ({
  connected: true, device: "WH-1000XM5", quaternion: [1, 0, 0, 0], yawDeg: 12.34, pitchDeg: -5.6, rollDeg: 0.4, gyroscope: null, packetsPerSecond: 99.5, receiveLatencyMs: 8.25, resetCounter: 0, ...over,
});
const watch = (over: Partial<WatchStatus> = {}): WatchStatus => ({
  connected: true, lastOrientation: null, lastHeartbeat: { deviceId: "w", sequence: 1, timestampNs: 1, batteryPercent: 64 }, clockOffsetNs: null, roundTripNs: 4_200_000,
  ppgState: "streaming", ppgLastSample: null, ppgRateHz: 25.04, lastButtonState: null, worn: true, medicalStatus: {}, sensorStatus: {},
  heartRateLast: { timestampNs: 1, heartRate: 71.6, heartRateStatus: 1, ibiMs: [], ibiStatus: [] }, heartRateRateHz: null,
  skinTemperatureLast: null, skinTemperatureRateHz: null, edaLast: null, edaRateHz: null, spo2Last: null, ecgLast: null, biaLast: null, sweatLossLast: null, ...over,
} as WatchStatus);

describe("NervTelemetryPanel", () => {
  it("is only there under the NERV theme, and follows a change of theme at once", async () => {
    document.documentElement.removeAttribute("data-theme");
    render(<NervTelemetryPanel headStatus={null} watchStatus={null} />);
    expect(screen.queryByRole("complementary", { name: "Telemetry" })).toBeNull();
    await act(async () => { document.documentElement.setAttribute("data-theme", "nerv"); await Promise.resolve(); });
    expect(await screen.findByRole("complementary", { name: "Telemetry" })).toBeInTheDocument();
  });

  it("shows no signal, and no numbers, for a headphone set and a watch that are not connected", () => {
    render(<NervTelemetryPanel headStatus={null} watchStatus={null} />);
    const headphones = within(screen.getByRole("region", { name: "Headphones" }));
    expect(headphones.getByText("○ OFFLINE")).toBeInTheDocument();
    expect(headphones.getByText("NO SIGNAL")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Watch" })).getByText("NO SIGNAL")).toBeInTheDocument();
    expect(screen.queryByText("YAW")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows a connected headphone set's readings", () => {
    render(<NervTelemetryPanel headStatus={head()} watchStatus={null} />);
    const headphones = within(screen.getByRole("region", { name: "Headphones" }));
    expect(headphones.getByText("● ACTIVE")).toBeInTheDocument();
    expect(headphones.getByText("WH-1000XM5")).toBeInTheDocument();
    expect(headphones.getByText("12.3")).toBeInTheDocument();
    expect(headphones.getByText("99.5")).toBeInTheDocument();
    expect(headphones.getByText("8.3")).toBeInTheDocument();
  });

  it("shows a connected watch's readings, with the battery as a bar, and leaves out what it has not reported", () => {
    render(<NervTelemetryPanel headStatus={null} watchStatus={watch()} />);
    const panel = within(screen.getByRole("region", { name: "Watch" }));
    expect(panel.getByText("● ACTIVE")).toBeInTheDocument();
    expect(panel.getByText("● WORN")).toBeInTheDocument();
    expect(panel.getByText("64")).toBeInTheDocument();
    expect(panel.getByRole("meter", { name: "Watch battery" })).toHaveAttribute("aria-valuenow", "64");
    expect(panel.getByText("STREAMING")).toBeInTheDocument();
    expect(panel.getByText("72")).toBeInTheDocument(); // heart rate
    expect(panel.getByText("4.2")).toBeInTheDocument(); // round trip
    expect(panel.queryByText("SKIN TEMP")).toBeNull();
  });

  it("says when the watch is off the wrist, and when that is not yet known", () => {
    const { rerender } = render(<NervTelemetryPanel headStatus={null} watchStatus={watch({ worn: false })} />);
    expect(screen.getByText("○ NOT WORN")).toBeInTheDocument();
    rerender(<NervTelemetryPanel headStatus={null} watchStatus={watch({ worn: null })} />);
    expect(screen.getByText("? UNKNOWN")).toBeInTheDocument();
  });

  it("logs the changes it sees, newest first, and nothing from before it opened", () => {
    const { rerender } = render(<NervTelemetryPanel headStatus={null} watchStatus={null} />);
    const log = () => within(screen.getByRole("region", { name: "Event log" })).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(log()).toHaveLength(1);
    expect(log()[0]).toContain("TELEMETRY ONLINE");
    rerender(<NervTelemetryPanel headStatus={head()} watchStatus={null} />);
    rerender(<NervTelemetryPanel headStatus={head()} watchStatus={watch()} />);
    const lines = log();
    expect(lines[0]).toContain("PPG STREAMING");
    expect(lines.some((line) => line.includes("WATCH CONNECTED"))).toBe(true);
    expect(lines.some((line) => line.includes("HEADPHONES CONNECTED"))).toBe(true);
    rerender(<NervTelemetryPanel headStatus={null} watchStatus={watch()} />);
    expect(log()[0]).toContain("HEADPHONES LOST");
  });

  it("collapses to a slim strip, remembers it, and opens again", () => {
    const { unmount } = render(<NervTelemetryPanel headStatus={null} watchStatus={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse telemetry" }));
    expect(screen.queryByRole("region", { name: "Watch" })).toBeNull();
    expect(window.localStorage.getItem("nervTelemetryCollapsed")).toBe("1");
    unmount();
    render(<NervTelemetryPanel headStatus={null} watchStatus={null} />);
    expect(screen.queryByRole("region", { name: "Watch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /TELEMETRY/ }));
    expect(screen.getByRole("region", { name: "Watch" })).toBeInTheDocument();
    expect(window.localStorage.getItem("nervTelemetryCollapsed")).toBe("0");
  });
});
