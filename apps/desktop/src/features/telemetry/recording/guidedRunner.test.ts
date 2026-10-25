import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryStore } from "../store/telemetryStore";
import { guidedRunner } from "./guidedRunner";
import { DEFAULT_PLAN, LEAD_IN_MS } from "./guidedSession";
import { timedCapture } from "./timedCapture";

let clock = 0;
let sequence = 0;
function sample() {
  sequence += 1;
  return {
    deviceId: "watch-test", sequence, timestampNs: 1_000_000_000 + sequence * 20_000_000,
    quaternion: [1, 0, 0, 0] as [number, number, number, number],
    accelerometer: [0, 0, 0] as [number, number, number], gyroscope: [0, 0, 0] as [number, number, number],
  };
}
/** Samples every 20 ms for `ms`, with the runner's clock ticking along. */
function run(ms: number) {
  for (let t = 0; t < ms; t += 20) {
    clock += 20;
    telemetryStore.ingestWatchOrientation(sample());
    vi.advanceTimersByTime(20);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1000;
  sequence = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  telemetryStore.reset();
  timedCapture.reset();
});
afterEach(() => {
  guidedRunner.stop();
  telemetryStore.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the guided session runner", () => {
  it("starts a timed timeline recording, and labels each cue from the first sample's clock", () => {
    const plan = { ...DEFAULT_PLAN, label: "pinch", cues: 2, holdMs: 400, minGapSeconds: 2, maxGapSeconds: 2, everydayLabel: "everyday", activities: [{ activity: "Type", seconds: 5 }] };
    expect(guidedRunner.start(plan)).toBe(true);
    expect(telemetryStore.getDatasetCaptureMode()).toBe("timeline");
    expect(timedCapture.take()).toBe(Math.ceil((LEAD_IN_MS + 400 + 2000 + 400 + 3000 + 5000 + 2000) / 1000));
    expect(guidedRunner.snapshot()?.elapsedMs).toBeNull();
    vi.advanceTimersByTime(500); // no sample yet: still arming, the session has not begun
    expect(guidedRunner.snapshot()?.elapsedMs).toBeNull();

    run(LEAD_IN_MS + 400 + 2000 + 400 + 3000 + 5000 + 1000);
    telemetryStore.stopDatasetRecording();
    vi.advanceTimersByTime(50);
    expect(guidedRunner.snapshot()).toBeNull(); // the recording stopped, so the session ended

    const intervals = telemetryStore.getTimelineIntervals();
    expect(intervals.map((interval) => [interval.labelId, interval.creationMechanism])).toEqual([
      ["pinch", "guided_cue"], ["pinch", "guided_cue"], ["everyday", "guided_cue"],
    ]);
    // Rows are 20 ms apart and the first one starts the clock: the first cue is 5 s in, held 0.4 s.
    const [first] = intervals;
    expect(first.startRawRow).toBeGreaterThanOrEqual(LEAD_IN_MS / 20 - 2);
    expect(first.startRawRow).toBeLessThanOrEqual(LEAD_IN_MS / 20 + 2);
    expect(first.endRawRow! - first.startRawRow).toBeGreaterThanOrEqual(400 / 20 - 2);
    expect(first.endRawRow! - first.startRawRow).toBeLessThanOrEqual(400 / 20 + 2);
  });

  it("will not start over a recording already under way", () => {
    telemetryStore.setDatasetCaptureMode("timeline");
    telemetryStore.startDatasetRecording();
    expect(guidedRunner.start({ ...DEFAULT_PLAN, label: "pinch" })).toBe(false);
  });
});
