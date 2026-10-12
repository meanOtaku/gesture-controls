import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryStore } from "./telemetryStore";

const sample = (sequence: number, timestampNs: number) => ({
  deviceId: "watch-test", sequence, timestampNs,
  quaternion: [1, 0, 0, 0] as [number, number, number, number],
  accelerometer: [sequence, 0, 0] as [number, number, number], gyroscope: [0, 0, 0] as [number, number, number],
});

let now = 0;
beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  telemetryStore.reset();
});
afterEach(() => {
  telemetryStore.reset();
  vi.restoreAllMocks();
});

describe("drawing watch motion", () => {
  it("draws a burst that arrived at once at the samples' own spacing, not piled at one moment", () => {
    // One sample on its own lines the clocks up, then five taken 20 ms apart arrive together 100 ms later.
    telemetryStore.ingestWatchOrientation(sample(1, 5_000_000_000));
    now += 120;
    for (let i = 0; i < 5; i++) telemetryStore.ingestWatchOrientation(sample(2 + i, 5_020_000_000 + i * 20_000_000));
    const at = telemetryStore.getSeries("watchAcceleration").map((p) => p.at);
    expect(at.slice(1).map((t, i) => t - at[i])).toEqual([20, 20, 20, 20, 20]);
    expect(telemetryStore.getSeries("watchOrientation").map((p) => p.at)).toEqual(at);
  });

  it("takes in every sample of a combined message, which share its sequence, but not the same sample twice", () => {
    for (let i = 0; i < 4; i++) telemetryStore.ingestWatchOrientation(sample(7, 5_000_000_000 + i * 20_000_000));
    telemetryStore.ingestWatchOrientation(sample(7, 5_060_000_000)); // the status poll's copy of the last one
    expect(telemetryStore.getSeries("watchOrientation")).toHaveLength(4);
  });

  it("does not freeze after a late start: a slow first delivery changes nothing about where later samples go", () => {
    telemetryStore.ingestWatchOrientation(sample(1, 5_000_000_000));
    now += 2_000; // the first samples were held up at connection...
    telemetryStore.ingestWatchOrientation(sample(2, 5_020_000_000));
    now += 1; // ...then they arrive promptly
    for (let i = 0; i < 3; i++) telemetryStore.ingestWatchOrientation(sample(3 + i, 5_040_000_000 + i * 20_000_000));
    const at = telemetryStore.getSeries("watchOrientation").map((p) => p.at);
    expect(at.slice(1).map((t, i) => t - at[i])).toEqual([20, 20, 20, 20]);
  });

  it("starts the motion charts afresh when the watch clock restarts", () => {
    telemetryStore.ingestWatchOrientation(sample(1, 900_000_000_000));
    telemetryStore.ingestWatchOrientation(sample(2, 900_020_000_000));
    telemetryStore.ingestWatchOrientation(sample(3, 1_000_000_000)); // the watch was restarted
    expect(telemetryStore.getSeries("watchOrientation").map((p) => p.at)).toEqual([1_000]);
  });
});
