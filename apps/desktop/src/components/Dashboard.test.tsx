import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("guides center and top-right calibration and reports an active target", () => {
    const captures: string[] = [];
    const settings: Array<[number, number]> = [];
    const { container } = render(
      <Dashboard
        status={connected}
        calibration={{
          centerCalibrated: true,
          topRightCalibrated: false,
          requiresRecalibration: true,
          activationThresholdDegrees: 12,
          dwellMs: 400,
          activeTarget: "topRight",
        }}
        onCaptureTarget={(target) => captures.push(target)}
        onUpdateCalibration={(threshold, dwell) => settings.push([threshold, dwell])}
      />,
    );

    const dashboard = within(container);
    expect(dashboard.getByText("Calibration required")).toBeInTheDocument();
    expect(dashboard.getByText("Top-right active")).toBeInTheDocument();
    fireEvent.click(dashboard.getByRole("button", { name: /Capture center/ }));
    fireEvent.click(dashboard.getByRole("button", { name: /Capture top-right/ }));
    expect(captures).toEqual(["center", "topRight"]);

    const threshold = dashboard.getByLabelText("Activation threshold degrees");
    fireEvent.change(threshold, { target: { value: "18" } });
    expect(settings).toEqual([]);
    fireEvent.blur(threshold);
    const dwell = dashboard.getByLabelText("Activation dwell milliseconds");
    fireEvent.change(dwell, { target: { value: "650" } });
    fireEvent.blur(dwell);
    expect(settings).toEqual([[18, 400], [18, 650]]);
  });

  it("shows a clear waiting state and one-command launch guidance before the first packet", () => {
    const { container } = render(<Dashboard status={null} />);
    const dashboard = within(container);
    expect(dashboard.getByText("Waiting for Sony tracker")).toBeInTheDocument();
    expect(dashboard.getByText(/on macos, use the arrow or \+\/- keys to change system volume/i)).toBeInTheDocument();
  });
});
