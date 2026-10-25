import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WATCH_STATUS } from "../../telemetry/store/telemetryStore";
import { WatchSensorControls } from "./WatchSensorControls";

afterEach(cleanup);

describe("the watch's sensor switches", () => {
  it("switch the pulse sensor, showing it off while the watch reports it idle", () => {
    const onSet = vi.fn();
    const { rerender } = render(<WatchSensorControls watchStatus={{ ...EMPTY_WATCH_STATUS, connected: true, ppgState: "streaming" }} isPending={() => false} onSetSensorEnabled={onSet} />);
    fireEvent.click(screen.getByRole("switch", { name: "Pulse (PPG) enabled" }));
    expect(onSet).toHaveBeenCalledWith("ppg_continuous", false);
    rerender(<WatchSensorControls watchStatus={{ ...EMPTY_WATCH_STATUS, connected: true, ppgState: "idle" }} isPending={() => false} onSetSensorEnabled={onSet} />);
    expect(screen.getByRole("switch", { name: "Pulse (PPG) disabled" })).toBeInTheDocument();
  });
});
