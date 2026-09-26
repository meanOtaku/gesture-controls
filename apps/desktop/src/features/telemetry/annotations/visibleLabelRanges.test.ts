import { describe, expect, it } from "vitest";
import { deriveVisibleCompactLabelRanges, deriveVisibleLabelRanges } from "./visibleLabelRanges";
import type { AnnotationInterval, RawRecordingCompactWindow } from "../../../shared/tauri/recordingBundle";

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

function compactWindow(overrides: Partial<RawRecordingCompactWindow> = {}): RawRecordingCompactWindow {
  return {
    recordingId: "rec-a",
    column: "ppg_green",
    gridSize: 4,
    totalObservedSampleCount: 4,
    startSampleIndex: 0,
    endSampleIndex: 4,
    sourceRawRowIndices: [3, 10, 11, 40],
    timestampsNs: [3, 10, 11, 40],
    values: [1, 2, 3, 4],
    precedingTimestampNs: null,
    recordingMin: 1,
    recordingMax: 4,
    transformValues: [null, 1, 1, 1],
    transformAvailable: true,
    transformUnavailableReason: null,
    recordingMaxAbsTransform: 1,

    ...overrides,
  };
}

describe("deriveVisibleCompactLabelRanges", () => {
  it("maps an interval's raw-row span onto observed-sample positions using each sample's own sourceRawRowIndex", () => {
    // Samples at raw rows [3, 10, 11, 40]; an interval covering raw rows 10-11
    // owns only the observed samples at positions 1-2 (compact sample indices 1-2).
    const [range] = deriveVisibleCompactLabelRanges([interval("pinch", 10, 11)], compactWindow());
    expect(range).toMatchObject({ labelId: "pinch", startRawRow: 1, endRawRow: 3 });
  });

  it("draws nothing for an interval whose raw-row span contains none of this channel's observed samples", () => {
    // No observed sample has a sourceRawRowIndex inside [12, 39].
    const ranges = deriveVisibleCompactLabelRanges([interval("pinch", 12, 39)], compactWindow());
    expect(ranges).toEqual([]);
  });

  it("draws nothing when the compact window has zero observed samples for this channel", () => {
    const ranges = deriveVisibleCompactLabelRanges(
      [interval("pinch", 0, 100)],
      compactWindow({ sourceRawRowIndices: [], values: [], timestampsNs: [], totalObservedSampleCount: 0, endSampleIndex: 0 }),
    );
    expect(ranges).toEqual([]);
  });

  it("offsets by the window's startSampleIndex for a later navigation page", () => {
    const window = compactWindow({ startSampleIndex: 100, sourceRawRowIndices: [200, 205, 210, 220] });
    const [range] = deriveVisibleCompactLabelRanges([interval("pinch", 205, 210)], window);
    expect(range).toMatchObject({ labelId: "pinch", startRawRow: 101, endRawRow: 103 });
  });

  it("computes fractions against the full grid pixel count, not just the loaded sample count", () => {
    // gridSize 4 -> 16 pixels; only 4 samples are loaded (the rest is "beyond" fill).
    const [range] = deriveVisibleCompactLabelRanges([interval("pinch", 3, 3)], compactWindow());
    expect(range.startFraction).toBeCloseTo(0 / 16);
    expect(range.endFraction).toBeCloseTo(1 / 16);
  });

  it("never mutates the passed compact window or intervals", () => {
    const window = compactWindow();
    const intervals = [interval("pinch", 10, 11)];
    const snapshot = JSON.stringify(window);
    deriveVisibleCompactLabelRanges(intervals, window);
    expect(JSON.stringify(window)).toBe(snapshot);
  });
});
