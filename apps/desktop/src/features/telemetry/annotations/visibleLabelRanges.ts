import type { AnnotationInterval } from "../../../shared/tauri/recordingBundle";

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
