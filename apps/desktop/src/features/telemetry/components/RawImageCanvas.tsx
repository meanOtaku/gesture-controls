import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { RawImageNormalizationMode } from "../store/rawImageViewerStore";
import type { RawRecordingWindow } from "../../../shared/tauri/recordingBundle";

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

function buildImageData(
  rawWindow: RawRecordingWindow,
  mode: RawImageNormalizationMode,
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
      const intensity = Math.round(Math.max(0, Math.min(1, fraction)) * 255);
      color = [intensity, intensity, intensity];
    }
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }

  return { imageData: new ImageData(data, gridSize, gridSize), extent, isConstant };
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

type RawImageCanvasProps = {
  rawWindow: RawRecordingWindow;
  normalizationMode: RawImageNormalizationMode;
};

/** Renders one N×N (N is the response's own `gridSize`, one of the
 * allow-listed grid sizes) chronological raw-value frame via
 * `<canvas>`/`ImageData` (never as N² DOM nodes), plus a keyboard/hover-
 * accessible textual inspector and a color legend. Purely visual
 * inspection: this component never edits annotations, never writes
 * raw.csv, and exposes no training action. */
export function RawImageCanvas({ rawWindow, normalizationMode }: RawImageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const gridSize = rawWindow.gridSize;
  const pixelCount = gridSize * gridSize;

  const built = useMemo(() => buildImageData(rawWindow, normalizationMode), [rawWindow, normalizationMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.putImageData(built.imageData, 0, 0);
  }, [built]);

  const inspectedIndex = hoveredIndex ?? focusedIndex;
  const inspectedInfo = inspectedIndex === null ? null : pixelInfoAt(rawWindow, inspectedIndex);

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

  return (
    <div className="flex flex-col gap-3">
      <canvas
        ref={canvasRef}
        width={gridSize}
        height={gridSize}
        role="img"
        tabIndex={0}
        aria-label={`Chronological raw-data image for column ${rawWindow.column}, ${gridSize}×${gridSize} grid, raw rows ${rawWindow.startRawRow} to ${Math.max(rawWindow.startRawRow, rawWindow.endRawRow - 1)}. Use arrow keys to inspect a pixel.`}
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
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {inspectedInfo
          ? describePixel(inspectedInfo, gridSize)
          : "Hover or focus the image (arrow keys move the focused pixel) to inspect a raw row."}
      </p>
      <RawImageLegend extent={built.extent} isConstant={built.isConstant} normalizationMode={normalizationMode} />
    </div>
  );
}

type RawImageLegendProps = {
  extent: { min: number; max: number } | null;
  isConstant: boolean;
  normalizationMode: RawImageNormalizationMode;
};

function swatchStyle(color: readonly [number, number, number]): CSSProperties {
  return { backgroundColor: `rgb(${color[0]}, ${color[1]}, ${color[2]})` };
}

/** Explains every fill used above so a reader never mistakes "beyond
 * recording", "missing value", or "constant neutral gray" for scaled data. */
function RawImageLegend({ extent, isConstant, normalizationMode }: RawImageLegendProps) {
  return (
    <dl className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-sm bg-gradient-to-r from-black to-white ring-1 ring-foreground/20" aria-hidden="true" />
        <span>
          {isConstant
            ? `Constant value: every recorded pixel renders at a fixed neutral gray, not scaled by magnitude (${normalizationMode}-scale normalization has no range to map).`
            : extent
              ? `Data range (${normalizationMode}-scale): black ≈ ${extent.min}, white ≈ ${extent.max}.`
              : "No valid numeric values to normalize against."}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20" style={swatchStyle(MISSING_COLOR)} aria-hidden="true" />
        <span>Missing value — an empty raw field, never replaced or estimated.</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-foreground/20" style={swatchStyle(BEYOND_COLOR)} aria-hidden="true" />
        <span>No data — this pixel position is beyond the end of the recording.</span>
      </div>
    </dl>
  );
}
