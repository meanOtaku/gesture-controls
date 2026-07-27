import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import type { HeadTrackerRuntimeStatus, HeadTrackerStatus } from "../protocol/events";

afterEach(cleanup);

const connected: HeadTrackerStatus = {
  connected: true,
  timestampNs: 1,
  device: "WH-1000XM5",
  quaternion: [0.987, 0.006, -0.002, 0.155],
  yawDeg: 17.84,
  pitchDeg: -0.46,
  rollDeg: 1.37,
  gyroscope: [0.01, 0, -0.02],
  angularVelocity: [0.01, 0, -0.02],
  accelerometer: null,
  packetsPerSecond: 25,
  receiveLatencyMs: 3.5,
  resetCounter: 7,
};

const runtime: HeadTrackerRuntimeStatus = {
  state: "connected",
  message: "Tracking WH-1000XM5 directly",
  device: "WH-1000XM5",
  revision: 4,
  canRecenter: true,
};

describe("Dashboard", () => {
  it("shows connection, built-in runtime controls, and all required Sony diagnostics", () => {
    const onRecenter = vi.fn();
    render(<Dashboard status={connected} runtime={runtime} onRecenter={onRecenter} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getAllByText("WH-1000XM5").length).toBeGreaterThan(0);
    expect(screen.getByText("Built-in Sony tracker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recenter" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recenter" }));
    expect(onRecenter).toHaveBeenCalledOnce();
    expect(screen.queryByText("Sony UDP input")).not.toBeInTheDocument();
    for (const label of ["Yaw", "Pitch", "Roll", "Quaternion", "Gyroscope", "Packet rate", "Receive latency", "Reset counter"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows native discovery while waiting for the first sample", () => {
    render(<Dashboard status={null} runtime={{ state: "searching", message: "Scanning for Android Head Tracker", device: null, revision: 1, canRecenter: true }} onRecenter={vi.fn()} />);
    expect(screen.getAllByText("Scanning for Android Head Tracker")).toHaveLength(2);
  });

  it("surfaces an unsupported platform instead of requesting an external tracker", () => {
    render(<Dashboard status={null} runtime={{ state: "unsupported", message: "Direct Sony tracking is not available on this platform", device: null, revision: 1, canRecenter: false }} onRecenter={vi.fn()} />);
    expect(screen.getAllByText("Direct Sony tracking is not available on this platform")).toHaveLength(2);
    expect(screen.queryByText(/start sony-head-tracker/i)).not.toBeInTheDocument();
  });

  it("disables recenter for the compatibility UDP provider", () => {
    render(<Dashboard status={connected} runtime={{ ...runtime, canRecenter: false }} onRecenter={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Recenter" })).toBeDisabled();
  });
});
