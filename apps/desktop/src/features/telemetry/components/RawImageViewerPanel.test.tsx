import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RawImageViewerPanel } from "./RawImageViewerPanel";
import { rawImageViewerStore } from "../store/rawImageViewerStore";
import { TooltipProvider } from "../../../components/ui/tooltip";
import type { AnnotationInterval, RecordingBundleSummary, RawRecordingWindow } from "../../../shared/tauri/recordingBundle";

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
      expect(screen.getByRole("listitem")).toHaveAccessibleName("pinching, rows 0–63");
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
    await waitFor(() => expect(screen.getByRole("listitem")).toHaveAccessibleName("pinching, rows 0–63"));

    rawImageViewerStore.setRecording("rec-b");
    await waitFor(() => {
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
      expect(screen.getByRole("note", { name: "Saved label ranges" })).toBeInTheDocument();
    });

    resolveSecond({
      recording: {},
      annotations: { format_version: 1, recording_id: "rec-b", intervals: [interval("waving", 10, 20)] },
    });
    await waitFor(() => expect(screen.getByRole("listitem")).toHaveAccessibleName("waving, rows 10–20"));
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

    await waitFor(() => expect(screen.getByRole("listitem")).toHaveAccessibleName("waving, rows 10–20"));
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
      expect(screen.getByRole("note", { name: "Saved label ranges" })).toHaveTextContent(
        "No saved label ranges in this frame.",
      );
    });
    expect(await screen.findByRole("img", { name: /Grayscale/ })).toBeInTheDocument();
  });
});
