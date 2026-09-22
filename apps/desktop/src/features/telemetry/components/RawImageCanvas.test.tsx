import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RawImageCanvas } from "./RawImageCanvas";
import { RawImageLabelRangeRail } from "./RawImageLabelRangeRail";
import type { RawRecordingDerivativeWindow, RawRecordingWindow } from "../../../shared/tauri/recordingBundle";

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
