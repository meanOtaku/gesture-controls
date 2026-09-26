import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCompactDivergingImageData, RawImageCanvas } from "./RawImageCanvas";
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
  recordingMaxAbsDerivative: 8,
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

    expect(screen.getByText(/raw value 0, First derivative \(Savitzky–Golay\): -8 per second/)).toBeInTheDocument();
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

    expect(screen.getByText(/raw value 3\. First derivative \(Savitzky–Golay\) unavailable for this row/)).toBeInTheDocument();
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

  it("honors the shared normalization selector: recording-scale uses the recording-wide max abs derivative, not the visible window's own max", () => {
    // This window's own visible derivative values only reach ±5, but the
    // recording-wide max (as computed over the whole selected recording by
    // the backend) is 8 — recording-scale must use the latter.
    const narrowWindow: RawRecordingDerivativeWindow = {
      ...derivativeWindow,
      derivativeValues: Array.from({ length: 16 }, (_, i) => (i === 3 ? null : i - 8 < -5 ? -5 : i - 8 > 5 ? 5 : i - 8)),
      recordingMaxAbsDerivative: 8,
    };
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={narrowWindow}
      />,
    );
    expect(screen.getByText(/recording-scale/)).toBeInTheDocument();
    expect(screen.getByText(/Scale: ±8 per second/)).toBeInTheDocument();
  });

  it("frame-scale mode instead scales to the visible window's own max abs derivative, distinct from recording-scale", () => {
    const narrowWindow: RawRecordingDerivativeWindow = {
      ...derivativeWindow,
      derivativeValues: Array.from({ length: 16 }, (_, i) => (i === 3 ? null : i - 8 < -5 ? -5 : i - 8 > 5 ? 5 : i - 8)),
      recordingMaxAbsDerivative: 8,
    };
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="frame"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={narrowWindow}
      />,
    );
    expect(screen.getByText(/frame-scale/)).toBeInTheDocument();
    expect(screen.getByText(/Scale: ±5 per second/)).toBeInTheDocument();
  });

  it("keeps the recording-scale extent stable across two different visible windows sharing the same recording-wide max", () => {
    const windowA: RawRecordingDerivativeWindow = { ...derivativeWindow, recordingMaxAbsDerivative: 8 };
    const windowB: RawRecordingDerivativeWindow = {
      ...derivativeWindow,
      startRawRow: 16,
      endRawRow: 32,
      derivativeValues: Array.from({ length: 16 }, () => 1),
      recordingMaxAbsDerivative: 8,
    };
    const { rerender } = render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={windowA}
      />,
    );
    expect(screen.getByText(/Scale: ±8 per second/)).toBeInTheDocument();

    rerender(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={windowB}
      />,
    );
    expect(screen.getByText(/Scale: ±8 per second/)).toBeInTheDocument();
  });
});

