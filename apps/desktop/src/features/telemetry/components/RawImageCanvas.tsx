import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Checkbox } from "../../../components/ui/checkbox";
import type { RawImageNormalizationMode } from "../store/rawImageViewerStore";
import type {
  DerivativeFilterConfig,
  RawRecordingCompactWindow,
  RawRecordingDerivativeWindow,
  RawRecordingWindow,
} from "../../../shared/tauri/recordingBundle";

const DISPLAY_SIZE = 320;

/** Distinct from both the grayscale data range and the "beyond recording" fill,
 * so a missing raw value can never be mistaken for real (or replacement) data. */
const MISSING_COLOR: readonly [number, number, number] = [217, 70, 239];
/** Distinct from `MISSING_COLOR`: this pixel position has no raw row at all
 * (the recording ended before reaching it), which is a different fact than an
 * empty field inside a recorded row. */
const BEYOND_COLOR: readonly [number, number, number] = [51, 65, 85];
/** Deterministic neutral mid-gray for constant-valued channels/frames, used
 * instead of a divide-by-zero normalization. */
const CONSTANT_COLOR: readonly [number, number, number] = [128, 128, 128];

/** Rendering palette for the value gradient only; `MISSING_COLOR`, `BEYOND_COLOR`,
 * and `CONSTANT_COLOR` are shared "not data" fills, unaffected by this choice.
 * `"diverging"` is the M3 derivative palette: always zero-centred; both the
 * raw-row derivative canvas and the GC-033 compact sample-order preview honor
 * `normalizationMode` for their scale (recording-wide fixed vs.
 * per-visible-window). */
export type RawImageColorMode = "grayscale" | "rainbow" | "diverging";

/** Diverging-scale endpoints: cool blue = decreasing, white = ~no change, warm red = increasing. */
const DIVERGING_LOW_COLOR: readonly [number, number, number] = [37, 99, 235];
const DIVERGING_MID_COLOR: readonly [number, number, number] = [255, 255, 255];
const DIVERGING_HIGH_COLOR: readonly [number, number, number] = [220, 38, 38];

function lerpChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t);
}

/** `signedFraction` in `[-1, 1]` (already divided by the frame's max absolute derivative). */
function colorForDivergingFraction(signedFraction: number): readonly [number, number, number] {
  const clamped = Math.max(-1, Math.min(1, signedFraction));
  const [from, to, t] = clamped < 0 ? [DIVERGING_LOW_COLOR, DIVERGING_MID_COLOR, clamped + 1] : [DIVERGING_MID_COLOR, DIVERGING_HIGH_COLOR, clamped];
  return [lerpChannel(from[0], to[0], t), lerpChannel(from[1], to[1], t), lerpChannel(from[2], to[2], t)];
}

type PixelCategory = "value" | "missing" | "beyond";

type PixelInfo = {
  index: number;
  column: number;
  row: number;
  rawRow: number;
  category: PixelCategory;
  value: number | null;
  timestampNs: number | null;
};

function pixelInfoAt(rawWindow: RawRecordingWindow, index: number): PixelInfo {
  const gridSize = rawWindow.gridSize;
  const column = index % gridSize;
  const row = Math.floor(index / gridSize);
  const rawRow = rawWindow.startRawRow + index;
  if (index >= rawWindow.values.length) {
    return { index, column, row, rawRow, category: "beyond", value: null, timestampNs: null };
  }
  const value = rawWindow.values[index];
  const timestampNs = rawWindow.timestampsNs[index] ?? null;
  if (value === null) {
    return { index, column, row, rawRow, category: "missing", value: null, timestampNs };
  }
  return { index, column, row, rawRow, category: "value", value, timestampNs };
}

/** Resolves the (min, max) extent used for normalization: the recording-wide
 * extent for `"recording"` mode, or this window's own non-null values for
 * `"frame"` mode. `null` means there is nothing to normalize against. */
function resolveExtent(
  rawWindow: RawRecordingWindow,
  mode: RawImageNormalizationMode,
): { min: number; max: number } | null {
  if (mode === "recording") {
    if (rawWindow.recordingMin === null || rawWindow.recordingMax === null) return null;
    return { min: rawWindow.recordingMin, max: rawWindow.recordingMax };
  }
  let min: number | null = null;
  let max: number | null = null;
  for (const value of rawWindow.values) {
    if (value === null) continue;
    min = min === null ? value : Math.min(min, value);
    max = max === null ? value : Math.max(max, value);
  }
  return min === null || max === null ? null : { min, max };
}

/** Low value → red (hue 0°), high value → violet (hue 270°), sweeping through
 * the visible spectrum in between — never wrapping back toward red. */
const RAINBOW_MAX_HUE_DEGREES = 270;

