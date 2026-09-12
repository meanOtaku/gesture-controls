import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalMonitor } from "./SignalMonitor";

afterEach(() => cleanup());

const points = [{ at: 0, values: [1, 2, 3] }];

describe("SignalMonitor", () => {
  it("shows motion and optical charts by default", () => {
    render(
      <SignalMonitor
        signalView="all"
        onSignalViewChange={vi.fn()}
        orientationEnabled={true}
        headPoints={points}
        watchOrientationPoints={points}
        ppgPoints={points}
      />,
    );
    expect(screen.getByRole("region", { name: "Headphone orientation" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Watch orientation" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Raw PPG" })).toBeInTheDocument();
  });

  it("hides motion charts in the optical filter", () => {
    render(
      <SignalMonitor
        signalView="optical"
        onSignalViewChange={vi.fn()}
        orientationEnabled={true}
        headPoints={points}
        watchOrientationPoints={points}
        ppgPoints={points}
      />,
    );
    expect(screen.queryByRole("region", { name: "Headphone orientation" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Raw PPG" })).toBeInTheDocument();
  });

  it("omits the watch orientation chart when the sensor is disabled", () => {
    render(
      <SignalMonitor
        signalView="all"
        onSignalViewChange={vi.fn()}
        orientationEnabled={false}
        headPoints={points}
        watchOrientationPoints={points}
        ppgPoints={points}
      />,
    );
    expect(screen.queryByRole("region", { name: "Watch orientation" })).not.toBeInTheDocument();
  });

  it("invokes the callback when a filter is pressed", () => {
    const onSignalViewChange = vi.fn();
    render(
      <SignalMonitor
        signalView="all"
        onSignalViewChange={onSignalViewChange}
        orientationEnabled={true}
        headPoints={points}
        watchOrientationPoints={points}
        ppgPoints={points}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Optical" }));
    expect(onSignalViewChange).toHaveBeenCalledWith("optical");
  });
});
