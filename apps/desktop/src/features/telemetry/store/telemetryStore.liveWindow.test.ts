import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_WINDOW_MS, telemetryStore } from "./telemetryStore";

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

/** One PPG batch of `n` samples 40 ms apart (25 Hz), ending at the watch time `endNs`. */
function ppg(sequence: number, endNs: number, n: number) {
  const timestampsNs = Array.from({ length: n }, (_, i) => endNs - (n - 1 - i) * 40_000_000);
  return { sequence, timestampNs: endNs, timestampsNs, green: timestampsNs.map(() => 1), greenStatus: timestampsNs.map(() => 0), red: timestampsNs.map(() => 2), redStatus: timestampsNs.map(() => 0), ir: timestampsNs.map(() => 3), irStatus: timestampsNs.map(() => 0) };
}

describe("the live charts' span", () => {
  it("shows the last 6 s of PPG, not the last 600 samples (24 s at 25 Hz)", () => {
    for (let second = 1; second <= 20; second += 1) {
      now += 1000;
      telemetryStore.ingestPpgBatch(ppg(second, 5_000_000_000 + second * 1_000_000_000, 25) as never);
    }
    const at = telemetryStore.getSeries("ppg").map((p) => p.at);
    expect(at.length).toBeGreaterThan(140);
    expect(at.length).toBeLessThan(160);
    expect(at[at.length - 1] - at[0]).toBeLessThanOrEqual(LIVE_WINDOW_MS);
  });

  it("keeps every value of a slow series such as heart rate", () => {
    for (let second = 1; second <= 20; second += 1) {
      now += 1000;
      telemetryStore.ingestHeartRateBatch({ sequence: second, timestampsNs: [second * 1_000_000_000], heartRate: [70], ibiMs: [[]] } as never);
    }
    expect(telemetryStore.getSeries("heartRate")).toHaveLength(20);
  });
});