function hsvToRgb(hueDegrees: number, saturation: number, value: number): readonly [number, number, number] {
  const c = value * saturation;
  const h = hueDegrees / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] =
    h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = value - c;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function colorForFraction(fraction: number, colorMode: RawImageColorMode): readonly [number, number, number] {
  const clamped = Math.max(0, Math.min(1, fraction));
  if (colorMode === "rainbow") return hsvToRgb(clamped * RAINBOW_MAX_HUE_DEGREES, 1, 1);
  const intensity = Math.round(clamped * 255);
  return [intensity, intensity, intensity];
}

function buildImageData(
  rawWindow: RawRecordingWindow,
  mode: RawImageNormalizationMode,
  colorMode: RawImageColorMode,
): { imageData: ImageData; extent: { min: number; max: number } | null; isConstant: boolean } {
  const extent = resolveExtent(rawWindow, mode);
  const isConstant = extent !== null && extent.min === extent.max;
  const gridSize = rawWindow.gridSize;
  const pixelCount = gridSize * gridSize;
  const data = new Uint8ClampedArray(pixelCount * 4);

  for (let index = 0; index < pixelCount; index += 1) {
    const info = pixelInfoAt(rawWindow, index);
    let color: readonly [number, number, number];
    if (info.category === "beyond") {
      color = BEYOND_COLOR;
    } else if (info.category === "missing") {
      color = MISSING_COLOR;
    } else if (extent === null || isConstant) {
      color = CONSTANT_COLOR;
    } else {
      const value = info.value as number;
      const fraction = (value - extent.min) / (extent.max - extent.min);
      color = colorForFraction(fraction, colorMode);
    }
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }

  return { imageData: new ImageData(data, gridSize, gridSize), extent, isConstant };
}

type DerivativePixelInfo = {
  index: number;
  column: number;
  row: number;
  rawRow: number;
  category: PixelCategory;
  rawValue: number | null;
  derivativeValue: number | null;
  timestampNs: number | null;
};

/**
 * Reads the raw value from `rawWindow` and the derivative value from
 * `derivativeWindow` for the same pixel index. The two windows are requested
 * with identical recording/channel/grid-size/start-row (see
 * `rawImageViewerStore.reload`), so index `i` names the same raw row in
 * both; this never re-derives or infers row alignment on its own.
 */
function derivativePixelInfoAt(
  rawWindow: RawRecordingWindow,
  derivativeWindow: RawRecordingDerivativeWindow,
  index: number,
): DerivativePixelInfo {
  const gridSize = derivativeWindow.gridSize;
  const column = index % gridSize;
  const row = Math.floor(index / gridSize);
  const rawRow = derivativeWindow.startRawRow + index;
  if (index >= derivativeWindow.derivativeValues.length) {
    return { index, column, row, rawRow, category: "beyond", rawValue: null, derivativeValue: null, timestampNs: null };
  }
  const rawValue = index < rawWindow.values.length ? rawWindow.values[index] : null;
  const timestampNs = derivativeWindow.timestampsNs[index] ?? null;
  const derivativeValue = derivativeWindow.derivativeValues[index];
  if (derivativeValue === null) {
    return { index, column, row, rawRow, category: "missing", rawValue, derivativeValue: null, timestampNs };
  }
  return { index, column, row, rawRow, category: "value", rawValue, derivativeValue, timestampNs };
}

/**
 * Zero-centred colour mapping for the M3 derivative canvas, honoring the
 * same `normalizationMode` selector as the raw/compact viewers: in
 * `"recording"` mode the scale is `±recordingMaxAbsDerivative` (the max
 * absolute finite derivative over the whole selected recording/channel, so a
 * given magnitude keeps the same color while scrolling); in `"frame"` mode
 * it stays `±(max absolute derivative visible in this window)`, as before.
 * Missing/beyond fills are shared with the raw canvases so they read as the
 * same "not data" facts everywhere.
 */
function buildDivergingImageData(
  derivativeWindow: RawRecordingDerivativeWindow,
  mode: RawImageNormalizationMode,
): { imageData: ImageData; extent: { min: number; max: number } | null; isConstant: boolean } {
  const gridSize = derivativeWindow.gridSize;
  const pixelCount = gridSize * gridSize;

  let maxAbs: number | null;
  if (mode === "recording") {
    maxAbs = derivativeWindow.recordingMaxAbsDerivative;
  } else {
    maxAbs = null;
    for (const value of derivativeWindow.derivativeValues) {
      if (value === null) continue;
      const abs = Math.abs(value);
      maxAbs = maxAbs === null ? abs : Math.max(maxAbs, abs);
    }
  }
  const extent = maxAbs === null ? null : { min: -maxAbs, max: maxAbs };
  const isConstant = extent !== null && extent.min === extent.max;

  const data = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    let color: readonly [number, number, number];
    if (index >= derivativeWindow.derivativeValues.length) {
      color = BEYOND_COLOR;
    } else {
      const value = derivativeWindow.derivativeValues[index];
      if (value === null) {
        color = MISSING_COLOR;
      } else if (extent === null || isConstant || maxAbs === null) {
        color = CONSTANT_COLOR;
      } else {
        color = colorForDivergingFraction(value / maxAbs);
      }
    }
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }

  return { imageData: new ImageData(data, gridSize, gridSize), extent, isConstant };
}

