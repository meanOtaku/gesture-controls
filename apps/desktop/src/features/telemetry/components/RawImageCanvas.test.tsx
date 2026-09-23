import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RawImageCanvas } from "./RawImageCanvas";
import { RawImageLabelRangeRail } from "./RawImageLabelRangeRail";
import type {
  RawRecordingCompactWindow,
  RawRecordingDerivativeWindow,
  RawRecordingWindow,
} from "../../../shared/tauri/recordingBundle";

afterEach(() => cleanup());

const rawWindow: RawRecordingWindow = {
  recordingId: "rec-1",
  column: "pinch_distance",
  gridSize: 4,
  totalRawRowCount: 16,
  startRawRow: 0,
  endRawRow: 16,
  rowIndices: Array.from({ length: 16 }, (_, i) => i),
  timestampsNs: Array.from({ length: 16 }, (_, i) => i),
  values: Array.from({ length: 16 }, (_, i) => i),
  channelAvailable: true,
  recordingMin: 0,
  recordingMax: 15,
};

describe("RawImageCanvas labelRangeOverlay", () => {
  it("renders the overlay inside the canvas's own wrapper, not beside it", () => {
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Grayscale"
        colorMode="grayscale"
        labelRangeOverlay={
          <RawImageLabelRangeRail
            ranges={[{ labelId: "pinching", startRawRow: 0, endRawRow: 4, startFraction: 0, endFraction: 0.25 }]}
          />
        }
      />,
    );

    const canvas = screen.getByRole("img", { name: /Grayscale:/ });
    const rail = screen.getByRole("list", { name: "Saved label ranges" });

    // Overlay and canvas share the same positioned wrapper (canvas bounds).
    expect(canvas.parentElement).toBe(rail.closest("[class*='absolute']")?.parentElement);
    expect(rail.closest("[class*='absolute']")?.parentElement).toHaveClass("relative");
  });

  it("renders no overlay when labelRangeOverlay is omitted", () => {
    render(<RawImageCanvas rawWindow={rawWindow} normalizationMode="recording" title="Rainbow" colorMode="rainbow" />);
    expect(screen.queryByRole("list", { name: "Saved label ranges" })).not.toBeInTheDocument();
  });

  it("shows no toggle when labelRangeOverlay is omitted", () => {
    render(<RawImageCanvas rawWindow={rawWindow} normalizationMode="recording" title="Rainbow" colorMode="rainbow" />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("hides the overlay when its toggle is unchecked, independently of a sibling viewer's toggle", () => {
    render(
      <>
        <RawImageCanvas
          rawWindow={rawWindow}
          normalizationMode="recording"
          title="Grayscale"
          colorMode="grayscale"
          labelRangeOverlay={
            <RawImageLabelRangeRail
              ranges={[{ labelId: "pinching", startRawRow: 0, endRawRow: 4, startFraction: 0, endFraction: 0.25 }]}
            />
          }
        />
        <RawImageCanvas
          rawWindow={rawWindow}
          normalizationMode="recording"
          title="Rainbow"
          colorMode="rainbow"
          labelRangeOverlay={
            <RawImageLabelRangeRail
              ranges={[{ labelId: "pinching", startRawRow: 0, endRawRow: 4, startFraction: 0, endFraction: 0.25 }]}
            />
          }
        />
      </>,
    );

    const grayscaleToggle = screen.getByRole("checkbox", { name: "Show label ranges for Grayscale" });
    const rainbowToggle = screen.getByRole("checkbox", { name: "Show label ranges for Rainbow" });
    expect(grayscaleToggle).toBeChecked();
    expect(rainbowToggle).toBeChecked();
    expect(screen.getAllByRole("list", { name: "Saved label ranges" })).toHaveLength(2);

    fireEvent.click(grayscaleToggle);

    expect(grayscaleToggle).not.toBeChecked();
    expect(rainbowToggle).toBeChecked();
    expect(screen.getAllByRole("list", { name: "Saved label ranges" })).toHaveLength(1);
  });
});

const derivativeWindow: RawRecordingDerivativeWindow = {
  recordingId: "rec-1",
  column: "pinch_distance",
  gridSize: 4,
  totalRawRowCount: 16,
  startRawRow: 0,
  endRawRow: 16,
  rowIndices: Array.from({ length: 16 }, (_, i) => i),
  timestampsNs: Array.from({ length: 16 }, (_, i) => i),
  // Row 3 withholds a value (series edge/gap); every other row has a signed derivative.
  derivativeValues: Array.from({ length: 16 }, (_, i) => (i === 3 ? null : i - 8)),
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
};

describe("RawImageCanvas diverging derivative mode", () => {
  it("reports raw value, derivative value, and filter configuration for an available pixel", () => {
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={derivativeWindow}
      />,
    );
    const canvas = screen.getByRole("img", { name: /Derivative/ });
    fireEvent.keyDown(canvas, { key: "Home" }); // focuses pixel index 0

    expect(screen.getByText(/raw value 0, derivative -8 per second/)).toBeInTheDocument();
    expect(screen.getByText(/savitzky_golay_order2_window11_v1/)).toBeInTheDocument();
  });

  it("reports a distinct missing/unavailable state for a row with no derivative, without dropping its raw value", () => {
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={derivativeWindow}
      />,
    );
    const canvas = screen.getByRole("img", { name: /Derivative/ });
    fireEvent.keyDown(canvas, { key: "Home" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); // index 3, the withheld row

    expect(screen.getByText(/raw value 3\. Derivative unavailable for this row/)).toBeInTheDocument();
  });

  it("shows a zero-centred diverging legend with a signed scale, distinct from the raw-value legend", () => {
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={derivativeWindow}
      />,
    );
    expect(screen.getByText(/Blue = decreasing, white ≈ no change, red = increasing/)).toBeInTheDocument();
    expect(screen.getByText(/Scale: ±8 per second/)).toBeInTheDocument();
  });
});

