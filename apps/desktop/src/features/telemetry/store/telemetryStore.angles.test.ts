import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telemetryStore } from "./telemetryStore";

/** A watch orientation that is a pure yaw of `degrees` (a turn about the vertical axis), as the watch reports it. */
function yawSample(sequence: number, degrees: number) {
  const half = (degrees * Math.PI) / 360;
  return {
    deviceId: "watch-test", sequence, timestampNs: 1_000_000_000 + sequence * 20_000_000,
    quaternion: [Math.cos(half), 0, 0, Math.sin(half)] as [number, number, number, number],
    accelerometer: [0, 0, 0] as [number, number, number], gyroscope: [0, 0, 0] as [number, number, number],
  };
}

beforeEach(() => telemetryStore.reset());
afterEach(() => telemetryStore.reset());

describe("watch orientation chart", () => {
  it("draws a slow turn through ±180° as a smooth line, not a spike", () => {
    // Yaw drifting 2° at a time from -170° through the back of the circle (-180°/+180°) and on.
    const raw = [-170, -172, -174, -176, -178, -180, 178, 176, 174, 172, 170];
    raw.forEach((degrees, i) => telemetryStore.ingestWatchOrientation(yawSample(i + 1, degrees)));
    const yaw = telemetryStore.getSeries("watchOrientation").map((point) => point.values[0]);
    expect(yaw).toHaveLength(raw.length);
    for (let i = 1; i < yaw.length; i++) expect(Math.abs(yaw[i] - yaw[i - 1])).toBeLessThan(3);
    // It carries on past -180 instead of jumping back to +180.
    expect(yaw[yaw.length - 1]).toBeCloseTo(-190, 0);
  });

  it("starts again after the series is cleared", () => {
    telemetryStore.ingestWatchOrientation(yawSample(1, 175));
    telemetryStore.ingestWatchOrientation(yawSample(2, -175));
    telemetryStore.reset();
    telemetryStore.ingestWatchOrientation(yawSample(1, -175));
    expect(telemetryStore.getSeries("watchOrientation")[0].values[0]).toBeCloseTo(-175, 0);
  });
});
