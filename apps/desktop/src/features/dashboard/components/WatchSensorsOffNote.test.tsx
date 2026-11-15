import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_WATCH_STATUS } from "../../telemetry/store/telemetryStore";
import { WatchSensorsOffNote, sensorsOff } from "./WatchSensorsOffNote";

afterEach(cleanup);

describe("the note about sensors that are off", () => {
  it("says nothing while every sensor streams, or while the watch is away", () => {
    render(<WatchSensorsOffNote watchStatus={{ ...EMPTY_WATCH_STATUS, connected: true, ppgState: "streaming" }} />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(sensorsOff({ ...EMPTY_WATCH_STATUS, connected: false, ppgState: "idle" })).toEqual([]);
  });

  it("names the pulse sensor when the watch reports it idle, and says the models cannot score", () => {
    render(<WatchSensorsOffNote watchStatus={{ ...EMPTY_WATCH_STATUS, connected: true, ppgState: "idle" }} />);
    expect(screen.getByRole("region", { name: "Sensors that are off" })).toHaveTextContent("Off: Pulse (PPG). Gesture models read");
    expect(screen.getByRole("button", { name: "Change in Settings" })).toBeInTheDocument();
  });

  it("names a motion sensor switched off", () => {
    expect(sensorsOff({ ...EMPTY_WATCH_STATUS, connected: true, ppgState: "streaming", sensorStatus: { gyroscope: false } }).map(({ id }) => id)).toEqual(["gyroscope"]);
  });
});
