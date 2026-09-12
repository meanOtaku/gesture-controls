import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dashboard } from "./Dashboard";
import type { HeadTrackerStatus } from "../../../shared/protocol/events";

afterEach(cleanup);

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
  it("does not report a ready gesture when calibrated headphones are disconnected", () => {
    render(<Dashboard status={{ ...connected, connected: false }} calibration={{
      centerCalibrated: true, topRightCalibrated: true, requiresRecalibration: false,
      activationThresholdDegrees: 12, dwellMs: 400, activeTarget: null,
    }} />);
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Connect headphones to begin")).toBeInTheDocument();
  });

  it("keeps device errors visible on the overview and routes setup actions", () => {
    const routes: string[] = [];
    render(<Dashboard status={null} calibrationError="Volume backend unavailable" onNavigate={(view) => routes.push(view)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Volume backend unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Open calibration →" }));
    fireEvent.click(screen.getByRole("button", { name: "Check Watch →" }));
    expect(routes).toEqual(["headphone", "watch"]);
  });

  it("shows connection and all required Sony diagnostics", () => {
    render(<Dashboard view="headphone" status={connected} />);
    expect(screen.getByText("Bridge connected")).toBeInTheDocument();
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
        view="headphone"
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
    expect(dashboard.getByText("Waiting for Sony bridge")).toBeInTheDocument();
    expect(dashboard.getByText("Sony bridge not detected")).toBeInTheDocument();
    expect(dashboard.getByText(/on macos, use the arrow or \+\/- keys to change system volume/i)).toBeInTheDocument();
  });
});
