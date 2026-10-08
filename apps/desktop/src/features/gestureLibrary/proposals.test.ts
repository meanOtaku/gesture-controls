import { describe, expect, it } from "vitest";
import { alignClocks, proposeIntervals, toAnnotationInterval } from "./proposals";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const pinch: GestureDefinition = {
  ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch",
  conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }], minHoldMs: 100, releaseGraceMs: 100,
};

/** 30 fps camera frames from 10 000 ms; the pinch is held for frames 30..59 (1 s). */
const frames = Array.from({ length: 120 }, (_, i) => ({
  frameIndex: i, captureMs: 10_000 + i * 33.333,
  hands: [makeHand({ pinch: i >= 30 && i < 60 ? 0.1 : 1.2 })],
}));
/** The watch clock runs 4 000 ms behind the camera's; raw rows every 20 ms from the start of the camera clip. */
const OFFSET = 4000;
const raw = Array.from({ length: 300 }, (_, i) => Math.round((10_000 - OFFSET + i * 20) * 1e6));
const alignment = { offsetMs: OFFSET, jitterMs: 5, samples: 50 };

describe("alignClocks", () => {
  it("takes the fastest sample as the offset and the spread above it as jitter", () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ watchTimestampNs: i * 1e8, browserArrivalMs: i * 100 + 4000 + (i % 5 === 0 ? 0 : 8) }));
    const a = alignClocks(pairs)!;
    expect(a.offsetMs).toBeCloseTo(4000, 6);
    expect(a.jitterMs).toBeCloseTo(8, 6);
  });
  it("refuses too few pairs", () => expect(alignClocks([{ watchTimestampNs: 1, browserArrivalMs: 1 }])).toBeNull());
});

describe("proposeIntervals", () => {
  it("turns a hold into the raw rows that span it, on the watch clock", () => {
    const [p] = proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [] });
    expect(p.labelId).toBe("pinch");
    // The pose began at frame 30 = 10 999.99 ms on the camera = 6 999.99 ms on the watch; raw rows start at 6 000 ms, 20 ms apart: row 50.
    expect(p.startRow).toBe(50);
    expect(p.endRow).toBeGreaterThan(p.startRow + 40);
    expect(p.endRow).toBeLessThan(p.startRow + 60);
    expect(p.overlaps).toBe(false);
  });

  it("closes a hold still going at the end of the clip, and ignores gestures with no label", () => {
    const held = frames.map((f) => ({ ...f, hands: [makeHand({ pinch: 0.1 })] }));
    const [p] = proposeIntervals({ definitions: [pinch, { ...pinch, id: "g2", name: "Other", labelId: null }], frames: held, alignment, rawTimestampsNs: raw, existing: [] });
    expect(p.endMs).toBeCloseTo(held[held.length - 1].captureMs, 3);
    expect(proposeIntervals({ definitions: [{ ...pinch, labelId: null }], frames: held, alignment, rawTimestampsNs: raw, existing: [] })).toEqual([]);
  });

  it("flags a proposal that would overlap an existing interval, and drops one outside the recording", () => {
    const [p] = proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [{ startRow: 0, endRow: 60 }] });
    expect(p.overlaps).toBe(true);
    const late = { ...alignment, offsetMs: -100_000 };
    expect(proposeIntervals({ definitions: [pinch], frames, alignment: late, rawTimestampsNs: raw, existing: [] })).toEqual([]);
  });

  it("makes a bundle interval that is an unreviewed camera proposal", () => {
    const [p] = proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [] });
    const interval = toAnnotationInterval(p, raw, "2026-10-09T10:00:00Z");
    expect(interval).toMatchObject({ label_id: "pinch", creation_mechanism: "camera_proposal", curation_status: "unreviewed", revision: 1 });
    expect(interval.resolved_start).toEqual({ raw_row: p.startRow, source_timestamp_ns: raw[p.startRow] });
  });
});
