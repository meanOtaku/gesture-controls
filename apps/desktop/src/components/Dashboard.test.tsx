import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dashboard } from "./Dashboard";
import type { HeadTrackerStatus } from "../protocol/events";

const connected: HeadTrackerStatus = {
  connected: true,
  device: "WH-1000XM5",
  quaternion: [0.987, 0.006, -0.002, 0.155],
  yawDeg: 17.84,
  pitchDeg: -0.46,
  rollDeg: 1.37,
  gyroscope: [0.01, 0, -0.02],
  packetsPerSecond: 25,
  receiveLatencyMs: 3.5,
  resetCounter: 7,
};

describe("Dashboard", () => {
  it("shows connection and all required Sony diagnostics", () => {
    render(<Dashboard status={connected} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("WH-1000XM5")).toBeInTheDocument();
    for (const label of ["Yaw", "Pitch", "Roll", "Quaternion", "Gyroscope", "Packet rate", "Receive latency", "Reset counter"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows a clear waiting state before the first packet", () => {
    render(<Dashboard status={null} />);
    expect(screen.getByText("Waiting for Sony tracker")).toBeInTheDocument();
  });
});
