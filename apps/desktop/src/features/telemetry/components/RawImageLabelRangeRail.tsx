import type { VisibleLabelRange } from "../annotations/visibleLabelRanges";

type RawImageLabelRangeRailProps = {
  ranges: VisibleLabelRange[];
};

function describeRange(range: VisibleLabelRange): string {
  const label = range.labelId.replaceAll("_", " ");
  const lastRow = Math.max(range.startRawRow, range.endRawRow - 1);
  return `${label}, rows ${range.startRawRow}–${lastRow}`;
}

/**
 * Narrow vertical rail overlaid on the grayscale raw image's left edge: one
 * bracket per visible label range (already clipped/merged by
 * `deriveVisibleLabelRanges`), positioned by percentage within the rail.
 * Display-only — no editing, no canvas, no icon dependency.
 */
export function RawImageLabelRangeRail({ ranges }: RawImageLabelRangeRailProps) {
  if (ranges.length === 0) {
    return (
      <div role="note" aria-label="Saved label ranges" className="flex w-20 shrink-0 items-start justify-center text-xs text-muted-foreground lg:w-24">
        No saved label ranges in this frame.
      </div>
    );
  }

  return (
    // Height matches RawImageCanvas's fixed 320px display size (not
    // percentage-based); the parent overlay wrapper positions this rail
    // absolutely over the canvas, so a fixed height is required regardless
    // of surrounding layout.
    <div
      role="list"
      aria-label="Saved label ranges"
      className="relative h-80 w-20 shrink-0 lg:w-24"
    >
      {ranges.map((range) => (
        <div
          key={`${range.labelId}-${range.startRawRow}-${range.endRawRow}`}
          role="listitem"
          aria-label={describeRange(range)}
          title={describeRange(range)}
          className="absolute left-1 right-1 flex items-center justify-center rounded-sm border-y-2 border-foreground/50 bg-foreground/5 px-1 text-center text-[10px] leading-tight text-foreground/80"
          style={{
            top: `${range.startFraction * 100}%`,
            height: `${Math.max(range.endFraction - range.startFraction, 0) * 100}%`,
          }}
        >
          <span className="truncate">{range.labelId.replaceAll("_", " ")}</span>
        </div>
      ))}
    </div>
  );
}