const compactWindow: RawRecordingCompactWindow = {
  recordingId: "rec-1",
  column: "pinch_distance",
  gridSize: 4,
  totalObservedSampleCount: 4,
  startSampleIndex: 0,
  endSampleIndex: 4,
  sourceRawRowIndices: [3, 10, 11, 40],
  timestampsNs: [3_000_000, 10_000_000, 11_000_000, 40_000_000],
  values: [1, 4, 2, 10],
  precedingTimestampNs: null,
  recordingMin: 1,
  recordingMax: 10,
};

describe("RawImageCanvas compact sample-order derivative preview (GC-033 follow-up)", () => {
  it("differences two actually-adjacent loaded samples and labels it per-sample, not per-second", () => {
    render(
      <RawImageCanvas
        compactWindow={compactWindow}
        normalizationMode="recording"
        title="Derivative preview (sample order)"
        colorMode="diverging"
      />,
    );
    const canvas = screen.getByRole("img", { name: /Derivative preview/ });
    fireEvent.keyDown(canvas, { key: "Home" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); // sample index 1: values[1] - values[0] = 3

    expect(screen.getByText(/value 4\. Sample-order derivative \(preview only, not time-normalized\): 3 per sample/)).toBeInTheDocument();
  });

  it("has no derivative at the window's first pixel — no actually-adjacent loaded sample to difference against", () => {
    render(
      <RawImageCanvas
        compactWindow={compactWindow}
        normalizationMode="recording"
        title="Derivative preview (sample order)"
        colorMode="diverging"
      />,
    );
    const canvas = screen.getByRole("img", { name: /Derivative preview/ });
    fireEvent.keyDown(canvas, { key: "Home" }); // sample index 0

    expect(screen.getByText(/Sample-order derivative unavailable — no actually-adjacent observed sample/)).toBeInTheDocument();
  });

  it("clears the focused/hovered pixel when the compact window changes (e.g. paging to a new sample range), so a stale index is never reapplied to new data", () => {
    const { rerender } = render(
      <RawImageCanvas
        compactWindow={compactWindow}
        normalizationMode="recording"
        title="Derivative preview (sample order)"
        colorMode="diverging"
      />,
    );
    const canvas = screen.getByRole("img", { name: /Derivative preview/ });
    fireEvent.keyDown(canvas, { key: "Home" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); // focuses index 1
    expect(screen.getByText(/Compact sample 2 of 4/)).toBeInTheDocument();

    const nextWindow: RawRecordingCompactWindow = {
      ...compactWindow,
      startSampleIndex: 4,
      endSampleIndex: 8,
      sourceRawRowIndices: [50, 51, 52, 53],
      timestampsNs: [50_000_000, 51_000_000, 52_000_000, 53_000_000],
      values: [20, 21, 19, 25],
      precedingTimestampNs: 40_000_000,
    };
    rerender(
      <RawImageCanvas
        compactWindow={nextWindow}
        normalizationMode="recording"
        title="Derivative preview (sample order)"
        colorMode="diverging"
      />,
    );

    // No description carried over describing sample 2 of the old window
    // against the new one's data — the inspector goes back to its idle prompt.
    expect(screen.queryByText(/Compact sample/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Hover or focus the image \(arrow keys move the focused pixel\) to inspect a sample-order derivative preview value\./),
    ).toBeInTheDocument();
  });

  it("labels the legend and aria-label as a preview, not the Savitzky–Golay time-based derivative", () => {
    render(
      <RawImageCanvas
        compactWindow={compactWindow}
        normalizationMode="recording"
        title="Derivative preview (sample order)"
        colorMode="diverging"
      />,
    );
    expect(screen.getByRole("img", { name: /Not time-normalized, not Savitzky–Golay/ })).toBeInTheDocument();
    expect(screen.getByText(/Scale: ±\d+(\.\d+)? per sample \(not per second, not time-normalized\)/)).toBeInTheDocument();
    expect(screen.getByText(/Not the Savitzky–Golay time-based derivative/)).toBeInTheDocument();
  });
});