type CompactPixelCategory = "value" | "beyond";

type CompactPixelInfo = {
  index: number;
  column: number;
  row: number;
  category: CompactPixelCategory;
  /** The compact sample-sequence position (`startSampleIndex + index`), never a raw row. */
  sampleIndex: number;
  value: number | null;
  /** The original `raw.csv` row this sample was read from — not contiguous
   * with neighboring pixels the way raw-row mode's `rawRow` is. */
  sourceRawRow: number | null;
  timestampNs: number | null;
  /** Elapsed time since the immediately preceding observed sample, or `null`
   * when this is the very first observed sample of the whole channel (no
   * predecessor to gap against) — never estimated or interpolated. */
  gapNs: number | null;
};

/** Pixel `i` is compact sample `compactWindow.startSampleIndex + i` — every
 * value present is a genuine finite observation, so there is no "missing"
 * category here, only "value" or "beyond" (past the channel's last observed
 * sample). See `.hermes/plans/2026-09-23-compact-sample-order-image-viewer.md`. */
function compactPixelInfoAt(compactWindow: RawRecordingCompactWindow, index: number): CompactPixelInfo {
  const gridSize = compactWindow.gridSize;
  const column = index % gridSize;
  const row = Math.floor(index / gridSize);
  const sampleIndex = compactWindow.startSampleIndex + index;
  if (index >= compactWindow.values.length) {
    return { index, column, row, category: "beyond", sampleIndex, value: null, sourceRawRow: null, timestampNs: null, gapNs: null };
  }
  const value = compactWindow.values[index];
  const timestampNs = compactWindow.timestampsNs[index];
  const sourceRawRow = compactWindow.sourceRawRowIndices[index];
  const previousTimestampNs = index === 0 ? compactWindow.precedingTimestampNs : compactWindow.timestampsNs[index - 1];
  const gapNs = previousTimestampNs === null ? null : timestampNs - previousTimestampNs;
  return { index, column, row, category: "value", sampleIndex, value, sourceRawRow, timestampNs, gapNs };
}

/** Resolves the (min, max) extent for the compact palette: the recording-wide
 * observed extent for `"recording"` mode, or this window's own values for
 * `"frame"` mode. Every compact value is finite by construction, so unlike
 * `resolveExtent` there is no null-filtering to do. */
