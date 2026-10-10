import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dashboard } from "./Dashboard";
import type { AutomationState, CalibrationState, HeadTrackerStatus, WatchStatus } from "../../../shared/protocol/events";

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

function calibrationFixture(overrides: Partial<CalibrationState> & { saved?: string[] } = {}): CalibrationState {
  const { saved = ["center", "topRight"], ...rest } = overrides;
  return {
    targets: [
      { id: "center", name: "Screen center", calibrated: saved.includes("center"), builtin: true },
      { id: "topRight", name: "Top right", calibrated: saved.includes("topRight"), builtin: false },
    ],
    requiresRecalibration: false,
    activationThresholdDegrees: 12,
    dwellMs: 400,
    activeTarget: null,
    ...rest,
  };
}

describe("Dashboard", () => {
  it("does not report a ready gesture when calibrated headphones are disconnected", () => {
    render(<Dashboard status={{ ...connected, connected: false }} calibration={calibrationFixture()} />);
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

  it("guides calibration of each location and reports an active target", () => {
    const captures: string[] = [];
    const settings: Array<[number, number]> = [];
    const { container } = render(
      <Dashboard
        view="headphone"
        status={connected}
        calibration={calibrationFixture({ saved: ["center"], requiresRecalibration: true, activeTarget: "topRight" })}
        onCaptureTarget={(target) => captures.push(target)}
        onUpdateCalibration={(threshold, dwell) => settings.push([threshold, dwell])}
      />,
    );

    const dashboard = within(container);
    expect(dashboard.getByText("Calibration required")).toBeInTheDocument();
    expect(dashboard.getByText("Top right active")).toBeInTheDocument();
    fireEvent.click(dashboard.getByRole("button", { name: "Capture Screen center" }));
    fireEvent.click(dashboard.getByRole("button", { name: "Capture Top right" }));
    expect(captures).toEqual(["center", "topRight"]);

    const threshold = dashboard.getByLabelText("Activation threshold");
    fireEvent.change(threshold, { target: { value: "18" } });
    expect(settings).toEqual([]);
    fireEvent.blur(threshold);
    const dwell = dashboard.getByLabelText("Activation dwell");
    fireEvent.change(dwell, { target: { value: "650" } });
    fireEvent.blur(dwell);
    expect(settings).toEqual([[18, 400], [18, 650]]);
  });

  it("does not look as if an invalid calibration value was accepted", () => {
    const settings: Array<[number, number]> = [];
    const { container } = render(
      <Dashboard
        view="headphone"
        status={null}
        calibration={calibrationFixture()}
        onUpdateCalibration={(threshold, dwell) => settings.push([threshold, dwell])}
      />,
    );
    const threshold = within(container).getByLabelText("Activation threshold");
    fireEvent.change(threshold, { target: { value: "500" } });
    fireEvent.blur(threshold);
    expect(settings).toEqual([]); // nothing was applied...
    expect(threshold).toHaveAttribute("aria-invalid", "true"); // ...and the field says so
    expect(threshold).toHaveAccessibleDescription("Too high: the maximum is 180 °.");
    expect(threshold).toHaveValue(500); // kept, so it can be corrected rather than retyped
  });

  it("shows a clear waiting state and one-command launch guidance before the first packet", () => {
    const { container } = render(<Dashboard status={null} />);
    const dashboard = within(container);
    expect(dashboard.getByText("Waiting for Sony bridge")).toBeInTheDocument();
    expect(dashboard.getByText("Sony bridge not detected")).toBeInTheDocument();
    expect(dashboard.getByText(/on macos, use the arrow or \+\/- keys to change system volume/i)).toBeInTheDocument();
  });

  it("surfaces a native-provider diagnostic instead of the generic waiting copy", () => {
    render(
      <Dashboard
        view="headphone"
        status={null}
        headDiagnostic={{
          id: "permission-denied",
          title: "Input Monitoring permission needed",
          detail: "macOS requires Input Monitoring permission to read the head tracker's sensor input.",
          action: "Open System Settings -> Privacy & Security -> Input Monitoring, allow Spatial Gesture Control, then restart the app.",
        }}
      />,
    );
    expect(screen.getByText("Input Monitoring permission needed")).toBeInTheDocument();
    expect(screen.getByText(/requires Input Monitoring permission/)).toBeInTheDocument();
    expect(screen.getByText(/allow Spatial Gesture Control, then restart/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for head-tracking data")).not.toBeInTheDocument();
  });

  it("names the right executable to allow device access for each provider mode", () => {
    const { unmount } = render(<Dashboard view="headphone" status={null} headTrackerProvider="native" />);
    expect(screen.getByText(/Allow Spatial Gesture Control through your OS device-access prompt/)).toBeInTheDocument();
    unmount();

    render(<Dashboard view="headphone" status={null} headTrackerProvider="external" />);
    expect(screen.getByText(/Allow the Sony tracker executable through your OS device-access prompt/)).toBeInTheDocument();
  });

  it("shows pending feedback and disables a capture button while its own request is in flight", () => {
    const captures: string[] = [];
    const { container } = render(
      <Dashboard
        view="headphone"
        status={connected}
        isPending={(key) => key === "capture:center"}
        onCaptureTarget={(target) => captures.push(target)}
      />,
    );
    const dashboard = within(container);
    const centerButton = dashboard.getByRole("button", { name: "Capture Screen center" });
    expect(centerButton).toHaveTextContent("Capturing…");
    expect(centerButton).toBeDisabled();
    fireEvent.click(centerButton);
    expect(captures).toEqual([]);
    expect(dashboard.getByRole("button", { name: "Capture Top right" })).not.toBeDisabled();
  });

  it("adds and removes locations, and refuses a bad name", () => {
    const calls: string[] = [];
    const calibration = calibrationFixture();
    calibration.targets.push({ id: "leftEdge", name: "Left edge", calibrated: false, builtin: false });
    const { container } = render(
      <Dashboard
        view="headphone"
        status={connected}
        calibration={calibration}
        onAddLocation={(name) => calls.push(`add:${name}`)}
        onRemoveLocation={(id) => calls.push(`remove:${id}`)}
      />,
    );
    const dashboard = within(container);

    // Center is the reference: it cannot be removed.
    expect(dashboard.queryByRole("button", { name: "Remove Screen center" })).not.toBeInTheDocument();
    fireEvent.click(dashboard.getByRole("button", { name: "Remove Left edge" }));

    const name = dashboard.getByLabelText("New location name");
    fireEvent.change(name, { target: { value: "top RIGHT" } });
    fireEvent.click(dashboard.getByRole("button", { name: "Add location" }));
    expect(name).toHaveAccessibleDescription("A location with that name already exists.");
    fireEvent.change(name, { target: { value: "  Desk lamp " } });
    fireEvent.click(dashboard.getByRole("button", { name: "Add location" }));
    expect(calls).toEqual(["remove:leftEdge", "add:Desk lamp"]);
    expect(name).toHaveValue("");
  });

  const automation: AutomationState = {
    recipes: [
      {
        id: "lookStemVolume", name: "Look top right, hold STEM, roll", enabled: true, action: "volume",
        stages: [
          { kind: "headAt", location: "topRight" },
          { kind: "hold", hold: "stemButton" },
          { kind: "drive", axis: "roll", deadZoneDegrees: 3, invert: false },
        ],
        device: { kind: "rotationKnob", fractionPerDegree: 0.005 },
      },
      {
        id: "lookPinchVolume", name: "Look top right, pinch, roll", enabled: true, action: "volume",
        stages: [
          { kind: "headAt", location: "topRight" },
          { kind: "model", label: "pinch", hold: "held" },
          { kind: "drive", axis: "roll", deadZoneDegrees: 3, invert: false },
        ],
        device: { kind: "rotationKnob", fractionPerDegree: 0.005 },
      },
    ],
    blocked: ["lookStemVolume", "lookPinchVolume"],
    conflicts: [{ resource: "volume", first: "lookStemVolume", second: "lookPinchVolume" }],
    unavailable: [],
    loadedLabels: [],
  };

  it("says which two recipes are in conflict and lets one be switched off", () => {
    const toggles: Array<[string, boolean]> = [];
    const { container } = render(
      <Dashboard
        status={null}
        calibration={calibrationFixture()}
        automation={automation}
        onSetRecipeEnabled={(id, enabled) => toggles.push([id, enabled])}
      />,
    );
    const recipes = within(container);
    expect(recipes.getByText("These gestures are fighting over volume")).toBeInTheDocument();
    expect(recipes.getByText(/“Look top right, hold STEM, roll” and “Look top right, pinch, roll” both control volume/)).toBeInTheDocument();
    expect(recipes.getAllByText("Paused: conflict")).toHaveLength(2);
    expect(recipes.getByText("Look at Top right → Model “pinch” → Roll wrist → rotation knob → Volume")).toBeInTheDocument();
    fireEvent.click(recipes.getByRole("switch", { name: "Look top right, pinch, roll on" }));
    expect(toggles).toEqual([["lookPinchVolume", false]]);
  });

  it("shows no conflict message when the recipes do not clash", () => {
    const { container } = render(
      <Dashboard
        status={null}
        calibration={calibrationFixture()}
        automation={{ ...automation, blocked: [], conflicts: [] }}
      />,
    );
    expect(within(container).queryByText(/fighting over/)).not.toBeInTheDocument();
    expect(within(container).queryByText("Paused: conflict")).not.toBeInTheDocument();
  });

  const watchStatus: WatchStatus = {
    connected: true,
    lastOrientation: null,
    lastHeartbeat: null,
    clockOffsetNs: null,
    roundTripNs: null,
    ppgState: null,
    ppgLastSample: null,
    ppgRateHz: null,
    lastButtonState: null,
    worn: null,
    medicalStatus: {},
    sensorStatus: { orientation: true },
    heartRateLast: null,
    heartRateRateHz: null,
    skinTemperatureLast: null,
    skinTemperatureRateHz: null,
    edaLast: null,
    edaRateHz: null,
    spo2Last: null,
    ecgLast: null,
    biaLast: null,
    sweatLossLast: null,
  };

  it("shows pending feedback and prevents a duplicate sensor toggle while one is in flight", () => {
    const toggles: Array<[string, boolean]> = [];
    const { container } = render(
      <Dashboard
        view="watch"
        status={null}
        watchStatus={watchStatus}
        isPending={(key) => key === "sensor:orientation"}
        onSetSensorEnabled={(sensor, enabled) => toggles.push([sensor, enabled])}
      />,
    );
    const dashboard = within(container);
    expect(dashboard.getByText("Updating…")).toBeInTheDocument();
    const orientationSwitch = dashboard.getByRole("switch", { name: /Orientation \(rotation vector\)/ });
    expect(orientationSwitch).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(orientationSwitch);
    expect(toggles).toEqual([]);
  });
});
