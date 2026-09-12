import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Settings } from "./Settings";
import type { AppSettings } from "../../../shared/protocol/events";

afterEach(cleanup);

const settings: AppSettings = {
  headphonesEnabled: true,
  headphonesRateHz: 60,
  recordingRateHz: 30,
  graphRefreshRateHz: 15,
  watchOrientationRateHz: 50,
  watchAccelerationRateHz: 50,
  watchGyroscopeRateHz: 50,
  watchPpgFlushRateHz: 1,
  watchHeartRateAcceptanceRateHz: 200,
  watchSkinTemperatureAcceptanceRateHz: 200,
  watchEdaAcceptanceRateHz: 200,
  wristDeadZoneDegrees: 3,
  wristSmoothingAlpha: 0.2,
  wristVolumePointsPerDegree: 1 / 3,
  wristMaxAngularVelocityDegreesPerSecond: 360,
  wristMaxVolumePointsPerSecond: 30,
  watchSensorsEnabled: { orientation: true, acceleration: true, gyroscope: true },
};

describe("Settings", () => {
  it("renders every rate control with its current value", () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByLabelText("Headphones rate Hz")).toHaveValue(60);
    expect(screen.getByLabelText("Wrist rotation dead zone degrees")).toHaveValue(3);
    expect(screen.getByLabelText("Watch PPG flush rate Hz")).toHaveValue(1);
  });

  it("shows the settings error near the affected controls", () => {
    render(<Settings settings={settings} error="Settings write failed" onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Settings write failed");
  });

  it("applies every edited rate together, clamped to its valid range", () => {
    const updates: AppSettings[] = [];
    render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);

    fireEvent.change(screen.getByLabelText("Headphones rate Hz"), { target: { value: "999" } });
    fireEvent.change(screen.getByLabelText("Wrist rotation dead zone degrees"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply rates" }));

    expect(updates).toHaveLength(1);
    expect(updates[0].headphonesRateHz).toBe(60);
    expect(updates[0].wristDeadZoneDegrees).toBe(10);
  });

  it("toggles a watch sensor switch immediately without a confirmation dialog", () => {
    const updates: AppSettings[] = [];
    render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: /Orientation \(rotation vector\) enabled by default/ }));
    expect(updates).toEqual([{ ...settings, watchSensorsEnabled: { ...settings.watchSensorsEnabled, orientation: false } }]);
  });

  it("requires confirmation before resetting to defaults, and does nothing on cancel", () => {
    let resetCount = 0;
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => resetCount++} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(screen.getByText("Reset all settings to defaults?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep current settings" }));
    expect(resetCount).toBe(0);
  });

  it("resets to defaults only after the destructive action is confirmed", async () => {
    let resetCount = 0;
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => resetCount++} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    const confirmButtons = await screen.findAllByRole("button", { name: "Reset to defaults" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    expect(resetCount).toBe(1);
  });

  it("explains the difference between recording and graph refresh rate via help", async () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "About recording and graph rates" }));
    expect(await screen.findByText(/does not affect what gets saved/i)).toBeInTheDocument();
  });

  it("shows pending feedback and disables both apply and reset while either is in flight", () => {
    render(
      <Settings
        settings={settings}
        isPending={(key) => key === "settings:apply"}
        onUpdate={() => {}}
        onReset={() => {}}
      />,
    );
    const applyButton = screen.getByRole("button", { name: "Applying…" });
    expect(applyButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();
  });
});
