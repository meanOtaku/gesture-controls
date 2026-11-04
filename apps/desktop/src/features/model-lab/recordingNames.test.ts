import { describe, expect, it } from "vitest";
import { formatTime } from "./labelModels";
import { defaultTitle, gestureSummary, labelsFromText, lineOf, recordingLine, recordingName, recordingTitle, recordingWhen } from "./recordingNames";
import type { DatasetSummary } from "./types";

const base: DatasetSummary = { id: "a", originalFilename: "recorder-94faf83c-60-intervals.csv", importedAt: "2026-11-03T01:30:00Z", label: "", rowCount: 1, sequence: 30 };
const quality = (holds: Record<string, number>) => ({ poorContactShare: 0, holds, shortHolds: 0 });

describe("naming a recording", () => {
  it("takes when it was recorded from its Recorder recording, else its file name, else its import", () => {
    expect(recordingWhen({ ...base, recordedAt: "2026-11-03T01:05:59.434Z" })).toBe("2026-11-03T01:05:59.434Z");
    expect(recordingWhen({ ...base, originalFilename: "gesture-dataset-pinch-2026-10-11T12-08-32.241Z.csv" })).toBe("2026-10-11T12:08:32.241Z");
    expect(recordingWhen(base)).toBe("2026-11-03T01:30:00Z");
    expect(recordingWhen({ ...base, importedAt: "" })).toBeNull();
  });

  it("counts a pinch's in, hold and out once, and lists the gestures most first", () => {
    expect(gestureSummary({ quality: quality({ pinch_in: 17, pinch_hold: 20, pinch_out: 20 }) })).toBe("20 pinches");
    expect(gestureSummary({ quality: quality({ fist: 1, hand_open: 15, left_out: 4, pinch_in: 15, pinch_hold: 15, pinch_out: 15 }) })).toBe("15 hand open, 15 pinches, 1 fist");
    expect(gestureSummary({ quality: quality({ fist: 19 }) })).toBe("19 fist");
    expect(gestureSummary({})).toBe("");
  });

  it("reads as when and what, with the camera, falling back to the file name", () => {
    const at = "2026-11-03T01:05:59.434Z";
    const named = { ...base, recordedAt: at, camera: true, quality: quality({ pinch_hold: 20 }) };
    expect(recordingTitle(named)).toBe(`${formatTime(at)} · 20 pinches`);
    expect(recordingLine(named)).toBe(`#30 ${formatTime(at)} · 20 pinches · camera`);
    expect(recordingLine({ ...base, importedAt: "", sequence: 3, originalFilename: "pinch session" })).toBe("#3 pinch session · no camera");
  });

  it("goes by the name you gave it everywhere, keeping when and what as its default", () => {
    const at = "2026-11-03T01:05:59.434Z";
    const named = { ...base, recordedAt: at, camera: true, quality: quality({ pinch_hold: 20 }), name: "Monday pinches" };
    expect(recordingTitle(named)).toBe("Monday pinches");
    expect(defaultTitle(named)).toBe(`${formatTime(at)} · 20 pinches`);
    expect(recordingName(named)).toBe("#30 Monday pinches");
    expect(recordingLine(named)).toBe("#30 Monday pinches · camera");
    expect(recordingTitle({ ...named, name: "  " })).toBe(`${formatTime(at)} · 20 pinches`);
    // A report from the desktop names a recording by its file: Model Lab's name wins while it has the recording.
    expect(lineOf([named], "a", "recorder-94faf83c.csv")).toBe("#30 Monday pinches · camera");
    expect(lineOf([named], "gone", "recorder-94faf83c.csv")).toBe("recorder-94faf83c.csv");
  });

  it("says how the labels were made, and nothing for a version labelled by hand", () => {
    expect(labelsFromText({ labelsFrom: "motion" })).toMatch(/estimated from the watch's motion/);
    expect(labelsFromText({ labelsFrom: "camera" })).toMatch(/marked by the camera/);
    expect(labelsFromText({ labelsFrom: "camera", derivedFrom: "x" })).toBeNull();
    expect(labelsFromText({})).toBeNull();
  });
});
