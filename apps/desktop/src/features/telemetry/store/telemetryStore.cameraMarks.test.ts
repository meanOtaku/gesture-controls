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

  it("ends the mark where the gesture ended, not where the camera let go after its grace and latency", () => {
    rows(1, 2);
    telemetryStore.setTimelineLabel("pinch", "camera_proposal");
    rows(3, 5); // rows 2..4, arriving at 1030..1050
    const ended = clock - 19; // the gesture ended at 1031; the camera is only now sure
    rows(6, 7);
    expect(telemetryStore.closeTimelineLabelAt("pinch", ended)).toBe(true);
    telemetryStore.stopDatasetRecording();
    // Rows that arrived after the gesture ended (1040 on) are no longer labelled.
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "", "pinch", "", "", "", ""]);
  });

  it("closes only the label it is asked to close", () => {
    rows(1, 2);
    telemetryStore.setTimelineLabel("snap");
    expect(telemetryStore.closeTimelineLabelAt("pinch", clock)).toBe(false);
    expect(telemetryStore.getActiveTimelineLabel()).toBe("snap");
  });

  it("keeps a mark's start on the right row when a delayed sample is inserted before it", () => {
    rows(1, 5); // rows 0..4 (sequence 1..5), arriving at 1010..1050
    const began = clock - 19; // began between the arrivals of sequence 3 and 4
    // A sample older than all of them arrives late and is placed first, moving every row one place on.
    clock += 1;
    telemetryStore.ingestWatchOrientation(sample(0));
    telemetryStore.setTimelineLabel("pinch", "camera_proposal", began);
    rows(6, 6);
    telemetryStore.stopDatasetRecording();
    // Sequence 0..6 in time order; the mark still starts at sequence 4, the first row that arrived after it began.
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "", "", "", "pinch", "pinch", "pinch"]);
  });

  it("still exports the label a row was recorded with when no interval covers it", () => {
    rows(1, 1);
    telemetryStore.setTimelineLabel("snap");
    rows(2, 3);
    telemetryStore.stopDatasetRecording();
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "snap", "snap"]);
  });
});

describe("several labels in one recording", () => {
  it("keeps the selected label first, lets others be added and dropped, and never lists the selected one twice", () => {
    telemetryStore.reset();
    telemetryStore.selectDatasetLabel("pinch");
    expect(telemetryStore.toggleExtraLabel("fist")).toBe(true);
    expect(telemetryStore.getMarkLabels()).toEqual(["pinch", "fist"]);
    expect(telemetryStore.toggleExtraLabel("pinch")).toBe(false);
    telemetryStore.toggleExtraLabel("fist");
    expect(telemetryStore.getMarkLabels()).toEqual(["pinch"]);
    telemetryStore.toggleExtraLabel("fist");
    telemetryStore.selectDatasetLabel("fist"); // choosing an extra as the main one moves it
    expect(telemetryStore.getMarkLabels()).toEqual(["fist"]);
  });

  it("writes each label on its own rows, counted separately", () => {
    rows(1, 2);
    telemetryStore.setTimelineLabel("pinch", "camera_proposal");
    rows(3, 4);
    telemetryStore.setTimelineLabel("fist", "camera_proposal");
    rows(5, 6);
    telemetryStore.setTimelineLabel(null);
    rows(7, 7);
    telemetryStore.stopDatasetRecording();
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "", "pinch", "pinch", "fist", "fist", ""]);
    expect(telemetryStore.countCameraIntervals("pinch")).toBe(1);
    expect(telemetryStore.countCameraIntervals("fist")).toBe(1);
    expect(telemetryStore.countCameraIntervals()).toBe(2);
  });
});