function resolveCompactExtent(
  compactWindow: RawRecordingCompactWindow,
  mode: RawImageNormalizationMode,
): { min: number; max: number } | null {
  if (mode === "recording") {
    if (compactWindow.recordingMin === null || compactWindow.recordingMax === null) return null;
    return { min: compactWindow.recordingMin, max: compactWindow.recordingMax };
  }
  if (compactWindow.values.length === 0) return null;
  let min = compactWindow.values[0];
  let max = compactWindow.values[0];
  for (const value of compactWindow.values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

function buildCompactImageData(
  compactWindow: RawRecordingCompactWindow,
  mode: RawImageNormalizationMode,
  colorMode: RawImageColorMode,
): { imageData: ImageData; extent: { min: number; max: number } | null; isConstant: boolean } {
  const extent = resolveCompactExtent(compactWindow, mode);
  const isConstant = extent !== null && extent.min === extent.max;
  const gridSize = compactWindow.gridSize;
  const pixelCount = gridSize * gridSize;
  const data = new Uint8ClampedArray(pixelCount * 4);

  for (let index = 0; index < pixelCount; index += 1) {
    const info = compactPixelInfoAt(compactWindow, index);
    let color: readonly [number, number, number];
    if (info.category === "beyond") {
      color = BEYOND_COLOR;
    } else if (extent === null || isConstant) {
      color = CONSTANT_COLOR;
    } else {
      const value = info.value as number;
      const fraction = (value - extent.min) / (extent.max - extent.min);
      color = colorForFraction(fraction, colorMode);
    }
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }

  return { imageData: new ImageData(data, gridSize, gridSize), extent, isConstant };
}

type CompactDerivativePixelInfo = {
  index: number;
  column: number;
  row: number;
  category: CompactPixelCategory;
  sampleIndex: number;
  /** `values[i] - values[i-1]` for two actually-adjacent loaded observed
   * samples; `null` at pixel 0 of the window (its predecessor, if any,
   * belongs to a different loaded window and is never fetched or invented
   * just to fill this pixel) and at the "beyond" fill. Never time-based —
   * see `RawRecordingCompactWindow` and the M3 plan's sample-order-only
   * non-goal. */
  derivativeValue: number | null;
  rawValue: number | null;
  sourceRawRow: number | null;
  timestampNs: number | null;
  gapNs: number | null;
};

/**
 * GC-033 sample-order derivative preview: differences only two positions that
 * are genuinely adjacent *in this window's loaded array* — never across a
 * navigation boundary, never time-weighted. This is expressly a visual
 * preview, not the M2 Savitzky–Golay time-based derivative and not
 * comparable to it.
 */
function compactDerivativePixelInfoAt(compactWindow: RawRecordingCompactWindow, index: number): CompactDerivativePixelInfo {
  const gridSize = compactWindow.gridSize;
  const column = index % gridSize;
  const row = Math.floor(index / gridSize);
  const sampleIndex = compactWindow.startSampleIndex + index;
  if (index >= compactWindow.values.length) {
    return { index, column, row, category: "beyond", sampleIndex, derivativeValue: null, rawValue: null, sourceRawRow: null, timestampNs: null, gapNs: null };
  }
  const base = compactPixelInfoAt(compactWindow, index);
  const derivativeValue = index === 0 ? null : compactWindow.values[index] - compactWindow.values[index - 1];
  return {
    index,
    column,
    row,
    category: "value",
    sampleIndex,
    derivativeValue,
    rawValue: base.value,
    sourceRawRow: base.sourceRawRow,
    timestampNs: base.timestampNs,
    gapNs: base.gapNs,
  };
}

/** Zero-centred diverging palette over consecutive-sample differences,
 * honoring the same `normalizationMode` selector as the grayscale/rainbow
 * compact imagers and the raw-row derivative canvas: in `"recording"` mode
 * the scale is `±recordingMaxAbsSampleOrderDerivative` (the max absolute
 * finite adjacent-sample diff over the whole selected recording/channel's
 * observed values, so a given magnitude keeps the same color across compact
 * windows); in `"frame"` mode it stays `±(max absolute diff visible in this
 * window)`, as before. Reuses the same "beyond" fill as the time-based
 * derivative canvas so it reads identically everywhere. Pixel 0 uses
 * `CONSTANT_COLOR` rather than `MISSING_COLOR`: every compact sample is a
 * genuine observation (unlike a raw-row's withheld field), so pixel 0 is not
 * "missing data" — it is simply a window edge with no actually-adjacent
 * loaded sample to difference against, the same "nothing to compute" case
 * `CONSTANT_COLOR` already covers elsewhere in this file. */
export function buildCompactDivergingImageData(
  compactWindow: RawRecordingCompactWindow,
  mode: RawImageNormalizationMode,
): { imageData: ImageData; extent: { min: number; max: number } | null; isConstant: boolean } {
  const gridSize = compactWindow.gridSize;
  const pixelCount = gridSize * gridSize;

  let maxAbs: number | null;
  if (mode === "recording") {
    maxAbs = compactWindow.recordingMaxAbsSampleOrderDerivative;
  } else {
    maxAbs = null;
    for (let index = 1; index < compactWindow.values.length; index += 1) {
      const abs = Math.abs(compactWindow.values[index] - compactWindow.values[index - 1]);
      maxAbs = maxAbs === null ? abs : Math.max(maxAbs, abs);
    }
  }
  const extent = maxAbs === null ? null : { min: -maxAbs, max: maxAbs };
  const isConstant = extent !== null && extent.min === extent.max;

  const data = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    let color: readonly [number, number, number];
    if (index >= compactWindow.values.length) {
      color = BEYOND_COLOR;
    } else if (index === 0) {
      // No actually-adjacent loaded sample to difference pixel 0 against.
      color = CONSTANT_COLOR;
    } else if (extent === null || isConstant || maxAbs === null) {
      color = CONSTANT_COLOR;
    } else {
      const diff = compactWindow.values[index] - compactWindow.values[index - 1];
      color = colorForDivergingFraction(diff / maxAbs);
    }
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }

  return { imageData: new ImageData(data, gridSize, gridSize), extent, isConstant };
}

/** Accessible pixel inspection for the compact sample-order derivative
 * preview: compact sample index, source raw row, original timestamp, raw
 * value, the differenced value (explicitly "per sample", never "per
 * second"), and the gap since the preceding observed sample. */
function describeCompactDerivativePixel(
  info: CompactDerivativePixelInfo,
  gridSize: number,
  totalObservedSampleCount: number,
): string {
  const position = `column ${info.column + 1}, row ${info.row + 1} of the ${gridSize}×${gridSize} grid`;
  if (info.category === "beyond") {
    return `${position}. No data — beyond the last observed sample of this channel (${totalObservedSampleCount} total).`;
  }
  const base = `${position}. Compact sample ${info.sampleIndex + 1} of ${totalObservedSampleCount}, source raw row ${info.sourceRawRow}, ${formatTimestamp(info.timestampNs)}: value ${info.rawValue}.`;
  if (info.derivativeValue === null) {
    return `${base} Sample-order derivative unavailable — no actually-adjacent observed sample is loaded in this window to difference against.`;
  }
  return `${base} Sample-order derivative (preview only, not time-normalized): ${info.derivativeValue} per sample. ${formatGap(info.gapNs)}.`;
}

function formatGap(gapNs: number | null): string {
  if (gapNs === null) return "first observed sample of this channel — no preceding observation to compare";
  const ms = gapNs / 1_000_000;
  return `${gapNs.toLocaleString()} ns (${ms.toFixed(3)} ms) since the preceding observed sample`;
}

/** Accessible pixel inspection for the compact canvas: compact sample index,
 * source raw row, original timestamp, value, and the gap since the preceding
 * observed sample — never just the value alone. */
function describeCompactPixel(info: CompactPixelInfo, gridSize: number, totalObservedSampleCount: number): string {
  const position = `column ${info.column + 1}, row ${info.row + 1} of the ${gridSize}×${gridSize} grid`;
  if (info.category === "beyond") {
    return `${position}. No data — beyond the last observed sample of this channel (${totalObservedSampleCount} total).`;
  }
  return `${position}. Compact sample ${info.sampleIndex + 1} of ${totalObservedSampleCount}, source raw row ${info.sourceRawRow}, ${formatTimestamp(info.timestampNs)}: value ${info.value}. ${formatGap(info.gapNs)}.`;
}

function formatTimestamp(timestampNs: number | null): string {
  if (timestampNs === null) return "no timestamp";
  const ms = timestampNs / 1_000_000;
  return `${new Date(ms).toISOString()} (${timestampNs.toLocaleString()} ns)`;
}

function describePixel(info: PixelInfo, gridSize: number): string {
  const position = `column ${info.column + 1}, row ${info.row + 1} of the ${gridSize}×${gridSize} grid`;
  if (info.category === "beyond") {
    return `${position}. Raw row ${info.rawRow}: no data — beyond the end of this recording.`;
  }
  if (info.category === "missing") {
    return `${position}. Raw row ${info.rawRow}, ${formatTimestamp(info.timestampNs)}: missing value (empty raw field), not replaced.`;
  }
  return `${position}. Raw row ${info.rawRow}, ${formatTimestamp(info.timestampNs)}: value ${info.value}.`;
}

/** Accessible pixel inspection for the derivative canvas: raw row, timestamp,
 * original raw value, derivative value/unit, filter configuration, and the
 * missing/unavailable state — never just the derivative number alone. */
function describeDerivativePixel(info: DerivativePixelInfo, gridSize: number, filterConfig: DerivativeFilterConfig): string {
  const position = `column ${info.column + 1}, row ${info.row + 1} of the ${gridSize}×${gridSize} grid`;
  if (info.category === "beyond") {
    return `${position}. Raw row ${info.rawRow}: no data — beyond the end of this recording.`;
  }
  const rawValueText = info.rawValue === null ? "missing" : `${info.rawValue}`;
  const filterText = `${filterConfig.method}, order ${filterConfig.polynomialOrder}, window ${filterConfig.windowSize} (${filterConfig.version})`;
  if (info.category === "missing") {
    return `${position}. Raw row ${info.rawRow}, ${formatTimestamp(info.timestampNs)}: raw value ${rawValueText}. Derivative unavailable for this row (series edge or a missing value in its local window) — not interpolated or estimated. Filter: ${filterText}.`;
  }
  return `${position}. Raw row ${info.rawRow}, ${formatTimestamp(info.timestampNs)}: raw value ${rawValueText}, derivative ${info.derivativeValue} per second. Filter: ${filterText}.`;
}

type RawImageCanvasProps = {
  /** Exactly one of `rawWindow`/`compactWindow` is provided per instance —
   * never both — selecting the raw-row audit rendering path or the M3
   * compact observed-samples path. */
  rawWindow?: RawRecordingWindow;
  /** The M3 compact sample-order window: pixel `i` is observed sample
   * `startSampleIndex + i`, never a contiguous raw row.
   * `"grayscale"`/`"rainbow"` render the observed values directly;
   * `"diverging"` renders the GC-033 sample-order derivative *preview*
   * (consecutive differences between actually-adjacent loaded samples,
   * computed client-side from this same window — never fetched, never
   * time-based, never the M2 Savitzky–Golay derivative). */
  compactWindow?: RawRecordingCompactWindow;
  normalizationMode: RawImageNormalizationMode;
  /** Visible heading and the basis for this image's aria-label; must be
   * distinct across images shown for the same window (e.g. "Grayscale",
   * "Rainbow (false-colour)"). */
  title: string;
  /** @default "grayscale" */
  colorMode?: RawImageColorMode;
  /** Optional accessible overlay (e.g. `RawImageLabelRangeRail`) rendered
   * full-bleed over the canvas, sized to its DISPLAY_SIZE bounds.
   * Non-interactive (pointer-events disabled) so it never blocks pixel
   * hover/inspection on the canvas beneath it. When provided, this instance
   * also renders its own "Show label ranges" checkbox (default on), so each
   * viewer's overlay toggles independently of its siblings. */
  labelRangeOverlay?: ReactNode;
  /** Required when `colorMode` is `"diverging"`: the M3 offline derivative
   * window for the identical recording/channel/grid-size/start-row as
   * `rawWindow`, used both for the colour mapping and for merging the
   * original raw value into pixel inspection. Ignored otherwise. */
  derivativeWindow?: RawRecordingDerivativeWindow;
  /** Optional element (e.g. a `HelpTooltip`) rendered next to the heading. */
  titleHelp?: ReactNode;
};

/** Renders one N×N (N is the response's own `gridSize`, one of the
 * allow-listed grid sizes) chronological raw-value frame via
 * `<canvas>`/`ImageData` (never as N² DOM nodes), plus a keyboard/hover-
 * accessible textual inspector and a color legend. Purely visual
 * inspection: this component never edits annotations, never writes
 * raw.csv, and exposes no training action. */
export function RawImageCanvas({
  rawWindow,
  compactWindow,
  normalizationMode,
  title,
  colorMode = "grayscale",
  labelRangeOverlay,
  derivativeWindow,
  titleHelp,
}: RawImageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [labelsVisible, setLabelsVisible] = useState(true);

  // A pixel index is only meaningful relative to the window it was hovered/
  // focused in. Without this, paging to a new window (new startSampleIndex/
  // startRawRow) silently reapplies a stale index to unrelated data — the
  // inspector then narrates a sample/column/row that no longer matches what
  // is on screen.
  useEffect(() => {
    setHoveredIndex(null);
    setFocusedIndex(null);
  }, [rawWindow, compactWindow, derivativeWindow]);
  const isCompact = compactWindow !== undefined;
  const isCompactDerivative = isCompact && colorMode === "diverging";
  const gridSize = isCompact ? compactWindow.gridSize : (rawWindow as RawRecordingWindow).gridSize;
  const pixelCount = gridSize * gridSize;
  const isDiverging = isCompactDerivative || (!isCompact && colorMode === "diverging" && derivativeWindow !== undefined);

  const built = useMemo(() => {
    if (isCompactDerivative) return buildCompactDivergingImageData(compactWindow as RawRecordingCompactWindow, normalizationMode);
    if (isCompact) return buildCompactImageData(compactWindow as RawRecordingCompactWindow, normalizationMode, colorMode);
    if (isDiverging) return buildDivergingImageData(derivativeWindow as RawRecordingDerivativeWindow, normalizationMode);
    return buildImageData(rawWindow as RawRecordingWindow, normalizationMode, colorMode);
  }, [rawWindow, compactWindow, normalizationMode, colorMode, derivativeWindow, isDiverging, isCompact, isCompactDerivative]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.putImageData(built.imageData, 0, 0);
  }, [built]);

  const inspectedIndex = hoveredIndex ?? focusedIndex;
  const pixelDescription = ((): string => {
    if (inspectedIndex === null) {
      return isCompactDerivative
        ? "Hover or focus the image (arrow keys move the focused pixel) to inspect a sample-order derivative preview value."
        : isCompact
          ? "Hover or focus the image (arrow keys move the focused pixel) to inspect an observed sample."
          : "Hover or focus the image (arrow keys move the focused pixel) to inspect a raw row.";
    }
    if (isCompactDerivative) {
      return describeCompactDerivativePixel(
        compactDerivativePixelInfoAt(compactWindow as RawRecordingCompactWindow, inspectedIndex),
        gridSize,
        (compactWindow as RawRecordingCompactWindow).totalObservedSampleCount,
      );
    }
    if (isCompact) {
      return describeCompactPixel(
        compactPixelInfoAt(compactWindow, inspectedIndex),
        gridSize,
        compactWindow.totalObservedSampleCount,
      );
    }
    if (isDiverging) {
      return describeDerivativePixel(
        derivativePixelInfoAt(rawWindow as RawRecordingWindow, derivativeWindow as RawRecordingDerivativeWindow, inspectedIndex),
        gridSize,
        (derivativeWindow as RawRecordingDerivativeWindow).filterConfig,
      );
    }
    return describePixel(pixelInfoAt(rawWindow as RawRecordingWindow, inspectedIndex), gridSize);
  })();

  const pixelIndexFromPointer = (event: { clientX: number; clientY: number }): number | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const relativeX = event.clientX - rect.left;
    const relativeY = event.clientY - rect.top;
    if (relativeX < 0 || relativeY < 0 || relativeX >= rect.width || relativeY >= rect.height) return null;
    const column = Math.min(gridSize - 1, Math.floor((relativeX / rect.width) * gridSize));
    const row = Math.min(gridSize - 1, Math.floor((relativeY / rect.height) * gridSize));
    return row * gridSize + column;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const current = focusedIndex ?? 0;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = current % gridSize === 0 ? current : current - 1;
        break;
      case "ArrowRight":
        next = current % gridSize === gridSize - 1 ? current : current + 1;
        break;
      case "ArrowUp":
        next = current - gridSize < 0 ? current : current - gridSize;
        break;
      case "ArrowDown":
        next = current + gridSize >= pixelCount ? current : current + gridSize;
        break;
      case "Home":
        next = current - (current % gridSize);
        break;
      case "End":
        next = current - (current % gridSize) + (gridSize - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocusedIndex(next);
  };

  const ariaLabel = isCompactDerivative
    ? `${title}: sample-order derivative preview image for column ${(compactWindow as RawRecordingCompactWindow).column}, ${gridSize}×${gridSize} grid, samples ${(compactWindow as RawRecordingCompactWindow).startSampleIndex} to ${Math.max((compactWindow as RawRecordingCompactWindow).startSampleIndex, (compactWindow as RawRecordingCompactWindow).endSampleIndex - 1)} of ${(compactWindow as RawRecordingCompactWindow).totalObservedSampleCount}. Not time-normalized, not Savitzky–Golay, not valid for training, export, or inference. Use arrow keys to inspect a pixel.`
    : isCompact
    ? `${title}: compact observed-samples image for column ${compactWindow.column}, ${gridSize}×${gridSize} grid, samples ${compactWindow.startSampleIndex} to ${Math.max(compactWindow.startSampleIndex, compactWindow.endSampleIndex - 1)} of ${compactWindow.totalObservedSampleCount}. Adjacency is sample order, not elapsed time. Use arrow keys to inspect a pixel.`
    : isDiverging
      ? `${title}: offline Savitzky–Golay derivative image for column ${(rawWindow as RawRecordingWindow).column}, ${gridSize}×${gridSize} grid, raw rows ${(derivativeWindow as RawRecordingDerivativeWindow).startRawRow} to ${Math.max((derivativeWindow as RawRecordingDerivativeWindow).startRawRow, (derivativeWindow as RawRecordingDerivativeWindow).endRawRow - 1)}. Not a live signal. Use arrow keys to inspect a pixel.`
      : `${title}: chronological raw-data image for column ${(rawWindow as RawRecordingWindow).column}, ${gridSize}×${gridSize} grid, raw rows ${(rawWindow as RawRecordingWindow).startRawRow} to ${Math.max((rawWindow as RawRecordingWindow).startRawRow, (rawWindow as RawRecordingWindow).endRawRow - 1)}. Use arrow keys to inspect a pixel.`;

  return (
    <div className="flex flex-col gap-3">
      <h4 className="flex min-w-0 items-center gap-1 truncate text-sm font-medium" title={title}>
        <span className="truncate">{title}</span>
        {titleHelp}
      </h4>
      {labelRangeOverlay && (
        // `truncate` keeps this row single-line regardless of `title`'s length, so every
        // sibling canvas in a row (e.g. Grayscale/Rainbow/Derivative) starts at the same
        // top edge instead of one wrapping to two lines and pushing its canvas down.
        <label
          className="flex min-w-0 items-center gap-2 text-xs font-normal text-muted-foreground"
          title={`Show label ranges for ${title}`}
        >
          <Checkbox checked={labelsVisible} onCheckedChange={setLabelsVisible} />
          <span className="truncate">{`Show label ranges for ${title}`}</span>
        </label>
      )}
      <div className="relative" style={{ width: DISPLAY_SIZE, height: DISPLAY_SIZE }}>
        <canvas
          ref={canvasRef}
          width={gridSize}
          height={gridSize}
          role="img"
          tabIndex={0}
          aria-label={ariaLabel}
          className="rounded-lg ring-1 ring-foreground/10"
          style={{ width: DISPLAY_SIZE, height: DISPLAY_SIZE, imageRendering: "pixelated", cursor: "crosshair" }}
          onPointerMove={(event) => setHoveredIndex(pixelIndexFromPointer(event))}
          onPointerLeave={() => setHoveredIndex(null)}
          onPointerDown={(event) => {
            const index = pixelIndexFromPointer(event);
            if (index !== null) setFocusedIndex(index);
          }}
          onFocus={() => setFocusedIndex((current) => current ?? 0)}
          onKeyDown={handleKeyDown}
        />
        {labelRangeOverlay && labelsVisible && (
          <div className="pointer-events-none absolute inset-0">{labelRangeOverlay}</div>
        )}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {pixelDescription}
      </p>
      <RawImageLegend
        extent={built.extent}
        isConstant={built.isConstant}
        normalizationMode={normalizationMode}
        colorMode={colorMode}
        isCompact={isCompact}
        sampleOrderDerivative={isCompactDerivative}
      />
    </div>
  );
}

