import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WATCH_STATUS, MAX_VISIBLE_SAMPLES, telemetryStore } from "./telemetryStore";

describe("telemetryStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    telemetryStore.reset();
  });

  it("retains only the latest graph window independently of component mounts", () => {
    for (let index = 0; index < MAX_VISIBLE_SAMPLES + 5; index += 1) {
      telemetryStore.ingestPpgBatch({
        sequence: index,
        timestampsNs: [index * 1_000_000],
        green: [index],
        red: [index + 1],
        ir: [index + 2],
      });
    }

    const points = telemetryStore.getSeries("ppg");
    expect(points).toHaveLength(MAX_VISIBLE_SAMPLES);
    expect(points[0].values[0]).toBe(5);
    expect(points.at(-1)?.values[0]).toBe(MAX_VISIBLE_SAMPLES + 4);
  });

  it("coalesces high-frequency ingestion into one UI publication per frame budget", () => {
    const subscriber = vi.fn();
    const unsubscribe = telemetryStore.subscribe(subscriber);

    for (let index = 0; index < 100; index += 1) {
      telemetryStore.ingestPpgBatch({
        sequence: index,
        timestampsNs: [index],
        green: [index],
        red: [index],
        ir: [index],
      });
    }

    expect(subscriber).not.toHaveBeenCalled();
    vi.advanceTimersByTime(66);
    expect(subscriber).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not duplicate the last orientation when unrelated status events repeat it", () => {
    const orientation = {
      deviceId: "watch-test",
      sequence: 7,
      timestampNs: 123,
      quaternion: [1, 0, 0, 0] as [number, number, number, number],
      accelerometer: null,
      gyroscope: null,
    };
    const status = { ...EMPTY_WATCH_STATUS, connected: true, lastOrientation: orientation };

    telemetryStore.ingestWatchStatus(status);
    telemetryStore.ingestWatchStatus({ ...status, ppgRateHz: 25 });

    expect(telemetryStore.getSeries("watchOrientation")).toHaveLength(1);
  });
});
