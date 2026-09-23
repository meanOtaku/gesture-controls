import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RawImageViewerPanel } from "./RawImageViewerPanel";
import { rawImageViewerStore } from "../store/rawImageViewerStore";
import { TooltipProvider } from "../../../components/ui/tooltip";
import type {
  AnnotationInterval,
  RawRecordingCompactWindow,
  RawRecordingDerivativeWindow,
  RecordingBundleSummary,
  RawRecordingWindow,
} from "../../../shared/tauri/recordingBundle";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function summary(recordingId: string): RecordingBundleSummary {
  return {
    recordingId,
    rawRowCount: 4096,
    intervalCount: 0,
    actualDurationMs: 1000,
    stopReason: "manual_stop",
    labelIds: [],
    unreviewedCount: 0,
    approvedCount: 0,
    excludedCount: 0,
    isImported: false,
  };
}

function interval(labelId: string, startRawRow: number, endRawRowInclusive: number): AnnotationInterval {
  return {
    interval_id: `${labelId}-${startRawRow}`,
    label_id: labelId,
    requested_start_monotonic_ns: 0,
    requested_end_monotonic_ns: 0,
    resolved_start: { raw_row: startRawRow, source_timestamp_ns: 0 },
    resolved_end: { raw_row: endRawRowInclusive, source_timestamp_ns: 0 },
    resolution_rule_version: 1,
    creation_mechanism: "quick_capture",
    curation_status: "unreviewed",
    created_at: new Date(0).toISOString(),
    revision: 1,
  };
}

function rawWindow(recordingId: string): RawRecordingWindow {
  return {
    recordingId,
    column: "ppg_green",
    gridSize: 64,
    totalRawRowCount: 4096,
    startRawRow: 0,
    endRawRow: 4096,
    rowIndices: [],
    timestampsNs: [],
    values: [],
    channelAvailable: true,
    recordingMin: 0,
    recordingMax: 1,
  };
}

function derivativeWindow(
  recordingId: string,
  overrides: Partial<RawRecordingDerivativeWindow> = {},
): RawRecordingDerivativeWindow {
  return {
    recordingId,
    column: "ppg_green",
    gridSize: 64,
    totalRawRowCount: 4096,
    startRawRow: 0,
    endRawRow: 4096,
    rowIndices: [],
    timestampsNs: [],
    derivativeValues: [],
    available: true,
    unavailableReason: null,
    effectiveSampleRateHz: 50,
    filterConfig: {
      method: "savitzky_golay",
      polynomialOrder: 2,
      windowSize: 11,
      version: "savitzky_golay_order2_window11_v1",
    },
    mode: "time",
    units: "per_second",
    unavailableIsCadenceIssue: false,
    ...overrides,
  };
}

function compactWindow(
  recordingId: string,
  overrides: Partial<RawRecordingCompactWindow> = {},
): RawRecordingCompactWindow {
  return {
    recordingId,
    column: "ppg_green",
    gridSize: 64,
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

function qualitySummary(recordingId: string) {
  return {
    recordingId,
    rowCount: 4096,
    timeSpanMs: 81_920,
    timestampStatus: "ok",
    nonMonotonicRowCount: 0,
    effectiveSampleRateHz: 50,
    missingValueCounts: {},
    missingChannels: [],
    intervalCount: 0,
    labeledRowCount: 0,
    unlabeledRowCount: 4096,
    shortLabelIntervalIds: [],
    shortLabelThresholdMs: 150,
    warnings: [],
  };
}

function mockInvoke({
  recordings,
  detailByRecording,
}: {
  recordings: RecordingBundleSummary[];
  detailByRecording: Record<string, () => Promise<unknown>>;
}) {
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "list_recording_bundles") return Promise.resolve(recordings);
    if (command === "load_recording_bundle") {
      const recordingId = args?.recordingId as string;
      const handler = detailByRecording[recordingId];
      return handler ? handler() : Promise.reject(new Error(`no detail mock for ${recordingId}`));
    }
    if (command === "get_raw_recording_window") {
      return Promise.resolve(rawWindow(args?.recordingId as string));
    }
    if (command === "get_raw_recording_derivative_window") {
      return Promise.resolve(derivativeWindow(args?.recordingId as string));
    }
    if (command === "get_recording_quality_summary") {
      return Promise.resolve(qualitySummary(args?.recordingId as string));
    }
    return Promise.reject(new Error(`unmocked command ${command}`));
  });
}

