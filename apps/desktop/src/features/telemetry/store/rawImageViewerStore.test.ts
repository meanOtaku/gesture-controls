import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawImageViewerStore } from "./rawImageViewerStore";
import type {
  RawRecordingCompactWindow,
  RawRecordingDerivativeWindow,
  RawRecordingWindow,
} from "../../../shared/tauri/recordingBundle";

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
    transformValues: [null, 8],
    transformAvailable: true,
    transformUnavailableReason: null,
    recordingMaxAbsTransform: 8,
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});

afterEach(() => {
  // Reset to the store's real defaults ("observedSamples" (GC-033 follow-up)
  // and "first_derivative" (GC-036)) so every test starts from the same
  // state regardless of run order.
  rawImageViewerStore.setViewMode("observedSamples");
  rawImageViewerStore.setSpikeExtractionMethod("first_derivative");
  rawImageViewerStore.setChannel(null);
  rawImageViewerStore.setRecording(null);
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("rawImageViewerStore compact mode (M2/M3)", () => {
  it("defaults to observed samples and fetches the compact endpoint automatically on selection (GC-033 follow-up)", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") {
        return Promise.reject(new Error("unused in this test"));
      }
      if (command === "get_compact_observation_window") return Promise.resolve(compactWindow());
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    expect(rawImageViewerStore.getViewMode()).toBe("observedSamples");

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactStatus()).toBe("loaded"));

    expect(invoke).toHaveBeenCalledWith(
      "get_compact_observation_window",
      expect.objectContaining({ recordingId: "rec-a", column: "ppg_green", method: "first_derivative" }),
    );
  });

  it("keeps Raw rows available and unchanged as an explicit mode switch", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") return Promise.reject(new Error("unused"));
      if (command === "get_compact_observation_window") return Promise.resolve(compactWindow());
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getStatus()).toBe("loaded"));

    rawImageViewerStore.setViewMode("rawRows");
    expect(rawImageViewerStore.getViewMode()).toBe("rawRows");
    expect(rawImageViewerStore.getWindow()?.values).toEqual([1, 2, 3, 4]);
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

function derivativeWindow(overrides: Partial<RawRecordingDerivativeWindow> = {}): RawRecordingDerivativeWindow {
  return {
    recordingId: "rec-a",
    column: "ppg_green",
    gridSize: 4,
    totalRawRowCount: 4,
    startRawRow: 0,
    endRawRow: 4,
    rowIndices: [0, 1, 2, 3],
    timestampsNs: [0, 1, 2, 3],
    derivativeValues: [1, 2, 3, 4],
    available: true,
    unavailableReason: null,
    effectiveSampleRateHz: 50,
    filterConfig: { method: "savitzky_golay", polynomialOrder: 2, windowSize: 11, version: "spike_extraction_v1" },
    mode: "time",
    units: "per_second",
    unavailableIsCadenceIssue: false,
    recordingMaxAbsDerivative: 4,
    ...overrides,
  };
}

