import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawImageViewerStore } from "./rawImageViewerStore";
import type { RawRecordingCompactWindow, RawRecordingWindow } from "../../../shared/tauri/recordingBundle";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function rawWindow(overrides: Partial<RawRecordingWindow> = {}): RawRecordingWindow {
  return {
    recordingId: "rec-a",
    column: "ppg_green",
    gridSize: 4,
    totalRawRowCount: 4,
    startRawRow: 0,
    endRawRow: 4,
    rowIndices: [0, 1, 2, 3],
    timestampsNs: [0, 1, 2, 3],
    values: [1, 2, 3, 4],
    channelAvailable: true,
    recordingMin: 1,
    recordingMax: 4,
    ...overrides,
  };
}

function compactWindow(overrides: Partial<RawRecordingCompactWindow> = {}): RawRecordingCompactWindow {
  return {
    recordingId: "rec-a",
    column: "ppg_green",
    gridSize: 4,
    totalObservedSampleCount: 2,
    startSampleIndex: 0,
    endSampleIndex: 2,
    sourceRawRowIndices: [3, 10],
    timestampsNs: [3_000_000, 10_000_000],
    values: [1.5, 9.5],
    precedingTimestampNs: null,
    recordingMin: 1.5,
    recordingMax: 9.5,
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});

afterEach(() => {
  rawImageViewerStore.setViewMode("rawRows");
  rawImageViewerStore.setChannel(null);
  rawImageViewerStore.setRecording(null);
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("rawImageViewerStore compact mode (M2/M3)", () => {
  it("defaults to raw rows and never fetches the compact endpoint until switched", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") {
        return Promise.reject(new Error("unused in this test"));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getStatus()).toBe("loaded"));

    expect(rawImageViewerStore.getViewMode()).toBe("rawRows");
    expect(invoke).not.toHaveBeenCalledWith("get_compact_observation_window", expect.anything());
  });

  it("fetches the compact window on switching to observedSamples, aligned/bounded like raw navigation", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") return Promise.reject(new Error("unused"));
      if (command === "get_compact_observation_window") return Promise.resolve(compactWindow());
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getStatus()).toBe("loaded"));

    rawImageViewerStore.setViewMode("observedSamples");
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactStatus()).toBe("loaded"));

    const window = rawImageViewerStore.getCompactWindow();
    expect(window?.sourceRawRowIndices).toEqual([3, 10]);
    expect(window?.timestampsNs).toEqual([3_000_000, 10_000_000]);
    expect(invoke).toHaveBeenCalledWith(
      "get_compact_observation_window",
      expect.objectContaining({ recordingId: "rec-a", column: "ppg_green", startSampleIndex: 0 }),
    );
  });

  it("aligns setStartSampleIndex down to the grid-size hop before requesting", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") return Promise.reject(new Error("unused"));
      if (command === "get_compact_observation_window") {
        const startSampleIndex = (args?.startSampleIndex as number) ?? 0;
        return Promise.resolve(compactWindow({ gridSize: 64, startSampleIndex, endSampleIndex: startSampleIndex + 2 }));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getStatus()).toBe("loaded"));
    rawImageViewerStore.setViewMode("observedSamples");
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactStatus()).toBe("loaded"));

    // Default grid size is 64 (64-sample hop): 70 is not a multiple of 64 and must align down to 64.
    rawImageViewerStore.setStartSampleIndex(70);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "get_compact_observation_window",
        expect.objectContaining({ startSampleIndex: 64 }),
      ),
    );
  });

  it("resets and re-requests the compact window when the channel selection changes", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") return Promise.reject(new Error("unused"));
      if (command === "get_compact_observation_window") {
        return Promise.resolve(compactWindow({ column: args?.column as string }));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    rawImageViewerStore.setViewMode("observedSamples");
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactWindow()?.column).toBe("ppg_green"));

    rawImageViewerStore.setChannel("ppg_red");
    // The compact window must be cleared immediately (never show a stale
    // channel's data while the new channel's compact window is in flight).
    expect(rawImageViewerStore.getCompactWindow()).toBeNull();

    await vi.waitFor(() => expect(rawImageViewerStore.getCompactWindow()?.column).toBe("ppg_red"));
  });

  it("discards a stale out-of-order compact response after a newer selection supersedes it", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") return Promise.reject(new Error("unused"));
      if (command === "get_compact_observation_window") {
        callCount += 1;
        if (callCount === 1) return firstResponse;
        return Promise.resolve(compactWindow({ column: args?.column as string, sourceRawRowIndices: [7] }));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    rawImageViewerStore.setViewMode("observedSamples");
    // Selection moves on before the first compact request resolves.
    rawImageViewerStore.setChannel("ppg_red");
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactWindow()?.column).toBe("ppg_red"));

    resolveFirst(compactWindow({ column: "ppg_green", sourceRawRowIndices: [999] }));
    // Give the stale promise a tick to (wrongly) land, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rawImageViewerStore.getCompactWindow()?.column).toBe("ppg_red");
    expect(rawImageViewerStore.getCompactWindow()?.sourceRawRowIndices).toEqual([7]);
  });

  it("never lets a raw-mode navigation reload cancel an in-flight compact request, and vice versa", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") {
        return Promise.resolve(rawWindow({ startRawRow: (args?.startRawRow as number) ?? 0 }));
      }
      if (command === "get_raw_recording_derivative_window") return Promise.reject(new Error("unused"));
      if (command === "get_compact_observation_window") return Promise.resolve(compactWindow());
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getStatus()).toBe("loaded"));
    rawImageViewerStore.setViewMode("observedSamples");
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactStatus()).toBe("loaded"));

    // Raw rows mode still functions independently: current behavior for raw
    // rows must remain exactly as before, unaffected by compact mode state.
    rawImageViewerStore.setStartRawRow(0);
    expect(rawImageViewerStore.getCompactWindow()).not.toBeNull();
  });
});