function renderPanel() {
  return render(
    <TooltipProvider>
      <RawImageViewerPanel />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});

afterEach(() => {
  cleanup();
  rawImageViewerStore.setChannel(null);
  rawImageViewerStore.setRecording(null);
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("RawImageViewerPanel quality summary", () => {
  it("loads and renders the recording quality summary for the selected recording", async () => {
    mockInvoke({
      recordings: [summary("rec-a")],
      detailByRecording: {
        "rec-a": () =>
          Promise.resolve({
            recording: {},
            annotations: { format_version: 1, recording_id: "rec-a", intervals: [] },
          }),
      },
    });
    renderPanel();

    await screen.findByRole("combobox", { name: "Saved recording" });
    rawImageViewerStore.setRecording("rec-a");

    await waitFor(() => {
      expect(screen.getByLabelText("Recording quality summary")).toBeInTheDocument();
    });
    expect(screen.getByText("Timing OK")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("get_recording_quality_summary", { recordingId: "rec-a" });
  });

  it("surfaces backend warnings when timestamp quality is degraded", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "list_recording_bundles") return Promise.resolve([summary("rec-a")]);
      if (command === "load_recording_bundle") {
        return Promise.resolve({
          recording: {},
          annotations: { format_version: 1, recording_id: "rec-a", intervals: [] },
        });
      }
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow(args?.recordingId as string));
      if (command === "get_recording_quality_summary") {
        return Promise.resolve({
          ...qualitySummary("rec-a"),
          timestampStatus: "warning",
          nonMonotonicRowCount: 3,
          effectiveSampleRateHz: null,
          warnings: ["3 row(s) are out of chronological order; the effective sample rate cannot be trusted."],
        });
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });
    renderPanel();

    await screen.findByRole("combobox", { name: "Saved recording" });
    rawImageViewerStore.setRecording("rec-a");

    await waitFor(() => {
      expect(screen.getByText("Timing warning")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("out of chronological order");
  });
});

describe("RawImageViewerPanel raw-window navigation (GC-030)", () => {
  it("keeps the loaded raw window mounted (not replaced by a loading skeleton) while paging with Next", async () => {
    let resolveSecondWindow: (value: unknown) => void = () => {};
    const secondWindow = new Promise((resolve) => {
      resolveSecondWindow = resolve;
    });
    let getRawWindowCallCount = 0;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "list_recording_bundles") return Promise.resolve([summary("rec-a")]);
      if (command === "load_recording_bundle") {
        return Promise.resolve({
          recording: {},
          annotations: { format_version: 1, recording_id: "rec-a", intervals: [] },
        });
      }
      if (command === "get_raw_recording_window") {
        getRawWindowCallCount += 1;
        // Two full 64x64 pages (8,192 total rows) so Next is actually
        // enabled instead of the single-page degenerate case.
        if (getRawWindowCallCount === 1) {
          return Promise.resolve({
            ...rawWindow(args?.recordingId as string),
            totalRawRowCount: 8_192,
            startRawRow: 0,
            endRawRow: 4_096,
          });
        }
        return secondWindow;
      }
      if (command === "get_raw_recording_derivative_window") {
        return Promise.resolve(derivativeWindow(args?.recordingId as string));
      }
      if (command === "get_recording_quality_summary") {
        return Promise.resolve(qualitySummary(args?.recordingId as string));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });
    renderPanel();

    await screen.findByRole("combobox", { name: "Saved recording" });
    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    const nextButton = await screen.findByRole("button", { name: "Next 64 rows" });
    expect(screen.getByText(/Rows 0–4,095 of/)).toBeInTheDocument();
    expect(nextButton).not.toBeDisabled();

    fireEvent.click(nextButton);

    // The second `get_raw_recording_window` fetch is still in flight: the
    // previously loaded window's content (and its Next/Previous/slider
    // controls) must still be in the document — never unmounted for a
    // Skeleton — so the page never collapses/re-expands and loses scroll
    // position (GC-030). A brand-new recording/channel selection is the only
    // case that should show the loading skeleton.
    expect(screen.getByText(/Rows 0–4,095 of/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next 64 rows" })).toBeInTheDocument();
    expect(screen.queryByText("Loading raw recording window…")).not.toBeInTheDocument();

    await act(async () => {
      resolveSecondWindow({
        ...rawWindow("rec-a"),
        totalRawRowCount: 8_192,
        startRawRow: 4_096,
        endRawRow: 8_192,
      });
      await secondWindow;
    });
    await waitFor(() => expect(screen.getByText(/Rows 4,096–8,191 of/)).toBeInTheDocument());
  });
});

describe("RawImageViewerPanel label ranges", () => {
  it("loads and renders saved label ranges once a recording and channel are selected", async () => {
    mockInvoke({
      recordings: [summary("rec-a")],
      detailByRecording: {
        "rec-a": () =>
          Promise.resolve({
            recording: {},
            annotations: { format_version: 1, recording_id: "rec-a", intervals: [interval("pinching", 0, 63)] },
          }),
      },
    });
    renderPanel();

    await screen.findByRole("combobox", { name: "Saved recording" });
    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    await waitFor(() => {
      // The same saved interval is shown on both the Grayscale and
      // Derivative canvases (each with their own label-range overlay).
      for (const item of screen.getAllByRole("listitem")) {
        expect(item).toHaveAccessibleName("pinching, rows 0–63");
      }
    });
    expect(invoke).toHaveBeenCalledWith("load_recording_bundle", { recordingId: "rec-a" });
    expect(invoke.mock.calls.filter((call) => call[0] === "load_recording_bundle")).toHaveLength(1);
  });

  it("clears prior ranges and shows the empty state while a new recording's detail is still loading", async () => {
    let resolveSecond: (value: unknown) => void = () => {};
    const secondDetail = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    mockInvoke({
      recordings: [summary("rec-a"), summary("rec-b")],
      detailByRecording: {
        "rec-a": () =>
          Promise.resolve({
            recording: {},
            annotations: { format_version: 1, recording_id: "rec-a", intervals: [interval("pinching", 0, 63)] },
          }),
        "rec-b": () => secondDetail,
      },
    });
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await waitFor(() => {
      for (const item of screen.getAllByRole("listitem")) {
        expect(item).toHaveAccessibleName("pinching, rows 0–63");
      }
    });

    rawImageViewerStore.setRecording("rec-b");
    await waitFor(() => {
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
      expect(screen.getAllByRole("note", { name: "Saved label ranges" }).length).toBeGreaterThan(0);
    });

    resolveSecond({
      recording: {},
      annotations: { format_version: 1, recording_id: "rec-b", intervals: [interval("waving", 10, 20)] },
    });
    await waitFor(() => {
      for (const item of screen.getAllByRole("listitem")) {
        expect(item).toHaveAccessibleName("waving, rows 10–20");
      }
    });
  });

  it("discards a stale out-of-order response and keeps only the latest recording's ranges", async () => {
    let resolveA: (value: unknown) => void = () => {};
    let resolveB: (value: unknown) => void = () => {};
    mockInvoke({
      recordings: [summary("rec-a"), summary("rec-b")],
      detailByRecording: {
        "rec-a": () => new Promise((resolve) => { resolveA = resolve; }),
        "rec-b": () => new Promise((resolve) => { resolveB = resolve; }),
      },
    });
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    act(() => rawImageViewerStore.setRecording("rec-a"));
    act(() => rawImageViewerStore.setChannel("ppg_green"));
    act(() => rawImageViewerStore.setRecording("rec-b"));

    // Recording A's (stale) response resolves after B was already selected.
    resolveA({
      recording: {},
      annotations: { format_version: 1, recording_id: "rec-a", intervals: [interval("pinching", 0, 63)] },
    });
    resolveB({
      recording: {},
      annotations: { format_version: 1, recording_id: "rec-b", intervals: [interval("waving", 10, 20)] },
    });

    await waitFor(() => {
      for (const item of screen.getAllByRole("listitem")) {
        expect(item).toHaveAccessibleName("waving, rows 10–20");
      }
    });
    expect(screen.queryByText(/pinching/)).not.toBeInTheDocument();
  });

  it("shows a bounded warning on a detail-load failure while raw image viewing keeps working", async () => {
    mockInvoke({
      recordings: [summary("rec-a")],
      detailByRecording: {
        "rec-a": () => Promise.reject(new Error("disk unavailable")),
      },
    });
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Could not load saved label ranges for this recording: disk unavailable");
    });
    // Raw image viewing is unaffected: the canvases still render from get_raw_recording_window.
    expect(await screen.findByRole("img", { name: /Grayscale/ })).toBeInTheDocument();
  });

  it("renders the quiet empty state for a recording with no saved annotations", async () => {
    mockInvoke({
      recordings: [summary("rec-a")],
      detailByRecording: {
        "rec-a": () =>
          Promise.resolve({
            recording: {},
            annotations: { format_version: 1, recording_id: "rec-a", intervals: [] },
          }),
      },
    });
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    await waitFor(() => {
      for (const note of screen.getAllByRole("note", { name: "Saved label ranges" })) {
        expect(note).toHaveTextContent("No saved label ranges in this frame.");
      }
    });
    expect(await screen.findByRole("img", { name: /Grayscale/ })).toBeInTheDocument();
  });
});