describe("rawImageViewerStore spike extraction method (GC-036 frontend slice)", () => {
  it("defaults to first_derivative and requests it on initial load", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") return Promise.resolve(derivativeWindow());
      if (command === "get_compact_observation_window") return Promise.resolve(compactWindow());
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    expect(rawImageViewerStore.getSpikeExtractionMethod()).toBe("first_derivative");

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeStatus()).toBe("loaded"));

    expect(invoke).toHaveBeenCalledWith(
      "get_raw_recording_derivative_window",
      expect.objectContaining({
        recordingId: "rec-a",
        column: "ppg_green",
        startRawRow: 0,
        method: "first_derivative",
        previewBySampleOrder: false,
      }),
    );
  });

  it("reloads the derivative window and the compact window (not the raw window) for the same recording/channel/row when the method changes", async () => {
    let rawWindowCalls = 0;
    let derivativeCalls = 0;
    let compactCalls = 0;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") {
        rawWindowCalls += 1;
        return Promise.resolve(rawWindow());
      }
      if (command === "get_raw_recording_derivative_window") {
        derivativeCalls += 1;
        return Promise.resolve(derivativeWindow({ filterConfig: { method: args?.method as string, polynomialOrder: 0, windowSize: 9, version: "spike_extraction_v1" } }));
      }
      if (command === "get_compact_observation_window") {
        compactCalls += 1;
        return Promise.resolve(compactWindow({ transformUnavailableReason: args?.method as string }));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeStatus()).toBe("loaded"));
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactStatus()).toBe("loaded"));
    const rawCallsAfterInitialLoad = rawWindowCalls;
    const compactCallsAfterInitialLoad = compactCalls;

    rawImageViewerStore.setSpikeExtractionMethod("haar_wavelet_detail");
    await vi.waitFor(() =>
      expect(rawImageViewerStore.getDerivativeWindow()?.filterConfig.method).toBe("haar_wavelet_detail"),
    );
    await vi.waitFor(() =>
      expect(rawImageViewerStore.getCompactWindow()?.transformUnavailableReason).toBe("haar_wavelet_detail"),
    );

    expect(rawWindowCalls).toBe(rawCallsAfterInitialLoad);
    expect(derivativeCalls).toBeGreaterThan(1);
    expect(compactCalls).toBeGreaterThan(compactCallsAfterInitialLoad);
    expect(invoke).toHaveBeenCalledWith(
      "get_raw_recording_derivative_window",
      expect.objectContaining({ method: "haar_wavelet_detail", startRawRow: 0, recordingId: "rec-a", column: "ppg_green" }),
    );
  });

  it("never fetches the compact window on a method change if it has never been loaded (mirrors setViewMode's load-on-first-entry treatment)", async () => {
    let compactCalls = 0;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") {
        return Promise.resolve(derivativeWindow({ filterConfig: { method: args?.method as string, polynomialOrder: 0, windowSize: 9, version: "spike_extraction_v1" } }));
      }
      if (command === "get_compact_observation_window") {
        compactCalls += 1;
        return Promise.reject(new Error("compact must not be fetched in this test"));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setViewMode("rawRows");
    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeStatus()).toBe("loaded"));
    expect(compactCalls).toBe(0);

    rawImageViewerStore.setSpikeExtractionMethod("rolling_median_residual");
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeWindow()?.filterConfig.method).toBe("rolling_median_residual"));
    expect(compactCalls).toBe(0);
    expect(rawImageViewerStore.getCompactWindow()).toBeNull();
  });

  it("discards a stale compact response after a newer method selection supersedes it (race-safe via compactRequestVersion)", async () => {
    let resolveFirstCompact: (value: unknown) => void = () => {};
    const firstCompactResponse = new Promise((resolve) => {
      resolveFirstCompact = resolve;
    });
    let compactCallCount = 0;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") return Promise.resolve(derivativeWindow());
      if (command === "get_compact_observation_window") {
        compactCallCount += 1;
        if (compactCallCount === 1) return firstCompactResponse;
        return Promise.resolve(compactWindow({ transformUnavailableReason: args?.method as string }));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getCompactStatus()).toBe("loading"));

    // The first compact fetch (default method, on initial load) is still in flight.
    rawImageViewerStore.setSpikeExtractionMethod("rolling_median_residual");
    await vi.waitFor(() =>
      expect(rawImageViewerStore.getCompactWindow()?.transformUnavailableReason).toBe("rolling_median_residual"),
    );

    resolveFirstCompact(compactWindow({ transformUnavailableReason: "first_derivative" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rawImageViewerStore.getCompactWindow()?.transformUnavailableReason).toBe("rolling_median_residual");
  });

  it("discards a stale derivative response after a newer method selection supersedes it", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow());
      if (command === "get_raw_recording_derivative_window") {
        callCount += 1;
        if (callCount === 1) return firstResponse;
        return Promise.resolve(
          derivativeWindow({ filterConfig: { method: args?.method as string, polynomialOrder: 0, windowSize: 9, version: "spike_extraction_v1" } }),
        );
      }
      if (command === "get_compact_observation_window") return Promise.resolve(compactWindow());
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeStatus()).toBe("loading"));

    // The first derivative fetch (default method, on initial load) is still in flight.
    rawImageViewerStore.setSpikeExtractionMethod("rolling_median_residual");
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeWindow()?.filterConfig.method).toBe("rolling_median_residual"));

    resolveFirst(derivativeWindow({ filterConfig: { method: "first_derivative", polynomialOrder: 2, windowSize: 11, version: "spike_extraction_v1" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rawImageViewerStore.getDerivativeWindow()?.filterConfig.method).toBe("rolling_median_residual");
  });

  it("reloads the derivative window with the currently selected method after navigating to a new row", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_raw_recording_window") {
        return Promise.resolve(rawWindow({ startRawRow: (args?.startRawRow as number) ?? 0, totalRawRowCount: 4096 }));
      }
      if (command === "get_raw_recording_derivative_window") {
        return Promise.resolve(
          derivativeWindow({
            startRawRow: (args?.startRawRow as number) ?? 0,
            filterConfig: { method: args?.method as string, polynomialOrder: 0, windowSize: 20, version: "spike_extraction_v1" },
          }),
        );
      }
      if (command === "get_compact_observation_window") return Promise.resolve(compactWindow());
      return Promise.reject(new Error(`unmocked command ${command}`));
    });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeStatus()).toBe("loaded"));

    rawImageViewerStore.setSpikeExtractionMethod("butterworth_high_pass");
    await vi.waitFor(() =>
      expect(rawImageViewerStore.getDerivativeWindow()?.filterConfig.method).toBe("butterworth_high_pass"),
    );
    expect(rawImageViewerStore.getDerivativeWindow()?.startRawRow).toBe(0);

    // Default grid size is 64 (64-row hop): setStartRawRow only actually moves
    // when the requested row is at or past that hop.
    rawImageViewerStore.setStartRawRow(64);
    await vi.waitFor(() => expect(rawImageViewerStore.getDerivativeWindow()?.startRawRow).toBe(64));

    expect(rawImageViewerStore.getDerivativeWindow()?.filterConfig.method).toBe("butterworth_high_pass");
    expect(invoke).toHaveBeenCalledWith(
      "get_raw_recording_derivative_window",
      expect.objectContaining({ method: "butterworth_high_pass", startRawRow: 64 }),
    );
  });

  it("notifies subscribers even when no recording is selected, so a method picker rendered before any selection still reflects the change", () => {
    const listener = vi.fn();
    const unsubscribe = rawImageViewerStore.subscribe(listener);
    try {
      listener.mockClear();
      rawImageViewerStore.setSpikeExtractionMethod("haar_wavelet_detail");
      expect(listener).toHaveBeenCalled();
      expect(rawImageViewerStore.getSpikeExtractionMethod()).toBe("haar_wavelet_detail");
    } finally {
      unsubscribe();
    }
  });
});
