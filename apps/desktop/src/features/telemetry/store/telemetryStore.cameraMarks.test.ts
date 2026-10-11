import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryStore } from "./telemetryStore";

function sample(sequence: number) {
  return {
    deviceId: "watch-test", sequence, timestampNs: 1_000_000_000 + sequence * 20_000_000,
    quaternion: [1, 0, 0, 0] as [number, number, number, number],
    accelerometer: [0, 0, 0] as [number, number, number], gyroscope: [0, 0, 0] as [number, number, number],
  };
}
const labelsOf = (csv: string) => csv.split("\n").filter((line) => !line.startsWith("#")).slice(1).map((line) => line.split(",").pop());

let clock = 0;
beforeEach(() => {
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  telemetryStore.reset();
  telemetryStore.setDatasetCaptureMode("timeline");
  telemetryStore.startDatasetRecording();
});
afterEach(() => {
  telemetryStore.reset();
  vi.restoreAllMocks();
});

/** One watch row every 10 ms of browser time. */
function rows(from: number, to: number) {
  for (let i = from; i <= to; i++) {
    clock += 10;
    telemetryStore.ingestWatchOrientation(sample(i));
  }
}

describe("camera marks written live into the session", () => {
  it("labels the rows while the camera holds the gesture, in the CSV export too", () => {
    rows(1, 3);
    telemetryStore.setTimelineLabel("pinch", "camera_proposal");
    rows(4, 6);
    telemetryStore.setTimelineLabel(null);
    rows(7, 8);
    telemetryStore.stopDatasetRecording();
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "", "", "pinch", "pinch", "pinch", "", ""]);
    expect(telemetryStore.countCameraIntervals()).toBe(1);
    expect(telemetryStore.getTimelineIntervals()[0].creationMechanism).toBe("camera_proposal");
  });

  it("starts the mark where the gesture began, not where the camera noticed it (rows that arrived since)", () => {
    rows(1, 5); // rows 0..4, arriving at 1010..1050
    const began = clock - 29; // the gesture began just over 20 ms ago; the camera only now knows
    telemetryStore.setTimelineLabel("pinch", "camera_proposal", began);
    rows(6, 7);
    telemetryStore.stopDatasetRecording();
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "", "pinch", "pinch", "pinch", "pinch", "pinch"]);
  });

  it("never starts a mark inside an interval that is already there", () => {
    rows(1, 2);
    telemetryStore.setTimelineLabel("pinch", "camera_proposal");
    rows(3, 4);
    telemetryStore.setTimelineLabel(null); // closes at row 4
    rows(5, 6);
    telemetryStore.setTimelineLabel("pinch", "camera_proposal", 0); // claims to have begun long ago
    rows(7, 7);
    telemetryStore.stopDatasetRecording();
    const [first, second] = telemetryStore.getTimelineIntervals();
    expect(second.startRawRow).toBeGreaterThanOrEqual(first.endRawRow as number);
  });

  it("still exports the label a row was recorded with when no interval covers it", () => {
    rows(1, 1);
    telemetryStore.setTimelineLabel("snap");
    rows(2, 3);
    telemetryStore.stopDatasetRecording();
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "snap", "snap"]);
  });
});