describe("RawImageViewerPanel derivative canvas", () => {
  it("renders the derivative canvas synchronized with the raw window's rows once available", async () => {
    mockInvoke({
      recordings: [summary("rec-a")],
      detailByRecording: {
        "rec-a": () =>
          Promise.resolve({ recording: {}, annotations: { format_version: 1, recording_id: "rec-a", intervals: [] } }),
      },
    });
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    const derivativeImage = await screen.findByRole("img", { name: /Derivative \(Savitzky–Golay\)/ });
    expect(derivativeImage).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Grayscale/ })).toHaveAccessibleName(/raw rows 0 to 4095/);
    expect(derivativeImage).toHaveAccessibleName(/raw rows 0 to 4095/);
    expect(derivativeImage).toHaveAccessibleName(/Not a live signal/);
  });

  it("shows an explicit unavailable state (not blank/missing) when the recording's cadence fails the M2 regularity gate", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "list_recording_bundles") return Promise.resolve([summary("rec-a")]);
      if (command === "load_recording_bundle") {
        return Promise.resolve({ recording: {}, annotations: { format_version: 1, recording_id: "rec-a", intervals: [] } });
      }
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow(args?.recordingId as string));
      if (command === "get_recording_quality_summary") return Promise.resolve(qualitySummary(args?.recordingId as string));
      if (command === "get_raw_recording_derivative_window") {
        return Promise.resolve({
          ...derivativeWindow(args?.recordingId as string),
          available: false,
          unavailableReason: "timestamp cadence is too irregular for a reliable derivative",
        });
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    await waitFor(() => {
      expect(screen.getByText(/timestamp cadence is too irregular/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("img", { name: /Derivative \(Savitzky–Golay\)/ })).not.toBeInTheDocument();
    // The raw canvases are unaffected by the derivative being unavailable.
    expect(screen.getByRole("img", { name: /Grayscale/ })).toBeInTheDocument();
    // Not offered when the recording simply has too few rows, only for a genuine cadence problem.
    expect(screen.queryByRole("button", { name: /Preview by sample order/ })).not.toBeInTheDocument();
  });

  it("offers an explicit 'Preview by sample order' opt-in only when unavailable solely for a cadence issue, and never fetches it automatically", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "list_recording_bundles") return Promise.resolve([summary("rec-a")]);
      if (command === "load_recording_bundle") {
        return Promise.resolve({ recording: {}, annotations: { format_version: 1, recording_id: "rec-a", intervals: [] } });
      }
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow(args?.recordingId as string));
      if (command === "get_recording_quality_summary") return Promise.resolve(qualitySummary(args?.recordingId as string));
      if (command === "get_raw_recording_derivative_window") {
        if (args?.previewBySampleOrder === true) {
          return Promise.resolve(
            derivativeWindow(args?.recordingId as string, {
              mode: "sample_order",
              units: "per_sample",
              derivativeValues: [],
            }),
          );
        }
        return Promise.resolve(
          derivativeWindow(args?.recordingId as string, {
            available: false,
            unavailableReason: "timestamp spacing deviates by more than 25% from the median cadence",
            unavailableIsCadenceIssue: true,
          }),
        );
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    const previewButton = await screen.findByRole("button", { name: /Preview by sample order/ });
    // The opt-in fallback must never fire on its own: no `previewBySampleOrder: true` call yet.
    expect(invoke).not.toHaveBeenCalledWith(
      "get_raw_recording_derivative_window",
      expect.objectContaining({ previewBySampleOrder: true }),
    );

    fireEvent.click(previewButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "get_raw_recording_derivative_window",
        expect.objectContaining({ previewBySampleOrder: true }),
      );
    });
    expect(await screen.findByText(/Legacy visual preview — change per sample, not per second/)).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /Derivative preview \(sample order, legacy\)/ })).toBeInTheDocument();
  });
});

