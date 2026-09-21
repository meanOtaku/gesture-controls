import { describe, expect, it } from "vitest";
import { deriveVisibleLabelRanges } from "./visibleLabelRanges";
import type { AnnotationInterval } from "../../../shared/tauri/recordingBundle";

function interval(labelId: string, startRawRow: number, endRawRowInclusive: number): AnnotationInterval {
  return {
    interval_id: `${labelId}-${startRawRow}-${endRawRowInclusive}`,
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

describe("deriveVisibleLabelRanges", () => {
  it("returns an empty list for no annotations", () => {
    expect(deriveVisibleLabelRanges([], 0, 64)).toEqual([]);
  });

  it("keeps an interval wholly inside the window unclipped", () => {
    const [range] = deriveVisibleLabelRanges([interval("pinch", 10, 19)], 0, 64);
    expect(range).toMatchObject({ labelId: "pinch", startRawRow: 10, endRawRow: 20 });
  });

  it("clips an interval that begins before the window", () => {
    const [range] = deriveVisibleLabelRanges([interval("pinch", -5, 9)], 0, 64);
    expect(range).toMatchObject({ startRawRow: 0, endRawRow: 10 });
  });

  it("clips an interval that ends after the window", () => {
    const [range] = deriveVisibleLabelRanges([interval("pinch", 60, 200)], 0, 64);
    expect(range).toMatchObject({ startRawRow: 60, endRawRow: 64 });
  });

  it("drops an interval wholly outside the window", () => {
    expect(deriveVisibleLabelRanges([interval("pinch", 100, 150)], 0, 64)).toEqual([]);
  });

  it("keeps separate labels/ranges distinct", () => {
    const ranges = deriveVisibleLabelRanges([interval("pinch", 0, 9), interval("wave", 20, 29)], 0, 64);
    expect(ranges).toHaveLength(2);
    expect(ranges.map((r) => r.labelId)).toEqual(["pinch", "wave"]);
  });

  it("merges adjacent same-label intervals using the inclusive saved end row", () => {
    // First interval owns rows 0-9 (inclusive resolved_end 9); second starts at row 10 — adjacent.
    const ranges = deriveVisibleLabelRanges([interval("pinch", 0, 9), interval("pinch", 10, 19)], 0, 64);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ labelId: "pinch", startRawRow: 0, endRawRow: 20 });
  });

  it("does not merge same-label intervals separated by a gap", () => {
    const ranges = deriveVisibleLabelRanges([interval("pinch", 0, 9), interval("pinch", 11, 19)], 0, 64);
    expect(ranges).toHaveLength(2);
  });

  it("does not merge adjacent intervals with different labels", () => {
    const ranges = deriveVisibleLabelRanges([interval("pinch", 0, 9), interval("wave", 10, 19)], 0, 64);
    expect(ranges).toHaveLength(2);
  });

  it("computes correct top/end fractions for the vertical rail", () => {
    const [range] = deriveVisibleLabelRanges([interval("pinch", 16, 31)], 0, 64);
    expect(range.startFraction).toBeCloseTo(16 / 64);
    expect(range.endFraction).toBeCloseTo(32 / 64);
  });
});
