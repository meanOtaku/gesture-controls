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
        timestampNs: index * 1_000_000,
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
        timestampNs: index,
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
      timestampNs: 160_000_000,
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

  it("clears the head-tracker diagnostic on reset but keeps the last-selected provider", () => {
    telemetryStore.setHeadTrackerProvider("native");
    telemetryStore.setHeadDiagnostic({
      id: "scanning",
      title: "Scanning for the Sony head tracker",
      detail: "Looking for a compatible Sony head-tracking device over Bluetooth.",
      action: null,
    });
    expect(telemetryStore.getHeadDiagnostic()?.id).toBe("scanning");

    telemetryStore.reset();
    expect(telemetryStore.getHeadDiagnostic()).toBeNull();
    expect(telemetryStore.getHeadTrackerProvider()).toBe("native");
  });

  it("clears a stale diagnostic once the head tracker connects", () => {
    telemetryStore.setHeadDiagnostic({ id: "device-not-found", title: "x", detail: "y", action: null });
    telemetryStore.setHeadDiagnostic(null);
    expect(telemetryStore.getHeadDiagnostic()).toBeNull();
  });

  describe("labeled dataset recorder", () => {
    // The store defaults to "timeline" mode (GC-017); these tests exercise the
    // still-supported "quick" mode explicitly, since that's the behavior they cover.
    beforeEach(() => {
      telemetryStore.setDatasetCaptureMode("quick");
    });

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

    it("fuses orientation and PPG samples, leaving each row's other channel absent rather than carried forward (GC-030)", () => {
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
        timestampNs: 2_000,
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
        accelX: null, accelY: null, accelZ: null,
        gyroX: null, gyroY: null, gyroZ: null,
        quatW: null, quatX: null, quatY: null, quatZ: null,
        label: "pinch_hold",
      });
    });

    it("stop keeps buffered rows for export; discard drops them and clears the session", () => {
      telemetryStore.selectDatasetLabel("scratching");
      telemetryStore.startDatasetRecording();
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampNs: 0, timestampsNs: [0], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
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

    it("removes an unreferenced label but blocks removal of a label a timeline interval still references", () => {
      telemetryStore.selectDatasetLabel("resting");
      expect(telemetryStore.getSessionLabels()).toContain("resting");
      expect(telemetryStore.labelRemovalBlockedReason("resting")).toBeNull();
      expect(telemetryStore.removeSessionLabel("resting")).toBe(true);
      expect(telemetryStore.getSessionLabels()).not.toContain("resting");
      expect(telemetryStore.getSelectedLabel()).toBeNull();

      telemetryStore.setDatasetCaptureMode("timeline");
      telemetryStore.startDatasetRecording();
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampNs: 0, timestampsNs: [0], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
      });
      telemetryStore.setTimelineLabel("waving");
      expect(telemetryStore.labelRemovalBlockedReason("waving")).not.toBeNull();
      expect(telemetryStore.removeSessionLabel("waving")).toBe(false);
      expect(telemetryStore.getSessionLabels()).toContain("waving");
    });
  });

  describe("dataset row chronological ordering (GC-029)", () => {
    beforeEach(() => {
      telemetryStore.setDatasetCaptureMode("timeline");
      telemetryStore.startDatasetRecording();
    });

    it("re-sorts a cross-sensor out-of-order arrival into source-timestamp order", () => {
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test", sequence: 1, timestampNs: 2_000,
        quaternion: [1, 0, 0, 0], accelerometer: null, gyroscope: null,
      });
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampNs: 1_000, timestampsNs: [1_000], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
      });
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test", sequence: 2, timestampNs: 1_500,
        quaternion: [1, 0, 0, 0], accelerometer: null, gyroscope: null,
      });

      expect(telemetryStore.getDatasetRows().map((row) => row.timestampNs)).toEqual(["1000", "1500", "2000"]);
    });

    it("re-sorts a cross-batch out-of-order arrival within the same channel", () => {
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampNs: 3_000, timestampsNs: [3_000], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
      });
      telemetryStore.ingestPpgBatch({
        sequence: 2, timestampNs: 2_000, timestampsNs: [1_000, 2_000], green: [1, 1], greenStatus: [0, 0], red: [1, 1], redStatus: [0, 0], ir: [1, 1], irStatus: [0, 0],
      });

      expect(telemetryStore.getDatasetRows().map((row) => row.timestampNs)).toEqual(["1000", "2000", "3000"]);
    });

    it("breaks equal source timestamps by arrival order (stable tie-break)", () => {
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test", sequence: 1, timestampNs: 1_000,
        quaternion: [1, 0, 0, 0], accelerometer: null, gyroscope: null,
      });
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampNs: 1_000, timestampsNs: [1_000], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
      });

      const rows = telemetryStore.getDatasetRows();
      expect(rows.map((row) => row.timestampNs)).toEqual(["1000", "1000"]);
      expect(rows[0].ppgGreen).toBeNull();
      expect(rows[1].ppgGreen).toBe(1);
    });

    it("shifts timeline interval boundaries so a late out-of-order sample does not move an already-closed interval's rows", () => {
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampNs: 1_000, timestampsNs: [1_000], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
      });
      telemetryStore.setTimelineLabel("waving");
      telemetryStore.ingestPpgBatch({
        sequence: 2, timestampNs: 2_000, timestampsNs: [2_000], green: [2], greenStatus: [0], red: [2], redStatus: [0], ir: [2], irStatus: [0],
      });
      telemetryStore.setTimelineLabel(null);

      const beforeLateArrival = telemetryStore.getTimelineIntervals()[0];
      expect(beforeLateArrival).toMatchObject({ startRawRow: 1, endRawRow: 2 });

      // A straggler with an earlier source timestamp arrives after the interval closed.
      telemetryStore.ingestPpgBatch({
        sequence: 3, timestampNs: 500, timestampsNs: [500], green: [3], greenStatus: [0], red: [3], redStatus: [0], ir: [3], irStatus: [0],
      });

      const rows = telemetryStore.getDatasetRows();
      expect(rows.map((row) => row.timestampNs)).toEqual(["500", "1000", "2000"]);

      const interval = telemetryStore.getTimelineIntervals()[0];
      expect(interval.startRawRow).toBe(2);
      expect(interval.endRawRow).toBe(3);
      expect(rows[interval.startRawRow].timestampNs).toBe("2000");
      expect(rows[(interval.endRawRow as number) - 1].timestampNs).toBe("2000");
    });

    it("persists raw.csv rows in chronological order after an out-of-order live capture", () => {
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test", sequence: 1, timestampNs: 5_000,
        quaternion: [1, 0, 0, 0], accelerometer: null, gyroscope: null,
      });
      telemetryStore.ingestPpgBatch({
        sequence: 1, timestampNs: 3_000, timestampsNs: [3_000], green: [1], greenStatus: [0], red: [1], redStatus: [0], ir: [1], irStatus: [0],
      });
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test", sequence: 2, timestampNs: 4_000,
        quaternion: [1, 0, 0, 0], accelerometer: null, gyroscope: null,
      });

      const payload = telemetryStore.buildRecordingBundlePayload();
      const dataLines = payload?.rawCsv.split("\n").slice(1) ?? [];
      const timestamps = dataLines.map((line) => Number(line.split(",")[0]));

      expect(timestamps).toEqual([3_000, 4_000, 5_000]);
      expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
    });

    it("translates PPG's SDK-clock-domain timestamps onto orientation's watch-clock domain instead of sorting incomparable clocks (GC-030)", () => {
      // The PPG batch's own per-sample SDK timestamps (1e9-scale, an
      // unrelated clock domain) sit nowhere near the watch-clock-domain
      // orientation timestamps below; only the batch envelope timestamp
      // (1_040 — the same domain as orientation) is comparable.
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test", sequence: 1, timestampNs: 1_000,
        quaternion: [1, 0, 0, 0], accelerometer: null, gyroscope: null,
      });
      telemetryStore.ingestPpgBatch({
        sequence: 1,
        timestampNs: 1_040,
        timestampsNs: [1_000_000_000, 1_000_000_040],
        green: [1, 2], greenStatus: [0, 0], red: [1, 2], redStatus: [0, 0], ir: [1, 2], irStatus: [0, 0],
      });
      telemetryStore.ingestWatchOrientation({
        deviceId: "watch-test", sequence: 2, timestampNs: 1_080,
        quaternion: [1, 0, 0, 0], accelerometer: null, gyroscope: null,
      });

      const rows = telemetryStore.getDatasetRows();
      // Translated PPG timestamps land at 1000 and 1040 (envelope 1040,
      // anchored on the last sample, offset by the genuine 40ns intra-batch
      // SDK delta) — comparable with and correctly interleaved among the
      // orientation rows, never the raw ~1e9 SDK values.
      expect(rows.map((row) => row.timestampNs)).toEqual(["1000", "1000", "1040", "1080"]);
      expect(rows.map((row) => Number(row.timestampNs))).toEqual([1_000, 1_000, 1_040, 1_080]);
    });
  });
});
