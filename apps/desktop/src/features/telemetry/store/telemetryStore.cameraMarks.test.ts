import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnnotationInterval } from "../../../shared/tauri/recordingBundle";
import { telemetryStore } from "./telemetryStore";

function sample(sequence: number) {
  return {
    deviceId: "watch-test", sequence, timestampNs: 1_000_000_000 + sequence * 20_000_000,
    quaternion: [1, 0, 0, 0] as [number, number, number, number],
    accelerometer: [0, 0, 0] as [number, number, number], gyroscope: [0, 0, 0] as [number, number, number],
  };
}
const mark = (id: string, label: string, startRow: number, endRowInclusive: number): AnnotationInterval => ({
  interval_id: id, label_id: label, requested_start_monotonic_ns: 1, requested_end_monotonic_ns: 2,
  resolved_start: { raw_row: startRow, source_timestamp_ns: 1 }, resolved_end: { raw_row: endRowInclusive, source_timestamp_ns: 2 },
  resolution_rule_version: 1, creation_mechanism: "camera_proposal", curation_status: "unreviewed", created_at: "2026-10-09T00:00:00Z", revision: 1,
});
const labelsOf = (csv: string) => csv.split("\n").filter((line) => !line.startsWith("#")).slice(1).map((line) => line.split(",").pop());

/** A saved timeline session of 10 rows with no manual intervals. */
function savedSession() {
  telemetryStore.setDatasetCaptureMode("timeline");
  telemetryStore.startDatasetRecording();
  for (let i = 1; i <= 10; i++) telemetryStore.ingestWatchOrientation(sample(i));
  telemetryStore.stopDatasetRecording();
}

beforeEach(() => telemetryStore.reset());
afterEach(() => telemetryStore.reset());

describe("camera marks in the session", () => {
  it("puts the camera's intervals in the session, and the CSV export labels those rows with them", () => {
    savedSession();
    expect(labelsOf(telemetryStore.generateDatasetCsv()).every((l) => l === "")).toBe(true);
    const added = telemetryStore.addCameraMarkedIntervals([mark("a", "pinch", 2, 4), mark("b", "pinch", 7, 8)], 10);
    expect(added).toBe(2);
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "", "pinch", "pinch", "pinch", "", "", "pinch", "pinch", ""]);
    expect(telemetryStore.getTimelineIntervals().map((i) => i.creationMechanism)).toEqual(["camera_proposal", "camera_proposal"]);
  });

  it("skips an interval that overlaps one already there, or runs past the rows", () => {
    savedSession();
    expect(telemetryStore.addCameraMarkedIntervals([mark("a", "pinch", 2, 4)], 10)).toBe(1);
    expect(telemetryStore.addCameraMarkedIntervals([mark("b", "pinch", 4, 6), mark("c", "pinch", 8, 12)], 10)).toBe(0);
    expect(telemetryStore.getTimelineIntervals()).toHaveLength(1);
  });

  it("does nothing unless the session is the one that was saved, with the same number of rows", () => {
    savedSession();
    expect(telemetryStore.addCameraMarkedIntervals([mark("a", "pinch", 2, 4)], 99)).toBe(0); // a different recording
    telemetryStore.startDatasetRecording(); // a new recording has begun
    expect(telemetryStore.addCameraMarkedIntervals([mark("a", "pinch", 2, 4)], 0)).toBe(0);
  });

  it("still exports the label a row was recorded with when no interval covers it", () => {
    telemetryStore.setDatasetCaptureMode("timeline");
    telemetryStore.startDatasetRecording();
    telemetryStore.ingestWatchOrientation(sample(1));
    telemetryStore.setTimelineLabel("snap");
    telemetryStore.ingestWatchOrientation(sample(2));
    telemetryStore.ingestWatchOrientation(sample(3));
    telemetryStore.stopDatasetRecording();
    expect(labelsOf(telemetryStore.generateDatasetCsv())).toEqual(["", "snap", "snap"]);
  });
});