describe("RawImageViewerPanel compact observed-samples mode (M3, GC-033)", () => {
  function mockInvokeWithCompact() {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "list_recording_bundles") return Promise.resolve([summary("rec-a")]);
      if (command === "load_recording_bundle") {
        return Promise.resolve({ recording: {}, annotations: { format_version: 1, recording_id: "rec-a", intervals: [] } });
      }
      if (command === "get_raw_recording_window") return Promise.resolve(rawWindow(args?.recordingId as string));
      if (command === "get_raw_recording_derivative_window") return Promise.resolve(derivativeWindow(args?.recordingId as string));
      if (command === "get_recording_quality_summary") return Promise.resolve(qualitySummary(args?.recordingId as string));
      if (command === "get_compact_observation_window") {
        return Promise.resolve(compactWindow(args?.recordingId as string));
      }
      return Promise.reject(new Error(`unmocked command ${command}`));
    });
  }

  it("defaults to Raw rows mode and never calls the compact endpoint", async () => {
    mockInvokeWithCompact();
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");

    expect(await screen.findByRole("img", { name: /Grayscale/ })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("get_compact_observation_window", expect.anything());
  });

  it("switches to Observed samples mode and renders sparse values compactly, with no missing-value pixels", async () => {
    mockInvokeWithCompact();
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await screen.findByRole("img", { name: /Grayscale/ });

    fireEvent.click(screen.getByRole("radio", { name: /Observed samples \(compact\)/ }));

    const compactImage = await screen.findByRole("img", { name: /Grayscale \(observed samples\): compact observed-samples image/ });
    expect(compactImage).toHaveAccessibleName(/samples 0 to 1 of 2/);
    expect(compactImage).toHaveAccessibleName(/Adjacency is sample order, not elapsed time/);
    expect(screen.getByText(/Samples 0–1 of 2/)).toBeInTheDocument();
    // No missing-value legend swatch/copy in compact mode.
    expect(screen.queryByText(/Missing value — an empty raw field/)).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith(
      "get_compact_observation_window",
      expect.objectContaining({ recordingId: "rec-a", column: "ppg_green", startSampleIndex: 0 }),
    );
  });

  it("keeps raw rows mode's null-preserving behavior unchanged after visiting compact mode", async () => {
    mockInvokeWithCompact();
    renderPanel();
    await screen.findByRole("combobox", { name: "Saved recording" });

    rawImageViewerStore.setRecording("rec-a");
    rawImageViewerStore.setChannel("ppg_green");
    await screen.findByRole("img", { name: /Grayscale/ });

    fireEvent.click(screen.getByRole("radio", { name: /Observed samples \(compact\)/ }));
    await screen.findByRole("img", { name: /Grayscale \(observed samples\): compact observed-samples image/ });

    fireEvent.click(screen.getByRole("radio", { name: /Raw rows \(default\)/ }));
    // Raw rows mode's exact prior semantics: still rendered from
    // `get_raw_recording_window`'s null-preserving raw-row response.
    expect(await screen.findByRole("img", { name: /Grayscale/ })).toHaveAccessibleName(/chronological raw-data image/);
    expect(screen.queryByRole("img", { name: /compact observed-samples image/ })).not.toBeInTheDocument();
  });
});
