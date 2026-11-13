import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clockSync } from "../../camera/clockSync";
import { telemetryStore } from "./telemetryStore";

const sample = (sequence: number) => ({
  deviceId: "watch-test", sequence, timestampNs: 5_000_000_000 + sequence * 10_000_000,
  quaternion: [1, 0, 0, 0] as [number, number, number, number],
  accelerometer: [sequence, 0, 0] as [number, number, number], gyroscope: [0, 0, 0] as [number, number, number],
});

beforeEach(() => { telemetryStore.reset(); clockSync.reset(); });
afterEach(() => { telemetryStore.reset(); clockSync.reset(); });

describe("an orientation batch", () => {
  it("keeps every sample, in order", () => {
    telemetryStore.ingestWatchOrientationBatch([sample(1), sample(2), sample(3), sample(4), sample(5)]);
    expect(telemetryStore.getSeries("watchAcceleration").map((p) => p.values[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it("lines the clocks up from its newest sample only, since the others waited in the batch", () => {
    telemetryStore.ingestWatchOrientationBatch([sample(1), sample(2), sample(3), sample(4), sample(5)]);
    expect(clockSync.estimate(1)?.samples).toBe(1);
  });

  it("skips the status event's copy of the newest sample", () => {
    telemetryStore.ingestWatchOrientationBatch([sample(1), sample(2)]);
    telemetryStore.ingestWatchOrientation(sample(2));
    expect(telemetryStore.getSeries("watchAcceleration")).toHaveLength(2);
  });
});
