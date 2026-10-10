import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryStore } from "../telemetry/store/telemetryStore";
import { clockSync } from "./clockSync";

function orientation(sequence: number, timestampNs: number) {
  return { deviceId: "watch-test", sequence, timestampNs, quaternion: [1, 0, 0, 0] as [number, number, number, number], accelerometer: [0, 0, 0] as [number, number, number], gyroscope: [0, 0, 0] as [number, number, number] };
}

beforeEach(() => { telemetryStore.reset(); clockSync.reset(); });
afterEach(() => { telemetryStore.setEvidenceProvider(null); telemetryStore.reset(); clockSync.reset(); vi.restoreAllMocks(); });

describe("camera evidence in a recording bundle", () => {
  function record() {
    telemetryStore.startDatasetRecording();
    telemetryStore.ingestWatchOrientation(orientation(1, 1_000_000_000));
    telemetryStore.ingestWatchOrientation(orientation(2, 1_020_000_000));
    return telemetryStore.buildRecordingBundlePayload("manual_stop");
  }

  it("is a plain watch recording when there is no camera evidence", () => {
    const payload = record()!;
    expect(payload.extraFiles).toBeUndefined();
    expect(payload.recording.sources.map((s) => s.source_id)).toEqual(["watch"]);
  });

  it("carries the camera's files and declares its source, without counting it among the raw rows", () => {
    const provider = vi.fn((_start: number, _end: number) => ({
      files: { "hand_landmarks.csv": "h\n1", "clock_sync.csv": "c\n1" },
      sources: [{ source_id: "camera_hand_landmarks", configuration: { frames: 1 } }],
    }));
    telemetryStore.setEvidenceProvider(provider);
    const payload = record()!;
    expect(payload.extraFiles).toEqual({ "hand_landmarks.csv": "h\n1", "clock_sync.csv": "c\n1" });
    expect(payload.recording.sources.map((s) => s.source_id)).toEqual(["watch", "camera_hand_landmarks"]);
    expect(Object.keys(payload.recording.raw_source_row_counts)).toEqual(["watch"]);
    // It is asked for the recording's own window, on the browser's monotonic clock in milliseconds.
    const [start, end] = provider.mock.calls[0];
    expect(start).toBeCloseTo(payload.recording.actual_start.monotonic_ns / 1e6, 3);
    expect(end).toBeCloseTo(payload.recording.actual_end.monotonic_ns / 1e6, 3);
    expect(end).toBeGreaterThanOrEqual(start);
  });

  it("declares every camera that contributed, each with its own file", () => {
    telemetryStore.setEvidenceProvider(() => ({
      files: { "hand_landmarks.csv": "h\n1", "hand_landmarks_2.csv": "h\n2", "clock_sync.csv": "c\n1" },
      sources: [{ source_id: "camera_hand_landmarks", configuration: {} }, { source_id: "camera_hand_landmarks_2", configuration: {} }],
    }));
    const payload = record()!;
    expect(Object.keys(payload.extraFiles!).sort()).toEqual(["clock_sync.csv", "hand_landmarks.csv", "hand_landmarks_2.csv"]);
    expect(payload.recording.sources.map((s) => s.source_id)).toEqual(["watch", "camera_hand_landmarks", "camera_hand_landmarks_2"]);
    expect(Object.keys(payload.recording.raw_source_row_counts)).toEqual(["watch"]);
  });

  it("is a plain watch recording when the provider has nothing", () => {
    telemetryStore.setEvidenceProvider(() => null);
    expect(record()!.extraFiles).toBeUndefined();
  });

  it("tells the camera when the recording's first sample was accepted", () => {
    expect(telemetryStore.getDatasetActualStartMonotonicMs()).toBeNull();
    telemetryStore.startDatasetRecording();
    telemetryStore.ingestWatchOrientation(orientation(1, 1_000_000_000));
    expect(telemetryStore.getDatasetActualStartMonotonicMs()).toBeGreaterThan(0);
  });
});

describe("clock alignment from the watch stream", () => {
  it("learns the watch/browser offset from orientation samples as they arrive", () => {
    for (let i = 0; i < 30; i += 1) telemetryStore.ingestWatchOrientation(orientation(i + 1, 1_000_000_000 + i * 20_000_000));
    expect(clockSync.estimate()?.samples).toBe(30);
  });

  it("ignores a repeated sample, as the store does", () => {
    for (let i = 0; i < 25; i += 1) telemetryStore.ingestWatchOrientation(orientation(1, 1_000_000_000 + i));
    expect(clockSync.estimate()).toBeNull();
  });
});
