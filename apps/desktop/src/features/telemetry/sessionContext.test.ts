import { afterEach, describe, expect, it } from "vitest";
import { cleanContext, contextCommentLines, describeContext, loadSessionContext, saveSessionContext } from "./sessionContext";
import { telemetryStore } from "./store/telemetryStore";

afterEach(() => {
  localStorage.clear();
  telemetryStore.reset();
});

describe("session details", () => {
  it("become # context lines in field order, leaving out empty fields and line breaks", () => {
    expect(contextCommentLines({ notes: "two\nlines", arm: "resting", wrist: "left", strap: " " })).toEqual([
      "# context.wrist: left",
      "# context.arm: resting",
      "# context.notes: two lines",
    ]);
    expect(cleanContext({ activity: "  typing " })).toEqual({ activity: "typing" });
  });

  it("are remembered for the next session and read in words", () => {
    saveSessionContext({ wrist: "right", arm: "walking", activity: "commuting" });
    expect(loadSessionContext()).toEqual({ wrist: "right", arm: "walking", activity: "commuting" });
    expect(describeContext({ wrist: "right", arm: "walking", activity: "commuting" })).toBe("Right wrist · Walking · commuting");
  });

  it("go into the recording's exports as they were when it started", () => {
    telemetryStore.setSessionContext({ arm: "raised", pinch: "firm" });
    telemetryStore.selectDatasetLabel("pinch");
    telemetryStore.startDatasetRecording();
    telemetryStore.setSessionContext({ arm: "walking" }); // changed mid-recording: for the next one
    telemetryStore.ingestWatchOrientation({ deviceId: "w", sequence: 1, timestampNs: 500, quaternion: [1, 0, 0, 0], accelerometer: [0.1, 0.2, 0.3], gyroscope: null });
    telemetryStore.stopDatasetRecording();
    const comments = telemetryStore.generateDatasetCsv().split("\n").filter((line) => line.startsWith("#"));
    expect(comments).toContain("# context.arm: raised");
    expect(comments).toContain("# context.pinch: firm");
    expect(telemetryStore.generateDatasetFolderFiles().imuCsv).toContain("# context.arm: raised\n");
  });

  it("keep, batch by batch, how the pulse timestamps were placed on the watch clock", () => {
    telemetryStore.selectDatasetLabel("pinch");
    telemetryStore.startDatasetRecording();
    // The pulse sensor's clock runs 5 s behind the watch's; the batch was sent 10 ms after its newest sample.
    telemetryStore.ingestPpgBatch({ deviceId: "w", sequence: 7, timestampNs: 6_010_000_000, sampleCount: 2, timestampsNs: [960_000_000, 1_000_000_000], green: [1, 2], greenStatus: [0, 0], red: [1, 2], redStatus: [0, 0], ir: [1, 2], irStatus: [0, 0] } as never);
    telemetryStore.stopDatasetRecording();
    const clock = telemetryStore.generateDatasetFolderFiles().ppgClockCsv.trim().split("\n");
    expect(clock).toEqual(["sequence,sent_ns,newest_sensor_ns,offset_ns", "7,6010000000,1000000000,5010000000"]);
  });
});