type RawImageLegendProps = {
  extent: { min: number; max: number } | null;
  isConstant: boolean;
  normalizationMode: RawImageNormalizationMode;
  colorMode: RawImageColorMode;
  /** M3 compact mode: no missing-value pixels exist by design (absent
   * fields are omitted, never a pixel), so the legend explains sample-order
   * adjacency instead of a missing-value swatch. */
  isCompact?: boolean;
  /** GC-033: this is the compact sample-order derivative *preview*, not the
   * M2 time-based Savitzky–Golay derivative — the legend must say so and use
   * "per sample" instead of "per second" scale wording. */
  sampleOrderDerivative?: boolean;
};

function swatchStyle(color: readonly [number, number, number]): CSSProperties {
  return { backgroundColor: `rgb(${color[0]}, ${color[1]}, ${color[2]})` };
}

const RAINBOW_GRADIENT_CSS = `linear-gradient(to right, ${Array.from({ length: 7 }, (_, step) => {
  const [r, g, b] = hsvToRgb((step / 6) * RAINBOW_MAX_HUE_DEGREES, 1, 1);
  return `rgb(${r}, ${g}, ${b})`;
}).join(", ")})`;

const DIVERGING_GRADIENT_CSS = `linear-gradient(to right, rgb(${DIVERGING_LOW_COLOR.join(", ")}), rgb(${DIVERGING_MID_COLOR.join(", ")}), rgb(${DIVERGING_HIGH_COLOR.join(", ")}))`;