describe("RawImageCanvas spike-extraction method legend (GC-036 frontend slice)", () => {
  it("shows the selected method's label and description in the legend when spikeExtractionMethod is provided", () => {
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Rolling median residual"
        colorMode="diverging"
        derivativeWindow={derivativeWindow}
        spikeExtractionMethod="rolling_median_residual"
      />,
    );
    expect(screen.getByText("Rolling median residual", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/rolling median of its own present neighbors/)).toBeInTheDocument();
  });

  it("omits the method line when spikeExtractionMethod is not provided (e.g. the legacy sample-order preview canvas)", () => {
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Derivative (Savitzky–Golay)"
        colorMode="diverging"
        derivativeWindow={derivativeWindow}
      />,
    );
    expect(screen.queryByText(/rolling median of its own present neighbors/)).not.toBeInTheDocument();
  });

  it("scales in 'value units' (not 'per second') for a non-first_derivative method's units", () => {
    const valueUnitsWindow: RawRecordingDerivativeWindow = { ...derivativeWindow, units: "value_units" };
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Haar wavelet detail"
        colorMode="diverging"
        derivativeWindow={valueUnitsWindow}
        spikeExtractionMethod="haar_wavelet_detail"
      />,
    );
    expect(screen.getByText(/Scale: ±8 value units/)).toBeInTheDocument();
    expect(screen.queryByText(/Scale: ±8 per second/)).not.toBeInTheDocument();
  });

  it("uses the backend's actual response unit in the per-pixel description, not a hardcoded 'per second', for a non-first_derivative method", () => {
    const valueUnitsWindow: RawRecordingDerivativeWindow = {
      ...derivativeWindow,
      units: "value_units",
      filterConfig: { ...derivativeWindow.filterConfig, method: "haar_wavelet_detail" },
    };
    render(
      <RawImageCanvas
        rawWindow={rawWindow}
        normalizationMode="recording"
        title="Haar wavelet detail"
        colorMode="diverging"
        derivativeWindow={valueUnitsWindow}
        spikeExtractionMethod="haar_wavelet_detail"
      />,
    );
    const canvas = screen.getByRole("img", { name: /Haar wavelet detail/ });
    fireEvent.keyDown(canvas, { key: "Home" }); // focuses pixel index 0

    expect(screen.getByText(/raw value 0, Haar wavelet detail: -8 value units/)).toBeInTheDocument();
    expect(screen.queryByText(/Haar wavelet detail: -8 per second/)).not.toBeInTheDocument();
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
  transformValues: [null, 3, -2, 8],
  transformAvailable: true,
  transformUnavailableReason: null,
  recordingMaxAbsTransform: 8,
};

describe("RawImageCanvas compact observed-samples transform preview (GC-036 follow-up)", () => {
  it("renders the backend-computed transform value, labeled per-sample, not per-second, for first_derivative", () => {
    render(
      <RawImageCanvas
        compactWindow={compactWindow}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    const canvas = screen.getByRole("img", { name: /First derivative \(observed samples\)/ });
    fireEvent.keyDown(canvas, { key: "Home" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); // sample index 1: transformValues[1] = 3

    expect(screen.getByText(/value 4\. First difference \(per sample\): 3 per sample/)).toBeInTheDocument();
  });

  it("labels compact first_derivative 'First difference (per sample)' in the legend and aria-label, distinct from the raw-row 'First derivative (Savitzky–Golay)' label — never the time-based derivative in compact mode", () => {
    render(
      <RawImageCanvas
        compactWindow={compactWindow}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    expect(screen.getByText("First difference (per sample)", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("First derivative (Savitzky–Golay)", { selector: "strong" })).not.toBeInTheDocument();

    const canvas = screen.getByRole("img", { name: /First derivative \(observed samples\)/ });
    expect(canvas).toHaveAccessibleName(/Not time-normalized, not the Savitzky–Golay time-based derivative/);
  });

  it("has no transform value at a true recording-wide edge, never a window-local scrolling artifact", () => {
    const edgeWindow: RawRecordingCompactWindow = { ...compactWindow, transformValues: [null, 3, -2, 8] };
    render(
      <RawImageCanvas
        compactWindow={edgeWindow}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    const canvas = screen.getByRole("img", { name: /First derivative \(observed samples\)/ });
    fireEvent.keyDown(canvas, { key: "Home" }); // sample index 0

    expect(
      screen.getByText(/First difference \(per sample\) unavailable — this is a true edge of this channel's observed-sample sequence, not a scrolling artifact\./),
    ).toBeInTheDocument();
  });

  it("paints an unavailable (null) transform pixel with the shared missing-value color, not a special white edge fill", () => {
    const { imageData } = buildCompactDivergingImageData(compactWindow, "recording");
    const [r, g, b] = [imageData.data[0], imageData.data[1], imageData.data[2]];
    expect([r, g, b]).toEqual([217, 70, 239]);
  });

  it("a later window's first pixel is NOT null — proves scrolling never creates a fixed window-local edge marker", () => {
    // Unlike the true-recording-edge case above, a later window's pixel 0
    // has a real backend-computed transform value (its predecessor lives in
    // the previous window, but the backend already folded it in).
    const laterWindow: RawRecordingCompactWindow = {
      ...compactWindow,
      startSampleIndex: 4,
      endSampleIndex: 8,
      sourceRawRowIndices: [50, 51, 52, 53],
      timestampsNs: [50_000_000, 51_000_000, 52_000_000, 53_000_000],
      values: [20, 21, 19, 25],
      precedingTimestampNs: 40_000_000,
      transformValues: [1, -2, 6, 3],
    };
    render(
      <RawImageCanvas
        compactWindow={laterWindow}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    const canvas = screen.getByRole("img", { name: /First derivative \(observed samples\)/ });
    fireEvent.keyDown(canvas, { key: "Home" }); // sample index 4, window-local pixel 0

    expect(screen.getByText(/Compact sample 5 of 4/)).toBeInTheDocument();
    expect(screen.queryByText(/First difference \(per sample\) unavailable/)).not.toBeInTheDocument();
  });

  it("selecting a different method changes the rendered title, legend, and per-pixel description — proves the selector actually reaches the third imager", () => {
    const haarWindow: RawRecordingCompactWindow = {
      ...compactWindow,
      transformValues: [-1.5, 2.5, -0.5, 1.5],
      recordingMaxAbsTransform: 2.5,
    };
    render(
      <RawImageCanvas
        compactWindow={haarWindow}
        normalizationMode="recording"
        title="Haar wavelet detail (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="haar_wavelet_detail"
      />,
    );
    expect(screen.getByText("Haar wavelet detail (observed samples)")).toBeInTheDocument();
    expect(screen.getByText("Haar wavelet detail", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/Haar wavelet detail coefficient\./)).toBeInTheDocument();
    expect(screen.getByText(/Scale: ±2\.5 value units/)).toBeInTheDocument();

    const canvas = screen.getByRole("img", { name: /Haar wavelet detail/ });
    fireEvent.keyDown(canvas, { key: "Home" });
    expect(screen.getByText(/value 1\. Haar wavelet detail: -1\.5 value units/)).toBeInTheDocument();
  });

  it("clears the focused/hovered pixel when the compact window changes (e.g. paging to a new sample range), so a stale index is never reapplied to new data", () => {
    const { rerender } = render(
      <RawImageCanvas
        compactWindow={compactWindow}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    const canvas = screen.getByRole("img", { name: /First derivative \(observed samples\)/ });
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
      transformValues: [1, -2, 6, 3],
    };
    rerender(
      <RawImageCanvas
        compactWindow={nextWindow}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );

    // No description carried over describing sample 2 of the old window
    // against the new one's data — the inspector goes back to its idle prompt.
    expect(screen.queryByText(/Compact sample/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Hover or focus the image \(arrow keys move the focused pixel\) to inspect a first difference \(per sample\) value\./i),
    ).toBeInTheDocument();
  });

  it("honors the shared normalization selector: recording-scale uses the whole-recording max abs transform, not the visible window's own max", () => {
    // This window's own transform values only reach ±3, but the recording-wide
    // max (as computed by the backend over the whole channel's observed
    // sequence) is 8 — recording-scale must use the latter.
    const narrowWindow: RawRecordingCompactWindow = { ...compactWindow, transformValues: [null, 3, -2, 3] };
    render(
      <RawImageCanvas
        compactWindow={narrowWindow}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    expect(screen.getByText(/recording-scale/)).toBeInTheDocument();
    expect(screen.getByText(/Scale: ±8 per sample/)).toBeInTheDocument();
  });

  it("frame-scale mode instead scales to the visible window's own max abs transform value, distinct from recording-scale", () => {
    const narrowWindow: RawRecordingCompactWindow = { ...compactWindow, transformValues: [null, 3, -2, 3] };
    render(
      <RawImageCanvas
        compactWindow={narrowWindow}
        normalizationMode="frame"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    expect(screen.getByText(/frame-scale/)).toBeInTheDocument();
    expect(screen.getByText(/Scale: ±3 per sample/)).toBeInTheDocument();
  });

  it("keeps the recording-scale extent stable across two different compact windows sharing the same recording-wide max", () => {
    const windowA: RawRecordingCompactWindow = { ...compactWindow, recordingMaxAbsTransform: 8 };
    const windowB: RawRecordingCompactWindow = {
      ...compactWindow,
      startSampleIndex: 4,
      endSampleIndex: 8,
      sourceRawRowIndices: [50, 51, 52, 53],
      timestampsNs: [50_000_000, 51_000_000, 52_000_000, 53_000_000],
      values: [20, 21, 19, 19.5],
      precedingTimestampNs: 40_000_000,
      transformValues: [1, -2, 6, 0.5],
      recordingMaxAbsTransform: 8,
    };
    const { rerender } = render(
      <RawImageCanvas
        compactWindow={windowA}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    expect(screen.getByText(/Scale: ±8 per sample/)).toBeInTheDocument();

    rerender(
      <RawImageCanvas
        compactWindow={windowB}
        normalizationMode="recording"
        title="First derivative (observed samples)"
        colorMode="diverging"
        spikeExtractionMethod="first_derivative"
      />,
    );
    expect(screen.getByText(/Scale: ±8 per sample/)).toBeInTheDocument();
  });
});
