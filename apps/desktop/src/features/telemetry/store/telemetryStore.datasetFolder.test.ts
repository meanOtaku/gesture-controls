import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMU_FILE_COLUMNS, PPG_FILE_COLUMNS, telemetryStore } from "./telemetryStore";

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

const motion = (sequence: number) => ({
  deviceId: "watch-test", sequence, timestampNs: 5_000_000_000 + sequence * 20_000_000,
  quaternion: [1, 0, 0, 0] as [number, number, number, number],
  accelerometer: [0.1, 0.2, 0.3] as [number, number, number], gyroscope: [0.4, 0.5, 0.6] as [number, number, number],
});
const pulse = (sequence: number, atNs: number) => ({
  deviceId: "watch-test", sequence, timestampNs: atNs, sampleCount: 2, timestampsNs: [atNs - 40_000_000, atNs],
  green: [10, 11], greenStatus: [0, 0], red: [20, 21], redStatus: [0, 0], ir: [30, 31], irStatus: [0, 0],
});
const lines = (csv: string) => csv.split("\n").filter((l) => l && !l.startsWith("#"));

describe("the dataset as two dense files", () => {
  it("puts each sample in the file of its own sensor, with no blank cell in either", () => {
    for (let i = 1; i <= 4; i++) { clock += 20; telemetryStore.ingestWatchOrientation(motion(i)); }
    telemetryStore.ingestPpgBatch({ ...pulse(1, 5_100_000_000), timestampNs: 5_100_000_000 });
    telemetryStore.stopDatasetRecording();
    const files = telemetryStore.generateDatasetFolderFiles();
    expect([files.ppgRows, files.imuRows]).toEqual([2, 4]);
    const ppg = lines(files.ppgCsv);
    const imu = lines(files.imuCsv);
    expect(ppg[0]).toBe(PPG_FILE_COLUMNS.join(","));
    expect(imu[0]).toBe(IMU_FILE_COLUMNS.join(","));
    expect(ppg).toHaveLength(3);
    expect(imu).toHaveLength(5);
    // Every cell filled except the label, which is empty until something marks the row.
    for (const row of [...ppg.slice(1), ...imu.slice(1)]) expect(row.split(",").slice(0, -2).every((cell) => cell !== "")).toBe(true);
    expect(ppg[1].split(",").slice(2, 5)).toEqual(["10", "20", "30"]);
    expect(imu[1].split(",").slice(2, 8)).toEqual(["0.1", "0.2", "0.3", "0.4", "0.5", "0.6"]);
  });

  it("holds the same samples and labels as the single file, and says the label the same way", () => {
    for (let i = 1; i <= 3; i++) { clock += 20; telemetryStore.ingestWatchOrientation(motion(i)); }
    telemetryStore.setTimelineLabel("pinch", "camera_proposal");
    for (let i = 4; i <= 6; i++) { clock += 20; telemetryStore.ingestWatchOrientation(motion(i)); }
    telemetryStore.ingestPpgBatch(pulse(1, 5_200_000_000));
    telemetryStore.setTimelineLabel(null);
    telemetryStore.stopDatasetRecording();
    const single = lines(telemetryStore.generateDatasetCsv()).slice(1);
    const files = telemetryStore.generateDatasetFolderFiles();
    const labelsOf = (rows: string[]) => rows.map((r) => r.split(",").at(-2));
    const fromPair = [...lines(files.ppgCsv).slice(1), ...lines(files.imuCsv).slice(1)];
    expect(fromPair).toHaveLength(single.length); // no row had both
    expect(labelsOf(fromPair).filter((l) => l === "pinch")).toHaveLength(labelsOf(single).filter((l) => l === "pinch").length);
    expect(files.ppgCsv.split("\n")[0]).toBe("# gesture-dataset-export: 1");
    expect(files.ppgCsv.split("\n")[1]).toBe(files.imuCsv.split("\n")[1]);
  });
});
