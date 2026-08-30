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
        greenStatus: [0],
        red: [index + 1],
        redStatus: [0],
        ir: [index + 2],
        irStatus: [0],
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
        greenStatus: [0],
        red: [index],
        redStatus: [0],
        ir: [index],
        irStatus: [0],
      });
    }

    expect(subscriber).not.toHaveBeenCalled();
    vi.advanceTimersByTime(66);
    expect(subscriber).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("preserves every PPG callback sample for the Watch-controlled flush schedule", () => {
    telemetryStore.setHealthAcceptanceRatesHz({ heartRate: 200, temperature: 200, eda: 200 });
    telemetryStore.ingestPpgBatch({
      sequence: 1,
      timestampsNs: [0, 40_000_000, 80_000_000, 120_000_000, 160_000_000],
      green: [1, 2, 3, 4, 5],
      greenStatus: [0, 0, 0, 0, 0],
      red: [1, 2, 3, 4, 5],
      redStatus: [0, 0, 0, 0, 0],
      ir: [1, 2, 3, 4, 5],
      irStatus: [0, 0, 0, 0, 0],
    });

    expect(telemetryStore.getSeries("ppg").map((point) => point.values[0])).toEqual([1, 2, 3, 4, 5]);
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

    telemetryStore.ingestWatchOrientation(orientation);
    telemetryStore.ingestWatchStatus({ ...status, ppgRateHz: 25 });

    expect(telemetryStore.getSeries("watchOrientation")).toHaveLength(1);
  });

  describe("labeled dataset recorder", () => {
    it("does not buffer dataset rows before a session is started", () => {
      telemetryStore.selectDatasetLabel("pinch_start");
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test",
        sequence: 1,
        timestampNs: 100,
        quaternion: [1, 0, 0, 0],
        accelerometer: [0.1, 0.2, 0.3],
        gyroscope: [0.4, 0.5, 0.6],
      });

      expect(telemetryStore.getDatasetRowCount()).toBe(0);
      expect(telemetryStore.getDatasetSession()).toBeNull();
    });

    it("captures immutable session metadata at start, independent of later label changes", () => {
      telemetryStore.selectDatasetLabel("walking");
      telemetryStore.startDatasetRecording();
      const session = telemetryStore.getDatasetSession();
      expect(session?.label).toBe("walking");

      telemetryStore.selectDatasetLabel("typing");
      expect(telemetryStore.getDatasetSession()?.label).toBe("walking");
      expect(telemetryStore.getSelectedLabel()).toBe("typing");
    });

    it("fuses orientation and PPG samples, carrying forward the other channel's last known values", () => {
      telemetryStore.selectDatasetLabel("pinch_hold");
      telemetryStore.startDatasetRecording();

      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test",
        sequence: 5,
        timestampNs: 1_000,
        quaternion: [0.9, 0.1, 0.2, 0.3],
        accelerometer: [1, 2, 3],
        gyroscope: [4, 5, 6],
      });
      telemetryStore.ingestPpgBatch({
        sequence: 9,
        timestampsNs: [2_000],
        green: [10],
        greenStatus: [0],
        red: [20],
        redStatus: [1],
        ir: [30],
        irStatus: [0],
      });

      const rows = telemetryStore.getDatasetRows();
      expect(rows).toHaveLength(2);

      expect(rows[0]).toMatchObject({
        timestampNs: "1000",
        sequence: "5",
        accelX: 1, accelY: 2, accelZ: 3,
        gyroX: 4, gyroY: 5, gyroZ: 6,
        quatW: 0.9, quatX: 0.1, quatY: 0.2, quatZ: 0.3,
        ppgGreen: null, ppgRed: null, ppgIr: null,
        contactQuality: null,
        label: "pinch_hold",
      });

      expect(rows[1]).toMatchObject({
        timestampNs: "2000",
        sequence: "9",
        ppgGreen: 10, ppgRed: 20, ppgIr: 30,
        contactQuality: 1,
        accelX: 1, accelY: 2, accelZ: 3,
        quatW: 0.9, quatX: 0.1, quatY: 0.2, quatZ: 0.3,
        label: "pinch_hold",
      });
    });

    it("stop keeps buffered rows for export; discard drops them and clears the session", () => {
      telemetryStore.selectDatasetLabel("scratching");
      telemetryStore.startDatasetRecording();
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampsNs: [0], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
      });

      telemetryStore.stopDatasetRecording();
      expect(telemetryStore.getDatasetRecording()).toBe(false);
      expect(telemetryStore.getDatasetRowCount()).toBe(1);
      expect(telemetryStore.getDatasetSession()).not.toBeNull();

      telemetryStore.discardDatasetRecording();
      expect(telemetryStore.getDatasetRowCount()).toBe(0);
      expect(telemetryStore.getDatasetSession()).toBeNull();
    });

    it("generates dataset CSV with leading metadata comments and a stable, uncorrupted header", () => {
      telemetryStore.selectDatasetLabel("standing");
      telemetryStore.startDatasetRecording();
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test",
        sequence: 3,
        timestampNs: 500,
        quaternion: [1, 0, 0, 0],
        accelerometer: [0.1, 0.2, 0.3],
        gyroscope: null,
      });
      telemetryStore.stopDatasetRecording();

      const csv = telemetryStore.generateDatasetCsv();
      const lines = csv.split("\n");
      const commentLines = lines.filter((line) => line.startsWith("#"));
      const headerLine = lines.find((line) => !line.startsWith("#"));

      expect(commentLines.some((line) => line.includes("label: standing"))).toBe(true);
      expect(commentLines.some((line) => line.includes("row_count: 1"))).toBe(true);
      expect(headerLine).toBe(
        "timestamp_ns,sequence,ppg_green,ppg_red,ppg_ir,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,quat_w,quat_x,quat_y,quat_z,contact_quality,label",
      );

      const dataLine = lines[lines.length - 1];
      expect(dataLine).toBe("500,3,,,,0.1,0.2,0.3,,,,1,0,0,0,,standing");
    });
  });
});
