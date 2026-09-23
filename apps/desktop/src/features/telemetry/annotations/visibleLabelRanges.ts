import type { AnnotationInterval, RawRecordingCompactWindow } from "../../../shared/tauri/recordingBundle";

/**
 * One contiguous, same-label saved range clipped to the currently displayed
 * raw window, ready to render as a single vertical bracket. `startRawRow`/
 * `endRawRow` are the clipped window-relative bounds with `endRawRow`
 * exclusive (matching `RawRecordingWindow`'s own convention), and
 * `startFraction`/`endFraction` are their position within the window as
 * `0..1` fractions for absolute vertical placement.
 */
export type VisibleLabelRange = {
  labelId: string;
  startRawRow: number;
  endRawRow: number;
  startFraction: number;
  endFraction: number;
};

/** `resolved_end.raw_row` is the last owned row (inclusive) on disk; this is one past it, matching the window's exclusive-end convention. */
function exclusiveEnd(interval: AnnotationInterval): number {
  return interval.resolved_end.raw_row + 1;
}

/**
 * Clips saved annotation intervals to `[windowStartRawRow, windowEndRawRow)`,
 * drops empty/out-of-window results, and merges only consecutive same-label
 * ranges whose clipped bounds touch (i.e. were adjacent, or touch at the same
 * window edge). Does not mutate `intervals`.
 */
export function deriveVisibleLabelRanges(
  intervals: readonly AnnotationInterval[],
  windowStartRawRow: number,
  windowEndRawRow: number,
): VisibleLabelRange[] {
  const windowSize = windowEndRawRow - windowStartRawRow;
  if (windowSize <= 0) return [];

  const clipped = intervals
    .map((interval) => ({
      labelId: interval.label_id,
      startRawRow: Math.max(interval.resolved_start.raw_row, windowStartRawRow),
      endRawRow: Math.min(exclusiveEnd(interval), windowEndRawRow),
    }))
    .filter((range) => range.endRawRow > range.startRawRow)
    .sort((a, b) => a.startRawRow - b.startRawRow);

  const merged: { labelId: string; startRawRow: number; endRawRow: number }[] = [];
  for (const range of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.labelId === range.labelId && last.endRawRow === range.startRawRow) {
      last.endRawRow = range.endRawRow;
    } else {
      merged.push({ ...range });
    }
  }

  return merged.map((range) => ({
    ...range,
    startFraction: (range.startRawRow - windowStartRawRow) / windowSize,
    endFraction: (range.endRawRow - windowStartRawRow) / windowSize,
  }));
}

/**
 * Compact-mode counterpart to `deriveVisibleLabelRanges`. An observed-sample
 * pixel belongs to a saved interval when its own `sourceRawRowIndices[i]`
 * (never a row-arithmetic guess) falls inside that interval's raw-row span.
 * Reuses `VisibleLabelRange`'s shape, but `startRawRow`/`endRawRow` here are
 * observed-sample-index bounds (window-relative pixel positions), not raw
 * rows — the rail's caller must label them accordingly (see
 * `RawImageLabelRangeRail`'s `unit` prop). An interval whose raw-row span
 * contains none of this channel's observed samples in the loaded window
 * contributes nothing (no bracket is invented). Does not mutate its inputs.
 */
export function deriveVisibleCompactLabelRanges(
  intervals: readonly AnnotationInterval[],
  compactWindow: Pick<RawRecordingCompactWindow, "gridSize" | "startSampleIndex" | "sourceRawRowIndices">,
): VisibleLabelRange[] {
  const gridPixelCount = compactWindow.gridSize * compactWindow.gridSize;
  if (gridPixelCount <= 0) return [];
  const sourceRows = compactWindow.sourceRawRowIndices;

  const clipped: { labelId: string; startRawRow: number; endRawRow: number }[] = [];
  for (const interval of intervals) {
    const startRawRow = interval.resolved_start.raw_row;
    const endRawRowExclusive = exclusiveEnd(interval);
    // `sourceRows` is chronological (non-decreasing) within the loaded
    // window, so the samples belonging to this interval, if any, form one
    // contiguous run of positions.
    let startPos = -1;
    let endPos = -1;
    for (let i = 0; i < sourceRows.length; i += 1) {
      const sourceRow = sourceRows[i];
      if (sourceRow >= startRawRow && sourceRow < endRawRowExclusive) {
        if (startPos === -1) startPos = i;
        endPos = i + 1;
      }
    }
    if (startPos === -1) continue;
    clipped.push({
      labelId: interval.label_id,
      startRawRow: compactWindow.startSampleIndex + startPos,
      endRawRow: compactWindow.startSampleIndex + endPos,
    });
  }
  clipped.sort((a, b) => a.startRawRow - b.startRawRow);

  const merged: { labelId: string; startRawRow: number; endRawRow: number }[] = [];
  for (const range of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.labelId === range.labelId && last.endRawRow === range.startRawRow) {
      last.endRawRow = range.endRawRow;
    } else {
      merged.push({ ...range });
    }
  }

  return merged.map((range) => ({
    ...range,
    startFraction: (range.startRawRow - compactWindow.startSampleIndex) / gridPixelCount,
    endFraction: (range.endRawRow - compactWindow.startSampleIndex) / gridPixelCount,
  }));
}
