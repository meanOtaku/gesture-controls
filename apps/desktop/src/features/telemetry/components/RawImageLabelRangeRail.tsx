import type { VisibleLabelRange } from "../annotations/visibleLabelRanges";

type RawImageLabelRangeRailProps = {
  ranges: VisibleLabelRange[];
  /** `ranges`' `startRawRow`/`endRawRow` are raw rows by default; pass
   * `"sample"` when they are compact-mode observed-sample-index bounds
   * instead (see `deriveVisibleCompactLabelRanges`), so the label reads
   * accurately either way. @default "row" */
  unit?: "row" | "sample";
};

function describeRange(range: VisibleLabelRange, unit: "row" | "sample"): string {
  const label = range.labelId.replaceAll("_", " ");
  const lastIndex = Math.max(range.startRawRow, range.endRawRow - 1);
  const unitLabel = unit === "sample" ? "samples" : "rows";
  return `${label}, ${unitLabel} ${range.startRawRow}–${lastIndex}`;
}

/**
 * Full-width band overlaid on the grayscale raw image: one bracket per
 * visible label range (already clipped/merged by
 * `deriveVisibleLabelRanges`), spanning the canvas's full width and
 * positioned vertically by percentage. Display-only — no editing, no
 * canvas, no icon dependency.
 */
export function RawImageLabelRangeRail({ ranges, unit = "row" }: RawImageLabelRangeRailProps) {
  if (ranges.length === 0) {
    return (
      <div role="note" aria-label="Saved label ranges" className="flex w-full items-start justify-center text-xs text-muted-foreground">
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
      className="relative h-80 w-full"
    >
      {ranges.map((range) => (
        <div
          key={`${range.labelId}-${range.startRawRow}-${range.endRawRow}`}
          role="listitem"
          aria-label={describeRange(range, unit)}
          title={describeRange(range, unit)}
          className="absolute left-0 right-0 flex items-center justify-center border-y-2 border-foreground/50 bg-foreground/5 px-1 text-center text-[10px] leading-tight text-foreground/80"
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