/** Explains every fill used above so a reader never mistakes "beyond
 * recording", "missing value", or "constant neutral gray/white" for scaled
 * data, and — for the diverging derivative palette — never has to interpret
 * positive/negative colour direction from a hidden convention. */
function RawImageLegend({
  extent,
  isConstant,
  normalizationMode,
  colorMode,
  isCompact = false,
  sampleOrderDerivative = false,
}: RawImageLegendProps) {
  if (colorMode === "diverging") {
    // Both the compact sample-order preview and the raw-row derivative
    // canvas honor the shared normalization selector, like the other imagers.
    const scaleLabel = `${normalizationMode}-scale`;
    return (
      <dl className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span
            className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20"
            style={{ backgroundImage: DIVERGING_GRADIENT_CSS }}
            aria-hidden="true"
          />
          <span>
            {isConstant
              ? "No change: every derivative value in this frame is zero (or unavailable), shown as neutral white."
              : extent
                ? sampleOrderDerivative
                  ? `Palette: diverging, zero-centred, ${scaleLabel}. Blue = decreasing, white ≈ no change, red = increasing. Scale: ±${extent.max} per sample (not per second, not time-normalized).`
                  : `Palette: diverging, zero-centred, ${scaleLabel}. Blue = decreasing, white ≈ no change, red = increasing. Scale: ±${extent.max} per second.`
                : "No available derivative values in this frame to scale against."}
          </span>
        </div>
        {sampleOrderDerivative && (
          <div className="flex items-center gap-2">
            <span className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20 bg-transparent" aria-hidden="true" />
            <span>
              Sample-order visual preview only: the difference between two actually-adjacent observed samples, not
              weighted by elapsed time. Not the Savitzky–Golay time-based derivative. Never used for training,
              export, or inference.
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span
            className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20"
            style={swatchStyle(sampleOrderDerivative ? CONSTANT_COLOR : MISSING_COLOR)}
            aria-hidden="true"
          />
          <span>
            {sampleOrderDerivative
              ? "Derivative unavailable — no actually-adjacent observed sample is loaded in this window to difference against."
              : "Derivative unavailable for this row (series edge or a missing value nearby) — not interpolated or estimated."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20" style={swatchStyle(BEYOND_COLOR)} aria-hidden="true" />
          <span>{sampleOrderDerivative ? "No data — beyond the last observed sample of this channel." : "No data — this pixel position is beyond the end of the recording."}</span>
        </div>
      </dl>
    );
  }

  const paletteName = colorMode === "rainbow" ? "rainbow (red → violet)" : "grayscale (black → white)";
  const lowLabel = colorMode === "rainbow" ? "red" : "black";
  const highLabel = colorMode === "rainbow" ? "violet" : "white";
  return (
    <dl className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span
          className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20"
          style={
            colorMode === "rainbow"
              ? { backgroundImage: RAINBOW_GRADIENT_CSS }
              : { backgroundImage: "linear-gradient(to right, black, white)" }
          }
          aria-hidden="true"
        />
        <span>
          {isConstant
            ? `Constant value: every recorded pixel renders at a fixed neutral gray, not scaled by magnitude (${normalizationMode}-scale normalization has no range to map).`
            : extent
              ? `Palette: ${paletteName}. Data range (${normalizationMode}-scale): ${lowLabel} ≈ ${extent.min}, ${highLabel} ≈ ${extent.max}.`
              : "No valid numeric values to normalize against."}
        </span>
      </div>
      {isCompact ? (
        <div className="flex items-center gap-2">
          <span className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20 bg-transparent" aria-hidden="true" />
          <span>
            Compact mode: only this channel&apos;s observed values are shown, in timestamp order. Pixel adjacency is
            sample order, not equal time spacing — there are no missing-value pixels here by design.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20" style={swatchStyle(MISSING_COLOR)} aria-hidden="true" />
          <span>Missing value — an empty raw field, never replaced or estimated.</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20" style={swatchStyle(BEYOND_COLOR)} aria-hidden="true" />
        <span>{isCompact ? "No data — beyond the last observed sample of this channel." : "No data — this pixel position is beyond the end of the recording."}</span>
      </div>
    </dl>
  );
}
